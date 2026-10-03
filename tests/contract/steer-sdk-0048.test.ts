import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  createOrchestrator,
  validateWire,
} from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { RuntimeAdapter } from '../../packages/engine/src/types.ts';

// SPEC-0048 W01: the TypeScript SDK, the schema and the flag.

test('AC-0048-W01 the SDK steers only a host that lists workflow.steer', async () => {
  const calls: string[] = [];
  const old = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        return {} as T;
      },
      disconnect() {},
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'fixture',
      schemaVersion: 3,
      instanceId: 'fixture',
      storeId: 'store',
      capabilities: { storeNamespaces: { version: 1 }, workflow: { version: 1 } },
    },
    true,
  );
  await assert.rejects(
    old.sessions.steer({ sessionId: 's', expectedGeneration: 1, expectedDispatchId: 'd' }, 'x'),
    { code: 'UNSUPPORTED_CAPABILITY' },
  );
  assert.deepEqual(calls, []);
  assert.doesNotThrow(() =>
    validateWire('SessionSteerParams', {
      target: { sessionId: 's', expectedGeneration: 1, expectedDispatchId: 'd' },
      text: 'x',
      idempotencyKey: 'k',
    }),
  );
  assert.throws(() =>
    validateWire('SessionSteerParams', {
      target: { sessionId: 's', expectedGeneration: 1, expectedDispatchId: 'd' },
      text: '',
      idempotencyKey: 'k',
    }),
  );
});

test('AC-0048-W01 a steer round trip returns schema-valid snapshots', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-steer-sdk-')));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter({ delayMs: 5000 });
  const adapter: RuntimeAdapter = {
    ...fake,
    capabilities: () => ({ ...fake.capabilities(), steer: true }),
    steer: async () => ({ status: 'accepted' }),
  };
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    storage: { emergencyBytes: 4096 },
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 2000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const task = await orch.tasks.create({
    goal: 'work',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['Review'] },
  });
  const sessionId = (await task.get()).sessionId!;
  let session = await orch.sessions.get(sessionId);
  for (let i = 0; i < 400 && !(session.activeDispatchId && session.providerSessionId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    session = await orch.sessions.get(sessionId);
  }
  const op = await orch.sessions.steer(
    {
      sessionId: session.id,
      expectedGeneration: session.generation,
      expectedDispatchId: session.activeDispatchId!,
    },
    'keep the old API',
  );
  const done = await op.wait({ timeoutMs: 5000 });
  validateWire('OperationSnapshot', done);
  assert.equal(done.status, 'completed');
  const message = await orch.messages.get((done.result as { messageId: string }).messageId);
  validateWire('MessageSnapshot', message);
  assert.equal(message.kind, 'steer');
  // A turn that is not running is refused before anything is recorded.
  await assert.rejects(
    orch.sessions.steer(
      { sessionId: session.id, expectedGeneration: session.generation, expectedDispatchId: 'gone' },
      'late',
    ),
    { code: 'STEER_TURN_ENDED' },
  );
});
