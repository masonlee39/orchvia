/**
 * SPEC-0051 R01: a rollback across one release. Installs the previous published `@orchvia/engine`
 * and checks both directions with the fake runtime:
 *   1. the working tree's engine writes a store (a completed task, a task waiting for acceptance, a
 *      steered turn, usage, a runtime rule, a label with metadata); the previous engine opens it and
 *      reads every record as written, or refuses it with SCHEMA_MISMATCH or STORE_TOO_NEW; the
 *      working tree's engine then opens it again and reads the same as before;
 *   2. the previous engine writes such a store without the steer, and the working tree's engine
 *      reads it back.
 * A newer engine may add fields to what it reads; every field the older engine reads must be equal.
 *
 * Usage: node scripts/compat-rollback.mjs [--previous X.Y.Z] [--keep]
 * Needs npm and the registry. Exits 1 when a check fails and 2 on invalid arguments.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const parts = (version) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? +part : part));
const older = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
/** The highest published release below the working tree's version. */
export function previousRelease(versions, version) {
  return versions
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && older(v, version))
    .sort((a, b) => (older(a, b) ? -1 : 1))
    .at(-1);
}

/** `a` holds nothing that `b` does not hold with the same value; `b` may hold more. */
export function within(a, b, path = '') {
  if (a === b) return [];
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length)
      return [`${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`];
    return a.flatMap((item, i) => within(item, b[i], `${path}[${i}]`));
  }
  if (a && typeof a === 'object' && b && typeof b === 'object' && !Array.isArray(b))
    return Object.keys(a).flatMap((key) => within(a[key], b[key], `${path}.${key}`));
  return [`${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`];
}

const until = async (read, done, what) => {
  for (let i = 0; i < 1000; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** An adapter that holds a turn whose goal starts with HOLD, and answers steers. */
function holding(fake, steerable) {
  let release;
  let held = new Promise((resolve) => (release = resolve));
  const steered = [];
  return {
    steered,
    release: () => release(),
    adapter: {
      ...fake,
      capabilities: () => ({ ...fake.capabilities(), ...(steerable ? { steer: true } : {}) }),
      async *execute(input) {
        if (!input.prompt.includes('HOLD')) {
          yield* fake.execute(input);
          return;
        }
        yield { type: 'accepted', providerSessionId: `fake-${input.sessionId}` };
        await held;
        for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
      },
      ...(steerable
        ? {
            steer: async (target, text, id) => {
              steered.push({ dispatchId: target.dispatchId, text, id });
              return { status: 'accepted' };
            },
          }
        : {}),
    },
  };
}

const spec = (goal, extra = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});
const rule = {
  id: 'lint',
  version: '1',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwdRelative: '.',
  timeoutMs: 10_000,
  permissionProfile: 'read-only',
  success: { exitCode: 0 },
};

/** Writes the representative store, and returns the ids to read back. */
async function writeStore(engines, dirs, steer) {
  const fake = engines.createFakeAdapter({ usage: { inputTokens: 11, outputTokens: 7 } });
  const runtime = holding(fake, steer);
  const engine = await engines.createEngine({ ...dirs, adapters: [runtime.adapter] });
  const call = (method, params, context) =>
    engine.call(method, { expectedStoreId: engine.storeId, ...params }, context);
  const get = (taskId) => engine.call('tasks.get', { taskId });
  const waiting = (taskId) =>
    until(
      () => get(taskId),
      (task) => task.status === 'waiting_approval',
      `${taskId} to wait for acceptance`,
    );
  try {
    await call('rules.register', { rule, idempotencyKey: 'rule' }, { owner: true });
    const done = await call('tasks.create', {
      spec: spec('first', { label: 'first', metadata: { team: 'compat', n: 1 } }),
      idempotencyKey: 'done',
    });
    const approval = await engine.call('approvals.get', {
      approvalId: (await waiting(done.id)).approvalId,
    });
    await call('approvals.decide', {
      approvalId: approval.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve',
    });
    await until(
      () => get(done.id),
      (task) => task.status === 'completed',
      'the first task to complete',
    );
    const pending = await call('tasks.create', {
      spec: spec('second', { label: 'second' }),
      idempotencyKey: 'pending',
    });
    await waiting(pending.id);
    const ids = { tasks: [done.id, pending.id], operations: [], messages: [] };
    if (steer) {
      const held = await call('tasks.create', {
        spec: spec('HOLD third'),
        idempotencyKey: 'held',
      });
      const session = await until(
        () => engine.call('sessions.get', { sessionId: held.sessionId }),
        (s) => !!s.activeDispatchId && !!s.providerSessionId,
        'the held turn to start',
      );
      const op = await call('sessions.steer', {
        target: {
          sessionId: session.id,
          expectedGeneration: session.generation,
          expectedDispatchId: session.activeDispatchId,
        },
        text: 'Keep config.json as it is',
        idempotencyKey: 'steer',
      });
      await until(
        () => engine.call('operations.get', { operationId: op.id }),
        (o) => o.status !== 'persisted',
        'the steer to settle',
      );
      runtime.release();
      await waiting(held.id);
      ids.tasks.push(held.id);
      ids.operations.push(op.id);
      ids.messages.push(runtime.steered[0].id);
    }
    return { ids, reads: await readStore(engine, ids) };
  } finally {
    runtime.release();
    await engine.close();
  }
}

/** Everything the store holds for `ids`, through the wire methods. */
async function readStore(engine, ids) {
  const call = (method, params = {}) => engine.call(method, params);
  const tasks = await Promise.all(ids.tasks.map((taskId) => call('tasks.get', { taskId })));
  const sessionIds = [...new Set(tasks.map((task) => task.sessionId))];
  const approvalIds = tasks.map((task) => task.approvalId).filter(Boolean);
  const usage = await call('usage.byTask', { taskIds: ids.tasks });
  return {
    tasks,
    list: await call('tasks.list', { limit: 100 }),
    sessions: await Promise.all(sessionIds.map((sessionId) => call('sessions.get', { sessionId }))),
    approvals: await Promise.all(
      approvalIds.map((approvalId) => call('approvals.get', { approvalId })),
    ),
    operations: await Promise.all(
      ids.operations.map((operationId) => call('operations.get', { operationId })),
    ),
    messages: await Promise.all(
      ids.messages.map((messageId) => call('messages.get', { messageId })),
    ),
    usage,
    records: await Promise.all(
      tasks.map((task) => call('usage.get', { taskId: task.id }).catch((error) => error.code)),
    ),
    rules: await call('rules.list', {}),
    events: (await call('events.read', { limit: 500 })).events,
  };
}

/** Opens `stateDir` with `engines` and reads it; a refusal returns its code. */
async function reopen(engines, dirs, ids) {
  let engine;
  try {
    engine = await engines.createEngine({ ...dirs, adapters: [engines.createFakeAdapter()] });
  } catch (error) {
    if (error?.code === 'SCHEMA_MISMATCH' || error?.code === 'STORE_TOO_NEW')
      return { refused: error.code };
    throw error;
  }
  try {
    return { reads: await readStore(engine, ids) };
  } finally {
    await engine.close();
  }
}

/**
 * Compares a read with a later read of the same store. What the older engine read must be within
 * what the newer engine read, since a newer engine may add fields; with `exact`, both are the same
 * engine and must agree. A later open may add events; the earlier events stay as they were.
 */
function compareReads(label, earlier, later, { laterByOlder = false, exact = false } = {}) {
  const { events: before, ...recordsBefore } = earlier;
  const { events: after, ...recordsAfter } = later;
  const [older, newer] = laterByOlder
    ? [recordsAfter, recordsBefore]
    : [recordsBefore, recordsAfter];
  const kept = after.slice(0, before.length);
  return [
    ...within(older, newer, ''),
    ...(exact ? within(newer, older, '') : []),
    ...(after.length < before.length ? [`.events: ${after.length} < ${before.length}`] : []),
    ...(laterByOlder ? within(kept, before, '.events') : within(before, kept, '.events')),
  ].map((problem) => `${label}${problem}`);
}

async function main() {
  const known = option('previous');
  if (known && !/^\d+\.\d+\.\d+$/.test(known)) {
    console.error(`--previous must be a version such as 0.1.25, not ${known}`);
    process.exit(2);
  }
  const versions = known
    ? [known]
    : JSON.parse(
        execFileSync(npm, ['view', '@orchvia/engine', 'versions', '--json'], { encoding: 'utf8' }),
      );
  const previous = known ?? previousRelease(versions, current);
  if (!previous) throw new Error(`No published @orchvia/engine below ${current}`);
  const work = mkdtempSync(join(tmpdir(), 'orchvia-rollback-'));
  try {
    const install = join(work, 'previous');
    mkdirSync(install);
    writeFileSync(join(install, 'package.json'), '{ "private": true }\n');
    execFileSync(
      npm,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-save',
        `@orchvia/engine@${previous}`,
      ],
      { cwd: install, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const pkgDir = join(install, 'node_modules/@orchvia/engine');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const entry = (sub) => {
      const target = manifest.exports[sub];
      return pathToFileURL(join(pkgDir, typeof target === 'string' ? target : target.import)).href;
    };
    const load = async (main, fake) => {
      const [engine, fakeModule] = [await import(main), await import(fake)];
      return {
        createEngine: (config) =>
          engine.createEngine({ ...config, storage: { emergencyBytes: 4096 } }),
        createFakeAdapter: fakeModule.createFakeAdapter,
      };
    };
    const older = await load(entry('.'), entry('./fake'));
    const newer = await load(
      pathToFileURL(join(root, 'packages/engine/src/index.ts')).href,
      pathToFileURL(join(root, 'packages/engine/src/fake.ts')).href,
    );
    const dirs = (name) => {
      const base = join(work, name);
      mkdirSync(join(base, 'workspace'), { recursive: true });
      return { workspace: join(base, 'workspace'), stateDir: join(base, 'state') };
    };
    const failures = [];

    // 1. The working tree writes; the previous release opens it; the working tree opens it again.
    const back = dirs('rollback');
    const written = await writeStore(newer, back, true);
    const rolledBack = await reopen(older, back, written.ids);
    if (rolledBack.refused) console.log(`${previous} refused the store: ${rolledBack.refused}`);
    else
      failures.push(
        ...compareReads(`${previous} read `, written.reads, rolledBack.reads, {
          laterByOlder: true,
        }),
      );
    const again = await reopen(newer, back, written.ids);
    failures.push(
      ...compareReads(`${current} read again `, written.reads, again.reads, { exact: true }),
    );

    // 2. The previous release writes; the working tree reads it.
    const up = dirs('upgrade');
    const old = await writeStore(older, up, false);
    const upgraded = await reopen(newer, up, old.ids);
    if (upgraded.refused)
      failures.push(`${current} refused a store of ${previous}: ${upgraded.refused}`);
    else failures.push(...compareReads(`${current} read `, old.reads, upgraded.reads));

    const counts = (reads) =>
      `${reads.tasks.length} tasks, ${reads.operations.length} steer operations, ` +
      `${reads.messages.length} steer messages, ${reads.rules.rules.length} rules, ${reads.events.length} events`;
    console.log(`Rollback ${current} → ${previous}: ${counts(written.reads)}`);
    console.log(`Upgrade ${previous} → ${current}: ${counts(old.reads)}`);
    if (failures.length) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
    } else console.log('Both directions read every record as written.');
  } finally {
    if (args.includes('--keep')) console.log(`Kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
