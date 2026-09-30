import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import {
  ACTIVE_TASK_STATUSES,
  ACTIVE_TASKS_SQL,
  TERMINAL_TASK_STATUSES,
} from '../../packages/engine/src/storage.ts';
import type { EngineClock } from '../../packages/engine/src/types.ts';

// SPEC-0052 P01, P02: the storage check keeps a total instead of walking the state directory on
// each call, and counts active tasks through an index.

const MINUTE = 60_000;

async function setup(t: any) {
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now() + offset,
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-storage-status-')));
  await mkdir(join(dir, 'workspace'));
  const stateDir = join(dir, 'state');
  const engine: any = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir,
    adapters: [createFakeAdapter()],
    clock,
  });
  t.after(async () => {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const storage = engine.storage;
  await storage.walked();
  return {
    engine,
    storage,
    store: engine.store,
    stateDir,
    bytes: () => storage.status().bytes as number,
    /** Lets a minute pass, calls status() so that it starts a walk, and waits for the walk. */
    async walk() {
      offset += MINUTE + 1;
      try {
        storage.status();
      } catch {
        // A refusal still starts the walk.
      }
      await storage.walked();
    },
  };
}

test('AC-0052-P01 a file put behind the engine counts only after a walk', async (t) => {
  const s = await setup(t);
  const before = s.bytes();
  await writeFile(join(s.stateDir, 'artifacts', 'external.txt'), 'x'.repeat(300_000));
  assert.ok(s.bytes() - before < 300_000, 'counted without a walk: the call walked the directory');
  await s.walk();
  assert.ok(s.bytes() - before >= 300_000, 'not counted after a walk');
});

test('AC-0052-P01 an artifact the engine writes counts at once', async (t) => {
  const s = await setup(t);
  const before = s.bytes();
  s.store.transaction(() => s.store.artifact('y'.repeat(200_000)));
  assert.ok(s.bytes() - before >= 200_000);
});

test('AC-0052-P01 a write during a walk is not lost', async (t) => {
  const s = await setup(t);
  const before = s.bytes();
  let reached!: () => void;
  const atArtifacts = new Promise<void>((resolve) => (reached = resolve));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  // The walk has listed the artifacts directory and waits there.
  s.storage.walkPause = async (directory: string) => {
    if (directory !== 'artifacts') return;
    reached();
    await gate;
  };
  const walking = s.walk();
  await Promise.race([
    atArtifacts,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('no walk reached artifacts')), 5000),
    ),
  ]);
  s.store.transaction(() => s.store.artifact('z'.repeat(200_000)));
  resume();
  await walking;
  s.storage.walkPause = undefined;
  assert.ok(s.bytes() - before >= 200_000, 'the walk dropped a file written while it ran');
});

test('AC-0052-P01 a symbolic link is refused once a walk finds it', async (t) => {
  const s = await setup(t);
  const link = join(s.stateDir, 'artifacts', 'link.txt');
  await symlink('/etc/hosts', link);
  await s.walk();
  assert.throws(() => s.storage.status(), { code: 'UNTRUSTED_PATH' });
  await unlink(link);
  await s.walk();
  s.storage.status();
});

test('AC-0052-P02 active tasks are counted through the index, as the scan counted them', async (t) => {
  const s = await setup(t);
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'),
  ).$defs.TaskStatus.enum as string[];
  assert.deepEqual([...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort(), [...schema].sort());
  s.store.transaction(() => {
    for (const status of schema)
      for (let n = 0; n < 3; n++)
        s.store.put('tasks', `${status}-${n}`, { id: `${status}-${n}`, status, revision: 1 });
  });
  const scan = (
    s.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE json_extract(data,'$.status') NOT IN ('completed','failed','cancelled')",
      )
      .get() as { count: number }
  ).count;
  assert.equal(s.storage.activeTasks(), scan);
  assert.equal(scan, ACTIVE_TASK_STATUSES.length * 3);
  const plan = (
    s.store.db.prepare(`EXPLAIN QUERY PLAN ${ACTIVE_TASKS_SQL}`).all() as { detail: string }[]
  )
    .map((row) => row.detail)
    .join('\n');
  assert.match(plan, /tasks_status/);
  // status() counts with that query, and scans no task's JSON.
  const seen: string[] = [];
  const prepare = s.store.db.prepare.bind(s.store.db);
  s.store.db.prepare = (sql: string) => (seen.push(sql), prepare(sql));
  try {
    s.storage.status();
  } finally {
    delete s.store.db.prepare;
  }
  assert.ok(seen.includes(ACTIVE_TASKS_SQL), seen.join('\n'));
  assert.ok(!seen.some((sql) => /NOT IN/.test(sql)), seen.join('\n'));
});
