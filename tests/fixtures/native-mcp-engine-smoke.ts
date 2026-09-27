import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEngine } from '../../packages/engine/src/index.ts';
import {
  createClaudeAdapter,
  type ClaudeQueryFactory,
} from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
const [provider, sdkPath] = process.argv.slice(2);
if (!['claude', 'codex'].includes(provider!))
  throw new Error('Choose offline claude or codex peer');
const sdk =
  provider === 'claude'
    ? ((await import(pathToFileURL(sdkPath!).href)) as { query: ClaudeQueryFactory })
    : undefined;
const root = await mkdtemp(join(tmpdir(), 'orch-native-engine-'));
await mkdir(join(root, 'work'));
const adapter =
  provider === 'claude'
    ? createClaudeAdapter({
        query: (request) =>
          sdk!.query({
            ...request,
            options: {
              ...request.options,
              spawnClaudeCodeProcess: (native) =>
                request.options.spawnClaudeCodeProcess({
                  command: process.execPath,
                  args: [
                    fileURLToPath(new URL('./claude-mcp-child.ts', import.meta.url)),
                    '--engine-tools',
                  ],
                  cwd: request.options.cwd,
                  env: {},
                  signal: native.signal,
                }),
            },
          }),
      })
    : createCodexAdapter({
        // Offline fixture commands never outlive their turn (SPEC-0034 A01).
        observeExecutionStop: async () => true,
        command: process.execPath,
        args: [fileURLToPath(new URL('./codex-tools.ts', import.meta.url)), '--engine-tools'],
      });
const engine = await createEngine({
  workspace: join(root, 'work'),
  stateDir: join(root, 'state'),
  adapters: [adapter],
  tools: { enabled: true },
  limits: { maxActiveSessions: 1 },
  storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  timeouts: { acceptanceMs: 5000, turnMs: 10000 },
});
try {
  const task = (await engine.call('tasks.create', {
    expectedStoreId: engine.storeId,
    idempotencyKey: 'parent',
    spec: {
      goal: 'exercise private tools',
      runtime: { provider, model: 'offline' },
      acceptance: { mode: 'human', criteria: ['review fixture'] },
    },
  })) as any;
  let current = task;
  const deadline = performance.now() + 12000;
  while (current.status !== 'waiting_approval') {
    if (['blocked', 'failed'].includes(current.status) || performance.now() > deadline)
      throw new Error(JSON.stringify(current));
    await new Promise((r) => setTimeout(r, 5));
    current = await engine.call('tasks.get', { taskId: task.id });
  }
  const result = JSON.parse(current.result);
  const child = (await engine.call('tasks.get', { taskId: result.childId })) as any;
  const message = (await engine.call('messages.get', { messageId: result.messageId })) as any;
  const operation = (await engine.call('operations.get', {
    operationId: result.operationId,
  })) as any;
  assert.equal(child.spec.parentTaskId, task.id);
  assert.equal(child.status, 'paused');
  assert.equal(message.fromSessionId, task.sessionId);
  assert.equal(message.summary, 'actual engine message');
  assert.equal(operation.status, 'completed');
  console.log(
    JSON.stringify({
      provider,
      actualEngine: true,
      tools: 4,
      childStatus: child.status,
      messageStatus: message.status,
      modelCalls: 0,
    }),
  );
} finally {
  await engine.close({ mode: 'interrupt', timeoutMs: 3000 });
  await rm(root, { recursive: true, force: true });
}
