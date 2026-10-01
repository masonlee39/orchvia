import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { Store, artifactWritesSettled } from '../../packages/engine/src/store.ts';

/** Waits until the cancelled turn has ended and released its lease, files included (SPEC-0057). */
async function idle(engine: { call(method: string, params?: object): Promise<unknown> }) {
  for (let i = 0; i < 400; i++) {
    await artifactWritesSettled();
    const scheduler = (await engine.call('scheduler.get', {})) as { executionOccupied: number };
    if (scheduler.executionOccupied === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('the cancelled turn did not end');
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-rollover-')));
  for (const name of ['work', 'state', 'control', 'stores', 'archives'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const config = {
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096, minFreeBytes: 0 },
    stores: {
      controlDir: join(root, 'control'),
      storesRoot: join(root, 'stores'),
      archiveRoot: join(root, 'archives'),
    },
  };
  return { root, config };
}
const spec = {
  goal: 'archive fixture',
  runtime: { provider: 'fake', model: 'fake' },
  acceptance: { mode: 'human' as const, criteria: ['review'] },
};
test('B10/B13/B14/B17 settled rollover preserves archive receipts and fences old namespace/writer', async () => {
  const f = fixture();
  const engine = await createEngine(f.config as any);
  const original = engine.storeId;
  const call = (method: string, params: Record<string, unknown> = {}) =>
    engine.call(method, { expectedStoreId: original, ...params }, { owner: true });
  try {
    const task = (await call('tasks.create', { spec, idempotencyKey: 'K' })) as any;
    await call('tasks.cancel', { taskId: task.id, idempotencyKey: 'cancel' });
    await idle(engine);
    const rollover = (await call('stores.rollover', { idempotencyKey: 'switch' })) as any;
    assert.equal(rollover.status, 'completed');
    assert.notEqual(engine.storeId, original);
    await assert.rejects(call('tasks.create', { spec, idempotencyKey: 'K' }), {
      code: 'STORE_NAMESPACE_MISMATCH',
    });
    const archived = (await engine.call('archives.lookup', {
      storeId: original,
      method: 'tasks.create',
      scope: 'local',
      idempotencyKey: 'K',
    })) as any;
    assert.equal(archived.targetId, task.id);
    assert.equal(
      ((await call('stores.rollover', { idempotencyKey: 'switch' })) as any).rolloverId,
      rollover.rolloverId,
    );
    assert.throws(() => new Store(f.config.workspace, f.config.stateDir), {
      code: 'STORE_RETIRED',
    });
    const newTask = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'K',
      expectedStoreId: engine.storeId,
    })) as any;
    assert.notEqual(newTask.id, task.id);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('B11/B12/B13 blockers, snapshot leases, owner auth and archive corruption fail closed', async () => {
  const f = fixture();
  const engine = await createEngine(f.config as any);
  const original = engine.storeId;
  const raw = { expectedStoreId: original, idempotencyKey: 'switch' };
  try {
    await assert.rejects(engine.call('stores.rollover', raw), { code: 'UNAUTHORIZED' });
    const lease = (await engine.call('state.snapshot')) as any;
    await assert.rejects(
      engine.call('stores.rollover', raw, { owner: true }),
      (error: any) =>
        error.code === 'ROLLOVER_BLOCKED' &&
        error.details.blockers.some((item: any) => item.id === lease.snapshotId),
    );
    await engine.call('state.releaseSnapshot', { snapshotId: lease.snapshotId });
    const result = (await engine.call('stores.rollover', raw, { owner: true })) as any;
    const manifest = JSON.parse(
      readFileSync(join(f.config.stores.controlDir, 'manifest.json'), 'utf8'),
    );
    const path = join(
      f.config.stores.archiveRoot,
      manifest.archives[original].directory,
      'store.sqlite',
    );
    const originalDatabase = readFileSync(path);
    rmSync(path);
    await assert.rejects(
      engine.call('archives.lookup', {
        storeId: original,
        method: 'tasks.create',
        scope: 'local',
        idempotencyKey: 'missing',
      }),
      { code: 'ARCHIVE_CORRUPT' },
    );
    writeFileSync(path, originalDatabase);
    writeFileSync(path, 'corrupt owned archive');
    await assert.rejects(
      engine.call('archives.lookup', {
        storeId: original,
        method: 'tasks.create',
        scope: 'local',
        idempotencyKey: 'missing',
      }),
      { code: 'ARCHIVE_CORRUPT' },
    );
    assert.equal(
      ((await engine.call('rollovers.get', { rolloverId: result.rolloverId })) as any).status,
      'completed',
    );
    await assert.rejects(
      engine.call('archives.lookup', {
        storeId: 'missing',
        method: 'tasks.create',
        scope: 'local',
        idempotencyKey: 'missing',
      }),
      { code: 'ARCHIVE_NOT_FOUND' },
    );
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('B07/B18 old backup import gets fresh identity and cannot recreate an old request automatically', async () => {
  const f = fixture();
  const engine = await createEngine(f.config as any);
  const firstStore = engine.storeId;
  let oldManifest = '';
  try {
    const backup = (await engine.call(
      'storage.backup',
      { expectedStoreId: firstStore, idempotencyKey: 'backup' },
      { owner: true },
    )) as any;
    const task = (await engine.call(
      'tasks.create',
      { expectedStoreId: firstStore, idempotencyKey: 'K', spec },
      { owner: true },
    )) as any;
    await engine.call(
      'tasks.cancel',
      { expectedStoreId: firstStore, idempotencyKey: 'cancel', taskId: task.id },
      { owner: true },
    );
    await idle(engine);
    oldManifest = readFileSync(join(f.config.stores.controlDir, 'manifest.json'), 'utf8');
    await engine.call(
      'stores.rollover',
      { expectedStoreId: firstStore, idempotencyKey: 'roll' },
      { owner: true },
    );
    const secondStore = engine.storeId;
    const imported = (await engine.call(
      'stores.import',
      { expectedStoreId: secondStore, idempotencyKey: 'restore', backupId: backup.backupId },
      { owner: true },
    )) as any;
    assert.notEqual(imported.newStoreId, firstStore);
    assert.notEqual(imported.newStoreId, secondStore);
    await assert.rejects(
      engine.call('tasks.create', { expectedStoreId: firstStore, idempotencyKey: 'K', spec }),
      { code: 'STORE_NAMESPACE_MISMATCH' },
    );
    const page = (await engine.call('state.snapshot')) as any;
    assert.deepEqual(page.items, []);
    const archived = (await engine.call('archives.lookup', {
      storeId: firstStore,
      method: 'tasks.create',
      scope: 'local',
      idempotencyKey: 'K',
    })) as any;
    assert.equal(archived.targetId, task.id);
    await engine.close();
    writeFileSync(join(f.config.stores.controlDir, 'manifest.json'), oldManifest);
    await assert.rejects(createEngine(f.config as any), { code: 'STORE_RETIRED' });
  } finally {
    await engine.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('B16 real competing owners and direct archived writers cannot acquire a second writer', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const f = fixture();
  const engine = await createEngine(f.config as any);
  const original = engine.storeId;
  try {
    const configPath = join(f.root, 'owner-config.json');
    writeFileSync(configPath, JSON.stringify({ ...f.config, adapters: undefined }));
    const contender = spawnSync(
      process.execPath,
      [new URL('../fixtures/rollover-crash.ts', import.meta.url).pathname, configPath, 'never'],
      { encoding: 'utf8' },
    );
    assert.equal(contender.status, 1);
    assert.match(contender.stderr, /HOST_ALREADY_RUNNING/);
    const result = (await engine.call(
      'stores.rollover',
      { expectedStoreId: original, idempotencyKey: 'switch' },
      { owner: true },
    )) as any;
    const archive = join(f.config.stores.archiveRoot, result.archiveDirectory);
    const before = readdirSync(archive);
    const database = readFileSync(join(archive, 'store.sqlite'));
    assert.throws(() => new Store(f.config.workspace, archive), { code: 'STORE_RETIRED' });
    assert.deepEqual(readdirSync(archive), before);
    assert.deepEqual(readFileSync(join(archive, 'store.sqlite')), database);
  } finally {
    await engine.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('B18 imported unfinished tasks have an exact owner reconciliation target without replay', async () => {
  const f = fixture();
  let calls = 0;
  const base = createFakeAdapter();
  const engine = await createEngine({
    ...f.config,
    adapters: [
      {
        ...base,
        async *execute(input) {
          calls++;
          yield* base.execute(input);
        },
      },
    ],
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    engine.call(
      method,
      { ...('idempotencyKey' in params ? { expectedStoreId: engine.storeId } : {}), ...params },
      { owner: true },
    );
  try {
    const task = (await call('tasks.create', { spec, idempotencyKey: 'pending' })) as any;
    while (((await call('tasks.get', { taskId: task.id })) as any).status !== 'waiting_approval')
      await new Promise((r) => setTimeout(r, 5));
    const backup = (await call('storage.backup', { idempotencyKey: 'pending-backup' })) as any;
    await call('tasks.cancel', { taskId: task.id, idempotencyKey: 'settle-current' });
    await call('stores.import', { backupId: backup.backupId, idempotencyKey: 'restore-pending' });
    const session = (await call('sessions.get', { sessionId: task.sessionId })) as any;
    assert.equal(session.status, 'outcome_unknown');
    assert.ok(session.activeDispatchId);
    await assert.rejects(call('tasks.resume', { taskId: task.id, idempotencyKey: 'unsafe' }), {
      code: 'OUTCOME_UNKNOWN',
    });
    const operation = (await call('sessions.reconcile', {
      target: {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId,
        expectedState: session.status,
      },
      evidence: {
        source: 'owner_attestation',
        summary: 'Fixture owner inspected all work after backup; abandon this task',
        localResources: 'stopped',
        remoteExecution: 'stopped',
        sideEffects: 'resolved',
        outcome: 'failed',
      },
      idempotencyKey: 'recover-import',
    })) as any;
    assert.equal(operation.result.resolved, true);
    assert.equal(calls, 1);
    assert.equal(((await call('tasks.get', { taskId: task.id })) as any).status, 'failed');
  } finally {
    await engine.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
