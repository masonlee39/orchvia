import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
import type { Engine, EventPage, Json, TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0024: reads whose cost grew with a store's history. The tests are deterministic: they check
// what a read returns and which query plans it uses, not how long it takes.

const DAY = 86400000;

async function withEngine(run: (engine: Engine, store: Store) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-read-path-')));
  mkdirSync(join(root, 'work'));
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  try {
    await run(engine, (engine as unknown as { store: Store }).store);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 2000 });
    rmSync(root, { recursive: true, force: true });
  }
}
const read = (engine: Engine, params: Record<string, unknown>) =>
  engine.call('events.read', params) as Promise<EventPage>;
/** Writes one event for each task ID, in order. */
function write(store: Store, taskIds: string[], data: Record<string, Json> = {}) {
  for (let start = 0; start < taskIds.length; start += 1000)
    store.transaction(() => {
      for (const taskId of taskIds.slice(start, start + 1000))
        store.event('fixture.event', data, { taskId });
    });
}
const lastCursor = (store: Store) =>
  String(
    (store.db.prepare('SELECT MAX(cursor) AS cursor FROM events').get() as { cursor: number })
      .cursor,
  );

test('0024-E01 a task-filtered read returns the first event of a task behind 5,000 events of other tasks', async () => {
  await withEngine(async (engine, store) => {
    write(
      store,
      Array.from({ length: 5000 }, (_, n) => `other-${n % 50}`),
    );
    write(store, ['mine']);
    const page = await read(engine, { taskId: 'mine' });
    assert.deepEqual(
      page.events.map((event) => event.taskId),
      ['mine'],
    );
    assert.equal(page.cursor, lastCursor(store));
  });
});

test('0024-E02 a task-filtered read never skips an event of its task, and jumps to the last event when its page is not full', async () => {
  await withEngine(async (engine, store) => {
    write(store, ['other', 'mine', 'other', 'other', 'mine', 'other', 'mine', 'other']);
    const mine = (await read(engine, { limit: 1000 })).events.filter(
      (event) => event.taskId === 'mine',
    );
    assert.equal(mine.length, 3);

    // A full page stops at its last event.
    const first = await read(engine, { taskId: 'mine', limit: 2 });
    assert.deepEqual(
      first.events.map((event) => event.cursor),
      [mine[0].cursor, mine[1].cursor],
    );
    assert.equal(first.cursor, mine[1].cursor);

    // A page that is not full has returned every event of the task up to the last event.
    const second = await read(engine, {
      taskId: 'mine',
      limit: 2,
      afterCursor: first.cursor,
      storeId: first.storeId,
    });
    assert.deepEqual(
      second.events.map((event) => event.cursor),
      [mine[2].cursor],
    );
    assert.equal(second.cursor, lastCursor(store));

    // Later events of other tasks move a caught-up reader to the new last event.
    write(store, ['other', 'other']);
    const third = await read(engine, {
      taskId: 'mine',
      afterCursor: second.cursor,
      storeId: second.storeId,
    });
    assert.deepEqual(third.events, []);
    assert.equal(third.cursor, lastCursor(store));

    // A later event of the task is returned from there.
    write(store, ['other', 'mine']);
    const fourth = await read(engine, {
      taskId: 'mine',
      afterCursor: third.cursor,
      storeId: third.storeId,
    });
    assert.deepEqual(
      fourth.events.map((event) => event.taskId),
      ['mine'],
    );
  });
});

test('0024-E02 a task-filtered page that reaches the byte budget stops at its last event', async () => {
  await withEngine(async (engine, store) => {
    // Three events of about 300 KiB: two fit the 768 KiB page budget, the third does not.
    const payload = { text: 'x'.repeat(300 * 1024) };
    write(store, ['mine', 'other', 'mine', 'other', 'mine'], payload);
    const first = await read(engine, { taskId: 'mine' });
    assert.equal(first.events.length, 2);
    assert.equal(first.cursor, first.events[1].cursor);
    const second = await read(engine, {
      taskId: 'mine',
      afterCursor: first.cursor,
      storeId: first.storeId,
    });
    assert.equal(second.events.length, 1);
    assert.equal(second.cursor, lastCursor(store));
  });
});

test('0024-E02 after the collector removed every event, a task-filtered read keeps its cursor', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-read-path-floor-')));
  mkdirSync(join(root, 'work'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = new Store(join(root, 'work'), join(root, 'state'), { now: () => now });
  try {
    const policy = new StorageGovernance(store, { emergencyBytes: 4096, minFreeBytes: 0 });
    store.put('tasks', 'done', {
      id: 'done',
      status: 'completed',
      artifactRefs: [],
      updatedAt: new Date(now).toISOString(),
    });
    write(store, ['done', 'done', 'done']);
    now += 120 * DAY;
    // A collection is a bounded batch of 50 ms: on a loaded machine one call may remove nothing.
    const left = () =>
      (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    for (let batch = 0; batch < 200 && left() > 0; batch++) policy.collect();
    const floor = store.metadata('retentionFloorCursor');
    assert.ok(floor && floor !== '0', 'the collector advanced the retention floor');
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      0,
    );
    const page = store.events(floor, store.storeId, 'done', 100);
    assert.deepEqual(page.events, []);
    assert.equal(page.cursor, floor);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Records every statement the store prepares while `run` runs. */
async function statements(store: Store, run: () => Promise<unknown>): Promise<string[]> {
  const db = store.db as unknown as { prepare(sql: string): unknown };
  const prepare = db.prepare;
  const seen: string[] = [];
  db.prepare = (sql: string) => {
    seen.push(sql);
    return prepare.call(store.db, sql);
  };
  try {
    await run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}
/** Query plan steps that read a whole approvals, messages or handoffs table. */
function tableScans(store: Store, sql: string[]): string[] {
  const scans = new Set<string>();
  for (const statement of new Set(sql)) {
    if (!/\b(approvals|messages|handoffs)\b/.test(statement)) continue;
    for (const step of store.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as {
      detail: string;
    }[])
      if (/^SCAN (approvals|messages|handoffs)\b(?! USING)/.test(step.detail))
        scans.add(`${step.detail} <- ${statement.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return [...scans];
}

test('0024-X01 read calls and scheduler passes read no whole approvals, messages or handoffs table', async () => {
  await withEngine(async (engine, store) => {
    const reads = await statements(store, async () => {
      await read(engine, {});
      await engine.call('storage.status', {});
      await engine.call('scheduler.get', {});
      await engine.call('usage.get', { taskId: 'missing' }).catch(() => {});
    });
    assert.deepEqual(tableScans(store, reads), [], 'read calls');
    let taskId = '';
    const pass = await statements(store, async () => {
      taskId = (
        (await engine.call('tasks.create', {
          spec: {
            goal: 'Start a scheduler pass',
            runtime: { provider: 'fake', model: 'fixture' },
            acceptance: { mode: 'human', criteria: ['Review'] },
          },
          idempotencyKey: 'scheduler-pass',
        })) as TaskSnapshot
      ).id;
      for (let n = 0; n < 400; n++) {
        const current = (await engine.call('tasks.get', { taskId })) as TaskSnapshot;
        if (current.status === 'waiting_approval') return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail('The fixture task did not reach its approval');
    });
    assert.deepEqual(tableScans(store, pass), [], 'a scheduler pass and a turn');
    // Cancelling a task that is not running expires its persisted messages.
    const cancel = await statements(store, () =>
      engine.call('tasks.cancel', { taskId, idempotencyKey: 'cancel-pass' }),
    );
    assert.deepEqual(tableScans(store, cancel), [], 'a cancel');
  });
});
