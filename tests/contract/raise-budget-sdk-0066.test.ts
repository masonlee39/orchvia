import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  connectOrchestrator,
  validateWire,
} from '../../packages/sdk-typescript/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';

// SPEC-0066 B06: the TypeScript SDK and the schema.

test('0066-B06 the SDK refuses raiseBudget before sending to a host without it', async () => {
  const sent: string[] = [];
  const legacy = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        sent.push(method);
        throw new Error('not reached');
      },
      disconnect() {},
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'fixture',
      schemaVersion: 3,
      instanceId: 'fixture',
      storeId: 'store',
      capabilities: { storeNamespaces: { version: 1 }, workflow: { version: 1, hostTasks: true } },
    },
    true,
  );
  await assert.rejects(
    (async () => legacy.tasks.raiseBudget('task', '2'))(),
    (error: { code?: string }) => error.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.deepEqual(sent, []);
});

test('0066-B06 0066-B05 a raise round-trips over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-raise-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/ors-'));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  try {
    assert.equal((client.info.capabilities.workflow as Record<string, unknown>).budgetRaise, true);
    validateWire('WorkflowCapability', client.info.capabilities.workflow);
    const run = await client.tasks.create({
      goal: 'one run',
      executor: 'host',
      budget: { currency: 'USD', maxCost: '5', reservePerDispatch: '1' },
    });
    const step = await client.tasks.create({
      goal: 'a step',
      executor: 'host',
      parentTaskId: run.id,
    });
    validateWire('TaskRaiseBudgetParams', { taskId: run.id, maxCost: '8', idempotencyKey: 'k' });
    const op = await (await client.tasks.raiseBudget(run.id, '8')).wait({ timeoutMs: 2000 });
    assert.equal(op.status, 'completed');
    validateWire('TaskRaiseBudgetResult', op.result);
    assert.deepEqual(op.result, {
      taskId: run.id,
      previousMaxCost: '5',
      maxCost: '8',
      pausedTaskIds: [],
    });
    assert.equal((await run.get()).spec.budget?.maxCost, '8');
    assert.equal((await step.get()).spec.budget?.maxCost, '8');
    validateWire('TaskSnapshot', await run.get());
    const events = await client.events.read({ taskId: run.id });
    for (const event of events.events) validateWire('EventEnvelope', event);
    assert.ok(events.events.some((event) => event.type === 'task.budget_raised'));
    await assert.rejects(
      client.tasks.raiseBudget(run.id, '8'),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
    for (const [definition, value] of [
      ['TaskRaiseBudgetParams', { taskId: run.id, idempotencyKey: 'k' }],
      ['TaskRaiseBudgetParams', { taskId: run.id, maxCost: 8, idempotencyKey: 'k' }],
      [
        'TaskRaiseBudgetParams',
        { taskId: run.id, maxCost: '8', currency: 'EUR', idempotencyKey: 'k' },
      ],
      ['TaskRaiseBudgetResult', { taskId: run.id, previousMaxCost: '5', maxCost: '8' }],
    ] as const)
      assert.throws(
        () => validateWire(definition, value),
        `${definition} ${JSON.stringify(value)}`,
      );
  } finally {
    await client.close();
    await host.close({ timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
});
