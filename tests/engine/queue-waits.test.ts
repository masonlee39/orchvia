import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

type Tools = { call(name: string, args: unknown): Promise<unknown> };

/** Engine time that a test moves. `sleep` moves only the wall clock, as a suspended computer does. */
function shiftedClock() {
  let wall = 0;
  let monotonic = 0;
  return {
    advance(ms: number) {
      wall += ms;
      monotonic += ms;
    },
    sleep(ms: number) {
      wall += ms;
    },
    clock: {
      wallNow: () => Date.now() + wall,
      monotonicNow: () => performance.now() + monotonic,
      setTimer(callback: () => void, delay: number) {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  };
}

/** The fake runtime. "hold" runs until the test ends; "delegate" asks for one child without a wait. */
function runtime() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      if (input.prompt.startsWith('hold'))
        await new Promise<void>((resolve) => {
          void released.then(resolve);
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      if (input.prompt.startsWith('delegate'))
        await (input as RuntimeInput & { orchestrationTools: Tools }).orchestrationTools.call(
          'work_delegate',
          {
            goal: 'child',
            contextPlan: { requestedMode: 'fresh', independent: true },
            idempotencyKey: 'child',
          },
        );
      yield* base.execute(input);
    },
  };
  return { adapter, release };
}

async function setup(extra: Partial<EngineConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orch-queue-waits-'));
  await mkdir(join(root, 'workspace'));
  const time = shiftedClock();
  const run = runtime();
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [run.adapter],
    clock: time.clock,
    ...extra,
  };
  let engine = await createEngine(config);
  return {
    time,
    get engine() {
      return engine;
    },
    async restart(changes: Partial<EngineConfig> = {}) {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      engine = await createEngine({ ...config, ...changes });
    },
    async close() {
      run.release();
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});
const plan = (maxQueueWaitMs?: number) => ({
  requestedMode: 'fresh',
  independent: true,
  ...(maxQueueWaitMs === undefined ? {} : { maxQueueWaitMs }),
});
const create = async (engine: Engine, goal: string, extra: Record<string, unknown> = {}) =>
  (await engine.call('tasks.create', {
    spec: spec(goal, extra),
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await get(engine, id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
/** Schedules a scheduler pass through an unrelated admission and lets it finish. */
async function poke(engine: Engine) {
  await create(engine, `poke ${crypto.randomUUID()}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
async function approve(engine: Engine, id: string) {
  const task = await wait(engine, id, 'waiting_approval');
  const approval = (await engine.call('approvals.get', { approvalId: task.approvalId })) as {
    revision: number;
  };
  await engine.call('approvals.decide', {
    approvalId: task.approvalId,
    decision: { choice: 'approve', expectedRevision: approval.revision },
    idempotencyKey: crypto.randomUUID(),
  });
}
async function control(
  engine: Engine,
  sessionId: string,
  command: Record<string, unknown>,
  key: string,
) {
  const session = (await engine.call('sessions.get', { sessionId })) as SessionSnapshot;
  const request = {
    target: {
      sessionId: session.id,
      expectedGeneration: session.generation,
      expectedRevision: session.revision,
      expectedState: session.status,
      expectedDispatchId: session.activeDispatchId,
    },
    command,
    idempotencyKey: key,
  };
  await engine.call('sessions.control', request);
  return request;
}
/** The routing wait restarted no earlier than `since` and lasts exactly `ms`. */
function restarted(task: TaskSnapshot, since: number, ms: number) {
  const enqueued = Date.parse(task.routing!.enqueuedAt);
  assert.ok(
    enqueued >= since,
    `enqueuedAt ${task.routing!.enqueuedAt} precedes ${new Date(since).toISOString()}`,
  );
  assert.equal(Date.parse(task.routing!.deadlineAt) - enqueued, ms);
}

test('0015-Q01 a dependency wait never expires and the wait starts at release', async () => {
  const f = await setup();
  try {
    const upstream = await create(f.engine, 'upstream');
    await wait(f.engine, upstream.id, 'waiting_approval');
    const downstream = await create(f.engine, 'downstream', { dependencyTaskIds: [upstream.id] });
    assert.equal(downstream.status, 'waiting_dependency');
    // An hour of human review is far beyond the downstream task's 30-second wait.
    f.time.advance(3_600_000);
    await poke(f.engine);
    assert.equal((await get(f.engine, downstream.id)).status, 'waiting_dependency');
    const approvedAt = f.time.clock.wallNow();
    await approve(f.engine, upstream.id);
    restarted(await wait(f.engine, downstream.id, 'waiting_approval'), approvedAt, 30000);
  } finally {
    await f.close();
  }
});

test('0015-Q01 pause time does not count, a resume restarts the wait and its retry does not', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const hold = await create(f.engine, 'hold');
    await wait(f.engine, hold.id, 'running');
    const task = await create(f.engine, 'queued', { contextPlan: plan(2000) });
    assert.equal(task.status, 'queued');
    await control(f.engine, task.sessionId!, { action: 'pause', mode: 'interrupt' }, 'pause');
    assert.equal((await get(f.engine, task.id)).status, 'paused');
    f.time.advance(1500);
    const resumedAt = f.time.clock.wallNow();
    const resume = await control(f.engine, task.sessionId!, { action: 'resume' }, 'resume');
    const resumed = await get(f.engine, task.id);
    assert.equal(resumed.status, 'queued');
    restarted(resumed, resumedAt, 2000);
    // Q02.3: 2.5 s after admission but 1 s after the resume, the earlier timer must not expire it.
    f.time.advance(1000);
    await poke(f.engine);
    assert.equal((await get(f.engine, task.id)).status, 'queued');
    await f.engine.call('sessions.control', resume);
    assert.equal((await get(f.engine, task.id)).routing!.deadlineAt, resumed.routing!.deadlineAt);
    f.time.advance(1500);
    await poke(f.engine);
    assert.equal((await wait(f.engine, task.id, 'blocked')).reason, 'SCHEDULING_BLOCKED');
  } finally {
    await f.close();
  }
});

test('0015-Q02 a released task without a wait dispatches in the releasing pass or expires', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const first = await create(f.engine, 'first upstream');
    await wait(f.engine, first.id, 'waiting_approval');
    const ready = await create(f.engine, 'ready downstream', {
      dependencyTaskIds: [first.id],
      contextPlan: plan(0),
    });
    f.time.advance(60000);
    await approve(f.engine, first.id);
    await wait(f.engine, ready.id, 'waiting_approval');
    const second = await create(f.engine, 'second upstream');
    await wait(f.engine, second.id, 'waiting_approval');
    const busy = await create(f.engine, 'busy downstream', {
      dependencyTaskIds: [second.id],
      contextPlan: plan(0),
    });
    const hold = await create(f.engine, 'hold');
    await wait(f.engine, hold.id, 'running');
    await approve(f.engine, second.id);
    assert.equal((await wait(f.engine, busy.id, 'blocked')).reason, 'SCHEDULING_BLOCKED');
  } finally {
    await f.close();
  }
});

test('0015-Q03 waits up to seven days are accepted and enforced', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    await assert.rejects(create(f.engine, 'too long', { contextPlan: plan(604_800_001) }), {
      code: 'VALIDATION_ERROR',
    });
    const hold = await create(f.engine, 'hold');
    await wait(f.engine, hold.id, 'running');
    const week = await create(f.engine, 'week', { contextPlan: plan(604_800_000) });
    assert.equal(week.routing?.maxQueueWaitMs, 604_800_000);
    f.time.advance(6 * 86_400_000);
    await poke(f.engine);
    assert.equal((await get(f.engine, week.id)).status, 'queued');
    f.time.advance(86_400_000);
    await poke(f.engine);
    assert.equal((await wait(f.engine, week.id, 'blocked')).reason, 'SCHEDULING_BLOCKED');
  } finally {
    await f.close();
  }
});

test('0015-Q04 the host default covers tasks and children without a wait and is fixed at admission', async () => {
  const f = await setup({ limits: { defaultMaxQueueWaitMs: 600_000 }, tools: { enabled: true } });
  try {
    const plain = await create(f.engine, 'plain');
    const planned = await create(f.engine, 'planned', { contextPlan: plan() });
    const explicit = await create(f.engine, 'explicit', { contextPlan: plan(1000) });
    assert.deepEqual(
      [plain, planned, explicit].map((task) => task.routing?.maxQueueWaitMs),
      [600_000, 600_000, 1000],
    );
    const parent = await create(f.engine, 'delegate one child');
    await wait(f.engine, parent.id, 'waiting_approval');
    const { tasks: children } = (await f.engine.call('tasks.list', {
      parentTaskId: parent.id,
    })) as { tasks: TaskSnapshot[] };
    assert.deepEqual(
      children.map((child) => child.routing?.maxQueueWaitMs),
      [600_000],
    );
    await f.restart({ limits: { defaultMaxQueueWaitMs: 5000 } });
    assert.equal((await get(f.engine, plain.id)).routing?.maxQueueWaitMs, 600_000);
    assert.equal((await create(f.engine, 'after restart')).routing?.maxQueueWaitMs, 5000);
  } finally {
    await f.close();
  }
});

test('0015-Q04 invalid host defaults fail engine creation and the JSON CLI', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-queue-default-')));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'), { mode: 0o700 });
    for (const [i, value] of [-1, 604_800_001, 1.5, '1000'].entries())
      await assert.rejects(
        createEngine({
          workspace: join(root, 'workspace'),
          stateDir: join(root, `engine-${i}`),
          adapters: [createFakeAdapter()],
          limits: { defaultMaxQueueWaitMs: value as number },
        }),
        { code: 'VALIDATION_ERROR' },
        String(value),
      );
    const write = async (value: unknown) => {
      const path = join(root, `config-${crypto.randomUUID()}.json`);
      await writeFile(
        path,
        JSON.stringify({
          configVersion: 1,
          workspace: join(root, 'workspace'),
          stateDir: join(root, 'state'),
          providers: { fake: { model: 'fixture' } },
          limits: { defaultMaxQueueWaitMs: value },
        }),
      );
      return path;
    };
    for (const value of [0, 604_800_000])
      assert.equal((await loadConfig(await write(value))).limits?.defaultMaxQueueWaitMs, value);
    for (const value of [-1, 604_800_001, 1.5, '1000'])
      await assert.rejects(
        loadConfig(await write(value)),
        { code: 'INVALID_CONFIG' },
        String(value),
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('0015-Q05 host downtime never counts: closing pauses queued tasks and a resume restarts the wait', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const hold = await create(f.engine, 'hold');
    await wait(f.engine, hold.id, 'running');
    const task = await create(f.engine, 'queued', { contextPlan: plan(60_000) });
    await f.restart();
    const paused = await get(f.engine, task.id);
    assert.deepEqual([paused.status, paused.reason], ['paused', 'owner_shutdown']);
    // The host stayed closed for an hour.
    f.time.advance(3_600_000);
    const resumedAt = f.time.clock.wallNow();
    await f.engine.call('tasks.resume', { taskId: task.id, idempotencyKey: 'resume' });
    restarted(await wait(f.engine, task.id, 'waiting_approval'), resumedAt, 60_000);
  } finally {
    await f.close();
  }
});

test('0015-Q05 computer sleep counts: a queued wait follows the wall clock', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const hold = await create(f.engine, 'hold');
    await wait(f.engine, hold.id, 'running');
    const task = await create(f.engine, 'queued', { contextPlan: plan(60_000) });
    f.time.sleep(59_000);
    await poke(f.engine);
    assert.equal((await get(f.engine, task.id)).status, 'queued');
    f.time.sleep(2_000);
    await poke(f.engine);
    assert.equal((await wait(f.engine, task.id, 'blocked')).reason, 'SCHEDULING_BLOCKED');
  } finally {
    await f.close();
  }
});
