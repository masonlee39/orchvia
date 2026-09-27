import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ORCHESTRATION_TOOLS } from '../../packages/engine/src/tools.ts';
import type { Json } from '../../packages/engine/src/types.ts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { claudeProcess } from '../fixtures/claude-process.ts';
import type { RuntimeTools } from '../../packages/engine/src/tools.ts';

for (const provider of ['claude', 'codex'])
  test(`AC-F06 ${provider} supplies exactly four bound tools to its owned runtime`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-tools-'));
    await mkdir(join(dir, 'workspace'));
    await mkdir(join(dir, 'state'));
    const calls: string[] = [];
    let bound: RuntimeTools | undefined;
    const adapter =
      provider === 'claude'
        ? createClaudeAdapter({
            createMcpServer(tools) {
              bound = tools;
              return { type: 'sdk', name: 'agent_orch' };
            },
            query(req) {
              const child = claudeProcess(req);
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'system', subtype: 'init', session_id: 'native' };
                  for (const tool of bound!.definitions) {
                    assert.ok(req.options.allowedTools.includes(`mcp__agent_orch__${tool.name}`));
                    await bound!.call(tool.name, { id: tool.name });
                  }
                  yield {
                    type: 'result',
                    subtype: 'success',
                    session_id: 'native',
                    result: 'tools-done',
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
            args: [fileURLToPath(new URL('../fixtures/codex-tools.ts', import.meta.url))],
          });
    try {
      const events = [];
      for await (const event of adapter.execute({
        taskId: 'task',
        sessionId: 'session',
        dispatchId: 'dispatch',
        providerSessionId: null,
        model: 'offline',
        workspace: join(dir, 'workspace'),
        stateDir: join(dir, 'state'),
        permissionProfile: 'read-only',
        prompt: 'Use the four tools',
        signal: new AbortController().signal,
        orchestrationTools: {
          definitions: ORCHESTRATION_TOOLS,
          async call(name) {
            calls.push(name);
            return { ok: true };
          },
        },
      }))
        events.push(event);
      assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
      assert.deepEqual(
        calls,
        ORCHESTRATION_TOOLS.map((tool) => tool.name),
      );
      if (bound) await assert.rejects(bound.call('work_read', {}), /expired/);
    } finally {
      await adapter.close?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

test('AC-F05/F06 private bridge authenticates, bounds and revokes actual stdio tool calls', async () => {
  const { createToolBridge, callToolBridge } = await import(
    '../../packages/engine/src/tool-bridge.ts'
  );
  const control = new AbortController();
  const calls: string[] = [];
  const bridge = await createToolBridge(
    {
      definitions: ORCHESTRATION_TOOLS,
      async call(name, request) {
        calls.push(name);
        return { name, request: request as Json };
      },
    },
    control.signal,
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../packages/engine/src/tool-bridge.ts', import.meta.url))],
    {
      env: { ...process.env, ...bridge.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (method: string, params: unknown = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    const line = await output.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value!);
  };
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal((await request('tools/list')).result.tools.length, 4);
    for (const name of ORCHESTRATION_TOOLS.map((d) => d.name)) {
      const response = await request('tools/call', {
        name,
        arguments: { request: { id: 'bound-target' } },
      });
      assert.equal(response.result.isError, undefined);
      assert.equal(JSON.parse(response.result.content[0].text).name, name);
    }
    await assert.rejects(
      callToolBridge({ ...bridge.env, AGENT_ORCH_BRIDGE_TOKEN: 'forged' }, 'work_read', {}),
      /UNAUTHORIZED/,
    );
    assert.equal(calls.length, 4);
    assert.equal(
      (await request('tools/call', { name: 'approvals.decide', arguments: { request: {} } })).result
        .isError,
      true,
    );
    assert.equal(
      (
        await request('tools/call', {
          name: 'work_read',
          arguments: { request: {}, actor: 'owner' },
        })
      ).result.isError,
      true,
    );
    await assert.rejects(
      callToolBridge(bridge.env, 'work_read', { huge: 'x'.repeat(1_048_576) }),
      /LIMIT/,
    );
    control.abort();
    await bridge.close();
    assert.equal(
      (await request('tools/call', { name: 'work_read', arguments: { request: {} } })).result
        .isError,
      true,
    );
    assert.equal(calls.length, 4);
  } finally {
    child.stdin.end();
    await bridge.close();
    child.kill();
  }
});

test('AC-F06 actual Codex MCP child delegates, sends, reads and pauses through the owning engine', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../fixtures/native-mcp-engine-smoke.ts', import.meta.url)), 'codex'],
    { timeout: 15000 },
  );
  assert.equal(JSON.parse(result.stdout).actualEngine, true);
  assert.equal(JSON.parse(result.stdout).tools, 4);
});
