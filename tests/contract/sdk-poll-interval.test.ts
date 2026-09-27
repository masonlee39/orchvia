import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectOrchestrator,
  createOrchestrator,
} from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

// SPEC-0033 T (#46): the TypeScript client's polling interval, like Python's `poll_interval`.

async function directories(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'orch-poll-interval-'));
  const workspace = join(root, 'workspace'),
    stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace,
    stateDir,
    adapters: [createFakeAdapter({ delayMs: 5000 })],
    providers: { fake: { model: 'fake-model' } },
    storage: { emergencyBytes: 4096 },
  };
}
/** Counts the client's calls of `method`. */
function counting(orch: object, method: string) {
  const caller = (orch as { caller: { call: (...args: unknown[]) => unknown } }).caller;
  const call = caller.call.bind(caller);
  const count = { n: 0 };
  caller.call = (...args: unknown[]) => {
    if (args[0] === method) count.n++;
    return call(...args);
  };
  return count;
}

test('0033-T01 a polling interval must be an integer from 1 to 60000 milliseconds', async (t) => {
  const config = await directories(t);
  for (const pollIntervalMs of [0, -1, 1.5, 60001, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(createOrchestrator(config, { pollIntervalMs }), {
      code: 'INVALID_PARAMS',
    });
  for (const pollIntervalMs of [0, 1.5])
    await assert.rejects(
      connectOrchestrator({ socketPath: join(config.stateDir, 'none.sock'), pollIntervalMs }),
      { code: 'INVALID_PARAMS' },
    );
  // An invalid value started no engine: the state directory can still be opened.
  const orch = await createOrchestrator(config, { pollIntervalMs: 1 });
  assert.equal(orch.pollIntervalMs, 1);
  await orch.close({ mode: 'interrupt', timeoutMs: 1000 });
});

test('0033-T02 events() waits the interval after an empty page', async (t) => {
  const orch = await createOrchestrator(await directories(t), { pollIntervalMs: 200 });
  try {
    assert.equal(
      await createOrchestrator(await directories(t)).then(async (other) => {
        const value = other.pollIntervalMs;
        await other.close({ mode: 'interrupt', timeoutMs: 1000 });
        return value;
      }),
      50,
      'the default is Python’s 0.05 seconds',
    );
    const reads = counting(orch, 'events.read');
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(
      (async () => {
        for await (const _ of orch.events({ signal }));
      })(),
    );
    assert.ok(reads.n >= 2 && reads.n <= 7, `${reads.n} reads in one idle second at 200 ms`);
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
  }
});

test('0033-T03 a task’s wait() polls at the interval too', async (t) => {
  const orch = await createOrchestrator(await directories(t), { pollIntervalMs: 200 });
  try {
    const task = await orch.tasks.create(
      {
        goal: 'Slow fixture',
        runtime: { provider: 'fake', model: 'fake-model' },
        acceptance: { mode: 'human', criteria: ['review'] },
      },
      { idempotencyKey: 'poll-wait' },
    );
    const reads = counting(orch, 'tasks.get');
    await assert.rejects(task.wait({ timeoutMs: 1000 }), { code: 'TIMEOUT' });
    assert.ok(reads.n >= 2 && reads.n <= 7, `${reads.n} reads in one second at 200 ms`);
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
  }
});
