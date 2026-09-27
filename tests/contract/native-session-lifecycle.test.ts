import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeAdapter,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { claudeProcess } from '../fixtures/claude-process.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

for (const provider of ['claude', 'codex']) {
  for (const action of ['fork', 'compact', 'missing-boundary']) {
    test(`AC-F03 ${provider} ${action} follows native identity and boundary through owned children`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orch-native-session-'));
      await mkdir(join(dir, 'workspace'));
      await mkdir(join(dir, 'state'));
      let request: ClaudeQueryRequest | undefined;
      let prompt: string | undefined;
      const adapter =
        provider === 'claude'
          ? createClaudeAdapter({
              query(value) {
                request = value;
                const child = claudeProcess(value);
                const native = action === 'fork' ? 'native-fork' : 'native-source';
                return {
                  async *[Symbol.asyncIterator]() {
                    const first = await value.prompt[Symbol.asyncIterator]().next();
                    prompt = first.value?.message.content;
                    yield { type: 'system', subtype: 'init', session_id: native };
                    yield {
                      type: 'assistant',
                      uuid: 'assistant-point',
                      session_id: native,
                      message: { content: [] },
                    };
                    if (action === 'compact')
                      yield {
                        type: 'system',
                        subtype: 'compact_boundary',
                        uuid: 'compact-point',
                        session_id: native,
                        compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 20 },
                      };
                    yield {
                      type: 'result',
                      subtype: 'success',
                      session_id: native,
                      result: 'done',
                    };
                  },
                  close() {
                    child.stdin.end();
                  },
                };
              },
            })
          : createCodexAdapter({
              executionStop: 'owner-reconcile',
              command: process.execPath,
              args: [
                fileURLToPath(new URL('../fixtures/codex-session-lifecycle.ts', import.meta.url)),
                action,
              ],
            });
      const input: RuntimeInput = {
        taskId: 'task',
        sessionId: 'session',
        dispatchId: 'dispatch',
        generation: 1,
        providerSessionId: action === 'fork' ? null : 'native-source',
        model: 'fixture',
        workspace: join(dir, 'workspace'),
        stateDir: join(dir, 'state'),
        prompt: 'branch task',
        permissionProfile: 'read-only',
        signal: new AbortController().signal,
        ...(action === 'fork'
          ? {
              forkSource: {
                sessionId: 'source',
                generation: 1,
                providerSessionId: 'native-source',
                nativeCheckpoint: 'completed-source-point',
                snapshotRef: 'sha256:fixture',
              },
            }
          : { nativeAction: 'compact' as const }),
      };
      try {
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(input)) events.push(event);
        const result = events.at(-1);
        if (action === 'missing-boundary') {
          assert.equal(result?.type, 'error');
          return;
        }
        assert.equal(result?.type, 'result');
        if (result?.type !== 'result') return;
        if (action === 'fork') {
          assert.equal(adapter.capabilities().fork, true);
          assert.equal(result.providerSessionId, 'native-fork');
          if (provider === 'claude') {
            assert.equal(request!.options.resume, 'native-source');
            assert.equal(request!.options.forkSession, true);
            assert.equal(request!.options.resumeSessionAt, 'completed-source-point');
          } else {
            const called = JSON.parse(result.text);
            assert.equal(called.method, 'thread/fork');
            assert.equal(called.params.lastTurnId, 'completed-source-point');
          }
        } else {
          assert.equal(result.compacted?.kind, 'boundary');
          if (provider === 'claude') assert.equal(prompt, '/compact');
        }
      } finally {
        await adapter.close?.();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
