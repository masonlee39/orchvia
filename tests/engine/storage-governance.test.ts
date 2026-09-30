import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
import { createArchive, verifyArchive } from '../../packages/engine/src/archive.ts';

const DAY = 86400000;

test('0011-R08 native helper symlinks are counted without traversal and omitted from archives', async () => {
  const f = fixture();
  try {
    const helpers = join(f.store.stateDir, 'runtime/codex/tmp/arg0/codex-arg0Ab12CD');
    mkdirSync(helpers, { recursive: true });
    const target = join(f.root, 'outside-binary');
    writeFileSync(target, Buffer.alloc(1024 * 1024));
    const before = f.policy.status().bytes;
    symlinkSync(target, join(helpers, 'apply_patch'));
    // The Codex CLI, not the engine, writes these links: they count after the next walk (SPEC-0052).
    await f.walk();
    const after = f.policy.status().bytes;
    assert.equal(after - before, Buffer.byteLength(target));
    const history = join(f.store.stateDir, 'runtime/codex/session.jsonl');
    writeFileSync(history, 'retained native history\n');
    const archive = join(realpathSync(f.root), 'archive');
    const manifest = createArchive(f.store, archive, 'native-helper-archive');
    assert.ok(manifest.files.some((file) => file.path === 'runtime/codex/session.jsonl'));
    assert.ok(!manifest.files.some((file) => file.path.includes('apply_patch')));
    verifyArchive(archive, { storeId: f.store.storeId }, true);
    assert.equal(readFileSync(target).length, 1024 * 1024);
    symlinkSync(f.root, join(helpers, 'unexpected'));
    await f.walk();
    assert.throws(() => f.policy.status(), { code: 'UNTRUSTED_PATH' });
    assert.throws(() => createArchive(f.store, join(realpathSync(f.root), 'bad-archive'), 'bad'), {
      code: 'UNTRUSTED_PATH',
    });
  } finally {
    f.close();
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-storage-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = new Store(workspace, join(root, 'state'), { now: () => now });
  let monotonic = 0;
  const policy = new StorageGovernance(
    store,
    { emergencyBytes: 4096, minFreeBytes: 0 },
    () => performance.now() + monotonic,
  );
  return {
    root,
    store,
    policy,
    /** Lets a minute pass and waits for the walk that the next status() starts (SPEC-0052). */
    async walk() {
      monotonic += 60_001;
      try {
        policy.status();
      } catch {
        // A refusal still starts the walk.
      }
      await policy.walked();
    },
    advance: (days: number) => {
      now += days * DAY;
    },
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function terminal(store: Store, id: string, refs: string[] = []) {
  store.put('tasks', id, {
    id,
    status: 'completed',
    artifactRefs: refs,
    updatedAt: new Date(store.now()).toISOString(),
  });
  store.saveOperation(
    {
      id: `op-${id}`,
      method: 'tasks.create',
      scope: 'local',
      idempotencyKey: id,
      status: 'completed',
      targetId: id,
      result: { taskId: id },
      error: null,
    },
    id,
  );
}
test('B01/B02 retained details expire into lifetime tombstones, protected shared artifacts survive', () => {
  const f = fixture();
  try {
    const artifact = f.store.artifact('shared evidence');
    terminal(f.store, 'old', [artifact]);
    f.store.put('tasks', 'active', { id: 'active', status: 'blocked', artifactRefs: [artifact] });
    f.advance(89);
    f.policy.collect();
    assert.equal(f.store.operation('op-old').targetId, 'old');
    f.advance(2);
    for (let batch = 0; batch < 10 && !f.store.findOperationById('op-old')?.historyExpired; batch++)
      f.policy.collect();
    assert.throws(() => f.store.operation('op-old'), { code: 'OPERATION_HISTORY_EXPIRED' });
    assert.equal(f.store.findOperation('tasks.create', 'local', 'old')?.digest, 'old');
    assert.equal(f.store.artifactText(artifact), 'shared evidence');
    f.store.put('tasks', 'active', { id: 'active', status: 'cancelled', artifactRefs: [artifact] });
    f.advance(91);
    for (
      let batch = 0;
      batch < 10 && !f.store.get<any>('artifacts', artifact)?.historyExpired;
      batch++
    )
      f.policy.collect();
    assert.throws(() => f.store.artifactText(artifact), { code: 'ARTIFACT_HISTORY_EXPIRED' });
    assert.equal(f.store.findOperation('tasks.create', 'local', 'old')?.operation.id, 'op-old');
  } finally {
    f.close();
  }
});
test('B03 fixed snapshot pages and continuous cursor floor reject stale recovery', () => {
  const f = fixture();
  try {
    terminal(f.store, 'a');
    f.store.event('old', {});
    const snapshot = f.policy.snapshot({ limit: 1 });
    terminal(f.store, 'b');
    f.store.event('new', {});
    const page = f.policy.snapshot({
      snapshotId: snapshot.snapshotId,
      offset: snapshot.nextOffset,
      limit: 1,
    });
    assert.equal(page.cursor, snapshot.cursor);
    assert.equal(
      page.items.some((item: any) => item.value.id === 'b'),
      false,
    );
    f.advance(31);
    for (let batch = 0; batch < 10 && f.policy.status().retentionFloorCursor !== '2'; batch++) {
      const collected = f.policy.collect();
      assert.ok(collected.records <= 500);
      assert.ok(collected.bytes <= 8 * 1024 ** 2);
    }
    assert.throws(() => f.policy.snapshot({ snapshotId: snapshot.snapshotId }), {
      code: 'SNAPSHOT_EXPIRED',
    });
    assert.throws(() => f.store.events('0', f.store.storeId, undefined, 10), {
      code: 'CURSOR_EXPIRED',
    });
    const floor = f.policy.status().retentionFloorCursor;
    assert.equal(floor, '2');
    assert.equal(f.store.events(floor, f.store.storeId, undefined, 10).cursor, floor);
  } finally {
    f.close();
  }
});
test('B05 exact capacity blocks business while bounded settlement and same-key lookup remain available', async () => {
  const f = fixture();
  try {
    // The owner of the policy writes the reserve (SPEC-0028 W01); settlement must leave it in place.
    await f.policy.reserve();
    f.policy.configure({ maxRecords: 8, settlementReserveRecords: 4 });
    terminal(f.store, 'a');
    terminal(f.store, 'b');
    assert.throws(() => f.policy.admit(), { code: 'STORAGE_BACKPRESSURE' });
    f.policy.settlement('tasks.cancel', 'a');
    assert.equal(f.store.findOperation('tasks.create', 'local', 'a')?.operation.id, 'op-a');
    for (let i = 0; i < 3; i++) f.policy.settlement('tasks.cancel', 'a');
    assert.throws(() => f.policy.settlement('tasks.cancel', 'a'), {
      code: 'SETTLEMENT_CAPACITY_EXHAUSTED',
    });
    assert.equal(existsSync(join(f.store.stateDir, 'emergency.reserve')), true);
  } finally {
    f.close();
  }
});

test('B03 snapshot leases expire monotonically even if the wall clock moves backward', () => {
  const f = fixture();
  let monotonic = 0;
  try {
    const policy = new StorageGovernance(f.store, {}, () => monotonic);
    terminal(f.store, 'clock');
    const snapshot = policy.snapshot();
    monotonic = 60001;
    f.advance(-1);
    assert.throws(() => policy.snapshot({ snapshotId: snapshot.snapshotId }), {
      code: 'SNAPSHOT_EXPIRED',
    });
    assert.deepEqual(policy.activeSnapshots(), []);
  } finally {
    f.close();
  }
});

test('B02 GC byte budget includes artifact payloads and advances across batches', () => {
  const f = fixture();
  try {
    const refs = ['a', 'b'].map((c) => f.store.artifact(c.repeat(5 * 1024 ** 2)));
    f.advance(91);
    const first = f.policy.collect();
    assert.ok(first.bytes >= 5 * 1024 ** 2, 'Payload bytes must count toward the budget');
    assert.ok(first.bytes <= 8 * 1024 ** 2);
    assert.equal(
      refs.filter((ref) => f.store.get<any>('artifacts', ref)?.historyExpired).length,
      1,
    );
    for (let i = 0; i < 5; i++) f.policy.collect();
    assert.equal(
      refs.filter((ref) => f.store.get<any>('artifacts', ref)?.historyExpired).length,
      2,
    );
  } finally {
    f.close();
  }
});
