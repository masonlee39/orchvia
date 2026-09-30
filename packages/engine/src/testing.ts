import { MUTATIONS } from './identity.ts';
/** Optional Node test entry point. Normal engine/SDK imports never load this module. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fail } from './errors.ts';
import { createEngine } from './index.ts';
import { reportedUsage } from './usage.ts';
import type {
  ApprovalRequest,
  Engine,
  EngineConfig,
  EngineRuntimeInput,
  EventPage,
  OperationSnapshot,
  RuntimeAdapter,
  SchedulerSnapshot,
  SessionSnapshot,
  TaskSnapshot,
  UsageRecord,
} from './types.ts';

export type RuntimeContractAction =
  | 'accept'
  | 'confirm-tool'
  | 'reject'
  | 'finish'
  | 'main-result'
  | 'disconnect'
  | 'stale-stop'
  | 'wrong-dispatch-stop'
  | 'stop';

/**
 * Implement actions at the controlled host/native boundary, never by writing engine state.
 * finish emits the declared result, duplicate usage with one stable ID, and full stop proof.
 * main-result leaves owned background resources alive; stop observes the entire owned execution.
 */
export interface RuntimeContractFixture {
  adapter: RuntimeAdapter;
  result: string;
  usage: Omit<UsageRecord, 'id' | 'taskId' | 'dispatchId' | 'provider'>;
  submissions(): readonly EngineRuntimeInput[];
  nativeIdentity(dispatchId: string): { sessionId: string; turnId: string };
  observationEnded(dispatchId: string): boolean;
  act(dispatchId: string, action: RuntimeContractAction): void | Promise<void>;
  dispose(): void | Promise<void>;
}

async function bounded<T>(value: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Runtime contract timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error(`Runtime contract timed out: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
const task = (engine: Engine, id: string) =>
  engine.call('tasks.get', { taskId: id }) as Promise<TaskSnapshot>;
const session = (engine: Engine, id: string) =>
  engine.call('sessions.get', { sessionId: id }) as Promise<SessionSnapshot>;
const scheduler = (engine: Engine) => engine.call('scheduler.get') as Promise<SchedulerSnapshot>;
const events = async (engine: Engine, id: string) =>
  ((await engine.call('events.read', { taskId: id })) as EventPage).events;

async function harness(
  t: TestContext,
  createFixture: () => RuntimeContractFixture | Promise<RuntimeContractFixture>,
  timeouts?: EngineConfig['timeouts'],
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-host-contract-')));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  let fixture: RuntimeContractFixture | undefined;
  let engine: Engine | undefined;
  t.after(async () => {
    try {
      if (fixture)
        await bounded(
          Promise.resolve().then(() => fixture!.dispose()),
          'host cleanup',
        );
    } finally {
      try {
        if (engine) await engine.close({ mode: 'interrupt', timeoutMs: 2000 });
      } catch (error) {
        t.diagnostic(`Incomplete engine cleanup; inspect retained temporary state: ${dir}`);
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
  const host = await bounded(
    Promise.resolve().then(() => createFixture()),
    'create fixture',
  );
  fixture = host;
  const active = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [host.adapter],
    limits: { maxActiveSessions: 1 },
    storage: { emergencyBytes: 4096 },
    timeouts,
  });
  engine = active;
  const create = () =>
    active.call('tasks.create', {
      expectedStoreId: active.storeId,
      idempotencyKey: 'same-business-request',
      spec: {
        goal: 'Deterministic host conformance request',
        runtime: { provider: host.adapter.provider, model: 'offline-host-model' },
        acceptance: { mode: 'human', criteria: ['Explicit fixture review after host execution'] },
      },
    }) as Promise<TaskSnapshot>;
  const created = await create();
  await until(() => host.submissions().length === 1, 'host submission');
  const input = host.submissions()[0];
  assert.equal(input.taskId, created.id);
  assert.equal(input.sessionId, created.sessionId);
  assert.equal(input.workspace, workspace);
  assert.ok(input.generation > 0);
  assert.equal(input.executionBudget.policyVersion, 2);
  const act = (action: RuntimeContractAction) =>
    bounded(
      Promise.resolve().then(() => host.act(input.dispatchId, action)),
      action,
    );
  return { engine: active, fixture: host, created, input, create, act };
}

async function approve(engine: Engine, id: string) {
  const current = await task(engine, id);
  assert.equal(current.status, 'waiting_approval');
  const approval = (await engine.call('approvals.get', {
    approvalId: current.approvalId,
  })) as ApprovalRequest;
  assert.equal(approval.purpose, 'task_acceptance');
  await engine.call('approvals.decide', {
    expectedStoreId: engine.storeId,
    approvalId: approval.approvalId,
    decision: { expectedRevision: approval.revision, choice: 'approve' },
    idempotencyKey: 'explicit-test-review',
  });
  assert.equal((await task(engine, id)).status, 'completed');
}

/** Register offline tests against a fresh, caller-supplied controlled host for each scenario. */
export function registerRuntimeAdapterContract(
  name: string,
  createFixture: () => RuntimeContractFixture | Promise<RuntimeContractFixture>,
): void {
  test(
    `${name}: AC-H02/H03/H07 native acceptance, deduplicated usage, and separate task review`,
    { timeout: 10000 },
    async (t) => {
      const f = await harness(t, createFixture);
      assert.equal((await session(f.engine, f.created.sessionId)).providerSessionId, null);
      assert.ok(
        !(await events(f.engine, f.created.id)).some((e) => e.type === 'dispatch.runtime_accepted'),
      );
      assert.equal((await f.create()).id, f.created.id);
      assert.equal(f.fixture.submissions().length, 1);
      await f.act('accept');
      await until(
        async () => (await session(f.engine, f.created.sessionId)).providerSessionId !== null,
        'native acceptance',
      );
      assert.equal(
        (await session(f.engine, f.created.sessionId)).providerSessionId,
        f.fixture.nativeIdentity(f.input.dispatchId).sessionId,
      );
      await f.act('confirm-tool');
      assert.equal((await task(f.engine, f.created.id)).status, 'running');
      await f.act('finish');
      await until(
        async () => (await task(f.engine, f.created.id)).status === 'waiting_approval',
        'result review',
      );
      assert.equal((await task(f.engine, f.created.id)).result, f.fixture.result);
      assert.equal((await scheduler(f.engine)).executionOccupied, 0);
      assert.equal((await task(f.engine, f.created.id)).status, 'waiting_approval');
      const usage = (await f.engine.call('usage.get', { taskId: f.created.id })) as {
        records: UsageRecord[];
      };
      assert.equal(usage.records.length, 1);
      // The fields that the runtime reported; the engine adds the rest (SPEC-0028 E01).
      const {
        id: _id,
        taskId: _task,
        dispatchId: _dispatch,
        provider: _provider,
        ...reported
      } = reportedUsage(usage.records[0]);
      assert.deepEqual(reported, f.fixture.usage);
      await approve(f.engine, f.created.id);
      assert.equal(f.fixture.submissions().length, 1);
    },
  );

  test(
    `${name}: AC-H03 queued host rejection is not native acceptance`,
    { timeout: 10000 },
    async (t) => {
      const f = await harness(t, createFixture);
      await f.act('reject');
      await until(
        async () => (await task(f.engine, f.created.id)).status === 'failed',
        'pre-submission rejection',
      );
      assert.equal((await scheduler(f.engine)).executionOccupied, 0);
      assert.equal((await session(f.engine, f.created.sessionId)).providerSessionId, null);
      assert.ok(
        !(await events(f.engine, f.created.id)).some((e) => e.type === 'dispatch.runtime_accepted'),
      );
      assert.equal((await task(f.engine, f.created.id)).approvalId, null);
    },
  );

  for (const accepted of [false, true]) {
    test(
      `${name}: AC-H04 ambiguous disconnect ${accepted ? 'after' : 'before'} native acceptance is never retried`,
      { timeout: 10000 },
      async (t) => {
        const f = await harness(t, createFixture);
        if (accepted) await f.act('accept');
        await f.act('disconnect');
        await until(
          async () => (await task(f.engine, f.created.id)).status === 'blocked',
          'unknown outcome',
        );
        const current = await session(f.engine, f.created.sessionId);
        assert.equal(current.status, 'outcome_unknown');
        assert.equal(current.providerSessionId !== null, accepted);
        assert.equal((await scheduler(f.engine)).executionOccupied, 1);
        assert.equal((await f.create()).id, f.created.id);
        await events(f.engine, f.created.id);
        await scheduler(f.engine);
        assert.equal(f.fixture.submissions().length, 1);
      },
    );
  }

  test(
    `${name}: AC-H05 cancellation acknowledgement cannot stand in for stop proof`,
    { timeout: 10000 },
    async (t) => {
      const f = await harness(t, createFixture);
      await f.act('accept');
      const cancel = () =>
        f.engine.call('tasks.cancel', {
          expectedStoreId: f.engine.storeId,
          taskId: f.created.id,
          idempotencyKey: 'cancel',
        });
      if (!f.fixture.adapter.capabilities().interrupt) {
        await assert.rejects(cancel(), { code: 'UNSUPPORTED_CAPABILITY' });
        assert.equal(f.input.signal.aborted, false);
        assert.equal((await scheduler(f.engine)).executionOccupied, 1);
        return;
      }
      const operation = (await cancel()) as OperationSnapshot;
      await until(
        async () => (await task(f.engine, f.created.id)).status === 'blocked',
        'unconfirmed cancellation',
      );
      assert.equal(f.input.signal.aborted, true);
      assert.equal((await scheduler(f.engine)).executionOccupied, 1);
      const recorded = (await f.engine.call('operations.get', {
        operationId: operation.id,
      })) as OperationSnapshot;
      assert.equal(recorded.status, 'outcome_unknown');
      await f.act('stop');
      await until(
        async () => (await scheduler(f.engine)).executionOccupied === 0,
        'late complete stop proof',
      );
      assert.equal((await scheduler(f.engine)).quarantined, 1);
      assert.equal((await task(f.engine, f.created.id)).status, 'blocked');
      assert.equal(f.fixture.submissions().length, 1);
    },
  );

  test(
    `${name}: AC-H06 live background work, stale evidence, and explicit result reconciliation`,
    { timeout: 10000 },
    async (t) => {
      const f = await harness(t, createFixture);
      await f.act('accept');
      await f.act('main-result');
      await until(
        async () => (await task(f.engine, f.created.id)).status === 'blocked',
        'background work retention',
      );
      assert.equal((await scheduler(f.engine)).executionOccupied, 1);
      assert.equal((await task(f.engine, f.created.id)).approvalId, null);
      await f.act('stale-stop');
      await f.act('wrong-dispatch-stop');
      assert.equal(
        (await events(f.engine, f.created.id)).filter(
          (e) => e.type === 'execution.evidence_rejected',
        ).length,
        2,
      );
      assert.equal((await scheduler(f.engine)).executionOccupied, 1);
      await f.act('stop');
      await until(
        async () => (await scheduler(f.engine)).executionOccupied === 0,
        'background exit observation',
      );
      assert.equal((await scheduler(f.engine)).quarantined, 1);
      const current = await session(f.engine, f.created.sessionId);
      await f.engine.call(
        'sessions.reconcile',
        {
          expectedStoreId: f.engine.storeId,
          target: {
            sessionId: current.id,
            expectedGeneration: current.generation,
            expectedRevision: current.revision,
            expectedDispatchId: current.activeDispatchId,
            expectedState: current.status,
          },
          evidence: {
            source: 'owner_attestation',
            summary:
              'Offline fixture owner observed full execution stop and reviewed the retained result.',
            localResources: 'stopped',
            remoteExecution: 'stopped',
            sideEffects: 'resolved',
            outcome: 'completed',
            result: f.fixture.result,
          },
          idempotencyKey: 'owner-review',
        },
        { owner: true },
      );
      assert.equal((await task(f.engine, f.created.id)).status, 'paused');
      await f.engine.call('tasks.resume', {
        expectedStoreId: f.engine.storeId,
        taskId: f.created.id,
        idempotencyKey: 'review-only',
      });
      await approve(f.engine, f.created.id);
      assert.equal(f.fixture.submissions().length, 1);
    },
  );

  test(
    `${name}: AC-H02 host queue waiting consumes the original acceptance budget`,
    { timeout: 10000 },
    async (t) => {
      const f = await harness(t, createFixture, { acceptanceMs: 30, turnMs: 1000 });
      const budget = f.input.executionBudget;
      assert.equal(budget.effectiveAcceptanceMs, 30);
      await until(
        async () => (await task(f.engine, f.created.id)).status === 'blocked',
        'host admission deadline',
      );
      await until(
        () => f.fixture.observationEnded(f.input.dispatchId),
        'bounded adapter observation',
      );
      assert.equal(budget.remainingAcceptanceMs(), 0);
      assert.equal((await scheduler(f.engine)).executionOccupied, 1);
      assert.equal((await session(f.engine, f.created.sessionId)).providerSessionId, null);
      assert.equal(f.fixture.submissions().length, 1);
    },
  );
}

/**
 * SPEC-0051 E03: marks a closed store as holding `feature`, data of the engine `engineVersion`, so
 * that a test can see an engine refuse it with `STORE_TOO_NEW`. Refuses with HOST_ALREADY_RUNNING
 * while an engine holds the store. Recording the same feature again changes nothing.
 */
export async function markStoreFeatureForTest(
  stateDir: string,
  feature: { name: string; engineVersion: string },
): Promise<void> {
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!text(feature?.name) || !text(feature?.engineVersion))
    fail('VALIDATION_ERROR', 'A feature needs a name and an engineVersion of 1 to 128 characters');
  if (!existsSync(join(stateDir, 'store.sqlite')))
    fail('NOT_FOUND', 'No store in stateDir', { stateDir });
  const lock = new DatabaseSync(join(stateDir, 'owner.sqlite'));
  try {
    try {
      lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch (error) {
      if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error)))
        fail('HOST_ALREADY_RUNNING', 'An engine holds the store', { stateDir });
      throw error;
    }
    const db = new DatabaseSync(join(stateDir, 'store.sqlite'));
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key='storeFeatures'").get() as
        | { value: string }
        | undefined;
      const features = row ? (JSON.parse(row.value) as { name: string }[]) : [];
      if (features.some((recorded) => recorded.name === feature.name)) return;
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES ('storeFeatures',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(
        JSON.stringify([...features, { name: feature.name, engineVersion: feature.engineVersion }]),
      );
    } finally {
      db.close();
    }
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
}
