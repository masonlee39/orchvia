import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  TaskListResult,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0028 B: why a queued task waits, computed from the scheduler's own predicates.

type BlockedBy = { reason: string; taskIds?: string[]; sessionId?: string };
type Blocked = TaskSnapshot & { blockedBy?: BlockedBy };
type Internals = {
  store: {
    put(table: string, id: string, value: unknown): void;
    remove(table: string, id: string): void;
  };
  kick(): void;
  scheduled: boolean;
  closing: boolean;
  pendingResourceCleanups: Map<string, unknown>;
  stopAfterFailure(step: string, error: unknown): void;
};

/** A fake runtime that holds each turn whose goal contains `hold:<name>` until released. */
function holding() {
  const base = createFakeAdapter();
  const gates = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  const gate = (name: string) => {
    if (!waits.has(name)) waits.set(name, new Promise<void>((resolve) => gates.set(name, resolve)));
    return waits.get(name)!;
  };
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      const name = /hold:(\w+)/.exec(input.prompt)?.[1];
      for await (const event of base.execute(input)) {
        if (event.type !== 'accepted' && name) await gate(name);
        yield event;
      }
    },
  };
  return {
    adapter,
    release(name: string) {
      gate(name);
      gates.get(name)!();
    },
    releaseAll() {
      for (const resolve of gates.values()) resolve();
    },
  };
}
async function setup(overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-queue-reasons-')));
  await mkdir(join(root, 'workspace'));
  const runtime = holding();
  const stateDir = join(root, 'state');
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [runtime.adapter],
    ...overrides,
  });
  return {
    engine,
    stateDir,
    runtime,
    internals: engine as unknown as Internals,
    async close() {
      runtime.releaseAll();
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});
async function create(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: spec(goal, extra),
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
}
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as Blocked;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await get(engine, id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
/** Runs a scheduler pass and lets it finish. */
async function pass(internals: Internals) {
  internals.kick();
  await new Promise((resolve) => setTimeout(resolve, 30));
}
/** The task is still queued after a pass, for the reason given, in every read (B02). */
async function held(f: Awaited<ReturnType<typeof setup>>, id: string, expected: BlockedBy) {
  await pass(f.internals);
  const task = await get(f.engine, id);
  assert.equal(task.status, 'queued', `${expected.reason}: the scheduler dispatched the task`);
  assert.deepEqual(task.blockedBy, expected);
  const listed = (await f.engine.call('tasks.list', { status: ['queued'] })) as TaskListResult;
  assert.deepEqual(
    (listed.tasks as Blocked[]).find((item) => item.id === id)?.blockedBy,
    expected,
    'tasks.list',
  );
  const many = (await f.engine.call('tasks.getMany', { taskIds: [id] })) as { tasks: Blocked[] };
  assert.deepEqual(many.tasks[0]?.blockedBy, expected, 'tasks.getMany');
}

test('0028-B01 0028-B02 a task behind held execution slots waits for capacity, then runs', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const first = await create(f.engine, 'hold:first');
    await wait(f.engine, first.id, 'running');
    const second = await create(f.engine, 'second');
    await held(f, second.id, { reason: 'capacity', taskIds: [first.id] });
    f.runtime.release('first');
    const done = (await wait(f.engine, second.id, 'waiting_approval')) as Blocked;
    assert.equal(done.blockedBy, undefined, 'a task that no longer waits has no blockedBy');
    const running = (await wait(f.engine, first.id, 'waiting_approval')) as Blocked;
    assert.equal(running.blockedBy, undefined);
  } finally {
    await f.close();
  }
});

test('0028-B01 0028-B02 a task that reuses a session waits for the session, then runs', async () => {
  const f = await setup();
  try {
    const parent = await create(f.engine, 'parent');
    const waiting = await wait(f.engine, parent.id, 'waiting_approval');
    const child = await create(f.engine, 'child', {
      parentTaskId: parent.id,
      contextPlan: {
        requestedMode: 'reuse',
        independent: true,
        candidateSessionId: waiting.sessionId,
      },
    });
    await held(f, child.id, {
      reason: 'session_busy',
      sessionId: waiting.sessionId!,
      taskIds: [parent.id],
    });
    const approval = (await f.engine.call('approvals.get', {
      approvalId: waiting.approvalId,
    })) as { revision: number };
    await f.engine.call('approvals.decide', {
      approvalId: waiting.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve',
    });
    await wait(f.engine, child.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('0028-B01 0028-B02 a task whose write paths overlap a held lease waits for it, then runs', async () => {
  const f = await setup({
    providers: { fake: { model: 'fixture', permissionProfile: 'workspace-write' } },
    writeScopes: { main: ['.'] },
  });
  try {
    const writer = await create(f.engine, 'hold:writer', { writeScope: 'main' });
    await wait(f.engine, writer.id, 'running');
    const other = await create(f.engine, 'other writer', { writeScope: 'main' });
    await held(f, other.id, { reason: 'write_conflict', taskIds: [writer.id] });
    f.runtime.release('writer');
    await wait(f.engine, other.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('0028-B01 0028-B02 a task waits while storage is backpressured, then runs', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const first = await create(f.engine, 'hold:first');
    await wait(f.engine, first.id, 'running');
    const second = await create(f.engine, 'second');
    const configure = (policy: Record<string, unknown>) =>
      f.engine.call(
        'storage.configure',
        { policy, idempotencyKey: crypto.randomUUID() },
        { owner: true },
      );
    await configure({ quotaBytes: 1 });
    // The first reason that holds wins: the held slot comes before storage.
    await held(f, second.id, { reason: 'capacity', taskIds: [first.id] });
    f.runtime.release('first');
    await wait(f.engine, first.id, 'waiting_approval');
    await held(f, second.id, { reason: 'storage' });
    await configure({ quotaBytes: 10 * 1024 ** 3 });
    await wait(f.engine, second.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('0028-B01 0028-B02 quarantine capacity, pending cleanup and open conflicts hold a queued task, in that order', async () => {
  const f = await setup({ limits: { maxActiveSessions: 2, maxQuarantinedDispatches: 2 } });
  try {
    // Without a scheduler pass the task waits only for the next one.
    f.internals.scheduled = true;
    const task = await create(f.engine, 'waiting');
    assert.deepEqual((await get(f.engine, task.id)).blockedBy, { reason: 'scheduling' });
    f.internals.scheduled = false;
    const at = new Date().toISOString();
    const quarantined = (id: string) => ({
      id,
      taskId: 'another-task',
      sessionId: 'another-session',
      generation: 1,
      status: 'outcome_unknown',
      executionLease: { status: 'released', acquiredAt: at, releasedAt: at },
      quarantined: true,
      quarantinedAt: at,
      lastEvidence: 'test',
    });
    f.internals.store.put('dispatches', 'q1', quarantined('q1'));
    f.internals.store.put('dispatches', 'q2', quarantined('q2'));
    f.internals.store.put('execution_conflicts', 'c1', {
      id: 'c1',
      status: 'open',
      revision: 1,
      dispatchId: 'q1',
    });
    f.internals.pendingResourceCleanups.set('cleanup', {});
    await held(f, task.id, { reason: 'quarantine_capacity' });
    f.internals.store.remove('dispatches', 'q2');
    await held(f, task.id, { reason: 'resource_cleanup' });
    f.internals.pendingResourceCleanups.delete('cleanup');
    await held(f, task.id, { reason: 'execution_conflict' });
    f.internals.store.remove('execution_conflicts', 'c1');
    f.internals.store.remove('dispatches', 'q1');
    await pass(f.internals);
    await wait(f.engine, task.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('0028-B01 a closing host and a failed scheduler come before every other reason', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const first = await create(f.engine, 'hold:first');
    await wait(f.engine, first.id, 'running');
    const second = await create(f.engine, 'second');
    f.internals.closing = true;
    await held(f, second.id, { reason: 'host_stopping' });
    f.internals.closing = false;
    f.internals.stopAfterFailure('test step', new Error('boom'));
    await held(f, second.id, { reason: 'scheduler_failed' });
  } finally {
    await f.close();
  }
});

test('0028-B01 a task that waits for its dependencies names the unfinished ones', async () => {
  const f = await setup();
  try {
    const done = await create(f.engine, 'done');
    const pending = await wait(f.engine, done.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', {
      approvalId: pending.approvalId,
    })) as { revision: number };
    await f.engine.call('approvals.decide', {
      approvalId: pending.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve',
    });
    await wait(f.engine, done.id, 'completed');
    const open = await create(f.engine, 'open');
    await wait(f.engine, open.id, 'waiting_approval');
    const dependent = await create(f.engine, 'dependent', {
      dependencyTaskIds: [done.id, open.id],
    });
    const read = await wait(f.engine, dependent.id, 'waiting_dependency');
    assert.deepEqual((read as Blocked).blockedBy, { reason: 'dependency', taskIds: [open.id] });
  } finally {
    await f.close();
  }
});

test('0028-B03 other tasks and a read-only view carry no blockedBy', async () => {
  const f = await setup({ limits: { maxActiveSessions: 1 } });
  try {
    const first = await create(f.engine, 'hold:first');
    await wait(f.engine, first.id, 'running');
    const second = await create(f.engine, 'second');
    assert.equal((await get(f.engine, second.id)).blockedBy?.reason, 'capacity');
    assert.equal((await get(f.engine, first.id)).blockedBy, undefined, 'a running task');
    const reader = await openReadOnlyEngine({ stateDir: f.stateDir });
    try {
      const offline = (await reader.call('tasks.get', { taskId: second.id })) as Blocked;
      assert.equal(offline.status, 'queued');
      assert.equal('blockedBy' in offline, false);
      const listed = (await reader.call('tasks.list', {})) as TaskListResult;
      assert.ok(listed.tasks.every((task) => !('blockedBy' in task)));
    } finally {
      await reader.close();
    }
    const hello = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(hello.capabilities.workflow.queueReasons, true);
  } finally {
    await f.close();
  }
});

// SPEC-0055 C01: cancelling a task that does not run frees its session and fails its dependants at
// once; nothing else has to wake the scheduler. The test waits without a scheduler pass of its own.
test('AC-0055-C01 cancelling a task that does not run lets the task queued behind it run', async () => {
  const f = await setup();
  try {
    const parent = await create(f.engine, 'parent');
    const waiting = await wait(f.engine, parent.id, 'waiting_approval');
    const child = await create(f.engine, 'child', {
      parentTaskId: parent.id,
      contextPlan: {
        requestedMode: 'reuse',
        independent: true,
        candidateSessionId: waiting.sessionId,
      },
    });
    await held(f, child.id, {
      reason: 'session_busy',
      sessionId: waiting.sessionId!,
      taskIds: [parent.id],
    });
    await f.engine.call('tasks.cancel', { taskId: parent.id, idempotencyKey: 'cancel-parent' });
    assert.equal((await get(f.engine, parent.id)).status, 'cancelled');
    await wait(f.engine, child.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('AC-0055-C01 cancelling a task that does not run fails its dependants at once', async () => {
  const f = await setup();
  try {
    const upstream = await create(f.engine, 'upstream');
    await wait(f.engine, upstream.id, 'waiting_approval');
    const downstream = await create(f.engine, 'downstream', { dependencyTaskIds: [upstream.id] });
    await wait(f.engine, downstream.id, 'waiting_dependency');
    await f.engine.call('tasks.cancel', { taskId: upstream.id, idempotencyKey: 'cancel-upstream' });
    const blocked = await wait(f.engine, downstream.id, 'blocked');
    assert.equal(blocked.reason, 'dependency_failed');
  } finally {
    await f.close();
  }
});
