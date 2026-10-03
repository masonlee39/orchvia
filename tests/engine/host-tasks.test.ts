import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineClock,
  EngineConfig,
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0065: tasks that the host completes.

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

/** Engine time that fires timers only when a test advances it. */
class ManualClock implements EngineClock {
  wall = Date.now();
  mono = 0;
  timers = new Set<{ at: number; fn: () => void }>();
  wallNow = () => this.wall;
  monotonicNow = () => this.mono;
  setTimer = (fn: () => void, delay: number) => {
    const item = { at: this.mono + delay, fn };
    this.timers.add(item);
    return () => {
      this.timers.delete(item);
    };
  };
  advance(ms: number, fire = true) {
    this.mono += ms;
    this.wall += ms;
    if (!fire) return;
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at))
      if (this.timers.has(timer) && timer.at <= this.mono) {
        this.timers.delete(timer);
        timer.fn();
      }
  }
}

/** A fake runtime that records its prompts and can hold its turns open. */
function recording(prompts: string[], hold?: Promise<void>): RuntimeAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    async *execute(input: RuntimeInput) {
      prompts.push(input.prompt);
      for await (const event of base.execute(input)) {
        if (event.type !== 'accepted') await hold;
        yield event;
      }
    },
  };
}
async function setup(overrides: Partial<EngineConfig> = {}, prompts: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-host-tasks-')));
  await mkdir(join(root, 'workspace'));
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [recording(prompts)],
    providers: { fake: { models: ['small'] } },
    ...overrides,
  };
  const f = {
    root,
    config,
    engine: await createEngine(config),
    prompts,
    db: () => (f.engine as unknown as { store: { db: Db } }).store.db,
    async restart() {
      await f.engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      f.engine = await createEngine({ ...config, adapters: [recording(prompts)] });
    },
    async close() {
      await f.engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}
const key = () => crypto.randomUUID();
async function host(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: { goal, executor: 'host', ...extra },
    idempotencyKey: key(),
  })) as TaskSnapshot;
}
async function agent(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'small' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      ...extra,
    },
    idempotencyKey: key(),
  })) as TaskSnapshot;
}
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
const complete = (engine: Engine, taskId: string, extra: Record<string, unknown> = {}) =>
  engine.call('tasks.complete', {
    taskId,
    outcome: 'completed',
    idempotencyKey: key(),
    ...extra,
  }) as Promise<OperationSnapshot>;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await get(engine, id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected, String(error));
  return true;
};
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as { n: number }[])[0].n;

test('0065-H01 H02 a host task has no session and no dispatch and holds no capacity', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const f = await setup({ adapters: [recording([], hold)], limits: { maxActiveSessions: 1 } });
  try {
    const running = await agent(f.engine, 'holds the only slot');
    await wait(f.engine, running.id, 'running');
    const sessions = count(f.db(), 'sessions'),
      dispatches = count(f.db(), 'dispatches');
    const task = await host(f.engine, 'wait for a person', { label: 'step:1' });
    assert.equal(task.status, 'waiting_host');
    assert.equal(task.sessionId, null);
    assert.equal(task.spec.executor, 'host');
    assert.equal(task.spec.runtime, undefined);
    assert.equal(count(f.db(), 'sessions'), sessions);
    assert.equal(count(f.db(), 'dispatches'), dispatches);
    const listed = (await f.engine.call('tasks.list', { status: ['waiting_host'] })) as {
      tasks: TaskSnapshot[];
    };
    assert.deepEqual(
      listed.tasks.map((item) => item.id),
      [task.id],
    );
    const scheduler = (await f.engine.call('scheduler.get')) as { executionOccupied: number };
    assert.equal(scheduler.executionOccupied, 1, 'only the running task holds a lease');
    const created = (
      (await f.engine.call('events.read', { taskId: task.id })) as {
        events: { type: string; sessionId: string | null; data: Record<string, unknown> }[];
      }
    ).events.find((event) => event.type === 'task.created')!;
    assert.equal(created.sessionId, null);
    assert.equal(created.data.executor, 'host');
    assert.equal(created.data.status, 'waiting_host');
    // Completing it needs no capacity either.
    assert.equal((await complete(f.engine, task.id, { result: 'done' })).status, 'completed');
    assert.equal((await get(f.engine, task.id)).status, 'completed');
  } finally {
    release();
    await f.close();
  }
});

test('0065-H01 a host task refuses runtime fields, and other tasks still need a runtime', async () => {
  const f = await setup();
  try {
    const create = (spec: Record<string, unknown>) =>
      f.engine.call('tasks.create', { spec, idempotencyKey: key() });
    const base = { goal: 'g', executor: 'host' };
    for (const extra of [
      { runtime: { provider: 'fake', model: 'small' } },
      { acceptance: { mode: 'human', criteria: ['Review'] } },
      { writeScope: 'docs' },
      { contextPlan: { requestedMode: 'fresh', independent: true, fallbackModes: [] } },
      { contextEstimate: { inputTokens: 1, outputReserveTokens: 1, toolReserveTokens: 1 } },
    ])
      await assert.rejects(create({ ...base, ...extra }), code('VALIDATION_ERROR'));
    await assert.rejects(create({ goal: 'g', executor: 'engine' }), code('VALIDATION_ERROR'));
    await assert.rejects(create({ goal: 'g' }), code('VALIDATION_ERROR'));
    await assert.rejects(
      create({
        goal: 'g',
        runtime: { provider: 'fake', model: 'small' },
        acceptance: { mode: 'human', criteria: ['Review'] },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      code('VALIDATION_ERROR'),
    );
    assert.equal((await agent(f.engine, 'unchanged')).sessionId!.length > 0, true);
  } finally {
    await f.close();
  }
});

test('0065-H03 H05 a host task waits for its dependencies and releases what depends on it', async () => {
  const f = await setup();
  try {
    const first = await agent(f.engine, 'first');
    const gate = await host(f.engine, 'approve the plan', { dependencyTaskIds: [first.id] });
    assert.equal(gate.status, 'waiting_dependency');
    await assert.rejects(complete(f.engine, gate.id), code('TASK_NOT_READY'));
    const after = await agent(f.engine, 'after the gate', { dependencyTaskIds: [gate.id] });
    assert.equal(after.status, 'waiting_dependency');
    const review = await wait(f.engine, first.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', {
      approvalId: review.approvalId,
    })) as { revision: number };
    await f.engine.call('approvals.decide', {
      approvalId: review.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: key(),
    });
    await wait(f.engine, gate.id, 'waiting_host');
    assert.equal((await get(f.engine, after.id)).status, 'waiting_dependency');
    const op = await complete(f.engine, gate.id, { result: 'APPROVED-BY-ALEX' });
    assert.deepEqual(op.result, { taskId: gate.id, status: 'completed' });
    const done = await get(f.engine, gate.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.reason, null);
    assert.equal(done.result, 'APPROVED-BY-ALEX');
    assert.equal(done.artifactRefs.length, 1);
    assert.equal(typeof done.deliveredAt, 'string');
    // Invariant 5: released and dispatched without another call.
    await wait(f.engine, after.id, 'waiting_approval');
    assert.ok(
      f.prompts.some((prompt) => prompt.includes('APPROVED-BY-ALEX')),
      'the host result is in the prompt of what depended on it',
    );
    const check = (await f.engine.call('context.checkRefs', {
      contextRefs: [{ artifactRef: done.artifactRefs[0], version: 1 }],
    })) as { contextRefs: { admissible: boolean }[] };
    assert.equal(check.contextRefs[0].admissible, true);
  } finally {
    await f.close();
  }
});

test('0065-H03 a host task whose dependency failed is blocked', async () => {
  const f = await setup();
  try {
    const first = await host(f.engine, 'first');
    const second = await host(f.engine, 'second', { dependencyTaskIds: [first.id] });
    await f.engine.call('tasks.cancel', { taskId: first.id, idempotencyKey: key() });
    const blocked = await wait(f.engine, second.id, 'blocked');
    assert.equal(blocked.reason, 'dependency_failed');
    await assert.rejects(complete(f.engine, second.id), code('TASK_NOT_READY'));
  } finally {
    await f.close();
  }
});

test('0065-H04 H06 a host reports a failure, and a second result never replaces the first', async () => {
  const f = await setup();
  try {
    const task = await host(f.engine, 'wait for the ticket');
    const after = await agent(f.engine, 'after', { dependencyTaskIds: [task.id] });
    const idempotencyKey = key();
    const params = { taskId: task.id, outcome: 'failed', result: 'ticket rejected' };
    const op = (await f.engine.call('tasks.complete', {
      ...params,
      idempotencyKey,
    })) as OperationSnapshot;
    assert.deepEqual(op.result, { taskId: task.id, status: 'failed' });
    const failed = await get(f.engine, task.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'host_reported_failure');
    assert.equal(failed.result, 'ticket rejected');
    assert.equal((await wait(f.engine, after.id, 'blocked')).reason, 'dependency_failed');
    const again = (await f.engine.call('tasks.complete', {
      ...params,
      idempotencyKey,
    })) as OperationSnapshot;
    assert.equal(again.id, op.id, 'the same key returns the first operation');
    await assert.rejects(
      f.engine.call('tasks.complete', { ...params, result: 'other', idempotencyKey }),
      code('IDEMPOTENCY_CONFLICT'),
    );
    await assert.rejects(complete(f.engine, task.id, { result: 'late' }), code('STALE_TARGET'));
    assert.equal((await get(f.engine, task.id)).result, 'ticket rejected');
    assert.equal((await get(f.engine, task.id)).revision, failed.revision);
  } finally {
    await f.close();
  }
});

test('0065-H04 H06 tasks.complete validates its task and its parameters', async () => {
  const f = await setup();
  try {
    const task = await host(f.engine, 'wait');
    const ordinary = await agent(f.engine, 'ordinary');
    await assert.rejects(complete(f.engine, ordinary.id), code('VALIDATION_ERROR'));
    await assert.rejects(complete(f.engine, 'missing'), code('NOT_FOUND'));
    await assert.rejects(
      complete(f.engine, task.id, { outcome: 'cancelled' }),
      code('VALIDATION_ERROR'),
    );
    await assert.rejects(complete(f.engine, task.id, { reason: 'x' }), code('VALIDATION_ERROR'));
    await assert.rejects(
      complete(f.engine, task.id, { result: 'é'.repeat(131073) }),
      code('VALIDATION_ERROR'),
    );
    assert.equal((await get(f.engine, task.id)).status, 'waiting_host');
    // Without a result the task completes with none.
    await complete(f.engine, task.id);
    const done = await get(f.engine, task.id);
    assert.equal(done.result, null);
    assert.deepEqual(done.artifactRefs, []);
  } finally {
    await f.close();
  }
});

test('0065-H07 cancel ends a host task; resume and messages are refused', async () => {
  const f = await setup();
  try {
    const task = await host(f.engine, 'wait');
    await assert.rejects(
      f.engine.call('tasks.resume', { taskId: task.id, idempotencyKey: key() }),
      code('UNSUPPORTED_CAPABILITY'),
    );
    const other = await agent(f.engine, 'has a session');
    await assert.rejects(
      f.engine.call('messages.send', {
        spec: {
          taskId: task.id,
          toSessionId: other.sessionId,
          expectedGeneration: 1,
          kind: 'finding',
          summary: 's',
        },
        idempotencyKey: key(),
      }),
      code('UNSUPPORTED_CAPABILITY'),
    );
    const sessions = count(f.db(), 'sessions');
    const op = (await f.engine.call('tasks.cancel', {
      taskId: task.id,
      idempotencyKey: key(),
    })) as OperationSnapshot;
    assert.equal(op.status, 'completed');
    const cancelled = await get(f.engine, task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.reason, 'cancelled_by_client');
    assert.equal(count(f.db(), 'sessions'), sessions);
    await assert.rejects(complete(f.engine, task.id), code('STALE_TARGET'));
    const waiting = await host(f.engine, 'waits for a dependency', {
      dependencyTaskIds: [(await host(f.engine, 'open')).id],
    });
    await f.engine.call('tasks.cancel', { taskId: waiting.id, idempotencyKey: key() });
    assert.equal((await get(f.engine, waiting.id)).status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('0065-H08 a host task is the root of the tasks created under it', async () => {
  const f = await setup({
    pricing: [
      {
        provider: 'fake',
        model: 'small',
        currency: 'USD',
        version: 'fixture',
        inputTokenMode: 'uncached' as const,
        perMillion: { input: '10', output: '10' },
      },
    ],
  });
  try {
    const budget = { currency: 'USD', maxCost: '5', reservePerDispatch: '1' };
    const run = await host(f.engine, 'one run', { budget });
    const step = await agent(f.engine, 'step one', { parentTaskId: run.id });
    assert.equal(step.rootTaskId, run.id);
    assert.deepEqual(step.spec.budget, budget);
    await wait(f.engine, step.id, 'waiting_approval');
    const summary = (await f.engine.call('usage.summary', { rootTaskId: run.id })) as {
      rootTaskId: string;
    };
    assert.equal(summary.rootTaskId, run.id);
    const costs = (await f.engine.call('costs.get', { taskId: run.id, scope: 'tree' })) as {
      records: { costOwnerTaskId: string }[];
    };
    assert.ok(costs.records.every((record) => record.costOwnerTaskId === step.id));
    const listed = (await f.engine.call('tasks.list', { parentTaskId: run.id })) as {
      tasks: TaskSnapshot[];
    };
    assert.deepEqual(
      listed.tasks.map((task) => task.id),
      [step.id],
    );
    await complete(f.engine, run.id, { result: 'run finished' });
    assert.equal(
      (await get(f.engine, step.id)).status,
      'waiting_approval',
      'children are not changed',
    );
  } finally {
    await f.close();
  }
});

test('0065-H09 maxHostTasks bounds the host tasks that wait for the host', async () => {
  const f = await setup({ limits: { maxHostTasks: 2 } });
  try {
    const first = await host(f.engine, 'one');
    await host(f.engine, 'two');
    await assert.rejects(host(f.engine, 'three'), code('QUEUE_CAPACITY_EXHAUSTED'));
    await complete(f.engine, first.id);
    assert.equal((await host(f.engine, 'three')).status, 'waiting_host');
    await assert.rejects(setup({ limits: { maxHostTasks: 0 } }), code('VALIDATION_ERROR'));
  } finally {
    await f.close();
  }
});

test('0065-H10 initialize announces hostTasks', async () => {
  const f = await setup();
  try {
    const info = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(info.capabilities.workflow.hostTasks, true);
  } finally {
    await f.close();
  }
});

test('0065-E01 expiresAt must be a later time within 365 days', async () => {
  const clock = new ManualClock();
  const f = await setup({ clock });
  try {
    const at = (ms: number) => new Date(clock.wall + ms).toISOString();
    for (const expiresAt of [at(0), at(-1000), at(366 * 86400000), 'tomorrow', 5])
      await assert.rejects(host(f.engine, 'g', { expiresAt }), code('VALIDATION_ERROR'));
    const idempotencyKey = key();
    const spec = { goal: 'g', executor: 'host', expiresAt: at(1000).replace('Z', '+00:00') };
    const task = (await f.engine.call('tasks.create', { spec, idempotencyKey })) as TaskSnapshot;
    assert.equal(task.spec.expiresAt, at(1000));
    clock.advance(5000);
    const again = (await f.engine.call('tasks.create', {
      spec,
      idempotencyKey,
    })) as TaskSnapshot;
    assert.equal(again.id, task.id, 'a repeated create returns the first task after the time');
  } finally {
    await f.close();
  }
});

test('0065-E02 E03 a host task expires on an idle host and blocks what depends on it', async () => {
  const clock = new ManualClock();
  const f = await setup({ clock });
  try {
    const at = (ms: number) => new Date(clock.wall + ms).toISOString();
    const soon = await host(f.engine, 'soon', { expiresAt: at(60000) });
    const later = await host(f.engine, 'later', { expiresAt: at(120000) });
    const waiting = await host(f.engine, 'waits for soon', {
      dependencyTaskIds: [soon.id],
      expiresAt: at(90000),
    });
    const after = await agent(f.engine, 'after', { dependencyTaskIds: [soon.id] });
    clock.advance(59999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await get(f.engine, soon.id)).status, 'waiting_host', 'not before its time');
    clock.advance(1);
    const expired = await wait(f.engine, soon.id, 'failed');
    assert.equal(expired.reason, 'host_task_expired');
    assert.equal((await wait(f.engine, after.id, 'blocked')).reason, 'dependency_failed');
    assert.equal((await wait(f.engine, waiting.id, 'blocked')).reason, 'dependency_failed');
    // A blocked host task still expires, and the timer moves to the next time.
    clock.advance(30000);
    assert.equal((await wait(f.engine, waiting.id, 'failed')).reason, 'host_task_expired');
    assert.equal((await get(f.engine, later.id)).status, 'waiting_host');
    clock.advance(30000);
    assert.equal((await wait(f.engine, later.id, 'failed')).reason, 'host_task_expired');
    const events = (
      (await f.engine.call('events.read', { taskId: soon.id })) as {
        events: { type: string; data: Record<string, unknown> }[];
      }
    ).events.filter((event) => event.type === 'task.failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, 'host_task_expired');
    assert.equal(events[0].data.executor, 'host');
  } finally {
    await f.close();
  }
});

test('0065-E02 a completion at or after the time loses although the timer has not fired', async () => {
  const clock = new ManualClock();
  const f = await setup({ clock });
  try {
    const task = await host(f.engine, 'g', {
      expiresAt: new Date(clock.wall + 60000).toISOString(),
    });
    clock.advance(60000, false);
    await assert.rejects(complete(f.engine, task.id, { result: 'late' }), code('TASK_EXPIRED'));
    const expired = await get(f.engine, task.id);
    assert.equal(expired.status, 'failed');
    assert.equal(expired.reason, 'host_task_expired');
    assert.equal(expired.result, null);
    // The time passes while the result's file is written: the transaction's time decides.
    const during = await host(f.engine, 'g', {
      expiresAt: new Date(clock.wall + 60000).toISOString(),
    });
    const store = (f.engine as unknown as { store: { writePause?: () => Promise<void> } }).store;
    store.writePause = async () => clock.advance(60000, false);
    await assert.rejects(complete(f.engine, during.id, { result: 'slow' }), code('TASK_EXPIRED'));
    store.writePause = undefined;
    assert.equal((await get(f.engine, during.id)).reason, 'host_task_expired');
    assert.deepEqual((await get(f.engine, during.id)).artifactRefs, []);
    const early = await host(f.engine, 'g', {
      expiresAt: new Date(clock.wall + 60000).toISOString(),
    });
    clock.advance(59999, false);
    assert.equal((await complete(f.engine, early.id)).status, 'completed');
    clock.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await get(f.engine, early.id)).status, 'completed', 'a completed task stays');
  } finally {
    await f.close();
  }
});

test('0065-E02 R01 a restart keeps host tasks, expires what came due and marks the store', async () => {
  const clock = new ManualClock();
  const f = await setup({ clock });
  try {
    const meta = () =>
      (
        f.db().prepare("SELECT value FROM metadata WHERE key='storeFeatures'").all() as {
          value: string;
        }[]
      )[0]?.value;
    await agent(f.engine, 'no host task yet');
    assert.equal(meta(), undefined, 'a store without host tasks has no feature');
    const due = await host(f.engine, 'due while down', {
      expiresAt: new Date(clock.wall + 60000).toISOString(),
    });
    const open = await host(f.engine, 'open', { label: 'kept' });
    assert.deepEqual(
      (JSON.parse(meta()!) as { name: string }[]).map((feature) => feature.name),
      ['hostTasks'],
    );
    clock.advance(60000, false);
    await f.restart();
    // Invariant 6: a read after the restart applies what came due, without a mutation.
    assert.equal((await get(f.engine, due.id)).reason, 'host_task_expired');
    await assert.rejects(complete(f.engine, due.id), code('TASK_EXPIRED'));
    assert.equal((await get(f.engine, due.id)).reason, 'host_task_expired');
    const kept = await get(f.engine, open.id);
    assert.equal(kept.status, 'waiting_host');
    assert.equal(kept.revision, open.revision);
    await f.engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    const view = await openReadOnlyEngine({ stateDir: f.config.stateDir });
    try {
      const read = (await view.call('tasks.get', { taskId: open.id })) as TaskSnapshot;
      assert.equal(read.status, 'waiting_host');
      assert.equal(read.sessionId, null);
    } finally {
      await view.close();
    }
    f.engine = await createEngine({ ...f.config, clock, adapters: [recording([])] });
    assert.equal((await complete(f.engine, open.id, { result: 'r' })).status, 'completed');
  } finally {
    await f.close();
  }
});

test('0065 invariant 1: no committed state has a queued host task', async () => {
  const f = await setup();
  try {
    const first = await host(f.engine, 'first');
    const second = await host(f.engine, 'second', { dependencyTaskIds: [first.id] });
    await complete(f.engine, first.id);
    await wait(f.engine, second.id, 'waiting_host');
    await complete(f.engine, second.id);
    const statuses = new Set<string>();
    for (const id of [first.id, second.id])
      for (const event of (
        (await f.engine.call('events.read', { taskId: id })) as {
          events: { type: string; data: Record<string, unknown> }[];
        }
      ).events)
        if (event.type.startsWith('task.')) statuses.add(String(event.data.status));
    assert.deepEqual([...statuses].sort(), ['completed', 'waiting_dependency', 'waiting_host']);
    assert.equal(count(f.db(), 'sessions'), 0);
    assert.equal(count(f.db(), 'dispatches'), 0);
  } finally {
    await f.close();
  }
});

test('0065-H12 a host task in the chain is not a level of delegation depth', async () => {
  type Tools = { call(name: string, args: unknown): Promise<unknown> };
  const fake = createFakeAdapter();
  const outcomes = new Map<string, unknown>();
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input: RuntimeInput) {
      const goal = input.prompt.split(/\s/)[0];
      if (goal === 'step' || goal === 'child')
        outcomes.set(
          goal,
          await (input.orchestrationTools as Tools)
            .call('work_delegate', {
              goal: goal === 'step' ? 'child of the step' : 'grandchild',
              contextPlan: { requestedMode: 'fresh', independent: true },
              idempotencyKey: `from-${goal}`,
            })
            .then(
              () => 'delegated',
              (error: { code?: string }) => error.code,
            ),
        );
      yield* fake.execute(input);
    },
  };
  const f = await setup({ adapters: [adapter], tools: { enabled: true, maxDepth: 1 } });
  try {
    const run = await host(f.engine, 'one run');
    const nested = await host(f.engine, 'a stage of the run', { parentTaskId: run.id });
    await agent(f.engine, 'step', { parentTaskId: nested.id });
    for (let i = 0; i < 400 && outcomes.size < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // The step is the first runtime task of its chain, as a root is: it may delegate once.
    assert.equal(outcomes.get('step'), 'delegated');
    // Its child is one level down, and maxDepth 1 still stops it.
    assert.equal(outcomes.get('child'), 'DELEGATION_DEPTH_LIMIT');
  } finally {
    await f.close();
  }
});

test('0065-H08 a host task that ended still takes new children', async () => {
  const f = await setup();
  try {
    for (const end of ['complete', 'cancel', 'fail'] as const) {
      const run = await host(f.engine, `run ${end}`, {
        budget: { currency: 'USD', maxCost: '5', reservePerDispatch: '1' },
      });
      if (end === 'cancel')
        await f.engine.call('tasks.cancel', { taskId: run.id, idempotencyKey: key() });
      else await complete(f.engine, run.id, { outcome: end === 'fail' ? 'failed' : 'completed' });
      const step = await host(f.engine, 'a later step', { parentTaskId: run.id });
      assert.equal(step.status, 'waiting_host', end);
      assert.equal(step.rootTaskId, run.id, end);
      assert.deepEqual(step.spec.budget, run.spec.budget, end);
    }
  } finally {
    await f.close();
  }
});
