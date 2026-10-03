import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  createClaudeAdapter,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import {
  connectOrchestrator,
  createOrchestrator,
} from '../../packages/sdk-typescript/src/index.ts';
import type {
  EventPage,
  EngineClock,
  ExecutionEvidence,
  Json,
  OperationSnapshot,
  ReconcileEvidence,
  RuntimeEvent,
  RuntimeInput,
  SchedulerSnapshot,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';
import {
  claudeProcess,
  refuseGroupSignals,
  stubbornClaudeProcess,
} from '../fixtures/claude-process.ts';

const spec = {
  goal: 'offline cleanup recovery',
  runtime: { provider: 'claude', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['review'] },
};
const terminal = { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
const proof: ReconcileEvidence = {
  source: 'owner_attestation',
  summary: 'The fixture owner independently checked local and remote execution.',
  localResources: 'stopped',
  remoteExecution: 'stopped',
  sideEffects: 'unknown',
  outcome: 'unknown',
};
const target = (session: SessionSnapshot) => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedDispatchId: session.activeDispatchId,
  expectedState: session.status,
});
function result(op: OperationSnapshot): Record<string, Json> {
  assert.ok(op.result !== null && typeof op.result === 'object' && !Array.isArray(op.result));
  return op.result as Record<string, Json>;
}
function input(evidence: ExecutionEvidence[]): RuntimeInput {
  return {
    taskId: 'recovery-task',
    sessionId: 'recovery-session',
    dispatchId: 'recovery-dispatch',
    generation: 3,
    providerSessionId: null,
    model: 'fixture',
    workspace: process.cwd(),
    stateDir: '/tmp/unused',
    prompt: 'offline fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportExecutionEvidence: (item) => evidence.push(item),
  };
}
async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const result: RuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 3000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(performance.now() < deadline, 'fixture state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const closeMode of ['pending', 'noop'] as const) {
  test(`AC-R04.3 ${closeMode} close reaps only its owned child with an independent signal`, async (t) => {
    const evidence: ExecutionEvidence[] = [];
    const bystander = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe' });
    t.after(() => stop(bystander));
    let child!: ChildProcessWithoutNullStreams;
    const adapter = createClaudeAdapter({
      cleanupTimeoutMs: 300,
      query: (request) => {
        child = claudeProcess(request);
        t.after(() => stop(child));
        return {
          close: () => (closeMode === 'pending' ? new Promise<void>(() => {}) : undefined),
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: false, value: terminal }),
              return: () => new Promise<IteratorResult<unknown>>(() => {}),
            };
          },
        };
      },
    });
    const events = await collect(adapter.execute(input(evidence)));
    assert.equal(adapter.hasActiveResources('recovery-session'), false);
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      'actual child exit is required',
    );
    assert.equal(events.at(-1)?.type, 'result');
    assert.equal(evidence.at(-1)?.localResources, 'stopped');
    assert.equal(evidence.at(-1)?.remoteExecution, 'stopped');
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
    await adapter.close();
  });
}

test('AC-R04.3 pending close without a terminal only confirms local exit', async (t) => {
  const evidence: ExecutionEvidence[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 300,
    query: (request) => {
      const child = claudeProcess(request);
      t.after(() => stop(child));
      return {
        close: () => new Promise<void>(() => {}),
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'native' };
        },
      };
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(adapter.hasActiveResources('recovery-session'), false);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'unknown');
  await adapter.close();
});

test('AC-R04.3 an uncooperative child keeps cleanup unknown after the bounded fallback', async (t) => {
  // The uncooperative child outlives its cleanup only because the adapter may not signal its group.
  refuseGroupSignals(t);
  const evidence: ExecutionEvidence[] = [];
  let cooperative!: ChildProcessWithoutNullStreams;
  let stubborn!: ChildProcessWithoutNullStreams;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 200,
    query: (request) => {
      cooperative = claudeProcess(request);
      const held = stubbornClaudeProcess(request);
      stubborn = held.child;
      t.after(() => Promise.all([stop(cooperative), stop(stubborn)]));
      return {
        close: () => new Promise<void>(() => {}),
        async *[Symbol.asyncIterator]() {
          await held.ready;
          yield terminal;
        },
      };
    },
  });
  const started = performance.now();
  const events = await collect(adapter.execute(input(evidence)));
  assert.ok(performance.now() - started < 1500, 'cleanup must remain bounded');
  assert.ok(cooperative.exitCode !== null || cooperative.signalCode !== null);
  assert.equal(stubborn.exitCode, null);
  assert.equal(stubborn.signalCode, null);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(adapter.hasActiveResources('recovery-session'), true);
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
  await stop(stubborn);
  assert.equal(adapter.hasActiveResources('recovery-session'), false);
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  await adapter.close();
});

async function unobservedFixture(t: TestContext, clock?: EngineClock) {
  const dir = await mkdtemp(join(tmpdir(), 'cr-'));
  const workspace = join(dir, 'workspace');
  const stateDir = join(dir, 'state');
  await mkdir(workspace);
  const requests: ClaudeQueryRequest[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: (request) => {
      requests.push(request);
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield terminal;
        },
      };
    },
  });
  const engine = await createEngine({
    workspace,
    stateDir,
    clock,
    adapters: [adapter, createFakeAdapter({ result: 'queued work' })],
    limits: { maxActiveSessions: 2 },
  });
  // This fixture never launches an unobserved process. On RED, dispose the test owner even if
  // its intentionally unreconciled in-memory records still block the production close method.
  t.after(async () => {
    adapter.close = async () => {};
    await engine.close({ timeoutMs: 500 });
    await rm(dir, { recursive: true, force: true });
  });
  const read = <T>(method: string, params = {}) => engine.call(method, params) as Promise<T>;
  const task = (taskId: string) => read<TaskSnapshot>('tasks.get', { taskId });
  const session = (sessionId: string) => read<SessionSnapshot>('sessions.get', { sessionId });
  const scheduler = () => read<SchedulerSnapshot>('scheduler.get');
  const events = () => read<EventPage>('events.read', { limit: 256 });
  const first = await read<TaskSnapshot>('tasks.create', { spec, idempotencyKey: 'first' });
  const second = await read<TaskSnapshot>('tasks.create', { spec, idempotencyKey: 'second' });
  await until(
    () => task(first.id),
    (value) => value.status === 'blocked',
  );
  await until(
    () => task(second.id),
    (value) => value.status === 'blocked',
  );
  return {
    dir,
    stateDir,
    engine,
    adapter,
    requests,
    read,
    task,
    session,
    scheduler,
    events,
    first,
    second,
    reconcile: async (id: string, key: string, evidence = proof) =>
      engine.call(
        'sessions.reconcile',
        {
          target: target(await session(id)),
          evidence,
          idempotencyKey: key,
        },
        { owner: true },
      ) as Promise<OperationSnapshot>,
  };
}

test('AC-R04.1 owner reconciliation releases only the attested unknown handle and restores scheduling', async (t) => {
  const f = await unobservedFixture(t);
  assert.equal((await f.scheduler()).executionOccupied, 2);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
  assert.equal(f.adapter.hasActiveResources(f.second.sessionId!), true);
  const queued = await f.read<TaskSnapshot>('tasks.create', {
    spec: { ...spec, runtime: { provider: 'fake', model: 'fixture' } },
    idempotencyKey: 'queued',
  });
  assert.equal((await f.task(queued.id)).status, 'queued');
  const originalTarget = target(await f.session(f.first.sessionId!));
  const op = await f.reconcile(f.first.sessionId!, 'owner-first');
  assert.equal(result(op).executionReleased, true);
  assert.equal(result(op).resolved, false);
  assert.equal(result(op).unobservedResourcesReconciled, true);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), false);
  assert.equal(f.adapter.hasActiveResources(f.second.sessionId!), true);
  await until(
    () => f.task(queued.id),
    (value) => value.status === 'waiting_approval',
  );
  assert.equal((await f.scheduler()).executionOccupied, 1);
  assert.equal((await f.scheduler()).quarantined, 2);
  assert.equal((await f.task(f.first.id)).status, 'blocked');
  assert.throws(() => claudeProcess(f.requests[0]!), /spawn rejected/);
  const retried = await f.engine.call(
    'sessions.reconcile',
    {
      target: originalTarget,
      evidence: proof,
      idempotencyKey: 'owner-first',
    },
    { owner: true },
  );
  assert.deepEqual(retried, op);
  const page = await f.events();
  const auditEvent = page.events.filter((item) => item.type === 'session.resources_reconciled');
  assert.equal(auditEvent.length, 1);
  assert.equal(auditEvent[0]?.operationId, op.id);
  assert.equal(auditEvent[0]?.data.evidenceRef, result(op).evidenceRef);
  const digest = (result(op).evidenceRef as string).replace(/^sha256:/, '');
  const audit = JSON.parse(await readFile(join(f.stateDir, 'artifacts', `${digest}.txt`), 'utf8'));
  assert.equal(audit.actor, 'host_owner');
  assert.deepEqual(audit.target, originalTarget);
  assert.deepEqual(audit.evidence, proof);
  assert.equal(audit.resourceReconciliation, 'owner_attested_unobserved');
  await f.reconcile(f.second.sessionId!, 'owner-second');
  await f.adapter.close();
});

test('AC-R04.1 unauthorized, stale, conflicting and incomplete declarations retain unknown records', async (t) => {
  const f = await unobservedFixture(t);
  const params = {
    target: target(await f.session(f.first.sessionId!)),
    evidence: proof,
    idempotencyKey: 'guarded',
  };
  await assert.rejects(f.engine.call('sessions.reconcile', params), { code: 'UNAUTHORIZED' });
  for (const key of ['expectedGeneration', 'expectedRevision', 'expectedDispatchId'] as const) {
    await assert.rejects(
      f.engine.call(
        'sessions.reconcile',
        {
          ...params,
          target: {
            ...params.target,
            [key]: key === 'expectedDispatchId' ? 'wrong-dispatch' : 999,
          },
        },
        { owner: true },
      ),
      { code: 'STALE_TARGET' },
    );
  }
  await assert.rejects(
    f.reconcile(f.first.sessionId!, 'conflict', {
      ...proof,
      outcome: 'failed',
      sideEffects: 'resolved',
    }),
    { code: 'EVIDENCE_CONFLICT' },
  );
  const unknown = await f.reconcile(f.first.sessionId!, 'still-unknown', {
    ...proof,
    localResources: 'unknown',
  });
  assert.equal(result(unknown).executionReleased, false);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
  assert.equal((await f.scheduler()).executionOccupied, 2);
  assert.equal(
    (await f.events()).events.filter((item) => item.type === 'session.resources_reconciled').length,
    0,
  );
  const localOnly = await f.reconcile(f.first.sessionId!, 'local-only', {
    ...proof,
    remoteExecution: 'unknown',
  });
  assert.equal(result(localOnly).executionReleased, false);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), false);
  assert.equal((await f.scheduler()).executionOccupied, 2);
  const complete = await f.reconcile(f.first.sessionId!, 'complete', {
    ...proof,
    outcome: 'completed',
    sideEffects: 'resolved',
    result: 'done',
  });
  assert.equal(result(complete).resolved, true);
  assert.equal((await f.task(f.first.id)).status, 'paused');
  assert.equal(
    (await f.events()).events.filter((item) => item.type === 'approval.requested').length,
    0,
  );
});

test('AC-R04.2 failed durable reconciliation does not retire the adapter handle or release its lease', async (t) => {
  const f = await unobservedFixture(t);
  const db = new DatabaseSync(join(f.stateDir, 'store.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_owner_reconcile BEFORE INSERT ON operations
    WHEN NEW.method = 'sessions.reconcile' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END`);
  await assert.rejects(f.reconcile(f.first.sessionId!, 'commit-retry'), /fixture commit failure/);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
  assert.equal((await f.scheduler()).executionOccupied, 2);
  assert.equal(
    (await f.events()).events.filter((item) => item.type === 'session.resources_reconciled').length,
    0,
  );
  db.exec('DROP TRIGGER fail_owner_reconcile');
  db.prepare('INSERT INTO execution_conflicts(id, data) VALUES (?, ?)').run(
    'fixture-conflict',
    JSON.stringify({
      id: 'fixture-conflict',
      revision: 1,
      dispatchId: (await f.session(f.first.sessionId!)).activeDispatchId,
      sessionId: f.first.sessionId,
      taskId: f.first.id,
      generation: 1,
      status: 'open',
      releaseEvidenceRef: null,
      conflictingEvidenceRef: 'fixture',
      createdAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(f.reconcile(f.first.sessionId!, 'commit-retry'), {
    code: 'EXECUTION_EVIDENCE_CONFLICT',
  });
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
  db.prepare('DELETE FROM execution_conflicts WHERE id = ?').run('fixture-conflict');
  const op = await f.reconcile(f.first.sessionId!, 'commit-retry');
  assert.equal(result(op).executionReleased, true);
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), false);
  assert.equal(
    (await f.events()).events.filter((item) => item.type === 'session.resources_reconciled').length,
    1,
  );
});

test('AC-R04.2 an expired reconciliation transaction retains the original record and lease', async (t) => {
  let now = 0;
  let advancing = false;
  const f = await unobservedFixture(t, {
    wallNow: () => Date.parse('2026-09-20T00:00:00Z') + now,
    monotonicNow: () => (advancing ? (now += 60001) : now),
    setTimer(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  advancing = true;
  await assert.rejects(f.reconcile(f.first.sessionId!, 'deadline-retry'), { code: 'TIMEOUT' });
  advancing = false;
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
  assert.equal((await f.scheduler()).executionOccupied, 2);
  assert.equal(
    (await f.events()).events.filter((item) => item.type === 'session.resources_reconciled').length,
    0,
  );
  await f.reconcile(f.first.sessionId!, 'deadline-retry');
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), false);
});

test('AC-R04.1 adapters without the narrow reconciliation hook keep their original resource guard', async (t) => {
  const f = await unobservedFixture(t);
  f.adapter.prepareUnobservedCleanup = undefined;
  await assert.rejects(f.reconcile(f.first.sessionId!, 'unsupported'), {
    code: 'RUNTIME_STILL_ACTIVE',
  });
  assert.equal(f.adapter.hasActiveResources(f.first.sessionId!), true);
});

test('AC-R04.2 cleanup preparation fences observers and target identity without reporting exit', async () => {
  const evidence: ExecutionEvidence[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: () => ({
      async *[Symbol.asyncIterator]() {
        yield terminal;
      },
    }),
  });
  const iterator = adapter.execute(input(evidence))[Symbol.asyncIterator]();
  await iterator.next(); // Suspended after accepted; the execution observer has not ended.
  const closing = adapter.close().catch(() => {});
  try {
    assert.equal(
      adapter.prepareUnobservedCleanup!({
        sessionId: 'recovery-session',
        dispatchId: 'recovery-dispatch',
        generation: 3,
      }),
      null,
    );
  } finally {
    await iterator.return?.();
    await closing;
  }
  for (const changed of [{ generation: 4 }, { dispatchId: 'wrong' }, { sessionId: 'wrong' }]) {
    assert.equal(
      adapter.prepareUnobservedCleanup!({
        sessionId: 'recovery-session',
        dispatchId: 'recovery-dispatch',
        generation: 3,
        ...changed,
      }),
      null,
    );
  }
  const commit = adapter.prepareUnobservedCleanup!({
    sessionId: 'recovery-session',
    dispatchId: 'recovery-dispatch',
    generation: 3,
  });
  assert.ok(commit);
  assert.equal(
    adapter.hasActiveResources('recovery-session'),
    true,
    'prepare cannot retire a record',
  );
  commit();
  commit();
  assert.equal(adapter.hasActiveResources('recovery-session'), false);
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  await adapter.close();
});

test('AC-R04.2 retrying an old disposition cannot retire a later dispatch in the same session', async () => {
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: () => ({
      async *[Symbol.asyncIterator]() {
        yield terminal;
      },
    }),
  });
  await collect(adapter.execute(input([])));
  const original = {
    sessionId: 'recovery-session',
    dispatchId: 'recovery-dispatch',
    generation: 3,
  };
  const commit = adapter.prepareUnobservedCleanup!(original)!;
  assert.ok(commit);
  commit();
  await collect(adapter.execute({ ...input([]), dispatchId: 'next-dispatch', generation: 4 }));
  commit();
  assert.equal(adapter.hasActiveResources('recovery-session'), true);
  assert.equal(adapter.prepareUnobservedCleanup!(original), null);
  const next = adapter.prepareUnobservedCleanup!({
    ...original,
    dispatchId: 'next-dispatch',
    generation: 4,
  });
  assert.ok(next);
  next();
  await adapter.close();
});

test('AC-R04.4 a real Unix SDK client cannot attest an unobserved Claude record', async (t) => {
  const f = await unobservedFixture(t);
  const host = await startUnixHost(f.engine, { socketPath: join(f.dir, 'host.sock') });
  const client = await connectOrchestrator({ socketPath: join(f.dir, 'host.sock') });
  try {
    const session = await client.sessions.get(f.first.sessionId!);
    await assert.rejects(
      client.sessions.reconcile(target(session), proof, { idempotencyKey: 'socket-owner' }),
      { code: 'UNAUTHORIZED' },
    );
    assert.equal(f.adapter.hasActiveResources(session.id), true);
    assert.equal((await client.scheduler.get()).executionOccupied, 2);
    await f.reconcile(f.first.sessionId!, 'real-owner-first');
    await f.reconcile(f.second.sessionId!, 'real-owner-second');
  } finally {
    await client.close();
    await host.close({ timeoutMs: 500 });
  }
});

test('AC-R04.4 the embedded TypeScript SDK reconciles an unknown record and closes its owner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-sdk-'));
  await mkdir(join(dir, 'workspace'));
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: () => ({
      async *[Symbol.asyncIterator]() {
        yield terminal;
      },
    }),
  });
  const client = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    storage: { emergencyBytes: 4096 },
  });
  t.after(async () => {
    adapter.close = async () => {};
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  const task = await client.tasks.create(
    { ...spec, acceptance: { mode: 'human', criteria: ['review'] } },
    { idempotencyKey: 'sdk-unknown' },
  );
  await until(
    () => client.tasks.get(task.id),
    (value) => value.status === 'blocked',
  );
  const session = await client.sessions.get(task.initial.sessionId!);
  const op = await client.sessions.reconcile(
    target(session),
    { ...proof, outcome: 'completed', sideEffects: 'resolved', result: 'done' },
    { idempotencyKey: 'sdk-reconcile' },
  );
  assert.equal(result(await op.wait({ timeoutMs: 500 })).unobservedResourcesReconciled, true);
  assert.equal(adapter.hasActiveResources(session.id), false);
  assert.equal((await client.tasks.get(task.id)).status, 'paused');
  await client.close({ timeoutMs: 500 });
});
