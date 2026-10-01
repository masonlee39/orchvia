import { artifactWritesSettled } from '../../packages/engine/src/store.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineClock,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  RuntimeEvent,
  ExecutionEvidence,
  SchedulerSnapshot,
  SessionSnapshot,
  TaskSnapshot,
  OperationSnapshot,
  ExecutionConflict,
} from '../../packages/engine/src/types.ts';

class Clock implements EngineClock {
  mono = 0;
  wall = Date.parse('2026-09-19T00:00:00Z');
  timers = new Set<{ at: number; fn: () => void }>();
  wallNow = () => this.wall;
  monotonicNow = () => this.mono;
  setTimer = (fn: () => void, ms: number) => {
    const t = { at: this.mono + ms, fn };
    this.timers.add(t);
    return () => {
      this.timers.delete(t);
    };
  };
  advance(ms: number, wall = ms) {
    this.mono += ms;
    this.wall += wall;
    for (const t of [...this.timers]) if (t.at <= this.mono && this.timers.delete(t)) t.fn();
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
  goal: 'isolated readonly test',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human', criteria: ['owner review'] },
};
const target = (s: SessionSnapshot) => ({
  sessionId: s.id,
  expectedGeneration: s.generation,
  expectedRevision: s.revision,
  expectedDispatchId: s.activeDispatchId,
  expectedState: s.status,
});
const attestation = {
  source: 'owner_attestation',
  summary: 'Fixture execution and its local resources are independently stopped.',
  localResources: 'stopped',
  remoteExecution: 'stopped',
  sideEffects: 'unknown',
  outcome: 'unknown',
};
async function fixture(
  limits: EngineConfig['limits'] = {},
  timeouts: EngineConfig['timeouts'] = {},
  caps: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-a2-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const clock = new Clock();
  const inputs: RuntimeInput[] = [],
    gates: ((e: RuntimeEvent) => void)[] = [];
  const adapter: RuntimeAdapter = {
    provider: 'fake',
    capabilities: () =>
      ({
        provider: 'fake',
        resume: true,
        interrupt: true,
        permissionProfiles: ['read-only'],
        executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
        executionEvidence: { version: 1, terminalCoversExecution: true },
        ...caps,
      }) as ReturnType<RuntimeAdapter['capabilities']>,
    async *execute(input) {
      inputs.push(input);
      const gate = new Promise<RuntimeEvent>((r) => gates.push(r));
      yield { type: 'accepted', providerSessionId: `native-${input.sessionId}` };
      yield await gate;
    },
    async close() {
      for (const g of gates) g({ type: 'error', outcome: 'unknown', message: 'fixture closed' });
    },
  };
  const config: EngineConfig = {
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    clock,
    limits,
    timeouts,
  };
  const engine = await createEngine(config);
  const create = async (key: string) => {
    const t = (await engine.call('tasks.create', { spec, idempotencyKey: key })) as TaskSnapshot;
    await flush();
    return t;
  };
  const status = () => engine.call('scheduler.get') as Promise<SchedulerSnapshot>;
  const session = (t: TaskSnapshot) =>
    engine.call('sessions.get', { sessionId: t.sessionId }) as Promise<SessionSnapshot>;
  const sequences: number[] = [];
  const evidence = (i: number, patch: Partial<ExecutionEvidence> = {}) => {
    const input = inputs[i];
    input.reportExecutionEvidence?.({
      version: 1,
      sequence: (sequences[i] = (sequences[i] ?? 0) + 1),
      dispatchId: input.dispatchId,
      sessionId: input.sessionId,
      generation: input.generation!,
      provider: 'fake',
      providerSessionId: `native-${input.sessionId}`,
      observedAt: new Date(clock.wall).toISOString(),
      source: 'runtime_terminal',
      localResources: 'stopped',
      remoteExecution: 'stopped',
      detail: 'fixture terminal and cleanup verified',
      terminal: { type: 'result', text: 'late result' },
      ...patch,
    });
  };
  return {
    dir,
    config,
    engine,
    clock,
    inputs,
    gates,
    create,
    status,
    session,
    evidence,
    async cleanup() {
      await adapter.close!();
      await flush();
      await engine.close({ timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('A2-01/02 default total budget is 1800s, explicit caps and initialization share one clock', async () => {
  const f = await fixture();
  try {
    const t = await f.create('default');
    const budget = f.inputs[0].executionBudget;
    assert.equal(budget?.effectiveTurnMs, 1_800_000);
    assert.equal((await f.session(t)).execution?.budget?.policyVersion, 2);
    f.clock.advance(300_001, -600_000);
    await flush();
    assert.equal((await f.session(t)).status, 'running');
    assert.equal(budget!.remainingTurnMs(), 1_499_999);
    f.clock.advance(1_499_999);
    await flush();
    assert.equal((await f.status()).executionOccupied, 1);
    assert.equal((await f.status()).quarantined, 1);
  } finally {
    await f.cleanup();
  }
  const g = await fixture(
    {},
    { turnMs: 1000, acceptanceMs: 100 },
    { executionBudget: { version: 2, acceptanceCapMs: 50, turnCapMs: 500 } },
  );
  try {
    await g.create('explicit');
    assert.equal(g.inputs[0].executionBudget?.effectiveTurnMs, 500);
    assert.equal(g.inputs[0].executionBudget?.effectiveAcceptanceMs, 50);
    g.clock.advance(500);
    await flush();
    assert.equal((await g.status()).quarantined, 1);
  } finally {
    await g.cleanup();
  }
  const h = await fixture(
    {},
    { turnMs: 500, acceptanceMs: 100 },
    { executionBudget: { version: 2, acceptanceCapMs: 5000, turnCapMs: 5000 } },
  );
  try {
    await h.create('host-shorter');
    assert.equal(h.inputs[0].executionBudget?.effectiveTurnMs, 500);
    assert.equal(h.inputs[0].executionBudget?.effectiveAcceptanceMs, 100);
    assert.equal(h.inputs[0].executionBudget?.turnSource, 'host_explicit');
    h.clock.advance(500);
    await flush();
    assert.equal((await h.status()).quarantined, 1);
  } finally {
    await h.cleanup();
  }
});

test('A2-03/04 two live unknowns hold slots; complete late proof releases only execution and starts third', async () => {
  const f = await fixture({}, { turnMs: 100 });
  try {
    const a = await f.create('a'),
      b = await f.create('b'),
      c = await f.create('c');
    f.clock.advance(100);
    await flush();
    assert.deepEqual(
      [(await f.status()).executionOccupied, (await f.status()).quarantined, f.inputs.length],
      [2, 2, 2],
    );
    for (let i = 0; i < 2; i++) {
      f.evidence(i, {
        source: 'resource_observation',
        terminal: undefined,
        remoteExecution: 'unknown',
      });
      f.gates[i]({ type: 'error', outcome: 'unknown', message: 'local exit only' });
    }
    await flush();
    assert.equal(f.inputs.length, 2);
    for (let i = 0; i < 2; i++) f.evidence(i);
    await flush();
    const snap = await f.status();
    assert.equal(snap.executionOccupied, 1);
    assert.equal(snap.quarantined, 2);
    assert.equal(snap.quarantineReserved, 1);
    assert.equal(f.inputs.length, 3);
    for (const t of [a, b]) {
      const s = await f.session(t);
      assert.equal(s.status, 'outcome_unknown');
      assert.ok(s.activeDispatchId);
      assert.equal(s.execution?.lease.status, 'released');
      assert.equal(
        ((await f.engine.call('tasks.get', { taskId: t.id })) as TaskSnapshot).status,
        'blocked',
      );
    }
    assert.equal((await f.session(c)).status, 'running');
  } finally {
    await f.cleanup();
  }
});

test('A2-05/06 terminal without cleanup, wrong generation, duplicate and generic failed never unlock', async () => {
  const f = await fixture({ maxActiveSessions: 1 }, { turnMs: 100 });
  try {
    const a = await f.create('a');
    await f.create('b');
    f.evidence(0, { localResources: 'unknown' });
    assert.equal(
      (await f.status()).quarantineReserved,
      1,
      'terminal still waiting for cleanup retains its reservation',
    );
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'cleanup waiting' });
    await flush();
    assert.equal((await f.status()).executionOccupied, 1);
    f.evidence(0, { generation: 999 });
    await flush();
    assert.equal(f.inputs.length, 1);
    f.evidence(0, { source: 'resource_observation', terminal: undefined });
    await flush();
    assert.equal(f.inputs.length, 2);
    assert.equal((await f.session(a)).execution?.lease.status, 'released');
    f.evidence(0, { sequence: 1, localResources: 'active' });
    await flush();
    assert.equal((await f.status()).openConflicts, 0);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ maxActiveSessions: 1 });
  try {
    await g.create('failed');
    g.gates[0]({ type: 'error', outcome: 'failed', message: 'generic failure' });
    await flush();
    assert.equal((await g.status()).executionOccupied, 1);
    assert.equal((await g.status()).quarantined, 1);
  } finally {
    await g.cleanup();
  }
});

test('A2-07 resource-only owner reconcile releases A, preserves Q and receipt, rejects live observer', async () => {
  const f = await fixture({ maxActiveSessions: 1 }, { turnMs: 100 });
  try {
    const t = await f.create('a');
    f.clock.advance(100);
    await flush();
    const p = {
      target: target(await f.session(t)),
      evidence: attestation,
      idempotencyKey: 'resource',
    };
    await assert.rejects(f.engine.call('sessions.reconcile', p, { owner: true }), {
      code: 'RUNTIME_STILL_ACTIVE',
    });
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'ended' });
    await flush();
    p.target = target(await f.session(t));
    await assert.rejects(f.engine.call('sessions.reconcile', p), { code: 'UNAUTHORIZED' });
    const op = (await f.engine.call('sessions.reconcile', p, { owner: true })) as OperationSnapshot;
    assert.equal((op.result as Record<string, unknown>).executionReleased, true);
    assert.equal((op.result as Record<string, unknown>).resolved, false);
    assert.deepEqual(await f.engine.call('sessions.reconcile', p, { owner: true }), op);
    await assert.rejects(
      f.engine.call(
        'sessions.reconcile',
        { ...p, evidence: { ...attestation, summary: 'changed' } },
        { owner: true },
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal((await f.status()).executionOccupied, 0);
    assert.equal((await f.status()).quarantined, 1);
  } finally {
    await f.cleanup();
  }
});

test('A2-08 Q+R backpressure precedes new records but follows idempotent lookup; business reconciliation frees Q', async () => {
  const f = await fixture({ maxActiveSessions: 1, maxQuarantinedDispatches: 1 }, { turnMs: 100 });
  try {
    const t = await f.create('a');
    assert.equal((await f.status()).quarantineReserved, 1);
    await assert.rejects(f.create('b'), { code: 'QUARANTINE_CAPACITY_EXCEEDED' });
    assert.equal((await f.create('a')).id, t.id);
    await assert.rejects(
      f.engine.call('tasks.create', {
        spec: { ...spec, goal: 'different payload' },
        idempotencyKey: 'a',
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      f.engine.call('messages.send', {
        spec: {
          taskId: t.id,
          toSessionId: t.sessionId,
          expectedGeneration: 1,
          kind: 'finding',
          summary: 'queued work',
        },
        idempotencyKey: 'message',
      }),
      { code: 'QUARANTINE_CAPACITY_EXCEEDED' },
    );
    f.clock.advance(100);
    f.evidence(0);
    f.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    assert.equal((await f.status()).executionOccupied, 0);
    assert.equal((await f.status()).quarantined, 1);
    await assert.rejects(f.create('b'), { code: 'QUARANTINE_CAPACITY_EXCEEDED' });
    await f.engine.call(
      'sessions.reconcile',
      {
        target: target(await f.session(t)),
        evidence: {
          ...attestation,
          sideEffects: 'resolved',
          outcome: 'completed',
          result: 'late result',
        },
        idempotencyKey: 'business',
      },
      { owner: true },
    );
    assert.equal((await f.status()).quarantined, 0);
    await f.create('b');
    assert.equal(f.inputs.length, 2);
    await f.engine.call('tasks.resume', { taskId: t.id, idempotencyKey: 'approval-only' });
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: t.id })) as TaskSnapshot).status,
      'waiting_approval',
    );
  } finally {
    await f.cleanup();
  }
});

test('A2-12 contradictory trusted proof creates durable conflict resolvable by id after business closure', async () => {
  const f = await fixture();
  try {
    const t = await f.create('a');
    f.evidence(0);
    f.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    assert.equal((await f.session(t)).activeDispatchId, null);
    f.evidence(0, {
      source: 'resource_observation',
      terminal: undefined,
      remoteExecution: 'active',
    });
    await flush();
    const snap = await f.status();
    assert.equal(snap.openConflicts, 1);
    assert.ok(snap.reasons.includes('EXECUTION_EVIDENCE_CONFLICT'));
    const ref = snap.conflicts[0];
    const conflict = (await f.engine.call('scheduler.getConflict', {
      conflictId: ref.conflictId,
    })) as ExecutionConflict;
    const p = {
      conflictId: conflict.id,
      expectedRevision: conflict.revision,
      evidence: attestation,
      idempotencyKey: 'resolve',
    };
    await assert.rejects(f.engine.call('scheduler.resolveConflict', p), { code: 'UNAUTHORIZED' });
    await assert.rejects(
      f.engine.call('scheduler.resolveConflict', { ...p, expectedRevision: 99 }, { owner: true }),
      { code: 'STALE_TARGET' },
    );
    const op = await f.engine.call('scheduler.resolveConflict', p, { owner: true });
    assert.deepEqual(await f.engine.call('scheduler.resolveConflict', p, { owner: true }), op);
    assert.equal((await f.status()).openConflicts, 0);
    assert.equal((await f.session(t)).activeDispatchId, null);
  } finally {
    await f.cleanup();
  }
});

test('A2-09 actual owner kill before/after release commit preserves held/released across restart without replay', async () => {
  const { spawn } = await import('node:child_process');
  for (const phase of ['before', 'after']) {
    const dir = await mkdtemp(join(tmpdir(), 'orch-a2-crash-'));
    const workspace = join(dir, 'workspace'),
      stateDir = join(dir, 'state');
    await mkdir(workspace);
    const child = spawn(
      process.execPath,
      ['tests/fixtures/execution-isolation-crash.ts', workspace, stateDir, phase],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    // The fixture reports its progress on stderr, which becomes the failure message if it stalls.
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
    let engine: Engine | undefined;
    try {
      const initial = await Promise.race([
        once(child, 'message').then(([v]) => v as { task: TaskSnapshot; session: SessionSnapshot }),
        once(child, 'exit').then(() => {
          throw new Error(stderr);
        }),
      ]);
      const exited = once(child, 'exit');
      const released = phase === 'after' ? once(child, 'message') : undefined;
      child.send('release');
      if (released) {
        await released;
        child.kill('SIGKILL');
      }
      await exited;
      let calls = 0;
      const adapter: RuntimeAdapter = {
        provider: 'fake',
        capabilities: () => ({
          provider: 'fake',
          resume: true,
          interrupt: true,
          permissionProfiles: ['read-only'],
          executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
        }),
        async *execute() {
          calls++;
          yield { type: 'error', outcome: 'unknown', message: 'must not replay' };
        },
      };
      engine = await createEngine({ workspace, stateDir, adapters: [adapter] });
      const s = (await engine.call('sessions.get', {
        sessionId: initial.task.sessionId,
      })) as SessionSnapshot;
      const status = (await engine.call('scheduler.get')) as SchedulerSnapshot;
      assert.equal(s.status, 'outcome_unknown');
      assert.equal(s.activeDispatchId, initial.session.activeDispatchId);
      assert.equal(s.execution?.budget?.deadlineAt, initial.session.execution?.budget?.deadlineAt);
      assert.equal(s.execution?.lease.status, phase === 'before' ? 'held' : 'released');
      assert.equal(status.executionOccupied, phase === 'before' ? 1 : 0);
      assert.equal(status.quarantined, 1);
      assert.equal(calls, 0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      await engine?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('A2-09 schema1 upgrade creates verified recovery backup and conservatively holds unknown; new engine refuses an unknown future schema', async () => {
  const f = await fixture({}, { turnMs: 100 });
  let upgraded: Engine | undefined;
  try {
    const t = await f.create('legacy');
    f.clock.advance(100);
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'legacy unknown' });
    await flush();
    await f.engine.close();
    const db = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'));
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run('1', 'schemaVersion');
    db.exec('DROP TABLE execution_conflicts');
    const row = db.prepare('SELECT id,data FROM dispatches').get() as { id: string; data: string };
    const d = JSON.parse(row.data);
    delete d.executionLease;
    delete d.quarantined;
    delete d.budget;
    db.prepare('UPDATE dispatches SET data=? WHERE id=?').run(JSON.stringify(d), row.id);
    db.close();
    upgraded = await createEngine({
      ...f.config,
      limits: { maxActiveSessions: 1, maxQuarantinedDispatches: 1 },
    });
    const snapshot = (await upgraded.call('scheduler.get')) as SchedulerSnapshot;
    assert.equal(snapshot.executionOccupied, 1);
    assert.equal(snapshot.quarantined, 1);
    assert.ok(snapshot.reasons.includes('QUARANTINE_CAPACITY_EXCEEDED'));
    assert.equal(
      ((await upgraded.call('sessions.get', { sessionId: t.sessionId })) as SessionSnapshot)
        .execution?.lease.status,
      'held',
    );
    const backups = (await readdir(f.config.stateDir)).filter((n) =>
      /^store-schema1-.*\.sqlite$/.test(n),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.config.stateDir, backups[0]), { readOnly: true });
    assert.equal(
      (
        backup.prepare('SELECT value FROM metadata WHERE key=?').get('schemaVersion') as {
          value: string;
        }
      ).value,
      '1',
    );
    assert.equal(
      (backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
      'ok',
    );
    backup.close();
    await upgraded.close();
    upgraded = undefined;
    const future = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'));
    future.prepare('UPDATE metadata SET value=? WHERE key=?').run('999', 'schemaVersion');
    future.close();
    await assert.rejects(createEngine(f.config), { code: 'SCHEMA_MISMATCH' });
  } finally {
    await upgraded?.close();
    await f.cleanup();
  }
});

test('A2-12 open conflicts survive restart and multiple conflicts gate dispatch until all owner resolutions', async () => {
  const f = await fixture();
  let restarted: Engine | undefined;
  try {
    await f.create('a');
    f.evidence(0);
    f.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    f.evidence(0, {
      source: 'resource_observation',
      terminal: undefined,
      localResources: 'active',
    });
    f.evidence(0, {
      source: 'resource_observation',
      terminal: undefined,
      remoteExecution: 'active',
    });
    assert.equal((await f.status()).openConflicts, 2);
    await f.engine.close();
    restarted = await createEngine(f.config);
    let status = (await restarted.call('scheduler.get')) as SchedulerSnapshot;
    assert.equal(status.openConflicts, 2);
    for (const [index, ref] of status.conflicts.entries()) {
      await restarted.call(
        'scheduler.resolveConflict',
        {
          conflictId: ref.conflictId,
          expectedRevision: ref.revision,
          evidence: attestation,
          idempotencyKey: 'resolve',
        },
        { owner: true },
      );
      status = (await restarted.call('scheduler.get')) as SchedulerSnapshot;
      assert.equal(status.openConflicts, 1 - index);
      assert.equal(status.canDispatch, index === 1);
    }
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});

test('A2-06 unsupported budget fails before admission, and unverified terminal coverage cannot release', async () => {
  const f = await fixture({}, {}, { executionBudget: { version: 1 } });
  try {
    await assert.rejects(f.create('legacy'), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.equal(f.inputs.length, 0);
    assert.equal((await f.status()).executionOccupied, 0);
    await assert.rejects(
      f.engine.call('operations.lookup', {
        method: 'tasks.create',
        scope: 'local',
        idempotencyKey: 'legacy',
      }),
      { code: 'NOT_FOUND' },
    );
  } finally {
    await f.cleanup();
  }
  const g = await fixture(
    {},
    {},
    { executionEvidence: { version: 1, terminalCoversExecution: false } },
  );
  try {
    await g.create('unverified');
    g.evidence(0);
    g.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    const snap = await g.status();
    assert.equal(snap.executionOccupied, 1);
    assert.equal(snap.quarantined, 1);
  } finally {
    await g.cleanup();
  }
});

test('A2-06 explicit pre-submission failure releases resources even with an existing native session', async () => {
  const f = await fixture();
  f.config.adapters[0].execute = async function* (input) {
    input.reportExecutionEvidence?.({
      version: 1,
      sequence: 1,
      dispatchId: input.dispatchId,
      sessionId: input.sessionId,
      generation: input.generation!,
      provider: 'fake',
      providerSessionId: 'native-created-before-turn',
      source: 'pre_submission',
      observedAt: new Date().toISOString(),
      localResources: 'stopped',
      remoteExecution: 'stopped',
      detail: 'Native thread exists but no turn was submitted; own resources cleaned',
    });
    yield { type: 'error', outcome: 'failed', message: 'validation before turn submission' };
  };
  try {
    const t = await f.create('no-turn');
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: t.id })) as TaskSnapshot).status,
      'failed',
    );
    const status = await f.status();
    assert.equal(status.executionOccupied, 0);
    assert.equal(status.quarantined, 0);
    assert.equal(status.quarantineReserved, 0);
  } finally {
    await f.cleanup();
  }
});

test('A2-05/06 malformed terminal certificates and foreign native IDs cannot release execution', async () => {
  const f = await fixture({ maxActiveSessions: 1 }, { turnMs: 100 });
  try {
    await f.create('a');
    f.clock.advance(100);
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'no terminal' });
    await flush();
    f.evidence(0, { terminal: { type: 'accepted' } as unknown as ExecutionEvidence['terminal'] });
    await flush();
    assert.equal((await f.status()).executionOccupied, 1, 'accepted is not a terminal certificate');
    f.evidence(0, {
      terminal: { type: 'result', text: 'fake', providerSessionId: 'foreign-session' },
    });
    await flush();
    assert.equal(
      (await f.status()).executionOccupied,
      1,
      'certificate native ID must match its envelope',
    );
    f.evidence(0, { providerSessionId: 'foreign-session' });
    await flush();
    assert.equal((await f.status()).executionOccupied, 1);
    f.evidence(0);
    await flush();
    assert.equal((await f.status()).executionOccupied, 0);
  } finally {
    await f.cleanup();
  }
});

test('A2-07 preserved native terminal certificate rejects replay attestation after cleanup error', async () => {
  const f = await fixture();
  try {
    const t = await f.create('a');
    f.evidence(0, { localResources: 'unknown' });
    f.gates[0]({
      type: 'error',
      outcome: 'unknown',
      message: 'cleanup unconfirmed after native result',
    });
    await flush();
    f.evidence(0, { source: 'resource_observation', terminal: undefined });
    await flush();
    const p = {
      target: target(await f.session(t)),
      evidence: { ...attestation, sideEffects: 'resolved', outcome: 'not_executed' },
      idempotencyKey: 'must-not-replay',
    };
    await assert.rejects(f.engine.call('sessions.reconcile', p, { owner: true }), {
      code: 'EVIDENCE_CONFLICT',
    });
    assert.equal((await f.session(t)).status, 'outcome_unknown');
    assert.equal((await f.status()).quarantined, 1);
    await f.engine.call(
      'sessions.reconcile',
      {
        ...p,
        evidence: {
          ...attestation,
          sideEffects: 'resolved',
          outcome: 'completed',
          result: 'late result',
        },
      },
      { owner: true },
    );
    assert.equal((await f.session(t)).status, 'paused');
  } finally {
    await f.cleanup();
  }
});

test('A2-07 owner may reconcile restored unknown after its original adapter is removed', async () => {
  const f = await fixture({}, { turnMs: 100 });
  let restarted: Engine | undefined;
  try {
    const t = await f.create('a');
    f.clock.advance(100);
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'unknown before owner restart' });
    await flush();
    await f.engine.close();
    const other: RuntimeAdapter = {
      provider: 'other',
      capabilities: () => ({
        provider: 'other',
        resume: false,
        interrupt: false,
        permissionProfiles: ['read-only'],
        executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: null },
      }),
      async *execute() {
        throw new Error('must not execute');
      },
    };
    restarted = await createEngine({ ...f.config, adapters: [other] });
    const session = (await restarted.call('sessions.get', {
      sessionId: t.sessionId,
    })) as SessionSnapshot;
    const op = (await restarted.call(
      'sessions.reconcile',
      { target: target(session), evidence: attestation, idempotencyKey: 'resource' },
      { owner: true },
    )) as OperationSnapshot;
    assert.equal((op.result as Record<string, unknown>).executionReleased, true);
    assert.equal(((await restarted.call('scheduler.get')) as SchedulerSnapshot).quarantined, 1);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});

test('A2-07 partial business claims must not conflict with recorded native results', async () => {
  const f = await fixture();
  try {
    const t = await f.create('a');
    f.evidence(0, { localResources: 'unknown' });
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'cleanup deferred' });
    await flush();
    const p = {
      target: target(await f.session(t)),
      evidence: { ...attestation, outcome: 'completed', result: 'conflicting result' },
      idempotencyKey: 'partial',
    };
    await assert.rejects(f.engine.call('sessions.reconcile', p, { owner: true }), {
      code: 'EVIDENCE_CONFLICT',
    });
    assert.equal((await f.status()).executionOccupied, 1);
    const op = (await f.engine.call(
      'sessions.reconcile',
      { ...p, evidence: attestation },
      { owner: true },
    )) as OperationSnapshot;
    assert.equal((op.result as Record<string, unknown>).executionReleased, true);
  } finally {
    await f.cleanup();
  }
});

test('A2-05 unknown observations preserve prior definitive stop proof until genuine active correction', async () => {
  const f = await fixture({ maxActiveSessions: 1 });
  try {
    const t = await f.create('a');
    await f.create('b');
    f.evidence(0);
    f.evidence(0, {
      source: 'resource_observation',
      localResources: 'unknown',
      remoteExecution: 'unknown',
      terminal: undefined,
    });
    f.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    assert.equal(f.inputs.length, 2);
    assert.equal((await f.session(t)).activeDispatchId, null);
  } finally {
    await f.cleanup();
  }
});

test('A2-08 resuming a paused approval session does not add execution work or consume full quarantine', async () => {
  const f = await fixture({ maxActiveSessions: 1, maxQuarantinedDispatches: 1 });
  try {
    const t = await f.create('approved-result');
    f.evidence(0);
    f.gates[0]({ type: 'result', text: 'late result' });
    await flush();
    await f.engine.call('sessions.control', {
      target: target(await f.session(t)),
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'pause-result',
    });
    await f.create('occupies-quarantine');
    await f.engine.call('sessions.control', {
      target: target(await f.session(t)),
      command: { action: 'resume' },
      idempotencyKey: 'resume-result',
    });
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: t.id })) as TaskSnapshot).status,
      'waiting_approval',
    );
    assert.equal(f.inputs.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('A2-10 legacy adapter resume fails before queuing and does not stop other providers', async () => {
  const f = await fixture({ maxActiveSessions: 1 });
  let restarted: Engine | undefined;
  try {
    await f.create('a');
    const queued = await f.create('queued');
    f.gates[0]({ type: 'error', outcome: 'unknown', message: 'prior observation ended' });
    await flush();
    await f.engine.close();
    const legacy: RuntimeAdapter = {
      provider: 'fake',
      // Deliberately emulate an untyped legacy integration missing budget v2.
      capabilities: () =>
        ({
          provider: 'fake',
          resume: true,
          interrupt: true,
          permissionProfiles: ['read-only'],
        }) as ReturnType<RuntimeAdapter['capabilities']>,
      async *execute() {
        throw new Error('legacy must not execute');
      },
    };
    restarted = await createEngine({ ...f.config, adapters: [legacy] });
    await assert.rejects(
      restarted.call('tasks.resume', { taskId: queued.id, idempotencyKey: 'resume' }),
      { code: 'UNSUPPORTED_CAPABILITY' },
    );
    assert.equal(
      ((await restarted.call('tasks.get', { taskId: queued.id })) as TaskSnapshot).status,
      'paused',
    );
    assert.ok(
      !((await restarted.call('scheduler.get')) as SchedulerSnapshot).reasons.includes(
        'HOST_STOPPING',
      ),
    );
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});

test('A2-07 empty native output remains a real completion and can be reconciled without fake text or replay', async () => {
  for (const result of ['', '   ']) {
    const f = await fixture({}, { turnMs: 100 });
    try {
      const t = await f.create('a');
      f.clock.advance(100);
      f.evidence(0, { terminal: { type: 'result', text: result } });
      f.gates[0]({ type: 'result', text: result });
      await flush();
      await f.engine.call(
        'sessions.reconcile',
        {
          target: target(await f.session(t)),
          evidence: { ...attestation, sideEffects: 'resolved', outcome: 'completed', result },
          idempotencyKey: 'empty-completion',
        },
        { owner: true },
      );
      assert.equal((await f.status()).quarantined, 0);
      await f.engine.call('tasks.resume', { taskId: t.id, idempotencyKey: 'only-approval' });
      const task = (await f.engine.call('tasks.get', { taskId: t.id })) as TaskSnapshot;
      assert.equal(task.status, 'waiting_approval');
      assert.equal(task.result, result);
      assert.equal(f.inputs.length, 1);
    } finally {
      await f.cleanup();
    }
  }
});

test('A2-08/09/11 snapshot samples are bounded and read-only; lowered quota preserves historical unknowns', async () => {
  const f = await fixture({ maxActiveSessions: 1 });
  let restarted: Engine | undefined;
  try {
    for (let i = 0; i < 17; i++) {
      await f.create(`task-${i}`);
      f.evidence(i);
      f.gates[i]({
        type: 'error',
        outcome: 'unknown',
        message: 'business outcome requires separate review',
      });
      await flush();
    }
    const status = await f.status();
    assert.equal(status.quarantined, 17);
    assert.equal(status.executionOccupied, 0);
    assert.equal(status.occupants.length, 16);
    assert.equal(status.truncated, true);
    const eventsBefore = await f.engine.call('events.read', { limit: 1000 });
    await f.status();
    await f.status();
    assert.deepEqual(await f.engine.call('events.read', { limit: 1000 }), eventsBefore);
    await f.engine.close();
    restarted = await createEngine({
      ...f.config,
      limits: { maxActiveSessions: 1, maxQuarantinedDispatches: 1 },
    });
    const restored = (await restarted.call('scheduler.get')) as SchedulerSnapshot;
    assert.equal(restored.quarantined, 17);
    assert.equal(restored.executionOccupied, 0);
    assert.ok(restored.reasons.includes('QUARANTINE_CAPACITY_EXCEEDED'));
    await assert.rejects(restarted.call('tasks.create', { spec, idempotencyKey: 'new' }), {
      code: 'QUARANTINE_CAPACITY_EXCEEDED',
    });
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});

test('A2-09 schema migration backup failure leaves schema1 intact before any new dispatch', async (t) => {
  const f = await fixture();
  try {
    await f.engine.close();
    const db = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'));
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run('1', 'schemaVersion');
    db.exec('DROP TABLE execution_conflicts');
    db.close();
    const prepare = DatabaseSync.prototype.prepare;
    const mocked = t.mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        if (sql === 'VACUUM INTO ?') throw new Error('fixture backup storage unavailable');
        return prepare.call(this, sql);
      },
    );
    await assert.rejects(createEngine(f.config), /fixture backup storage unavailable/);
    mocked.mock.restore();
    const saved = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'), { readOnly: true });
    assert.equal(
      (
        saved.prepare('SELECT value FROM metadata WHERE key=?').get('schemaVersion') as {
          value: string;
        }
      ).value,
      '1',
    );
    assert.equal(
      (saved.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n,
      0,
    );
    saved.close();
    assert.equal(f.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
