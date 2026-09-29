import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, validateWire } from '../../packages/sdk-typescript/src/index.ts';

// SPEC-0045 R02: the wire, the flag and the TypeScript SDK.

const lifecycle = { version: 1, reconcile: 'owner-attestation', durableDeadlines: true };
const info = (workflow: Record<string, unknown>) => ({
  protocolVersion: '2.0' as const,
  engineVersion: 'fixture',
  schemaVersion: 3,
  instanceId: 'fixture',
  storeId: 'store',
  capabilities: {
    storeNamespaces: { version: 1 },
    lifecycle,
    workflow: { version: 1, ...workflow },
  },
});
const target = {
  sessionId: 's',
  expectedGeneration: 1,
  expectedRevision: 1,
  expectedDispatchId: 'd',
  expectedState: 'outcome_unknown' as const,
};
const evidence = {
  source: 'owner_attestation' as const,
  summary: 'checked',
  localResources: 'stopped' as const,
  remoteExecution: 'stopped' as const,
  sideEffects: 'resolved' as const,
  outcome: 'completed' as const,
};
function client(workflow: Record<string, unknown>) {
  const calls: string[] = [];
  const orch = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        return { id: 'op', status: 'completed' } as T;
      },
      disconnect() {},
    },
    info(workflow),
    true,
  );
  return { orch, calls };
}

test('AC-0045-R02 the schema accepts a completed attestation without result', () => {
  assert.doesNotThrow(() => validateWire('ReconcileEvidence', evidence));
  assert.doesNotThrow(() => validateWire('ReconcileEvidence', { ...evidence, result: 'x' }));
  assert.throws(() =>
    validateWire('ReconcileEvidence', { ...evidence, outcome: 'failed', result: 'x' }),
  );
});

test('AC-0045-R02 AC-0045-R03 the SDK sends them only to a host that lists the flag', async () => {
  const old = client({});
  await assert.rejects(old.orch.sessions.reconcile(target, evidence), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  assert.deepEqual(old.calls, []);
  // With a result, an older host still takes it.
  await old.orch.sessions.reconcile(target, { ...evidence, result: 'x' });
  assert.deepEqual(old.calls, ['sessions.reconcile']);
  await assert.rejects(old.orch.sessions.reconcile(target, { ...evidence, outcome: 'recorded' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  assert.deepEqual(old.calls, ['sessions.reconcile']);
  const current = client({ reconcileRecordedResult: true });
  await current.orch.sessions.reconcile(target, evidence);
  assert.deepEqual(current.calls, ['sessions.reconcile']);
});
