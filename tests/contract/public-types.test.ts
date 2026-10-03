import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../fixtures/engine.ts';
import {
  createOrchestrator,
  type ContextEstimateInput,
  type ContextEstimateResult,
  type ContextPlanInput,
  type CostSummary,
  type Orchestrator,
  type RolloverRecord,
  type SessionControlCommand,
  type StateSnapshotPage,
  type StoragePolicy,
  type StorageStatus,
  type TaskSpecInput,
} from '../../packages/sdk-typescript/src/index.ts';

// SPEC-0027 T: the public types match the wire. `npm run typecheck` checks this file; the calls
// below use realistic values and no casts.

const plan: ContextPlanInput = { requestedMode: 'fresh', independent: true };
const task: TaskSpecInput = {
  goal: 'Typed request',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  contextPlan: plan,
};
const estimate: ContextEstimateInput = {
  provider: 'fake',
  model: 'fixture',
  keepHistoryTokens: 1000,
  compactHistoryTokens: 200,
  requests: 2,
  growthTokens: 100,
  outputTokens: 50,
  retainedPrefixTokens: 100,
  compaction: {
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 200,
  },
  intervalsMs: [1000, 1000],
  ttlMs: 300000,
};

/** Every call compiles against the public types without a cast; not every one runs. */
async function typed(orch: Orchestrator) {
  const created = await orch.tasks.create(task);
  const costs: CostSummary = await orch.costs.get(created.id, 'tree');
  const totals: Record<string, string> = costs.totals;
  const unknownCount: number = costs.unknownRecords;
  const result: ContextEstimateResult = await orch.context.estimate(estimate);
  const status: StorageStatus = await orch.storage.status();
  const policy: StoragePolicy = status.policy;
  const configured = await orch.storage.configure({ quotaBytes: policy.quotaBytes });
  const page: StateSnapshotPage = await orch.state.snapshot();
  const rollover: RolloverRecord = await orch.stores.rollover();
  const session = await orch.sessions.get(created.initial.sessionId!);
  const command: SessionControlCommand = { action: 'pause', mode: 'interrupt' };
  const target = {
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedDispatchId: session.activeDispatchId,
    expectedState: session.status,
  };
  await orch.sessions.control(target, command);
  // @ts-expect-error The engine accepts only pause, resume and stop.
  await orch.sessions.control(target, { action: 'explode' });
  return { totals, unknownCount, result, configured, page, rollover };
}
void typed;

test('0027-T01 0027-T02 results have the declared shapes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-public-types-')));
  await mkdir(join(root, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
    pricing: [
      {
        provider: 'fake',
        model: 'fixture',
        currency: 'USD',
        version: 'test',
        inputTokenMode: 'total',
        perMillion: { input: '1', output: '2' },
      },
    ],
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  // The plan's other fields default on the engine, including the host's queue wait.
  const created = await orch.tasks.create(task);
  assert.deepEqual(created.initial.spec.contextPlan, {
    requestedMode: 'fresh',
    independent: true,
    dependencyTaskIds: [],
    contextRefs: [],
    fallbackModes: [],
    maxQueueWaitMs: 30000,
  });
  const costs = await orch.costs.get(created.id, 'tree');
  assert.equal(costs.scope, 'tree');
  assert.equal(costs.basis, 'registered-price estimate; not a provider bill');
  assert.ok(Array.isArray(costs.records));
  const result = await orch.context.estimate(estimate);
  assert.ok('scenarios' in result && result.scenarios.sustained_hit.keep.requests === 2);
  const status = await orch.storage.status();
  assert.equal(status.storeId, orch.info.storeId);
  assert.equal(status.policy.emergencyBytes, 4096);
  const page = await orch.state.snapshot();
  assert.equal(page.storeId, orch.info.storeId);
  assert.ok(page.items.length >= 1);
  await orch.state.releaseSnapshot(page.snapshotId);
});
