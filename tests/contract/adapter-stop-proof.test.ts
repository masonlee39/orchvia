import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
} from '../../packages/adapter-claude/src/index.ts';
import {
  createCodexAdapter,
  type CodexAdapterConfig,
} from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeCapabilities } from '../../packages/engine/src/types.ts';

// SPEC-0027 A: an adapter that cannot prove that execution stopped is refused when it is created,
// not when execution capacity runs out.

const claude = (config: Record<string, unknown>) =>
  createClaudeAdapter(config as ClaudeAdapterConfig);
const codex = (config: Record<string, unknown>) => createCodexAdapter(config as CodexAdapterConfig);
const covers = (adapter: { capabilities(): unknown }) =>
  (adapter.capabilities() as RuntimeCapabilities).executionEvidence?.terminalCoversExecution;
const observer = async () => true;
const refused = (error: Error & { code?: string }) => {
  assert.equal(error.code, 'INVALID_ADAPTER_CONFIG');
  assert.match(error.message, /observeExecutionStop/);
  assert.match(error.message, /owner-reconcile/);
  return true;
};

test('0027-A01 a Claude adapter without proof of stop is refused when it is created', () => {
  for (const config of [
    { options: {} },
    { extendOptions: () => ({}) },
    { permissionProfile: 'workspace-write' },
    { permissionProfile: 'workspace-write', options: {}, extendOptions: () => ({}) },
  ])
    assert.throws(() => claude(config), refused, JSON.stringify(Object.keys(config)));
  // The adapter that owns its options still vouches for its own terminal.
  assert.equal(covers(claude({})), true);
  assert.equal(covers(claude({ permissionProfile: 'read-only' })), true);
  for (const config of [
    { options: {}, observeExecutionStop: observer },
    { extendOptions: () => ({}), observeExecutionStop: observer },
    { permissionProfile: 'workspace-write', observeExecutionStop: observer },
  ])
    assert.equal(covers(claude(config)), true);
});

test('0027-A02 owner reconciliation is an explicit choice and excludes an observer', () => {
  for (const config of [
    { options: {} },
    { extendOptions: () => ({}) },
    { permissionProfile: 'workspace-write' },
  ])
    assert.equal(covers(claude({ ...config, executionStop: 'owner-reconcile' })), false);
  assert.throws(
    () =>
      claude({
        permissionProfile: 'workspace-write',
        executionStop: 'owner-reconcile',
        observeExecutionStop: observer,
      }),
    { code: 'INVALID_ADAPTER_CONFIG' },
  );
  assert.throws(() => claude({ executionStop: 'sometimes' }), { code: 'INVALID_ADAPTER_CONFIG' });
});

test('0027-A03 a writable Codex adapter needs the same proof', () => {
  assert.throws(() => codex({ permissionProfile: 'workspace-write' }), refused);
  // SPEC-0034 A01 supersedes the read-only coverage this test once asserted here.
  assert.throws(() => codex({}), refused);
  assert.equal(
    covers(codex({ permissionProfile: 'workspace-write', observeExecutionStop: observer })),
    true,
  );
  assert.equal(
    covers(codex({ permissionProfile: 'workspace-write', executionStop: 'owner-reconcile' })),
    false,
  );
  assert.throws(
    () =>
      codex({
        permissionProfile: 'workspace-write',
        executionStop: 'owner-reconcile',
        observeExecutionStop: observer,
      }),
    { code: 'INVALID_ADAPTER_CONFIG' },
  );
});
