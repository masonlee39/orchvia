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
import { loadConfig } from '../../packages/cli/src/config.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';

// SPEC-0065 H10: the TypeScript SDK, the schema and the command-line host's configuration.

test('0065-H10 the SDK refuses host tasks before sending to a host without them', async () => {
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
      capabilities: { storeNamespaces: { version: 1 }, workflow: { version: 1, steer: true } },
    },
    true,
  );
  for (const attempt of [
    () => legacy.tasks.create({ goal: 'wait', executor: 'host' }),
    () => legacy.tasks.complete('task', { outcome: 'completed' }),
  ])
    await assert.rejects(
      (async () => attempt())(),
      (error: { code?: string }) => error.code === 'UNSUPPORTED_CAPABILITY',
    );
  assert.deepEqual(sent, []);
});

test('0065-H10 0065-H04 a host task round-trips over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-host-tasks-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/ohs-'));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  try {
    assert.equal((client.info.capabilities.workflow as Record<string, unknown>).hostTasks, true);
    validateWire('WorkflowCapability', client.info.capabilities.workflow);
    const spec = {
      goal: 'wait for a person',
      executor: 'host' as const,
      label: 'step:approve',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    validateWire('TaskSpec', spec);
    const gate = await client.tasks.create(spec);
    assert.equal(gate.initial.status, 'waiting_host');
    assert.equal(gate.initial.sessionId, null);
    validateWire('TaskSnapshot', gate.initial);
    const after = await client.tasks.create({
      goal: 'after the gate',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      dependencyTaskIds: [gate.id],
    });
    assert.deepEqual(await gate.settle({ timeoutMs: 2000 }), {
      task: await gate.get(),
      reason: 'waiting_host',
    });
    const params = { taskId: gate.id, outcome: 'completed' as const, result: 'approved by Alex' };
    validateWire('TaskCompleteParams', { ...params, idempotencyKey: 'k' });
    const op = await gate.complete({ outcome: 'completed', result: 'approved by Alex' });
    const done = await op.wait({ timeoutMs: 2000 });
    assert.equal(done.status, 'completed');
    validateWire('TaskCompleteResult', done.result);
    assert.deepEqual(done.result, { taskId: gate.id, status: 'completed' });
    const ended = await gate.get();
    validateWire('TaskSnapshot', ended);
    assert.equal(ended.result, 'approved by Alex');
    assert.equal((await after.settle({ timeoutMs: 5000 })).reason, 'waiting_approval');
    await assert.rejects(
      client.tasks.complete(gate.id, { outcome: 'failed' }),
      (error: { code?: string }) => error.code === 'STALE_TARGET',
    );
    const events = await client.events.read({ taskId: gate.id });
    for (const event of events.events) validateWire('EventEnvelope', event);
    assert.deepEqual(
      events.events.filter((event) => event.type.startsWith('task.')).map((event) => event.type),
      ['task.created', 'task.completed'],
    );
    assert.equal(events.events[0].data.status, 'waiting_host');
    // Negative cases of the schema.
    for (const [definition, value] of [
      ['TaskSpec', { goal: 'g', executor: 'engine' }],
      ['TaskCompleteParams', { taskId: gate.id, outcome: 'cancelled', idempotencyKey: 'k' }],
      ['TaskCompleteParams', { taskId: gate.id, idempotencyKey: 'k' }],
      ['TaskCompleteParams', { ...params, idempotencyKey: 'k', reason: 'x' }],
      ['TaskSnapshot', { ...ended, sessionId: 5 }],
      ['TaskSnapshot', { ...ended, status: 'waiting_person' }],
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

test('0065-H09 the command-line host takes limits.maxHostTasks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-host-tasks-cli-')));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'), { mode: 0o700 });
    const { writeFile } = await import('node:fs/promises');
    const write = async (limits: Record<string, unknown>) => {
      const path = join(root, 'orchestrator.json');
      await writeFile(
        path,
        JSON.stringify({
          configVersion: 1,
          workspace: join(root, 'workspace'),
          stateDir: join(root, 'state'),
          providers: { fake: { model: 'fixture' } },
          limits,
        }),
      );
      return path;
    };
    const loaded = (await loadConfig(await write({ maxHostTasks: 5 }))) as {
      limits?: { maxHostTasks?: number };
    };
    assert.equal(loaded.limits?.maxHostTasks, 5);
    await assert.rejects(async () => loadConfig(await write({ maxHostTasks: 10001 })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
