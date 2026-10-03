import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EventPage,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0032 E: the engine keeps each dispatch's native session totals and hands the next dispatch
// of the same native session the ones before it.

const totalsOf = (dispatchId: string, sessionId: string) => ({
  version: 1,
  sessionId,
  cumulative: true,
  models: { small: [Number(dispatchId.length), 0, 0, 1] },
});
/** Each goal's first word says whether its dispatch reports totals. */
function probe(inputs: RuntimeInput[], hold?: { release?: () => void; wait?: Promise<void> }) {
  const fake = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      inputs.push(input);
      const word = input.prompt.split(' ')[0];
      for await (const event of fake.execute(input)) {
        if (event.type === 'result') {
          const native = input.providerSessionId ?? `fake-${input.sessionId}`;
          yield {
            type: 'usage',
            usageId: 'main',
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 1,
              raw: {},
            },
            ...(word === 'silent' ? {} : { sessionTotals: totalsOf(input.dispatchId, native) }),
          } as RuntimeEvent;
          // A held dispatch has reported its usage and totals but has not ended.
          if (word === 'held' && hold?.wait) await hold.wait;
          yield { ...event, usageComplete: true };
        } else yield event;
      }
    },
  };
  return adapter;
}
async function setup(hold?: { release?: () => void; wait?: Promise<void> }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-session-usage-')));
  await mkdir(join(root, 'workspace'));
  const inputs: RuntimeInput[] = [];
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [probe(inputs, hold)],
    providers: { fake: { models: ['small'] } },
    allowCrossRootReuse: true,
  });
  return {
    engine,
    inputs,
    input: (taskId: string) => inputs.filter((input) => input.taskId === taskId).at(-1)!,
    dispatches: () =>
      (
        engine as unknown as {
          store: { db: { prepare(sql: string): { all(): { data: string }[] } } };
        }
      ).store.db
        .prepare('SELECT data FROM dispatches ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(row.data) as Record<string, unknown>),
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
const reuse = (candidateSessionId: string) => ({
  requestedMode: 'reuse',
  independent: true,
  candidateSessionId,
  dependencyTaskIds: [],
  contextRefs: [],
  fallbackModes: [],
  maxQueueWaitMs: 1000,
});
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task did not become ${status}`);
}
async function run(engine: Engine, goal: string, sessionId?: string, complete = true) {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'small' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      ...(sessionId ? { contextPlan: reuse(sessionId) } : {}),
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
  const pending = await wait(engine, task.id, 'waiting_approval');
  if (!complete) return pending;
  await engine.call('approvals.decide', {
    approvalId: pending.approvalId,
    decision: { choice: 'approve', expectedRevision: 1 },
    idempotencyKey: crypto.randomUUID(),
  });
  return wait(engine, task.id, 'completed');
}
const session = (engine: Engine, sessionId: string) =>
  engine.call('sessions.get', { sessionId }) as Promise<SessionSnapshot>;
const target = (value: SessionSnapshot) => ({
  sessionId: value.id,
  expectedGeneration: value.generation,
  expectedRevision: value.revision,
  expectedState: value.status,
  expectedDispatchId: value.activeDispatchId,
});

test('0032-E01 a dispatch’s totals are kept and the next dispatch of the session receives them', async () => {
  const f = await setup();
  try {
    const first = await run(f.engine, 'first');
    assert.equal(f.input(first.id).usageBaseline, null, 'a new native session has no baseline');
    const second = await run(f.engine, 'second', first.sessionId!);
    const firstDispatch = f.inputs[0].dispatchId;
    assert.deepEqual(f.input(second.id).usageBaseline, {
      dispatchId: firstDispatch,
      totals: totalsOf(firstDispatch, `fake-${first.sessionId}`),
    });
    const third = await run(f.engine, 'third', first.sessionId!);
    assert.equal(f.input(third.id).usageBaseline?.dispatchId, f.input(second.id).dispatchId);
  } finally {
    await f.close();
  }
});

test('0032-E02 a previous dispatch without totals leaves no baseline, never an older one', async () => {
  const f = await setup();
  try {
    const first = await run(f.engine, 'first');
    await run(f.engine, 'silent', first.sessionId!);
    const third = await run(f.engine, 'third', first.sessionId!);
    assert.equal(f.input(third.id).usageBaseline, null);
  } finally {
    await f.close();
  }
});

test('0032-E03 a fork’s first dispatch receives its source’s latest totals, unless the source is running', async () => {
  const f = await setup();
  try {
    const first = await run(f.engine, 'first');
    const second = await run(f.engine, 'second', first.sessionId!);
    const source = await session(f.engine, first.sessionId!);
    // A native fork continues from its source's latest totals, whatever its checkpoint.
    const forked = (await f.engine.call('sessions.fork', {
      target: target(source),
      snapshotRef: second.artifactRefs[0],
      idempotencyKey: 'fork',
    })) as SessionSnapshot;
    const branch = await run(f.engine, 'branch', forked.id);
    assert.deepEqual(f.input(branch.id).usageBaseline, {
      dispatchId: f.input(second.id).dispatchId,
      totals: totalsOf(f.input(second.id).dispatchId, `fake-${first.sessionId}`),
    });
  } finally {
    await f.close();
  }
  let release!: () => void;
  const hold = { wait: new Promise<void>((resolve) => (release = resolve)) };
  const g = await setup(hold);
  try {
    const first = await run(g.engine, 'first');
    const source = await session(g.engine, first.sessionId!);
    const forked = (await g.engine.call('sessions.fork', {
      target: target(source),
      snapshotRef: first.artifactRefs[0],
      idempotencyKey: 'fork',
    })) as SessionSnapshot;
    // The source runs again while the fork starts: which totals the fork continues is unknown.
    const running = g.engine.call('tasks.create', {
      spec: {
        goal: 'held source',
        runtime: { provider: 'fake', model: 'small' },
        acceptance: { mode: 'human', criteria: ['Review'] },
        contextPlan: reuse(first.sessionId!),
      },
      idempotencyKey: crypto.randomUUID(),
    }) as Promise<TaskSnapshot>;
    const held = await running;
    await wait(g.engine, held.id, 'running');
    for (let i = 0; i < 400 && !g.dispatches().at(-1)?.usageTotals; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(g.dispatches().at(-1)?.usageTotals, 'the running source dispatch kept its totals');
    const branch = await run(g.engine, 'branch', forked.id, false);
    assert.equal(g.input(branch.id).usageBaseline, null);
    release();
  } finally {
    release();
    await g.close();
  }
});

test('0032-E04 the totals stay inside the engine: not in snapshots, events or usage records', async () => {
  const f = await setup();
  try {
    const first = await run(f.engine, 'first');
    const second = await run(f.engine, 'second', first.sessionId!);
    const kept = f.dispatches().find((row) => row.id === f.input(second.id).dispatchId)!;
    assert.deepEqual(kept.usageTotals, totalsOf(String(kept.id), `fake-${first.sessionId}`));
    const visible = JSON.stringify([
      await session(f.engine, first.sessionId!),
      await f.engine.call('tasks.get', { taskId: second.id }),
      await f.engine.call('usage.get', { taskId: second.id }),
      ((await f.engine.call('events.read', { afterCursor: '0', limit: 500 })) as EventPage).events,
    ]);
    assert.ok(!visible.includes('usageTotals') && !visible.includes('sessionTotals'), visible);
  } finally {
    await f.close();
  }
});

test('0032-E01 a repeated observation must carry the same totals', async () => {
  const f = await setup();
  try {
    const first = await run(f.engine, 'first');
    const input = f.input(first.id) as RuntimeInput & {
      reportUsage: (event: RuntimeEvent) => void;
    };
    const repeat = (sessionTotals: unknown) =>
      input.reportUsage({
        type: 'usage',
        usageId: 'main',
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
          raw: {},
        },
        sessionTotals,
      } as RuntimeEvent);
    repeat(totalsOf(input.dispatchId, `fake-${first.sessionId}`));
    assert.throws(() => repeat({ version: 1, other: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally {
    await f.close();
  }
});

test('0032-E05 invalid totals are refused like any invalid usage observation', async () => {
  const { usageTotals } = await import('../../packages/engine/src/usage.ts');
  const event = (sessionTotals: unknown) =>
    ({
      type: 'usage',
      usageId: 'main',
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        raw: {},
      },
      sessionTotals,
    }) as never;
  assert.equal(usageTotals(event(undefined)), undefined);
  assert.deepEqual(usageTotals(event({ a: [1] })), { a: [1] });
  for (const bad of [Number.NaN, () => 1, new Date(), { big: 'x'.repeat(70 * 1024) }])
    assert.throws(() => usageTotals(event(bad)), { code: 'INVALID_RUNTIME_CONTRACT' });
});
