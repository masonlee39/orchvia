import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
for (const allow of [true, false])
  test(`AC-F07 Codex stdio permission callback ${allow ? 'accepts' : 'declines'} exact turn`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-native-permission-'));
    await mkdir(join(dir, 'workspace'));
    await mkdir(join(dir, 'state'));
    const adapter = createCodexAdapter({
      executionStop: 'owner-reconcile',
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/codex-approval.ts', import.meta.url))],
    });
    let called = 0;
    try {
      const events = [];
      for await (const event of adapter.execute({
        taskId: 'task',
        sessionId: 'session',
        dispatchId: 'dispatch',
        providerSessionId: null,
        workspace: join(dir, 'workspace'),
        stateDir: join(dir, 'state'),
        model: 'offline',
        prompt: 'permission',
        permissionProfile: 'read-only',
        signal: new AbortController().signal,
        async requestPermission(request) {
          called++;
          assert.equal(request.providerSessionId, 'thread');
          assert.equal(request.providerTurnId, 'turn');
          return allow;
        },
      }))
        events.push(event);
      assert.equal(called, 1);
      const result = events.at(-1);
      assert.equal(result?.type, 'result', JSON.stringify(events));
      if (result?.type === 'result') assert.equal(result.text, allow ? 'accept' : 'decline');
    } finally {
      await adapter.close?.();
      await rm(dir, { recursive: true, force: true });
    }
  });
