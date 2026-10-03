import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { openReadOnlyEngine } from '../../packages/engine/src/index.ts';
import { openOrchestratorReadOnly } from '../../packages/sdk-typescript/src/index.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0027 R: reading a store without starting an engine.

type Tree = Record<string, string>;
/** Every file under `root`, by relative path, as its SHA-256 and size. */
function tree(root: string): Tree {
  const result: Tree = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else
        result[relative(root, path)] =
          `${createHash('sha256').update(readFileSync(path)).digest('hex')}:${stat.size}`;
    }
  };
  visit(root);
  return result;
}
/** R02: nothing that existed changed, and SQLite's WAL index is all that may have appeared. */
function assertUnchanged(before: Tree, after: Tree) {
  for (const [path, value] of Object.entries(before))
    if (path !== 'store.sqlite-shm') assert.equal(after[path], value, `${path} changed`);
  for (const path of Object.keys(after))
    if (!(path in before)) {
      assert.ok(['store.sqlite-shm', 'store.sqlite-wal'].includes(path), `${path} appeared`);
      if (path === 'store.sqlite-wal') assert.match(after[path], /:0$/, 'a new WAL is empty');
    }
}

const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
/** A fake runtime that reports usage, and holds prompts that start with `hold` until released. */
function runtime() {
  const base = createFakeAdapter();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        if (event.type !== 'accepted' && input.prompt.startsWith('hold')) await held;
        yield event;
        if (event.type === 'accepted')
          yield {
            type: 'usage',
            usageId: 'u1',
            usage: {
              inputTokens: 11,
              cachedInputTokens: 2,
              cacheWriteInputTokens: null,
              outputTokens: 5,
              raw: { provider: 'fixture' },
            },
          };
      }
    },
  };
  return { adapter, release };
}
/** A store with finished, waiting and messaged work; the engine stays open until `close`. */
async function populated(t: TestContext, overrides: Partial<EngineConfig> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-read-only-')));
  mkdirSync(join(root, 'work'));
  const stateDir = join(root, 'state');
  const fake = runtime();
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir,
    adapters: [fake.adapter],
    ...overrides,
  });
  let open = true;
  t.after(async () => {
    fake.release();
    if (open) await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const done = (await engine.call('tasks.create', {
    spec: spec('finished work', { label: 'group:alpha' }),
    idempotencyKey: 'finished',
  })) as TaskSnapshot;
  const pending = await wait(engine, done.id, 'waiting_approval');
  const approval = (await engine.call('approvals.get', {
    approvalId: pending.approvalId,
  })) as { revision: number };
  await engine.call('approvals.decide', {
    approvalId: pending.approvalId,
    decision: { choice: 'approve', expectedRevision: approval.revision },
    idempotencyKey: 'approve',
  });
  const finished = await wait(engine, done.id, 'completed');
  const waiting = (await engine.call('tasks.create', {
    spec: spec('waiting work'),
    idempotencyKey: 'waiting',
  })) as TaskSnapshot;
  const review = await wait(engine, waiting.id, 'waiting_approval');
  const session = (await engine.call('sessions.get', {
    sessionId: review.sessionId,
  })) as SessionSnapshot;
  const message = (await engine.call('messages.send', {
    spec: {
      taskId: review.id,
      toSessionId: session.id,
      expectedGeneration: session.generation,
      kind: 'finding',
      summary: 'A note for the reviewer',
      artifactRefs: [],
    },
    idempotencyKey: 'message',
  })) as { id: string };
  return {
    root,
    stateDir,
    engine,
    fake,
    finished,
    review,
    message,
    async close() {
      open = false;
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    },
  };
}
/** The read calls of R03, with parameters that name the populated store's records. */
function reads(f: Awaited<ReturnType<typeof populated>>) {
  return [
    ['tasks.get', { taskId: f.finished.id }],
    ['tasks.get', { taskId: 'no-such-task' }],
    ['tasks.list', {}],
    ['tasks.list', { label: 'group:alpha' }],
    ['tasks.list', { parentTaskId: f.finished.id, limit: 1 }],
    ['sessions.get', { sessionId: f.review.sessionId }],
    ['usage.get', { taskId: f.finished.id }],
    ['usage.getRecord', { usageRecordId: `${'x'}` }],
    ['events.read', { limit: 1000 }],
    ['events.read', { taskId: f.review.id }],
    ['operations.lookup', { method: 'tasks.create', scope: 'local', idempotencyKey: 'finished' }],
    ['approvals.get', { approvalId: f.review.approvalId }],
    ['messages.get', { messageId: f.message.id }],
    ['handoffs.list', {}],
    ['handoffs.get', { handoffId: 'no-such-handoff' }],
    ['costs.get', { taskId: f.finished.id, scope: 'tree' }],
    [
      'context.checkRefs',
      { contextRefs: [{ artifactRef: f.finished.artifactRefs[0], version: 1 }] },
    ],
    ['rules.list', {}],
  ] as const;
}
const outcome = (call: Promise<unknown>) =>
  call.then(
    (value) => ({ value }),
    (error: { code?: string; message?: string }) => ({ error: error.code, message: error.message }),
  );

test('0027-R01 0027-R07 a missing store is NOT_FOUND and nothing is created', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-read-only-missing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(openReadOnlyEngine({ stateDir: join(root, 'absent') }), {
    code: 'NOT_FOUND',
  });
  assert.equal(existsSync(join(root, 'absent')), false);
  mkdirSync(join(root, 'empty'));
  await assert.rejects(openReadOnlyEngine({ stateDir: join(root, 'empty') }), {
    code: 'NOT_FOUND',
  });
  assert.deepEqual(readdirSync(join(root, 'empty')), []);
  await assert.rejects(openReadOnlyEngine({ stateDir: 'relative/state' }), {
    code: 'VALIDATION_ERROR',
  });
});

test('0027-R02 0027-R03 reads equal the running engine and change no file', async (t) => {
  const f = await populated(t);
  await f.engine.call(
    'rules.register',
    {
      rule: {
        id: 'lint',
        version: '1',
        argv: [process.execPath, '--version'],
        cwdRelative: '.',
        timeoutMs: 1000,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
      idempotencyKey: 'rule',
    },
    { owner: true },
  );
  const usage = (await f.engine.call('usage.get', { taskId: f.finished.id })) as {
    records: { id: string }[];
  };
  assert.equal(usage.records.length, 1);
  const calls = reads(f).map(([method, params]) =>
    method === 'usage.getRecord'
      ? ([method, { usageRecordId: usage.records[0].id }] as const)
      : ([method, params] as const),
  );
  const before = tree(f.stateDir);
  const handle = await openReadOnlyEngine({ stateDir: f.stateDir });
  try {
    for (const [method, params] of calls)
      assert.deepEqual(
        await outcome(handle.call(method, { ...params })),
        await outcome(f.engine.call(method, { ...params })),
        method,
      );
  } finally {
    await handle.close();
  }
  assertUnchanged(before, tree(f.stateDir));

  // The same after the engine closed, from a clean store.
  const expected: unknown[] = [];
  for (const [method, params] of calls)
    expected.push(await outcome(f.engine.call(method, { ...params })));
  await f.close();
  const closed = tree(f.stateDir);
  const again = await openReadOnlyEngine({ stateDir: f.stateDir });
  try {
    for (const [index, [method, params]] of calls.entries()) {
      const read = await outcome(again.call(method, { ...params }));
      if (method !== 'events.read') assert.deepEqual(read, expected[index], method);
      else {
        // The close added its own events after the ones read while the engine ran.
        const before = (expected[index] as { value: { events: unknown[] } }).value.events;
        const after = (read as { value: { events: unknown[] } }).value.events;
        assert.deepEqual(after.slice(0, before.length), before, method);
      }
    }
  } finally {
    await again.close();
  }
  assertUnchanged(closed, tree(f.stateDir));
});

test('0027-R04 0027-R05 a store copied while its engine ran is read completely and needs recovery', async (t) => {
  const f = await populated(t);
  // A dispatch that is running when the copy is taken, as a crash would leave it.
  const running = (await f.engine.call('tasks.create', {
    spec: spec('hold this dispatch'),
    idempotencyKey: 'running',
  })) as TaskSnapshot;
  await wait(f.engine, running.id, 'running');
  const copy = join(f.root, 'copy');
  cpSync(f.stateDir, copy, { recursive: true });
  const listed = (await f.engine.call('tasks.list', {})) as { tasks: TaskSnapshot[] };
  f.fake.release();
  assert.ok(existsSync(join(copy, 'store.sqlite-wal')), 'the copy has a write-ahead log');

  const before = tree(copy);
  const handle = await openReadOnlyEngine({ stateDir: copy });
  try {
    const read = (await handle.call('tasks.list', {})) as { tasks: TaskSnapshot[] };
    assert.deepEqual(
      read.tasks.map((task) => [task.id, task.status]),
      listed.tasks.map((task) => [task.id, task.status]),
    );
    assert.equal(
      ((await handle.call('tasks.get', { taskId: running.id })) as TaskSnapshot).status,
      'running',
      'no recovery ran',
    );
    const info = (await handle.call('store.info', {})) as { recoveryPending: boolean };
    assert.equal(info.recoveryPending, true);
  } finally {
    await handle.close();
  }
  assertUnchanged(before, tree(copy));
});

test('0027-R05 0027-R07 info describes the store; a clean store needs no recovery', async (t) => {
  const f = await populated(t);
  await f.close();
  const orch = await openOrchestratorReadOnly({ stateDir: f.stateDir });
  try {
    const info = await orch.info();
    assert.deepEqual(info, {
      storeId: f.engine.storeId,
      schemaVersion: 3,
      role: 'active',
      workspace: join(f.root, 'work'),
      recoveryPending: false,
    });
    assert.equal(orch.storeId, f.engine.storeId);
    // Typed reads through the SDK.
    const task = await orch.tasks.get(f.finished.id);
    assert.equal(task.status, 'completed');
    assert.equal((await orch.tasks.list({ label: 'group:alpha' })).tasks.length, 1);
    assert.equal((await orch.usage.get(f.finished.id)).records.length, 1);
    assert.ok((await orch.events.read({ limit: 10 })).events.length > 0);
    assert.equal((await orch.sessions.get(f.review.sessionId!)).id, f.review.sessionId);
    assert.equal(
      (
        await orch.operations.lookup({
          method: 'tasks.create',
          scope: 'local',
          idempotencyKey: 'waiting',
        })
      ).targetId,
      f.review.id,
    );
  } finally {
    await orch.close();
  }
});

test('0027-R06 writes and live-host reads fail with READ_ONLY and change nothing', async (t) => {
  const f = await populated(t);
  await f.close();
  const before = tree(f.stateDir);
  const handle = await openReadOnlyEngine({ stateDir: f.stateDir });
  try {
    for (const [method, params] of [
      ['tasks.create', { spec: spec('new'), idempotencyKey: 'new' }],
      ['tasks.cancel', { taskId: f.review.id, idempotencyKey: 'cancel' }],
      [
        'approvals.decide',
        {
          approvalId: f.review.approvalId,
          decision: { choice: 'approve', expectedRevision: 1 },
          idempotencyKey: 'a',
        },
      ],
      ['messages.send', { spec: {}, idempotencyKey: 'm' }],
      [
        'sessions.open',
        { spec: { runtime: { provider: 'fake', model: 'fixture' } }, idempotencyKey: 's' },
      ],
      ['rules.register', { rule: {}, idempotencyKey: 'r' }],
      ['storage.gc', { idempotencyKey: 'g' }],
      ['sessions.inspect', { sessionId: f.review.sessionId }],
      ['capabilities.get', {}],
      ['context.estimate', {}],
      ['scheduler.get', {}],
      ['scheduler.getConflict', { conflictId: 'c' }],
      ['state.snapshot', {}],
      ['storage.status', {}],
    ] as const)
      await assert.rejects(handle.call(method, { ...params }), { code: 'READ_ONLY' }, method);
  } finally {
    await handle.close();
  }
  assertUnchanged(before, tree(f.stateDir));

  const orch = await openOrchestratorReadOnly({ stateDir: f.stateDir });
  try {
    // @ts-expect-error A read-only orchestrator has no write methods.
    assert.equal(orch.tasks.create, undefined);
    // @ts-expect-error No approvals can be decided.
    assert.equal(orch.approvals.decide, undefined);
  } finally {
    await orch.close();
  }
});

test('0027-R07 other schemas fail, every role can be read, and a linked store is refused', async (t) => {
  const f = await populated(t);
  await f.close();
  const variant = (name: string, change: (db: DatabaseSync) => void) => {
    const path = join(f.root, name);
    cpSync(f.stateDir, path, { recursive: true });
    const db = new DatabaseSync(join(path, 'store.sqlite'));
    change(db);
    db.close();
    return path;
  };
  const schema = (version: string) =>
    variant(`schema-${version}`, (db) =>
      db.prepare("UPDATE metadata SET value=? WHERE key='schemaVersion'").run(version),
    );
  await assert.rejects(openReadOnlyEngine({ stateDir: schema('4') }), { code: 'SCHEMA_MISMATCH' });
  await assert.rejects(
    openReadOnlyEngine({ stateDir: schema('2') }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'SCHEMA_MISMATCH');
      assert.match(error.message, /full engine/);
      return true;
    },
  );
  for (const role of ['standby', 'retired', 'archive']) {
    const path = variant(`role-${role}`, (db) =>
      db.prepare("UPDATE metadata SET value=? WHERE key='role'").run(role),
    );
    const handle = await openReadOnlyEngine({ stateDir: path });
    try {
      assert.equal(((await handle.call('store.info', {})) as { role: string }).role, role);
      assert.equal(
        ((await handle.call('tasks.get', { taskId: f.finished.id })) as TaskSnapshot).status,
        'completed',
      );
    } finally {
      await handle.close();
    }
  }
  const linked = join(f.root, 'linked');
  cpSync(f.stateDir, linked, { recursive: true });
  renameSync(join(linked, 'store.sqlite'), join(f.root, 'elsewhere.sqlite'));
  symlinkSync(join(f.root, 'elsewhere.sqlite'), join(linked, 'store.sqlite'));
  await assert.rejects(openReadOnlyEngine({ stateDir: linked }), { code: 'UNTRUSTED_PATH' });
});

test('0027-R08 an open handle does not keep an engine from starting, and sees its commits', async (t) => {
  const f = await populated(t);
  await f.close();
  const handle = await openReadOnlyEngine({ stateDir: f.stateDir });
  try {
    const engine = await createEngine({
      workspace: join(f.root, 'work'),
      stateDir: f.stateDir,
      adapters: [createFakeAdapter()],
    });
    try {
      const task = (await engine.call('tasks.create', {
        spec: spec('after the handle opened'),
        idempotencyKey: 'later',
      })) as TaskSnapshot;
      assert.equal(
        ((await handle.call('tasks.get', { taskId: task.id })) as TaskSnapshot).id,
        task.id,
      );
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await handle.close();
  }
});
