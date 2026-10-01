import { artifactWritesSettled } from '../../packages/engine/src/store.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineClock,
  EngineConfig,
  RuntimeAdapter,
  RuntimeEvent,
  TaskSnapshot,
  SessionSnapshot,
  OperationSnapshot,
  ReconcileEvidence,
  SessionControlTarget,
  EventPage,
  ApprovalRequest,
  MessageSnapshot,
} from '../../packages/engine/src/types.ts';

class Clock implements EngineClock {
  wall = Date.parse('2026-09-19T00:00:00Z');
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
  advance(ms: number, wallMs = ms) {
    this.mono += ms;
    this.wall += wallMs;
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) {
      if (this.timers.has(timer) && timer.at <= this.mono) {
        this.timers.delete(timer);
        timer.fn();
      }
    }
  }
}
// A turn's end waits for its files (SPEC-0057), so "a few ticks later" includes those writes.
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await artifactWritesSettled();
    await new Promise<void>((r) => setImmediate(r));
  }
};
const spec = {
  goal: 'lifecycle evidence',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human', criteria: ['review evidence'] },
};
const read = <T>(e: Engine, method: string, p: Record<string, unknown>) =>
  e.call(method, p) as Promise<T>;
const target = (s: SessionSnapshot): SessionControlTarget => ({
  sessionId: s.id,
  expectedGeneration: s.generation,
  expectedRevision: s.revision,
  expectedDispatchId: s.activeDispatchId,
  expectedState: s.status,
});
const proof = (outcome: ReconcileEvidence['outcome'] = 'completed'): ReconcileEvidence => ({
  source: 'owner_attestation',
  summary: 'Owner checked the native history and tool receipts; no active execution remains.',
  localResources: 'stopped',
  remoteExecution: 'stopped',
  sideEffects: 'resolved',
  outcome,
  ...(outcome === 'completed' ? { result: 'late evidence' } : {}),
});

async function fixture(accepted = true) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-lifecycle-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const clock = new Clock();
  let calls = 0,
    aborts = 0;
  const gates: ((e: RuntimeEvent) => void)[] = [];
  const adapter: RuntimeAdapter = {
    provider: 'fake',
    capabilities: () => ({
      provider: 'fake',
      resume: true,
      interrupt: true,
      permissionProfiles: ['read-only'],
      executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
      executionEvidence: { version: 1, terminalCoversExecution: true },
    }),
    async *execute(input) {
      calls++;
      let sequence = 0;
      const report = (
        source: 'pre_submission' | 'runtime_terminal' | 'resource_observation',
        localResources: 'stopped' | 'unknown',
        remoteExecution: 'stopped' | 'unknown',
        detail: string,
        terminal?: RuntimeEvent,
      ) =>
        input.reportExecutionEvidence?.({
          version: 1,
          sequence: ++sequence,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider: 'fake',
          providerSessionId: accepted ? 'native-lifecycle' : null,
          source,
          observedAt: new Date().toISOString(),
          localResources,
          remoteExecution,
          detail,
          ...(terminal
            ? {
                terminal: terminal as Extract<
                  RuntimeEvent,
                  { type: 'result' | 'interrupted' | 'error' }
                >,
              }
            : {}),
        });
      let release!: (e: RuntimeEvent) => void;
      const gate = new Promise<RuntimeEvent>((r) => {
        release = r;
      });
      gates.push(release);
      input.signal.addEventListener(
        'abort',
        () => {
          aborts++;
        },
        { once: true },
      );
      if (accepted) yield { type: 'accepted', providerSessionId: 'native-lifecycle' };
      const terminal = await gate;
      const preSubmissionFailure =
        !accepted &&
        terminal.type === 'error' &&
        terminal.message === 'proven validation failure before submission';
      const matchedTerminal =
        accepted &&
        (terminal.type === 'result' || terminal.type === 'interrupted') &&
        (terminal.type !== 'result' ||
          !terminal.providerSessionId ||
          terminal.providerSessionId === 'native-lifecycle');
      if (preSubmissionFailure)
        report(
          'pre_submission',
          'stopped',
          'stopped',
          'fixture validation failed before submission',
        );
      if (matchedTerminal)
        report(
          'runtime_terminal',
          'unknown',
          'stopped',
          'fixture delivered its terminal event',
          terminal,
        );
      try {
        yield terminal;
      } finally {
        if (matchedTerminal)
          report(
            'resource_observation',
            'stopped',
            'stopped',
            'fixture iterator and resources stopped',
          );
      }
    },
    async close() {
      for (const release of gates)
        release({ type: 'error', message: 'fixture closed', outcome: 'unknown' });
    },
  };
  const config: EngineConfig = {
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    clock,
    limits: { maxActiveSessions: 1 },
    timeouts: { acceptanceMs: 100, turnMs: 1000, drainMs: 50, interruptMs: 20, reconcileMs: 60 },
  };
  const engine = await createEngine(config);
  const create = async (key = 'task') => {
    const t = await read<TaskSnapshot>(engine, 'tasks.create', { spec, idempotencyKey: key });
    await flush();
    return t;
  };
  const session = (id: string) => read<SessionSnapshot>(engine, 'sessions.get', { sessionId: id });
  const task = (id: string) => read<TaskSnapshot>(engine, 'tasks.get', { taskId: id });
  const pause = async (t: TaskSnapshot, mode = 'drain') =>
    engine.call('sessions.control', {
      target: target(await session(t.sessionId)),
      command: { action: 'pause', mode },
      idempotencyKey: 'pause',
    }) as Promise<OperationSnapshot>;
  return {
    engine,
    config,
    clock,
    create,
    session,
    task,
    pause,
    gates,
    calls: () => calls,
    aborts: () => aborts,
    async cleanup() {
      const closing = engine.close({ timeoutMs: 1000 });
      await adapter.close!();
      await flush();
      await closing;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('0011-R01 control deadline uses one wall-clock sample and retry preserves it', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const params = {
      target: target(await f.session(t.sessionId)),
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'exact-deadline',
    };
    f.clock.wallNow = () => f.clock.wall++;
    const operation = await read<OperationSnapshot>(f.engine, 'sessions.control', params);
    assert.equal(
      Date.parse(operation.lifecycle!.deadlineAt) - Date.parse(operation.lifecycle!.enteredAt),
      50,
    );
    const replay = await read<OperationSnapshot>(f.engine, 'sessions.control', params);
    assert.deepEqual(replay.lifecycle, operation.lifecycle);
  } finally {
    f.clock.wallNow = () => f.clock.wall;
    await f.cleanup();
  }
});

test('0012-R01 a client pause retains its origin while an active dispatch drains', async () => {
  const f = await fixture();
  try {
    const task = await f.create();
    await f.pause(task);
    assert.equal((await f.session(task.sessionId)).pauseOrigin, 'client');
    f.gates[0]({ type: 'result', text: 'stopped at pause', providerSessionId: 'native-lifecycle' });
    await flush();
    const paused = await f.session(task.sessionId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseOrigin, 'client');
  } finally {
    await f.cleanup();
  }
});

test('0003-A01/A03 drain deadline is durable, independent of wall-clock rollback and retries', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const s = await f.session(t.sessionId);
    const p = {
      target: target(s),
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'pause',
    };
    const op = await read<OperationSnapshot>(f.engine, 'sessions.control', p);
    assert.ok(op.lifecycle, 'pending control needs persisted lifecycle');
    const deadline = op.lifecycle.deadlineAt;
    f.clock.advance(49, -100000);
    await flush();
    const retry = await read<OperationSnapshot>(f.engine, 'sessions.control', p);
    assert.equal(retry.lifecycle?.deadlineAt, deadline);
    assert.equal(retry.status, 'persisted');
    f.clock.advance(1);
    await flush();
    assert.equal(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id })).status,
      'outcome_unknown',
    );
    assert.equal((await f.task(t.id)).status, 'blocked');
    assert.equal(f.aborts(), 0, 'drain must not silently interrupt');
    await assert.rejects(
      f.engine.call('tasks.resume', { taskId: t.id, idempotencyKey: 'unsafe' }),
      { code: 'OUTCOME_UNKNOWN' },
    );
  } finally {
    await f.cleanup();
  }
});

test('0003-A02 acceptance timeout and ended unknown still reserve the only dispatch slot', async () => {
  const f = await fixture(false);
  try {
    const t = await f.create();
    const queued = await f.create('second');
    f.clock.advance(100);
    await flush();
    assert.equal((await f.task(t.id)).status, 'blocked');
    f.gates[0]({ type: 'error', message: 'connection lost', outcome: 'unknown' });
    await flush();
    assert.equal((await f.task(queued.id)).status, 'queued');
    assert.equal(f.calls(), 1);
    assert.ok((await f.session(t.sessionId)).activeDispatchId);
  } finally {
    await f.cleanup();
  }
});

test('0003-A04/A05 late result needs explicit owner reconciliation and resume never reruns it', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const op = await f.pause(t);
    f.clock.advance(50);
    await flush();
    f.gates[0]({ type: 'result', text: 'late evidence', providerSessionId: 'native-lifecycle' });
    await flush();
    assert.equal(
      (await f.task(t.id)).status,
      'blocked',
      'late terminal is evidence, not implicit resolution',
    );
    const p = {
      target: target(await f.session(t.sessionId)),
      evidence: proof(),
      idempotencyKey: 'reconcile',
    };
    await assert.rejects(f.engine.call('sessions.reconcile', p, { owner: false }), {
      code: 'UNAUTHORIZED',
    });
    const resolved = (await f.engine.call('sessions.reconcile', p, {
      owner: true,
    })) as OperationSnapshot;
    assert.equal(resolved.status, 'completed');
    assert.equal((await f.task(t.id)).status, 'paused');
    assert.equal(
      ((await f.engine.call('sessions.reconcile', p, { owner: true })) as OperationSnapshot).id,
      resolved.id,
    );
    const old = await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id });
    assert.equal(old.status, 'outcome_unknown');
    assert.equal(old.resolution?.operationId, resolved.id);
    await f.engine.call('tasks.resume', { taskId: t.id, idempotencyKey: 'resume' });
    await flush();
    assert.equal(f.calls(), 1);
    assert.equal((await f.task(t.id)).status, 'waiting_approval');
    const events = await read<EventPage>(f.engine, 'events.read', { taskId: t.id });
    assert.equal(events.events.filter((e) => e.type === 'dispatch.late_evidence').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('0003-A05 process-stopped alone cannot resolve business uncertainty or release remote quota', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    f.gates[0]({ type: 'error', message: 'gone', outcome: 'unknown' });
    await flush();
    const evidence = { ...proof('unknown'), remoteExecution: 'unknown', sideEffects: 'unknown' };
    await f.engine.call(
      'sessions.reconcile',
      { target: target(await f.session(t.sessionId)), evidence, idempotencyKey: 'partial' },
      { owner: true },
    );
    assert.equal((await f.task(t.id)).status, 'blocked');
    assert.ok((await f.session(t.sessionId)).activeDispatchId);
    const next = await f.create('next');
    assert.equal((await f.task(next.id)).status, 'queued');
    assert.equal(f.calls(), 1);
  } finally {
    await f.cleanup();
  }
});

test('0003-A03 interrupt timeout cannot masquerade as observed interruption', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const op = await f.pause(t, 'interrupt');
    assert.equal(f.aborts(), 1);
    f.clock.advance(20);
    await flush();
    assert.equal(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id })).status,
      'outcome_unknown',
    );
    assert.equal((await f.session(t.sessionId)).status, 'outcome_unknown');
  } finally {
    await f.cleanup();
  }
});

test('0003-A05 still-held runtime and conflicting late evidence reject a resolving attestation', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    f.clock.advance(1000);
    await flush();
    await assert.rejects(
      f.engine.call(
        'sessions.reconcile',
        {
          target: target(await f.session(t.sessionId)),
          evidence: proof('not_executed'),
          idempotencyKey: 'held',
        },
        { owner: true },
      ),
      { code: 'RUNTIME_STILL_ACTIVE' },
    );
    f.gates[0]({ type: 'result', text: 'late evidence', providerSessionId: 'native-lifecycle' });
    await flush();
    await assert.rejects(
      f.engine.call(
        'sessions.reconcile',
        {
          target: target(await f.session(t.sessionId)),
          evidence: proof('not_executed'),
          idempotencyKey: 'conflict',
        },
        { owner: true },
      ),
      { code: 'EVIDENCE_CONFLICT' },
    );
  } finally {
    await f.cleanup();
  }
});

test('0003-A01 validates finite deadline configuration before starting the store', async () => {
  const f = await fixture();
  try {
    for (const value of [0, -1, Infinity, 1.5, 86400001]) {
      await assert.rejects(createEngine({ ...f.config, timeouts: { drainMs: value } }), {
        code: 'VALIDATION_ERROR',
      });
    }
  } finally {
    await f.cleanup();
  }
});

test('0003-A01/A05 restart preserves expired control evidence and reserves unknown dispatch', async () => {
  const f = await fixture();
  let reopened: Engine | undefined;
  try {
    const t = await f.create();
    const op = await f.pause(t);
    f.clock.advance(50);
    await flush();
    f.gates[0]({ type: 'error', message: 'lost', outcome: 'unknown' });
    await flush();
    await f.engine.close();
    reopened = await createEngine(f.config);
    const restored = await read<OperationSnapshot>(reopened, 'operations.get', {
      operationId: op.id,
    });
    assert.equal(restored.lifecycle?.deadlineAt, op.lifecycle?.deadlineAt);
    assert.ok(restored.lifecycle?.expiredAt);
    await reopened.call('tasks.create', { spec, idempotencyKey: 'after-restart' });
    await flush();
    assert.equal(f.calls(), 1);
    assert.equal(
      (await read<TaskSnapshot>(reopened, 'tasks.get', { taskId: t.id })).status,
      'blocked',
    );
  } finally {
    await reopened?.close();
    await f.cleanup();
  }
});

test('0003-A02 known pre-submission failure releases capacity without misclassifying unknown', async () => {
  const f = await fixture(false);
  try {
    const first = await f.create();
    const second = await f.create('second');
    f.gates[0]({
      type: 'error',
      message: 'proven validation failure before submission',
      outcome: 'failed',
    });
    await flush();
    assert.equal((await f.task(first.id)).status, 'failed');
    assert.equal((await f.session(first.sessionId)).activeDispatchId, null);
    assert.equal((await f.task(second.id)).status, 'running');
    assert.equal(f.calls(), 2);
  } finally {
    await f.cleanup();
  }
});

test('0003-A02 deadline updates message/outbox atomically and reconciliation never redelivers completed mail', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    f.gates[0]({ type: 'result', text: 'first pass' });
    await flush();
    const waiting = await f.task(t.id);
    const message = await read<MessageSnapshot>(f.engine, 'messages.send', {
      spec: {
        taskId: t.id,
        toSessionId: t.sessionId,
        expectedGeneration: 1,
        kind: 'finding',
        summary: 'second pass',
      },
      idempotencyKey: 'message',
    });
    const approval = await read<ApprovalRequest>(f.engine, 'approvals.get', {
      approvalId: waiting.approvalId,
    });
    await f.engine.call('approvals.decide', {
      approvalId: approval.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'first-approval',
    });
    await flush();
    const op = await f.pause(t);
    f.clock.advance(50);
    await flush();
    assert.equal(
      (await read<MessageSnapshot>(f.engine, 'messages.get', { messageId: message.id })).status,
      'outcome_unknown',
    );
    const db = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT data FROM outbox WHERE id=?').get(message.id) as {
        data: string;
      };
      assert.equal(JSON.parse(row.data).status, 'outcome_unknown');
    } finally {
      db.close();
    }
    f.gates[1]({ type: 'result', text: 'late evidence' });
    await flush();
    await f.engine.call(
      'sessions.reconcile',
      {
        target: target(await f.session(t.sessionId)),
        evidence: proof(),
        idempotencyKey: 'second-reconcile',
      },
      { owner: true },
    );
    assert.equal(
      (await read<MessageSnapshot>(f.engine, 'messages.get', { messageId: message.id })).status,
      'completed',
    );
    await f.engine.call('tasks.resume', { taskId: t.id, idempotencyKey: 'resume-result' });
    await flush();
    assert.equal(f.calls(), 2);
    assert.equal((await f.task(t.id)).status, 'waiting_approval');
    assert.ok(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id }))
        .resolution,
    );
  } finally {
    await f.cleanup();
  }
});

test('0003-A01 superseded pause timer cannot expire a later cancellation operation', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const pause = await f.pause(t);
    // Let cancellation's shorter deadline expire first; the old pause timer must not add a second timeout.
    const cancel = await read<OperationSnapshot>(f.engine, 'tasks.cancel', {
      taskId: t.id,
      idempotencyKey: 'cancel',
    });
    f.clock.advance(20);
    await flush();
    f.clock.advance(30);
    await flush();
    assert.equal(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: pause.id })).status,
      'rejected',
    );
    assert.equal(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: cancel.id }))
        .status,
      'outcome_unknown',
    );
    const page = await read<EventPage>(f.engine, 'events.read', { taskId: t.id });
    assert.equal(page.events.filter((e) => e.type === 'dispatch.deadline_exceeded').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('0003-A01/A05 real owner crash preserves deadline and restart does not replay a stale pause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-deadline-crash-'));
  const workspace = join(dir, 'workspace'),
    stateDir = join(dir, 'state');
  await mkdir(workspace);
  const child = spawn(
    process.execPath,
    ['tests/fixtures/lifecycle-crash-owner.ts', workspace, stateDir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  let engine: Engine | undefined;
  try {
    const ready = await new Promise<{ task: TaskSnapshot; operation: OperationSnapshot }>(
      (resolve, reject) => {
        let data = '';
        const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 3000);
        child.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.stdout.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\n')) {
            clearTimeout(timer);
            resolve(JSON.parse(data.split('\n')[0]));
          }
        });
      },
    );
    assert.equal(ready.operation.status, 'persisted');
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    let calls = 0;
    const clock = new Clock();
    clock.wall = Date.parse(ready.operation.lifecycle!.deadlineAt) + 1;
    const adapter: RuntimeAdapter = {
      provider: 'fake',
      capabilities: () => ({
        provider: 'fake',
        resume: true,
        interrupt: true,
        permissionProfiles: ['read-only'],
        executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
        executionEvidence: { version: 1, terminalCoversExecution: true },
      }),
      async *execute() {
        calls++;
        yield { type: 'result', text: 'must not run' };
      },
    };
    engine = await createEngine({
      workspace,
      stateDir,
      adapters: [adapter],
      clock,
      limits: { maxActiveSessions: 1 },
    });
    const restored = await read<OperationSnapshot>(engine, 'operations.get', {
      operationId: ready.operation.id,
    });
    assert.equal(restored.status, 'outcome_unknown');
    assert.equal(restored.lifecycle?.deadlineAt, ready.operation.lifecycle?.deadlineAt);
    assert.ok(restored.lifecycle?.expiredAt);
    await engine.call('tasks.create', { spec, idempotencyKey: 'next' });
    await flush();
    assert.equal(calls, 0);
    await assert.rejects(
      engine.call('tasks.resume', { taskId: ready.task.id, idempotencyKey: 'replay' }),
      { code: 'OUTCOME_UNKNOWN' },
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await engine?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('0003-A01 delayed timer delivery cannot let an overdue terminal complete a pause', async () => {
  const f = await fixture();
  try {
    const t = await f.create();
    const op = await f.pause(t);
    // Simulate a delayed event loop timer: elapsed monotonic time advances, timer callbacks have not run.
    f.clock.mono += 60;
    f.clock.wall += 60;
    f.gates[0]({ type: 'result', text: 'late evidence' });
    await flush();
    assert.equal(
      (await read<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id })).status,
      'outcome_unknown',
    );
    assert.equal((await f.task(t.id)).status, 'blocked');
  } finally {
    await f.cleanup();
  }
});

test('0003-A05 retained adapter cleanup blocks attestation after the observation loop ends', async (t) => {
  const { createClaudeAdapter } = await import('../../packages/adapter-claude/src/index.ts');
  const { refuseGroupSignals, stubbornClaudeProcess } = await import(
    '../fixtures/claude-process.ts'
  );
  // The process outlives its cleanup only because the adapter may not signal its group.
  refuseGroupSignals(t);
  let child: ReturnType<typeof stubbornClaudeProcess>['child'] | undefined;
  const dir = await mkdtemp(join(tmpdir(), 'orch-retained-cleanup-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  let finishReturn!: (value: IteratorResult<unknown>) => void;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    cleanupTimeoutMs: 5,
    query(request) {
      const held = stubbornClaudeProcess(request);
      child = held.child;
      let first = true;
      return {
        close() {},
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await held.ready;
              if (first) {
                first = false;
                return Promise.resolve({
                  done: false,
                  value: { type: 'system', session_id: 'native-cleanup' },
                });
              }
              return { done: true, value: undefined };
            },
            return() {
              return new Promise<IteratorResult<unknown>>((r) => {
                finishReturn = r;
              });
            },
          };
        },
      };
    },
  });
  const engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
  });
  try {
    const t = await read<TaskSnapshot>(engine, 'tasks.create', {
      spec: { ...spec, runtime: { provider: 'claude', model: 'test' } },
      idempotencyKey: 'task',
    });
    const until = performance.now() + 1000;
    while ((await read<TaskSnapshot>(engine, 'tasks.get', { taskId: t.id })).status !== 'blocked') {
      assert.ok(performance.now() < until);
      await new Promise((r) => setTimeout(r, 5));
    }
    await flush();
    const s = await read<SessionSnapshot>(engine, 'sessions.get', { sessionId: t.sessionId });
    await assert.rejects(
      engine.call(
        'sessions.reconcile',
        { target: target(s), evidence: proof('not_executed'), idempotencyKey: 'untrue-cleanup' },
        { owner: true },
      ),
      { code: 'RUNTIME_STILL_ACTIVE' },
    );
  } finally {
    finishReturn?.({ done: true, value: undefined });
    await flush();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await engine.close({ timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});
