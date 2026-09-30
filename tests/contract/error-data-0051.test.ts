import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { validateWire } from '../../packages/engine/src/index.ts';
import { markStoreFeatureForTest } from '../../packages/engine/src/testing.ts';
import { openOrchestratorReadOnly } from '../../packages/sdk-typescript/src/index.ts';
import type {
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0051 E01 to E03: the data of the errors hosts read by value is a wire definition, an error
// while opening a store carries it as `data`, and a test can mark a store as a newer engine's.

async function dirs(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-error-data-'));
  await mkdir(join(dir, 'workspace'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { workspace: join(dir, 'workspace'), stateDir: join(dir, 'state') };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; data?: Record<string, unknown>; details?: unknown };
  }
  assert.fail('expected a rejection');
}

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  for (let i = 0; i < 1000; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out');
};

test('AC-0051-E01 STEER_TURN_ENDED carries SteerTurnEndedData', async (t) => {
  const fake = createFakeAdapter();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const adapter = {
    ...fake,
    capabilities: () => ({ ...fake.capabilities(), steer: true }),
    async *execute(input: RuntimeInput) {
      yield { type: 'accepted', providerSessionId: `fake-${input.sessionId}` };
      await held;
      for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
    },
    steer: async () => ({ status: 'accepted' }),
  } as RuntimeAdapter;
  const engine = await createEngine({ ...(await dirs(t)), adapters: [adapter] });
  t.after(() => {
    release();
    return engine.close({ mode: 'interrupt', timeoutMs: 1000 });
  });
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'work',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const session = await until(
    () => engine.call('sessions.get', { sessionId: task.sessionId }) as Promise<SessionSnapshot>,
    (s) => !!s.activeDispatchId && !!s.providerSessionId,
  );
  release();
  await until(
    () => engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>,
    (current) => current.status === 'waiting_approval',
  );
  const error = await rejection(
    engine.call('sessions.steer', {
      target: {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedDispatchId: session.activeDispatchId,
      },
      text: 'too late',
      idempotencyKey: 'late',
    }),
  );
  assert.equal(error.code, 'STEER_TURN_ENDED');
  assert.deepEqual(error.data, {
    dispatchId: session.activeDispatchId,
    turnOutcome: 'completed',
    taskStatus: 'waiting_approval',
  });
  validateWire('SteerTurnEndedData', error.data);
  assert.throws(() => validateWire('SteerTurnEndedData', { ...error.data, turnOutcome: 'gone' }), {
    code: 'INVALID_WIRE_DATA',
  });
});

test('AC-0051-E01 CURSOR_EXPIRED carries CursorExpiredData for each reason', async (t) => {
  const engine = await createEngine({ ...(await dirs(t)), adapters: [createFakeAdapter()] });
  t.after(() => engine.close());
  const ahead = await rejection(
    engine.call('events.read', { afterCursor: '999999', storeId: engine.storeId }),
  );
  const other = await rejection(
    engine.call('events.read', { afterCursor: '1', storeId: 'another-store' }),
  );
  for (const [error, reason] of [
    [ahead, 'ahead_of_store'],
    [other, 'store_changed'],
  ] as const) {
    assert.equal(error.code, 'CURSOR_EXPIRED');
    assert.equal(error.data?.reason, reason);
    validateWire('CursorExpiredData', error.data);
  }
  assert.throws(() => validateWire('CursorExpiredData', { ...ahead.data, reason: 'other' }), {
    code: 'INVALID_WIRE_DATA',
  });
});

test('AC-0051-E02 AC-0051-E03 a marked store is refused with StoreTooNewData as data', async (t) => {
  const paths = await dirs(t);
  const config = { ...paths, adapters: [createFakeAdapter()] };
  const engine = await createEngine(config);
  // E03: an engine that holds the store keeps it from being marked.
  await assert.rejects(
    markStoreFeatureForTest(paths.stateDir, { name: 'from-the-future', engineVersion: '9.9.9' }),
    { code: 'HOST_ALREADY_RUNNING' },
  );
  await engine.close();
  const feature = { name: 'from-the-future', engineVersion: '9.9.9' };
  await markStoreFeatureForTest(paths.stateDir, feature);
  await markStoreFeatureForTest(paths.stateDir, feature);
  await assert.rejects(markStoreFeatureForTest(paths.stateDir, { name: '', engineVersion: '1' }), {
    code: 'VALIDATION_ERROR',
  });
  for (const open of [
    () => createEngine(config),
    () => openOrchestratorReadOnly({ stateDir: paths.stateDir }),
  ]) {
    const error = await rejection(open());
    assert.equal(error.code, 'STORE_TOO_NEW');
    // E02: `data`, as every other error of the SDK; `details` stays for existing callers.
    assert.deepEqual(error.data, { features: [feature] });
    assert.deepEqual(error.details, error.data);
    validateWire('StoreTooNewData', error.data);
  }
});

test('AC-0051-E01 the definitions list every value the engine sets', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (path: string) =>
    readFile(new URL(`../../packages/engine/src/${path}`, import.meta.url), 'utf8');
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'),
  ).$defs;
  const reasons = [...(await source('store.ts')).matchAll(/expired\(\s*'([a-z_]+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(reasons.sort(), [...schema.CursorExpiredData.properties.reason.enum].sort());
  const turnState = /private turnState[\s\S]*?\n {2}\}/.exec(await source('index.ts'))![0];
  const outcomes = [...turnState.matchAll(/\? '([a-z_]+)'|: '([a-z_]+)';/g)].map(
    (match) => match[1] ?? match[2],
  );
  assert.deepEqual(
    [...new Set(outcomes)].sort(),
    [...schema.SteerTurnEndedData.properties.turnOutcome.enum].sort(),
  );
});
