import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { artifactWritesSettled, type Store } from '../../packages/engine/src/store.ts';
import type {
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  RuntimeProgress,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0060: masking in linear time, private store files, and counts through indexes.

const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
});

/** A runtime that hands its input to the test and works until released. */
async function running(t: any, config: Record<string, unknown> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-review-')));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: (input: RuntimeInput) => void;
  const began = new Promise<RuntimeInput>((resolve) => (started = resolve));
  const adapter = {
    ...fake,
    async *execute(input: RuntimeInput) {
      yield { type: 'accepted', providerSessionId: `fake-${input.sessionId}` };
      started(input);
      await held;
      for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
    },
  } as RuntimeAdapter;
  const engine: any = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    ...config,
  });
  t.after(async () => {
    release();
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const task = (await engine.call('tasks.create', {
    spec: spec('work'),
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const input = await began;
  const progress = async () =>
    (
      (await engine.call('events.read', {
        limit: 1000,
        types: ['dispatch.progress'],
      })) as EventPage
    ).events.map((event) => event.data as Record<string, any>);
  return { dir, engine, task, input, release, progress };
}

// The two patterns of 0.1.31 that look for a secret's name, and its two others, as they were.
const SECRET_NAME =
  '[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*';
const SECRET_VALUE = `(?:"[^"]*"|'[^']*'|[A-Za-z0-9_+/=~@](?:[A-Za-z0-9_+/=.~:@-]*[A-Za-z0-9_+/=~@-])?)`;
const BEFORE: [RegExp, string][] = [
  [new RegExp(`(\\b${SECRET_NAME}\\s*[=:]\\s*)${SECRET_VALUE}`, 'gi'), '$1***'],
  [new RegExp(`(--?${SECRET_NAME}\\s+)${SECRET_VALUE}`, 'gi'), '$1***'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g,
    '***',
  ],
];
const before = (value: string) =>
  BEFORE.reduce((text, [pattern, mask]) => text.replace(pattern, mask), value);
const masking = () => import('../../packages/engine/src/masking.ts');

test('AC-0060-M01 a command that held the engine for seconds is masked at once', async (t) => {
  const s = await running(t);
  // 6,000 characters of this took 8 seconds in 0.1.31, inside the engine's only thread.
  const started = performance.now();
  s.input.reportProgress!({
    kind: 'tool_started',
    tool: 'Bash',
    command: `echo ${'token-'.repeat(1000)}`,
  } as RuntimeProgress);
  const elapsed = performance.now() - started;
  // A loaded machine may take its time; 0.1.31 took 8 seconds on an idle one.
  assert.ok(elapsed < 3000, `reporting one command took ${Math.round(elapsed)} ms`);
  const [written] = await s.progress();
  assert.equal(written!.command, `echo ${'token-'.repeat(1000)}`.slice(0, 200));
});

test('AC-0060-M01 masking takes time proportional to the text', async () => {
  const { maskSecrets } = await masking();
  // Each of these grew with the square or the cube of its length in 0.1.31.
  for (const unit of ['token-', 'a-', '--a-', 'token- ', 'secret="', "key-token:'"]) {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const started = performance.now();
    maskSecrets(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(unit)} repeated took ${Math.round(elapsed)} ms`);
  }
});

test('AC-0060-M02 generated texts are masked as the patterns of 0.1.31 mask them', async () => {
  const { maskSecrets } = await masking();
  const parts = [
    'token', 'secret', 'password', 'passwd', 'api-key', 'api_key', 'apikey', 'access-key',
    'private_key', 'credential', 'TOKEN', 'Api-Key', 'key', 'name', 'x', 'my', 'abc', 'Z9',
    '-', '--', '_', '=', ':', ' ', '  ', '\t', '\n', '"', "'", '.', '/', '+', '@', '~', ',', ';',
    '(', ')', 'Bearer', 'Basic', 'sk-', 'ghp_', 'AKIA', 'abcdefgh12345678', 'ABCDEFGHIJKLMNOP',
    'é', '中', '$', '*',
  ]; // prettier-ignore
  // A fixed sequence, so that a difference can be found again.
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 40_000; sample++) {
    let text = '';
    for (let count = next() % 14; count > 0; count--) text += parts[next() % parts.length];
    assert.equal(maskSecrets(text), before(text), JSON.stringify(text));
  }
  for (const text of [
    'curl -H "Authorization: Bearer abc.DEF-123" --api-key k123 GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx deploy',
    'Use sk-ant-api03-abcdefghijkl and AKIAABCDEFGHIJKLMNOP; password: hunter2. Done.',
    'export DB_PASSWORD="p w" MY-SECRET=\'x y\' token : abc --secret-key=v1 -token v2',
    'x-api-key abc my-token def foo--token bar key-token: --password hunter2',
    'R1-token R2secret=value more',
    '',
  ])
    assert.equal(maskSecrets(text), before(text), JSON.stringify(text));
});

test('AC-0060-M03 a long value is masked whole, and a bounded part of the text is examined', async (t) => {
  const s = await running(t);
  const report = (progress: unknown) => s.input.reportProgress!(progress as RuntimeProgress);
  // A quoted value far longer than what is kept, such as a private key, is seen to its end.
  report({
    kind: 'tool_started',
    tool: 'Bash',
    command: `export PRIVATE_KEY="${'k'.repeat(5000)}" && deploy --token ${'v'.repeat(5000)}`,
  });
  // What lies past the kept part changes nothing that is kept.
  report({
    kind: 'tool_started',
    tool: 'Bash',
    command: `${'make '.repeat(300)} password=hunter2`,
  });
  report({ kind: 'assistant_text', text: `the password: "${'p'.repeat(5000)}" was used` });
  // More than is examined: the part that is kept comes from the examined part alone.
  report({ kind: 'tool_started', tool: 'Bash', command: `echo ${'a b '.repeat(100_000)}` });
  const [long, far, text, huge] = await s.progress();
  assert.equal(long!.command, 'export PRIVATE_KEY=*** && deploy --token ***');
  assert.equal(far!.command, 'make '.repeat(300).slice(0, 200));
  assert.equal(text!.text, 'the password: *** was used');
  assert.equal(huge!.command, `echo ${'a b '.repeat(100_000)}`.slice(0, 200));
  const { MASKED_CHARACTERS } = await masking();
  assert.equal(MASKED_CHARACTERS, 262_144);
});

test('AC-0060-M04 the message of a retry is masked', async (t) => {
  const s = await running(t);
  s.input.reportProgress!({
    kind: 'api_retry',
    attempt: 1,
    maxRetries: 5,
    delayMs: null,
    status: 401,
    message: 'Incorrect API key provided: sk-abcdefgh12345678. Authorization: Bearer abc.def',
  } as RuntimeProgress);
  const [retry] = await s.progress();
  assert.equal(retry!.message, 'Incorrect API key provided: ***. Authorization: Bearer ***');
});

const modes = (root: string): string[] => {
  const found: string[] = [];
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      if (mode !== 0o700) found.push(`${name}/ ${mode.toString(8)}`);
      for (const child of readdirSync(path)) visit(join(path, child), `${name}/${child}`);
    } else if (mode & 0o077) found.push(`${name} ${mode.toString(8)}`);
  };
  visit(root, '.');
  return found;
};

test('AC-0060-P01 every file of a new state and control directory is private', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-review-')));
  for (const name of ['workspace', 'state', 'control', 'stores', 'archives'])
    await mkdir(join(dir, name), { mode: 0o700 });
  const engine: any = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    stores: {
      controlDir: join(dir, 'control'),
      storesRoot: join(dir, 'stores'),
      archiveRoot: join(dir, 'archives'),
    },
  });
  t.after(async () => {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await engine.call('tasks.create', { spec: spec('files'), idempotencyKey: 'files' });
  for (
    let n = 0;
    n < 400 && (engine.flights.size || !existsSync(join(dir, 'state', 'artifacts')));
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await artifactWritesSettled();
  // While the engine runs: the WAL, its index and the lock's journal exist now.
  for (const name of ['store.sqlite-wal', 'store.sqlite-shm', 'owner.sqlite-journal'])
    assert.ok(existsSync(join(dir, 'state', name)), `${name} exists while the engine runs`);
  assert.ok(existsSync(join(dir, 'control', 'owner.sqlite-journal')));
  assert.deepEqual(modes(join(dir, 'state')), []);
  assert.deepEqual(modes(join(dir, 'control')), []);
});

test('AC-0060-P01 files that an earlier version left readable become private at a start', async (t) => {
  const s = await running(t);
  // As a crash leaves the directory, with the modes 0.1.31 gave these files.
  const copy = join(s.dir, 'state-after-crash');
  await cp(join(s.dir, 'state'), copy, { recursive: true });
  await chmod(copy, 0o700);
  for (const name of ['store.sqlite-wal', 'store.sqlite-shm', 'owner.sqlite-journal'])
    if (existsSync(join(copy, name))) await chmod(join(copy, name), 0o644);
  assert.ok(existsSync(join(copy, 'store.sqlite-wal')), 'the copy holds a WAL');
  const again: any = await createEngine({
    workspace: join(s.dir, 'workspace'),
    stateDir: copy,
    adapters: [createFakeAdapter()],
    allowCrossRootReuse: true,
  });
  t.after(() => again.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
  assert.deepEqual(modes(copy), []);
});

/** The plan of each statement that `use` prepares and that reads `table`. */
async function plans(engine: any, table: string, use: () => Promise<unknown>): Promise<string[]> {
  const store: Store = engine.store;
  const seen = new Set<string>();
  const prepare = store.db.prepare.bind(store.db);
  (store.db as any).prepare = (sql: string) => {
    if (new RegExp(`count\\(\\*\\)[^;]*FROM ${table} WHERE`, 'is').test(sql)) seen.add(sql);
    return prepare(sql);
  };
  try {
    await use();
  } finally {
    delete (store.db as any).prepare;
  }
  return [...seen].map((sql) =>
    (
      prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.match(/\?/g) ?? []).map(() => 'x')) as {
        detail: string;
      }[]
    )
      .map((row) => row.detail)
      .join(' | '),
  );
}

test('AC-0060-I01 the count of a dispatch’s tool calls reads an index', async (t) => {
  const s = await running(t, { tools: { enabled: true } });
  const found = await plans(s.engine, 'tool_calls', () =>
    s.input.orchestrationTools!.call('work_read', { kind: 'task', id: s.task.id }),
  );
  assert.equal(found.length, 1, 'the tool call counted its dispatch’s calls');
  assert.match(found[0]!, /USING (COVERING )?INDEX tool_calls_dispatch/);
});

test('AC-0060-I02 the message rate limit reads an index', async (t) => {
  const s = await running(t);
  const session = (await s.engine.call('sessions.get', {
    sessionId: s.task.sessionId,
  })) as SessionSnapshot;
  const found = await plans(s.engine, 'messages', () =>
    s.engine.call('messages.send', {
      spec: {
        taskId: s.task.id,
        toSessionId: session.id,
        expectedGeneration: session.generation,
        kind: 'finding',
        summary: 'note',
      },
      idempotencyKey: 'note',
    }),
  );
  assert.equal(found.length, 1, 'the send counted its sender’s recent messages');
  assert.match(found[0]!, /USING (COVERING )?INDEX messages_sender_created/);
});

test('AC-0060-I03 a store without the indexes gets them when it is opened', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-review-')));
  await mkdir(join(dir, 'workspace'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
  };
  const names = (engine: any) =>
    (
      engine.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
  const first: any = await createEngine(config);
  // As a store that 0.1.31 wrote.
  first.store.db.exec(
    'DROP INDEX IF EXISTS tool_calls_dispatch; DROP INDEX IF EXISTS messages_sender_created;',
  );
  assert.ok(!names(first).includes('tool_calls_dispatch'));
  await first.close({ mode: 'interrupt', timeoutMs: 1000 });
  const second: any = await createEngine(config);
  t.after(() => second.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
  for (const index of ['tool_calls_dispatch', 'messages_sender_created'])
    assert.ok(names(second).includes(index), index);
});
