import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  TaskSnapshot,
  SessionSnapshot,
} from '../../packages/engine/src/types.ts';
const spec = {
  goal: 'A deterministic task',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human', criteria: ['Review'] },
};
async function setup(overrides: Partial<EngineConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-routing-'));
  await mkdir(join(dir, 'workspace'));
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    ...overrides,
  });
  return {
    engine,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const create = async (engine: Engine, extra = {}, key: string = crypto.randomUUID()) =>
  (await engine.call('tasks.create', {
    spec: { ...spec, ...extra },
    idempotencyKey: key,
  })) as TaskSnapshot;
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task did not become ${status}`);
}
async function complete(engine: Engine, task: TaskSnapshot) {
  const pending = await wait(engine, task.id, 'waiting_approval');
  await engine.call('approvals.decide', {
    approvalId: pending.approvalId,
    decision: { choice: 'approve', expectedRevision: 1 },
    idempotencyKey: crypto.randomUUID(),
  });
}
const plan = (candidateSessionId: string, maxQueueWaitMs = 1000) => ({
  requestedMode: 'reuse',
  independent: true,
  candidateSessionId,
  dependencyTaskIds: [],
  contextRefs: [],
  fallbackModes: [],
  maxQueueWaitMs,
});
const target = (session: SessionSnapshot) => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedState: session.status,
  expectedDispatchId: session.activeDispatchId,
});
test('AC-F03 logical open creates no model call and safely attaches its first task', async () => {
  const f = await setup();
  try {
    const opened = (await f.engine.call('sessions.open', {
      spec: { runtime: spec.runtime },
      idempotencyKey: 'open',
    })) as SessionSnapshot;
    assert.equal(opened.taskId, null);
    assert.equal(opened.providerSessionId, null);
    const task = await create(f.engine, { contextPlan: plan(opened.id) });
    assert.equal(task.sessionId, opened.id);
    await complete(f.engine, task);
    const current = (await f.engine.call('sessions.get', {
      sessionId: opened.id,
    })) as SessionSnapshot;
    assert.equal(current.taskId, task.id);
    assert.ok(current.providerSessionId);
  } finally {
    await f.close();
  }
});
test('AC-F02 serial reuse preserves native identity and old task history', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine);
    await complete(f.engine, first);
    const before = (await f.engine.call('sessions.get', {
      sessionId: first.sessionId,
    })) as SessionSnapshot;
    const second = await create(f.engine, { parentTaskId: first.id, contextPlan: plan(before.id) });
    await complete(f.engine, second);
    const after = (await f.engine.call('sessions.get', {
      sessionId: first.sessionId,
    })) as SessionSnapshot;
    assert.equal(after.providerSessionId, before.providerSessionId);
    assert.equal(after.taskId, second.id);
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: first.id })) as TaskSnapshot).status,
      'completed',
    );
    await assert.rejects(create(f.engine, { contextPlan: plan(before.id) }), {
      code: 'HISTORY_REUSE_FORBIDDEN',
    });
  } finally {
    await f.close();
  }
});
test('AC-F02 busy reuse expiry is durable, retry does not renew it, and no late dispatch occurs', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine);
    await wait(f.engine, first.id, 'waiting_approval');
    const extra = { parentTaskId: first.id, contextPlan: plan(first.sessionId!, 20) };
    const second = await create(f.engine, extra, 'busy');
    const expired = await wait(f.engine, second.id, 'blocked');
    assert.equal(expired.reason, 'SCHEDULING_BLOCKED');
    assert.equal((await create(f.engine, extra, 'busy')).id, second.id);
    await complete(f.engine, first);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: second.id })) as TaskSnapshot).status,
      'blocked',
    );
  } finally {
    await f.close();
  }
});
test('AC-F02 only a declared fresh fallback creates another session', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine);
    await wait(f.engine, first.id, 'waiting_approval');
    const second = await create(f.engine, {
      parentTaskId: first.id,
      contextPlan: { ...plan(first.sessionId!, 0), fallbackModes: ['fresh'] },
    });
    await wait(f.engine, second.id, 'waiting_approval');
    assert.notEqual(
      ((await f.engine.call('tasks.get', { taskId: second.id })) as TaskSnapshot).sessionId,
      first.sessionId,
    );
  } finally {
    await f.close();
  }
});

test('AC-F03 fork binds a completed checkpoint and creates a distinct native session on first use', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine);
    await complete(f.engine, first);
    const done = (await f.engine.call('tasks.get', { taskId: first.id })) as TaskSnapshot;
    const source = (await f.engine.call('sessions.get', {
      sessionId: first.sessionId,
    })) as SessionSnapshot;
    const fork = (await f.engine.call('sessions.fork', {
      target: target(source),
      snapshotRef: done.artifactRefs[0],
      idempotencyKey: 'fork',
    })) as SessionSnapshot;
    assert.notEqual(fork.id, source.id);
    assert.equal(fork.providerSessionId, null);
    assert.equal(fork.forkSource?.nativeCheckpoint, source.nativeCheckpoint);
    const branch = await create(f.engine, { parentTaskId: first.id, contextPlan: plan(fork.id) });
    await complete(f.engine, branch);
    const used = (await f.engine.call('sessions.get', { sessionId: fork.id })) as SessionSnapshot;
    assert.notEqual(used.providerSessionId, source.providerSessionId);
    await assert.rejects(
      f.engine.call('sessions.fork', {
        target: target(source),
        snapshotRef: 'sha256:missing',
        idempotencyKey: 'bad-fork',
      }),
      { code: 'INVALID_SNAPSHOT' },
    );
  } finally {
    await f.close();
  }
});

test('AC-F03 compact observes a native boundary, rotate preserves history, stop differs from cancel', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine);
    await complete(f.engine, first);
    let session = (await f.engine.call('sessions.get', {
      sessionId: first.sessionId,
    })) as SessionSnapshot;
    const originalNative = session.providerSessionId;
    const op = (await f.engine.call('sessions.compact', {
      target: target(session),
      idempotencyKey: 'compact',
    })) as { id: string; result: { taskId: string } };
    await wait(f.engine, op.result.taskId, 'completed');
    assert.equal(
      ((await f.engine.call('operations.get', { operationId: op.id })) as { status: string })
        .status,
      'completed',
    );
    session = (await f.engine.call('sessions.get', { sessionId: session.id })) as SessionSnapshot;
    assert.equal(session.providerSessionId, originalNative);
    await f.engine.call('sessions.rotate', { target: target(session), idempotencyKey: 'rotate' });
    session = (await f.engine.call('sessions.get', { sessionId: session.id })) as SessionSnapshot;
    assert.equal(session.generation, 2);
    assert.equal(session.providerSessionId, null);
    assert.equal(session.generations?.[0].providerSessionId, originalNative);
    await f.engine.call('sessions.control', {
      target: target(session),
      command: { action: 'stop' },
      idempotencyKey: 'stop',
    });
    assert.equal(
      ((await f.engine.call('sessions.get', { sessionId: session.id })) as SessionSnapshot).status,
      'closed',
    );
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: first.id })) as TaskSnapshot).status,
      'completed',
    );
  } finally {
    await f.close();
  }
});
