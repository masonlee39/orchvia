import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeEvent,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0045 R01: a completed attestation may take the dispatch's recorded result.

const RESULT = 'Created the directory reports/2026';
const spec = {
  goal: 'mkdir',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
};
const attestation = {
  source: 'owner_attestation',
  summary: 'The command ended and the directory exists',
  localResources: 'stopped',
  remoteExecution: 'stopped',
  sideEffects: 'resolved',
  outcome: 'completed',
};

/**
 * A runtime that returns `result` but whose terminal does not prove execution stopped, as a
 * dispatch whose stop observation found strays. `result: null` ends in an unknown error instead.
 */
async function blocked(result: string | null | RuntimeEvent) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-reconcile-recorded-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...fake,
    capabilities: () => ({
      ...fake.capabilities(),
      executionEvidence: { version: 1, terminalCoversExecution: false },
    }),
    async *execute() {
      yield { type: 'accepted', providerSessionId: 'native' };
      yield result === null
        ? { type: 'error', message: 'the runtime stopped answering', outcome: 'unknown' }
        : typeof result === 'string'
          ? { type: 'result', text: result, providerSessionId: 'native' }
          : result;
    },
  };
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
  });
  const task = (await engine.call('tasks.create', {
    spec,
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  let session!: SessionSnapshot;
  for (let i = 0; i < 400; i++) {
    session = (await engine.call('sessions.get', { sessionId: task.sessionId })) as SessionSnapshot;
    if (session.status === 'outcome_unknown') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(session.status, 'outcome_unknown');
  const target = {
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedDispatchId: session.activeDispatchId,
    expectedState: session.status,
  };
  return {
    engine,
    task,
    reconcile: (evidence: Record<string, unknown>, key = 'reconcile') =>
      engine.call('sessions.reconcile', { target, evidence, idempotencyKey: key }, { owner: true }),
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('AC-0045-R01 completed without result takes the recorded result, for acceptance', async () => {
  const f = await blocked(RESULT);
  try {
    await f.reconcile(attestation);
    const task = (await f.engine.call('tasks.get', { taskId: f.task.id })) as TaskSnapshot;
    assert.equal(task.status, 'paused');
    assert.equal(task.reason, 'reconciled_result');
    assert.equal(task.result, RESULT);
  } finally {
    await f.close();
  }
});

test('AC-0045-R01 a given result must still equal the recorded one', async () => {
  const f = await blocked(RESULT);
  try {
    await assert.rejects(f.reconcile({ ...attestation, result: 'something else' }), {
      code: 'EVIDENCE_CONFLICT',
    });
    await f.reconcile({ ...attestation, result: RESULT }, 'exact');
    const task = (await f.engine.call('tasks.get', { taskId: f.task.id })) as TaskSnapshot;
    assert.equal(task.result, RESULT);
  } finally {
    await f.close();
  }
});

test('AC-0045-R01 without a recorded result, completed still needs one', async () => {
  const f = await blocked(null);
  try {
    await assert.rejects(f.reconcile(attestation), { code: 'VALIDATION_ERROR' });
    await f.reconcile({ ...attestation, result: 'Checked by hand' }, 'given');
    const task = (await f.engine.call('tasks.get', { taskId: f.task.id })) as TaskSnapshot;
    assert.equal(task.result, 'Checked by hand');
  } finally {
    await f.close();
  }
});

test('AC-0045-R02 initialize lists workflow.reconcileRecordedResult', async () => {
  const f = await blocked(RESULT);
  try {
    const info = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(
      (info.capabilities.workflow as Record<string, unknown>).reconcileRecordedResult,
      true,
    );
  } finally {
    await f.close();
  }
});

test('AC-0045-R03 recorded takes the outcome of the recorded terminal', async () => {
  const cases: [RuntimeEvent | string, string, string][] = [
    [RESULT, 'completed', 'paused'],
    [{ type: 'interrupted' }, 'interrupted', 'failed'],
    [{ type: 'error', message: 'the command failed', outcome: 'failed' }, 'failed', 'failed'],
  ];
  for (const [terminal, outcome, status] of cases) {
    const f = await blocked(terminal);
    try {
      const op = (await f.reconcile({ ...attestation, outcome: 'recorded' })) as OperationSnapshot;
      assert.equal((op.result as { outcome: string }).outcome, outcome);
      const task = (await f.engine.call('tasks.get', { taskId: f.task.id })) as TaskSnapshot;
      assert.equal(task.status, status, outcome);
      if (outcome === 'completed') assert.equal(task.result, RESULT);
      else assert.equal(task.reason, `reconciled_${outcome}`);
    } finally {
      await f.close();
    }
  }
});

test('AC-0045-R03 recorded needs a settled terminal and takes no result', async () => {
  const f = await blocked(null);
  try {
    await assert.rejects(f.reconcile({ ...attestation, outcome: 'recorded' }), {
      code: 'VALIDATION_ERROR',
    });
  } finally {
    await f.close();
  }
  const g = await blocked(RESULT);
  try {
    await assert.rejects(g.reconcile({ ...attestation, outcome: 'recorded', result: RESULT }), {
      code: 'VALIDATION_ERROR',
    });
  } finally {
    await g.close();
  }
});
