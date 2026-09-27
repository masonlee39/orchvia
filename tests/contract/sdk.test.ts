import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOrchestrator,
  Orchestrator,
  TaskHandle,
} from '../../packages/sdk-typescript/src/index.ts';
import type { RuntimeAdapter, TaskSnapshot } from '../../packages/engine/src/types.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { createEngine } from '../fixtures/engine.ts';

async function fixture(t: any, delayMs = 0, adapter?: RuntimeAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'orch-sdk-test-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  const orch = await createOrchestrator({
    workspace,
    stateDir,
    adapters: [adapter ?? createFakeAdapter({ delayMs })],
    providers: { fake: { model: 'fake-model' } },
    storage: { emergencyBytes: 4096 },
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 2000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return orch;
}
const spec = {
  goal: 'Contract fixture',
  runtime: { provider: 'fake', model: 'fake-model' },
  acceptance: { mode: 'human' as const, criteria: ['review result'] },
};

test('AC12 TS embedded handles replay events, require approval, and preserve null usage', async (t) => {
  const orch = await fixture(t);
  const task = await orch.tasks.create(spec, { idempotencyKey: 'sdk-task' });
  assert.ok(task.id);
  const abort = AbortSignal.timeout(3000);
  for await (const event of orch.events({ taskId: task.id, signal: abort })) {
    if (event.type !== 'approval.requested') continue;
    const snapshot = await orch.tasks.get(task.id);
    assert.equal(snapshot.status, 'waiting_approval');
    const approval = await orch.approvals.get(snapshot.approvalId!);
    const operation = await orch.approvals.decide(approval.approvalId, {
      choice: 'approve',
      expectedRevision: approval.revision,
    });
    assert.equal((await operation.wait({ timeoutMs: 1000 })).status, 'completed');
    break;
  }
  assert.equal((await task.wait({ timeoutMs: 1000 })).status, 'completed');
  const usage = await orch.usage.get({ taskId: task.id });
  assert.ok(['unknown', 'reported'].includes(usage.completeness));
  for (const record of usage.records)
    assert.ok(record.cachedInputTokens === null || typeof record.cachedInputTokens === 'number');
});

test('AC06 TS wait timeout and AbortSignal only stop the local wait', async (t) => {
  const orch = await fixture(t, 400);
  const task = await orch.tasks.create(spec);
  await assert.rejects(task.wait({ timeoutMs: 5 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(task.wait({ signal: controller.signal }), { code: 'ABORTED' });
  assert.notEqual((await orch.tasks.get(task.id)).status, 'cancelled');
});

test('AC07 drain timeout keeps the client and shutdown operation recoverable', async (t) => {
  const base = createFakeAdapter();
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      for await (const event of base.execute(input)) {
        if (event.type === 'result') await terminalGate;
        yield event;
      }
    },
  };
  const orch = await fixture(t, 0, adapter);
  const task = await orch.tasks.create(spec);
  const deadline = Date.now() + 5000;
  let snapshot = await orch.tasks.get(task.id);
  while (snapshot.status !== 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    snapshot = await orch.tasks.get(task.id);
  }
  assert.equal(snapshot.status, 'running');
  let failure: any;
  try {
    await orch.close({ mode: 'drain', timeoutMs: 1 });
  } catch (error) {
    failure = error;
  }
  releaseTerminal();
  assert.equal(failure?.code, 'SHUTDOWN_INCOMPLETE');
  assert.equal(failure.client, orch);
  assert.equal(typeof failure.operationId, 'string');
  assert.equal((await failure.client.tasks.get(task.id)).id, task.id);
  await failure.client.close({ mode: 'drain', timeoutMs: 2000, operationId: failure.operationId });
});

test('AC06 wait deadline includes a slow status response and does not call remote cancellation', async () => {
  const calls: string[] = [];
  const snapshot = { id: 'slow-task', status: 'queued' } as TaskSnapshot;
  const client = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        await new Promise((r) => setTimeout(r, 200));
        return snapshot as T;
      },
      disconnect() {},
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'test',
      schemaVersion: 1,
      instanceId: 'test',
      storeId: 'test',
      capabilities: { storeNamespaces: { version: 1 } },
    },
    false,
  );
  const handle = new TaskHandle(client, snapshot);
  const started = Date.now();
  await assert.rejects(handle.wait({ timeoutMs: 10 }), { code: 'TIMEOUT' });
  assert.ok(Date.now() - started < 150, 'local timeout must not wait for a slow host reply');
  assert.deepEqual(calls, ['tasks.get']);
  await client.close();
});

test('AC02 generated mutation key survives a lost creation receipt and recovers the persisted task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orch-sdk-recovery-'));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  t.after(async () => {
    await engine.close({ mode: 'interrupt', timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
  });
  let loseReceipt = true;
  const info = (await engine.call('initialize', {
    protocolVersion: '2.0',
    sdkVersion: 'test',
  })) as any;
  const client = new Orchestrator(
    {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        const result = await engine.call(method, params, { owner: true });
        if (method === 'tasks.create' && loseReceipt) {
          loseReceipt = false;
          throw Object.assign(new Error('Receipt lost after persistence'), {
            code: 'CONNECTION_CLOSED',
          });
        }
        return result as T;
      },
      disconnect() {},
    },
    info,
    true,
  );
  let error: any;
  try {
    await client.tasks.create(spec);
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.method, 'tasks.create');
  assert.equal(error.scope, 'local');
  assert.equal(typeof error.idempotencyKey, 'string');
  const operation = await client.ops.lookup({
    method: error.method,
    scope: error.scope,
    idempotencyKey: error.idempotencyKey,
  });
  const recovered = await client.tasks.get(operation.targetId);
  const retry = await client.tasks.create(spec, { idempotencyKey: error.idempotencyKey });
  assert.equal(retry.id, recovered.id);
});

test('AC02 every mutation failure exposes its exact lookup scope and key', async () => {
  const client = new Orchestrator(
    {
      async call<T>(): Promise<T> {
        throw Object.assign(new Error('Disconnected'), { code: 'CONNECTION_CLOSED' });
      },
      disconnect() {},
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'test',
      schemaVersion: 1,
      instanceId: 'test',
      storeId: 'test',
      capabilities: { storeNamespaces: { version: 1 } },
    },
    false,
  );
  const mutations: [string, string, () => Promise<unknown>][] = [
    ['tasks.resume', 'task', () => client.tasks.resume('task')],
    ['tasks.cancel', 'task', () => client.tasks.cancel('task')],
    [
      'sessions.control',
      'session',
      () =>
        client.sessions.control(
          {
            sessionId: 'session',
            expectedGeneration: 1,
            expectedRevision: 1,
            expectedDispatchId: null,
            expectedState: 'idle',
          },
          { action: 'pause' },
        ),
    ],
    [
      'messages.send',
      'session',
      () =>
        client.messages.send({
          taskId: 'task',
          toSessionId: 'session',
          expectedGeneration: 1,
          kind: 'finding',
          summary: 'fixture',
        }),
    ],
    [
      'approvals.decide',
      'approval',
      () => client.approvals.decide('approval', { choice: 'approve', expectedRevision: 1 }),
    ],
  ];
  for (const [method, scope, invoke] of mutations) {
    await assert.rejects(
      invoke(),
      (error: any) =>
        error.method === method &&
        error.scope === scope &&
        typeof error.idempotencyKey === 'string',
    );
  }
});

test('TS events() rejects a non-positive pollIntervalMs like the Python SDK', async (t) => {
  const orch = await fixture(t);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      (async () => {
        for await (const _event of orch.events({ pollIntervalMs: bad })) {
          // unreachable: validation throws before the first poll
        }
      })(),
      { code: 'INVALID_PARAMS' },
    );
  }
});

test('TS events() accepts a custom pollIntervalMs and still streams events', async (t) => {
  const orch = await fixture(t);
  const task = await orch.tasks.create(spec, { idempotencyKey: 'sdk-poll-interval' });
  const abort = AbortSignal.timeout(3000);
  let seen = 0;
  for await (const _event of orch.events({
    taskId: task.id,
    signal: abort,
    pollIntervalMs: 5,
  })) {
    seen += 1;
    break;
  }
  assert.equal(seen, 1);
});
