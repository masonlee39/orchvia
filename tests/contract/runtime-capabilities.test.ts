import { artifactWritesSettled } from '../../packages/engine/src/store.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInput,
  SchedulerSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const taskSpec = {
  goal: 'Offline capability admission test',
  runtime: { provider: 'fake', model: 'fixture-model' },
  acceptance: { mode: 'human', criteria: ['Fixture review'] },
};
// A turn's end waits for its files (SPEC-0057), so "a few ticks later" includes those writes.
const flush = async () => {
  for (let n = 0; n < 5; n++) {
    await artifactWritesSettled();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

async function fixture(capabilities: () => unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-host-caps-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const base = createFakeAdapter();
  const calls: RuntimeInput[] = [];
  const adapter: RuntimeAdapter = {
    ...base,
    capabilities: () => capabilities() as RuntimeCapabilities,
    async *execute(input) {
      calls.push(input);
      yield* base.execute(input);
    },
  };
  const engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
  });
  return {
    engine,
    calls,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const valid = () => createFakeAdapter().capabilities();
const invalid: [string, () => unknown, string][] = [
  ['null declaration', () => null, 'INVALID_RUNTIME_CONTRACT'],
  ['array declaration', () => [], 'INVALID_RUNTIME_CONTRACT'],
  ['wrong provider', () => ({ ...valid(), provider: 'another-host' }), 'INVALID_RUNTIME_CONTRACT'],
  ['truthy resume', () => ({ ...valid(), resume: 'false' }), 'INVALID_RUNTIME_CONTRACT'],
  ['truthy interrupt', () => ({ ...valid(), interrupt: 'false' }), 'INVALID_RUNTIME_CONTRACT'],
  ['empty profiles', () => ({ ...valid(), permissionProfiles: [] }), 'INVALID_RUNTIME_CONTRACT'],
  [
    'unknown profile',
    () => ({ ...valid(), permissionProfiles: ['read-only', 'full-access'] }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'duplicate profiles',
    () => ({ ...valid(), permissionProfiles: ['read-only', 'read-only'] }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  ['missing budget', () => ({ ...valid(), executionBudget: undefined }), 'UNSUPPORTED_CAPABILITY'],
  ['old budget', () => ({ ...valid(), executionBudget: { version: 1 } }), 'UNSUPPORTED_CAPABILITY'],
  [
    'missing explicit cap',
    () => ({ ...valid(), executionBudget: { version: 2, turnCapMs: null } }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'invalid turn cap',
    () => ({ ...valid(), executionBudget: { version: 2, acceptanceCapMs: null, turnCapMs: 0 } }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  ...[0, -1, 0.5, 86400001, Infinity, NaN, '100', false].map(
    (acceptanceCapMs): [string, () => unknown, string] => [
      `invalid cap ${String(acceptanceCapMs)}`,
      () => ({ ...valid(), executionBudget: { version: 2, acceptanceCapMs, turnCapMs: null } }),
      'INVALID_RUNTIME_CONTRACT',
    ],
  ),
  ['null evidence', () => ({ ...valid(), executionEvidence: null }), 'INVALID_RUNTIME_CONTRACT'],
  [
    'old evidence',
    () => ({ ...valid(), executionEvidence: { version: 0, terminalCoversExecution: true } }),
    'UNSUPPORTED_CAPABILITY',
  ],
  [
    'truthy coverage',
    () => ({ ...valid(), executionEvidence: { version: 1, terminalCoversExecution: 'false' } }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'missing coverage',
    () => ({ ...valid(), executionEvidence: { version: 1 } }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  ['function extension', () => ({ ...valid(), extension: () => true }), 'INVALID_RUNTIME_CONTRACT'],
  ['date extension', () => ({ ...valid(), extension: new Date() }), 'INVALID_RUNTIME_CONTRACT'],
  ['bigint extension', () => ({ ...valid(), extension: 1n }), 'INVALID_RUNTIME_CONTRACT'],
  [
    'undefined array item',
    () => ({ ...valid(), extension: [undefined] }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  ['sparse array', () => ({ ...valid(), extension: Array(2) }), 'INVALID_RUNTIME_CONTRACT'],
  [
    'cyclic extension',
    () => {
      const extension: Record<string, unknown> = {};
      extension.self = extension;
      return { ...valid(), extension };
    },
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'deep extension',
    () => {
      let extension: unknown = null;
      for (let n = 0; n < 33; n++) extension = { nested: extension };
      return { ...valid(), extension };
    },
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'oversized extension traversal',
    () => ({ ...valid(), extension: Array(10001).fill(null) }),
    'INVALID_RUNTIME_CONTRACT',
  ],
  [
    'throwing declaration',
    () => {
      throw new Error('host-private-payload');
    },
    'INVALID_RUNTIME_CONTRACT',
  ],
  ['async declaration', () => Promise.resolve(valid()), 'INVALID_RUNTIME_CONTRACT'],
  [
    'rejected async declaration',
    () => Promise.reject(new Error('host-private-payload')),
    'INVALID_RUNTIME_CONTRACT',
  ],
];

test('AC-H01 malformed host capabilities fail before task persistence and host submission', async (t) => {
  for (const [name, getCapabilities, code] of invalid) {
    await t.test(name, async () => {
      const f = await fixture(getCapabilities);
      try {
        await assert.rejects(
          f.engine.call('tasks.create', { spec: taskSpec, idempotencyKey: 'invalid-contract' }),
          { code },
        );
        assert.equal(f.calls.length, 0);
        await assert.rejects(
          f.engine.call('operations.lookup', {
            method: 'tasks.create',
            scope: 'local',
            idempotencyKey: 'invalid-contract',
          }),
          { code: 'NOT_FOUND' },
        );
        await assert.rejects(f.engine.call('capabilities.get', { provider: 'fake' }), (error) => {
          assert.equal((error as { code: string }).code, code);
          assert.ok(!String(error).includes('host-private-payload'));
          return true;
        });
      } finally {
        await f.close();
      }
    });
  }
});

test('AC-H01 omitted evidence coverage remains conservative and valid cap boundaries stay supported', async () => {
  const capabilities = valid();
  delete capabilities.executionEvidence;
  const f = await fixture(() => capabilities);
  try {
    const original = (await f.engine.call('tasks.create', {
      spec: taskSpec,
      idempotencyKey: 'no-proof',
    })) as TaskSnapshot;
    let current = original;
    for (let n = 0; n < 100 && current.status !== 'blocked'; n++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      current = (await f.engine.call('tasks.get', { taskId: original.id })) as TaskSnapshot;
    }
    assert.equal(current.status, 'blocked');
    assert.equal(
      ((await f.engine.call('scheduler.get')) as SchedulerSnapshot).executionOccupied,
      1,
    );
    for (const cap of [null, 1, 86400000]) {
      capabilities.executionBudget = { version: 2, acceptanceCapMs: cap, turnCapMs: cap };
      const snapshot = (await f.engine.call('capabilities.get', {
        provider: 'fake',
      })) as RuntimeCapabilities;
      assert.deepEqual(snapshot.executionBudget, capabilities.executionBudget);
      assert.equal(Object.hasOwn(snapshot, 'executionEvidence'), false);
    }
  } finally {
    await f.close();
  }
});

test('AC-H01 capability snapshots are detached and frozen, preserving valid JSON extensions', async () => {
  const original = {
    ...valid(),
    extension: { names: ['one', 'two'], enabled: true, absent: undefined, value: null },
  };
  const f = await fixture(() => original);
  try {
    const snapshot = (await f.engine.call('capabilities.get', {
      provider: 'fake',
    })) as RuntimeCapabilities;
    (
      (original as unknown as RuntimeCapabilities).executionBudget as { turnCapMs: number | null }
    ).turnCapMs = 123;
    original.extension.names.push('changed');
    assert.equal(
      snapshot.executionBudget &&
        (snapshot.executionBudget as { turnCapMs: number | null }).turnCapMs,
      null,
    );
    assert.deepEqual(snapshot.extension, { names: ['one', 'two'], enabled: true, value: null });
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.executionBudget));
    assert.ok(Object.isFrozen((snapshot.extension as { names: string[] }).names));
  } finally {
    await f.close();
  }
});

test('AC-H01 queued work rechecks its permission capability before entering the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-host-queue-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const base = createFakeAdapter();
  let capabilities = base.capabilities();
  const inputs: RuntimeInput[] = [];
  const releases: (() => void)[] = [];
  const adapter: RuntimeAdapter = {
    ...base,
    capabilities: () => capabilities,
    async *execute(input) {
      inputs.push(input);
      await new Promise<void>((resolve) => releases.push(resolve));
      yield* base.execute(input);
    },
    async close() {
      for (const release of releases) release();
    },
  };
  const engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    limits: { maxActiveSessions: 1 },
  });
  try {
    await engine.call('tasks.create', { spec: taskSpec, idempotencyKey: 'first' });
    await flush();
    const second = (await engine.call('tasks.create', {
      spec: taskSpec,
      idempotencyKey: 'second',
    })) as TaskSnapshot;
    capabilities = { ...capabilities, permissionProfiles: ['workspace-write'] };
    releases[0]();
    // The first turn ends once its files are on disk (SPEC-0057); only then is the second considered.
    let task = second;
    for (const until = Date.now() + 10_000; task.status === 'queued' && Date.now() < until; ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      task = (await engine.call('tasks.get', { taskId: second.id })) as TaskSnapshot;
    }
    assert.equal(inputs.length, 1, 'permission removal must prevent the second submission');
    assert.equal(task.status, 'paused');
    assert.match(task.reason!, /UNSUPPORTED_CAPABILITY:.*read-only/);
  } finally {
    await adapter.close!();
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});
