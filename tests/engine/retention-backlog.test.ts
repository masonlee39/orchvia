import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { StorageStatus } from '../../packages/engine/src/types.ts';

// SPEC-0033 S (#44): collection no longer rescans what it collected, and `storage.status` reports
// what is left to collect and what stops the collection of events.

const DAY = 86400000;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'orch-retention-'));
  const workspace = join(base, 'workspace'),
    stateDir = join(base, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const store = new Store(workspace, stateDir, {});
  const governance = new StorageGovernance(store, { emergencyBytes: 4096 });
  const usage = (id: string) => {
    store.put('usage', id, {
      id,
      taskId: 'none',
      dispatchId: 'd',
      provider: 'p',
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      raw: { detail: 'x'.repeat(64) },
    });
    // Old enough for detail and usage retention.
    store.db
      .prepare("UPDATE retention_records SET terminal_at=0 WHERE table_name='usage' AND id=?")
      .run(id);
  };
  const event = (
    occurredAt: string,
    extra: Record<string, unknown> = {},
    taskId: string | null = null,
  ) =>
    store.db
      .prepare('INSERT INTO events(taskId,data) VALUES (?,?)')
      .run(taskId, JSON.stringify({ type: 'fixture', occurredAt, ...extra }));
  return {
    store,
    governance,
    usage,
    event,
    redacted: (id: string) =>
      !!store.get<{ historyExpired?: boolean }>('usage', id)?.historyExpired,
    close() {
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
const old = new Date(Date.now() - 400 * DAY).toISOString();
const recent = new Date().toISOString();

test('0033-S01 a collected record is not scanned again, so a new one is collected in the next run', () => {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 1200; i++) f.usage(`u${i}`);
    });
    for (
      let run = 0;
      run < 5000 && [...Array(1200).keys()].some((i) => !f.redacted(`u${i}`));
      run++
    )
      f.governance.collect();
    assert.ok(
      [...Array(1200).keys()].every((i) => f.redacted(`u${i}`)),
      'all collected',
    );
    // A later pass starts from the beginning again, as it does after reaching the end.
    f.store.setMetadata('gcScanCursor', '0');
    f.store.transaction(() => f.usage('late'));
    const run = f.governance.collect();
    assert.equal(f.redacted('late'), true, 'the new record is collected in the next run');
    assert.equal(run.records, 1);
  } finally {
    f.close();
  }
});

test('0033-S02 records collected before 0.1.9 are marked the first time a run meets them', () => {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 300; i++) f.usage(`u${i}`);
    });
    for (let run = 0; run < 5000 && [...Array(300).keys()].some((i) => !f.redacted(`u${i}`)); run++)
      f.governance.collect();
    assert.ok([...Array(300).keys()].every((i) => f.redacted(`u${i}`)));
    // As 0.1.8 left them: collected, but not marked.
    f.store.db.exec('UPDATE retention_records SET collected=0');
    f.store.setMetadata('gcScanCursor', '0');
    const unmarked = () =>
      (
        f.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM retention_records WHERE table_name='usage' AND collected=0",
          )
          .get() as { n: number }
      ).n;
    let runs = 0;
    for (; runs < 5000 && unmarked() > 0; runs++) f.governance.collect();
    assert.equal(unmarked(), 0);
    // Marking collects nothing again.
    assert.ok([...Array(300).keys()].every((i) => f.redacted(`u${i}`)));
  } finally {
    f.close();
  }
});

test('0033-S03 the retention status counts what is left and names what stops the events', () => {
  const f = fixture();
  try {
    const empty = f.governance.retentionStatus();
    assert.deepEqual(empty, {
      eventsPastAge: 0,
      eventsPastAgeCapped: false,
      detailPending: 0,
      detailPendingCapped: false,
      oldestCollectableAt: null,
      eventPrefix: { stoppedAtCursor: null, reason: null },
    });
    f.store.transaction(() => {
      for (let i = 0; i < 3; i++) f.usage(`u${i}`);
      f.event(old);
      f.event(old);
      f.event(recent);
    });
    const counted = f.governance.retentionStatus();
    assert.equal(counted.eventsPastAge, 2);
    assert.equal(counted.detailPending, 3);
    assert.equal(counted.oldestCollectableAt, new Date(0).toISOString());
    assert.deepEqual(counted.eventPrefix, { stoppedAtCursor: '3', reason: 'age' });
    // A task that has not ended keeps its events and every later one.
    f.store.transaction(() => {
      f.store.db.exec('DELETE FROM events');
      f.store.put('tasks', 'open', { id: 'open', status: 'running', spec: {} });
      f.event(old);
      f.event(old, {}, 'open');
      f.event(old);
    });
    const stopped = f.governance.retentionStatus().eventPrefix;
    assert.equal(stopped.reason, 'task');
    assert.equal(stopped.taskId, 'open');
    // An operation that is still open keeps its events too.
    f.store.transaction(() => {
      f.store.db.exec('DELETE FROM events');
      f.event(old, { operationId: 'op-open' });
    });
    f.store.saveOperation({
      id: 'op-open',
      method: 'fixture',
      scope: 'local',
      idempotencyKey: 'k',
      status: 'persisted',
    } as never);
    assert.deepEqual(f.governance.retentionStatus().eventPrefix, {
      stoppedAtCursor: String(
        (f.store.db.prepare('SELECT MIN(cursor) AS c FROM events').get() as { c: number }).c,
      ),
      reason: 'operation',
      operationId: 'op-open',
    });
    // Collection does not go past an active snapshot's cursor.
    f.store.transaction(() => {
      f.store.db.exec('DELETE FROM events');
      f.event(old);
    });
    f.governance.snapshot({});
    f.store.transaction(() => f.event(old));
    assert.equal(f.governance.retentionStatus().eventPrefix.reason, 'snapshot_lease');
  } finally {
    f.close();
  }
});

test('0033-S03 counts are capped at 10,000 and the prefix probe at 500 events', () => {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 10001; i++) f.event(old);
    });
    const status = f.governance.retentionStatus();
    assert.equal(status.eventsPastAge, 10000);
    assert.equal(status.eventsPastAgeCapped, true);
    assert.deepEqual(status.eventPrefix, { stoppedAtCursor: '500', reason: 'scan_limit' });
  } finally {
    f.close();
  }
});

test('0033-S04 storage.status carries the retention status; the scheduler’s check does not compute it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-retention-wire-')));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  try {
    const status = (await engine.call('storage.status', {})) as StorageStatus & {
      retention?: unknown;
    };
    assert.deepEqual(status.retention, {
      eventsPastAge: 0,
      eventsPastAgeCapped: false,
      detailPending: 0,
      detailPendingCapped: false,
      oldestCollectableAt: null,
      eventPrefix: status.retention && (status.retention as { eventPrefix: unknown }).eventPrefix,
    });
    const internal = (
      engine as unknown as { storage: { status(): Record<string, unknown> } }
    ).storage.status();
    assert.equal('retention' in internal, false);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
