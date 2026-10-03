import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { engineConfig, loadConfig } from '../../packages/cli/src/config.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { artifactWritesSettled, Store } from '../../packages/engine/src/store.ts';
import * as verification from '../../packages/engine/src/verification.ts';
import { normalizeRules, workspacePath } from '../../packages/engine/src/verification.ts';
import type { EngineClock, TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0061: journals removed once their artifact is registered, baselines computed without holding
// the thread, and a check's environment.

const spec = (goal: string, acceptance?: Record<string, unknown>) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: acceptance ?? { mode: 'human', criteria: ['Review'] },
});
async function directory(t: any) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-second-')));
  await mkdir(join(dir, 'workspace'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, workspace: join(dir, 'workspace'), stateDir: join(dir, 'state') };
}
const idle = async (engine: any) => {
  for (let n = 0; n < 4000; n++) {
    await artifactWritesSettled();
    await new Promise((resolve) => setTimeout(resolve, 3));
    if (engine.flights.size === 0 && !engine.store.queuedTasks().length) return;
  }
  assert.fail('the engine did not become idle');
};
const journals = (stateDir: string) => readdirSync(join(stateDir, 'file-commits'));

test('AC-0061-J01 after a task ends no journal is left, and the kept total is the directory’s', async (t) => {
  const { workspace, stateDir } = await directory(t);
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now() + offset,
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const config = { workspace, stateDir, adapters: [createFakeAdapter()], clock };
  const engine: any = await createEngine(config);
  t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
  await engine.storage.walked();
  for (const key of ['one', 'two'])
    await engine.call('tasks.create', { spec: spec(key), idempotencyKey: key });
  await idle(engine);
  assert.ok(readdirSync(join(stateDir, 'artifacts')).length >= 3, 'the tasks wrote artifacts');
  assert.deepEqual(journals(stateDir), []);
  // What the store keeps as its files' total, against a walk of the directory.
  const kept = engine.storage.fileBytes as number;
  offset += 61_000;
  engine.storage.status();
  await engine.storage.walked();
  assert.equal(kept, engine.storage.fileBytes, 'the total does not count the removed journals');
});

test('AC-0061-J02 a registration that rolls back keeps its journal for the next start', async (t) => {
  const { workspace, stateDir } = await directory(t);
  const first = new Store(workspace, stateDir);
  assert.throws(() =>
    first.transaction(() => {
      first.artifact('rolled back');
      throw new Error('stop');
    }),
  );
  assert.equal(journals(stateDir).length, 1, 'the journal of what was not registered stays');
  assert.equal(first.all('artifacts').length, 0);
  first.close();
  const second = new Store(workspace, stateDir);
  t.after(() => second.close());
  const [orphan] = second.all<{ recoveredOrphan?: boolean }>('artifacts');
  assert.equal(orphan?.recoveredOrphan, true);
  assert.deepEqual(journals(stateDir), []);
});

test('AC-0061-J03 a stop between the commit and the removal leaves a journal the next start removes', async (t) => {
  const { workspace, stateDir } = await directory(t);
  const first = new Store(workspace, stateDir, {
    fault: (point) => {
      if (point === 'artifact.committed') throw new Error('stopped here');
    },
  });
  // The transaction committed: the stop came after it.
  const ref = first.transaction(() => first.artifact('committed'));
  assert.equal(journals(stateDir).length, 1);
  assert.equal(first.artifactText(ref), 'committed');
  first.close();
  const second = new Store(workspace, stateDir);
  t.after(() => second.close());
  const records = second.all<{ id: string; recoveredOrphan?: boolean }>('artifacts');
  assert.deepEqual(
    records.map((record) => [record.id, record.recoveredOrphan ?? false]),
    [[ref, false]],
  );
  assert.deepEqual(journals(stateDir), []);
  // Without the stop, an artifact outside any transaction of the caller's loses its journal too.
  second.artifact('on its own');
  assert.deepEqual(journals(stateDir), []);
});

/** A tree with what a baseline meets: directories, links, an empty and a large file, `.git`. */
function tree(workspace: string): void {
  mkdirSync(join(workspace, 'src', 'deep', 'er'), { recursive: true });
  mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, '.git', 'HEAD'), 'not part of a baseline');
  writeFileSync(join(workspace, 'src', 'a.txt'), 'a');
  writeFileSync(join(workspace, 'src', 'empty'), '');
  writeFileSync(join(workspace, 'src', 'deep', 'er', 'b.bin'), Buffer.alloc(3_500_000, 7));
  writeFileSync(join(workspace, 'src', 'deep', 'c.txt'), 'c'.repeat(70_000), { mode: 0o755 });
  symlinkSync(join(workspace, 'src', 'a.txt'), join(workspace, 'link-to-file'));
  symlinkSync(join(workspace, 'src', 'deep'), join(workspace, 'link-to-directory'));
}
/** The baseline as 0.1.32 computed it, synchronously: what B02 compares with. */
function workspaceBaseline(workspace: string, paths: string[]): string {
  const refuse = (code: string, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  const hash = createHash('sha256');
  const seen = new Set<string>();
  let bytes = 0;
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    if (seen.size > 20000)
      refuse(
        'BASELINE_LIMIT',
        'Verification baseline exceeds 20000 entries; register narrower baselinePaths',
      );
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = workspacePath(workspace, path);
      hash.update(`link:${relative(workspace, path)}:${target}\n`);
      visit(target);
    } else if (stat.isDirectory()) {
      hash.update(`directory:${relative(workspace, path)}\n`);
      for (const child of readdirSync(path).sort()) {
        if (child !== '.git') visit(resolve(path, child));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024)
        refuse(
          'BASELINE_LIMIT',
          'Verification baseline exceeds 64 MiB; register narrower baselinePaths',
        );
      hash.update(`file:${relative(workspace, path)}:${stat.mode}:`);
      hash.update(readFileSync(path));
    } else refuse('INVALID_WORKSPACE_SCOPE', 'Verification baseline contains a special file');
  };
  for (const path of [...paths].sort()) visit(workspacePath(workspace, path));
  return hash.digest('hex');
}
const baselineAsync = (workspace: string, paths: string[], signal?: AbortSignal) =>
  (
    verification.workspaceBaseline as unknown as (
      workspace: string,
      paths: string[],
      signal?: AbortSignal,
    ) => Promise<string>
  )(workspace, paths, signal);

test('AC-0061-B02 the asynchronous baseline equals the synchronous one, with its limits', async (t) => {
  const { workspace } = await directory(t);
  tree(workspace);
  for (const paths of [['.'], ['src'], ['src/deep', 'link-to-file'], ['link-to-directory']])
    assert.equal(
      await baselineAsync(workspace, paths),
      workspaceBaseline(workspace, paths),
      paths.join(' '),
    );
  // 65 MiB that take no space: the limit is the files' sizes.
  writeFileSync(join(workspace, 'huge'), '');
  truncateSync(join(workspace, 'huge'), 65 * 1024 * 1024);
  const refused = { code: 'BASELINE_LIMIT', message: /64 MiB/ };
  assert.throws(() => workspaceBaseline(workspace, ['.']), refused);
  await assert.rejects(baselineAsync(workspace, ['.']), refused);
  await rm(join(workspace, 'huge'));
  mkdirSync(join(workspace, 'many'));
  for (let n = 0; n < 20_001; n++) writeFileSync(join(workspace, 'many', `f${n}`), '');
  const tooMany = { code: 'BASELINE_LIMIT', message: /20000 entries/ };
  assert.throws(() => workspaceBaseline(workspace, ['many']), tooMany);
  await assert.rejects(baselineAsync(workspace, ['many']), tooMany);
});

const rule = (argv: string[], extra: Record<string, unknown> = {}) =>
  normalizeRules('/', [
    {
      id: 'check',
      version: '1',
      argv,
      cwdRelative: '.',
      timeoutMs: 20_000,
      permissionProfile: 'read-only',
      success: { exitCode: 0 },
      ...extra,
    } as never,
  ]);

test('AC-0061-B01 a verification reads no file synchronously', async (t) => {
  const { workspace } = await directory(t);
  tree(workspace);
  const [check] = normalizeRules(workspace, [
    {
      id: 'check',
      version: '1',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwdRelative: '.',
      timeoutMs: 20_000,
      permissionProfile: 'read-only',
      success: { exitCode: 0 },
    },
  ]);
  const read = t.mock.method(fs, 'readFileSync');
  const list = t.mock.method(fs, 'readdirSync');
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const evidence = await verification.verifyRule(workspace, check!, new AbortController().signal);
  const synchronous = read.mock.callCount() + list.mock.callCount();
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
  assert.equal(evidence.before, workspaceBaseline(workspace, ['.']));
  assert.equal(synchronous, 0, 'files read or directories listed synchronously');
});

test('AC-0061-B03 a verification cancelled during its baseline ends without running its command', async (t) => {
  const { workspace } = await directory(t);
  tree(workspace);
  const marker = join(workspace, '..', 'ran');
  const [check] = normalizeRules(workspace, [
    {
      id: 'check',
      version: '1',
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`,
      ],
      cwdRelative: '.',
      timeoutMs: 20_000,
      permissionProfile: 'read-only',
      success: { exitCode: 0 },
    },
  ]);
  const controller = new AbortController();
  controller.abort();
  const evidence = await verification.verifyRule(workspace, check!, controller.signal);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.before, null, 'the baseline stopped before it was complete');
  assert.match(evidence.error ?? '', /cancelled/i);
  assert.equal(existsSync(marker), false, 'the command did not run');
});

test('AC-0061-V01 AC-0061-V02 0065-B02 a minimal environment, the default, holds the listed variables, the named ones and no other', () => {
  const environment = (verification as any).verificationEnvironment as (
    mode: unknown,
    names: unknown,
    host: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv | undefined;
  assert.equal(typeof environment, 'function');
  const host = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'C.UTF-8',
    ANTHROPIC_API_KEY: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NODE_OPTIONS: '--max-old-space-size=512',
    CI: '1',
  };
  assert.equal(environment('inherit', ['CI'], host), undefined, 'inherit: the host’s own');
  // SPEC-0065 B02: minimal is the default from 0.2.0 (SPEC-0061 V03).
  assert.deepEqual(environment(undefined, ['CI'], host), {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'C.UTF-8',
    CI: '1',
  });
  assert.deepEqual(environment('minimal', undefined, host), {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'C.UTF-8',
  });
  assert.deepEqual(environment('minimal', ['CI', 'NODE_OPTIONS', 'NOT_SET'], host), {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'C.UTF-8',
    CI: '1',
    NODE_OPTIONS: '--max-old-space-size=512',
  });
  for (const [mode, names] of [
    ['none', undefined],
    ['minimal', 'CI'],
    ['minimal', ['BAD-NAME']],
    ['minimal', ['1X']],
    ['minimal', Array.from({ length: 65 }, (_, n) => `V${n}`)],
  ] as const)
    assert.throws(() => environment(mode, names, host), { code: 'VALIDATION_ERROR' });
});

test('AC-0061-V01 0065-B02 a check’s command sees the minimal environment by default, and the host’s when asked', async (t) => {
  process.env.ORCH_0061_SECRET = 'from the host';
  process.env.ORCH_0061_NAMED = 'named';
  t.after(() => {
    delete process.env.ORCH_0061_SECRET;
    delete process.env.ORCH_0061_NAMED;
  });
  // The check passes only when the secret is not in its environment and the named variable is.
  const argv = [
    process.execPath,
    '-e',
    'process.exit(process.env.ORCH_0061_SECRET ? 3 : process.env.ORCH_0061_NAMED === "named" ? 0 : 4)',
  ];
  const run = async (config: Record<string, unknown>) => {
    const { workspace, stateDir } = await directory(t);
    const engine: any = await createEngine({
      workspace,
      stateDir,
      adapters: [createFakeAdapter()],
      verificationRules: rule(argv).map(({ digest: _digest, ...value }) => value),
      ...config,
    });
    t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
    const task = (await engine.call('tasks.create', {
      spec: spec('checked', {
        mode: 'checks',
        ruleRefs: [{ id: 'check', version: '1' }],
        maxRepairs: 0,
      }),
      idempotencyKey: 'checked',
    })) as TaskSnapshot;
    for (let n = 0; n < 4000; n++) {
      const now = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
      if (!['queued', 'running', 'verifying'].includes(now.status)) return now.status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return 'still running';
  };
  // A check that fails with no repair left blocks its task.
  assert.equal(
    await run({ verificationEnvironment: 'inherit' }),
    'blocked',
    'inherit: the command sees the secret',
  );
  assert.equal(
    await run({ verificationInheritEnv: ['ORCH_0061_NAMED'] }),
    'completed',
    'by default the command sees only the minimal environment and the named variables',
  );
  assert.equal(
    await run({ verificationEnvironment: 'minimal', verificationInheritEnv: ['ORCH_0061_NAMED'] }),
    'completed',
  );
  assert.equal(
    await run({ verificationEnvironment: 'minimal' }),
    'blocked',
    'not named: not passed',
  );
  const { workspace, stateDir } = await directory(t);
  await assert.rejects(
    createEngine({
      workspace,
      stateDir,
      adapters: [createFakeAdapter()],
      verificationEnvironment: 'none',
    } as never),
    { code: 'VALIDATION_ERROR' },
  );
});

test('AC-0061-V02 the CLI configuration takes both settings and refuses another value', async (t) => {
  const { dir, workspace, stateDir } = await directory(t);
  await mkdir(stateDir, { mode: 0o700 });
  let files = 0;
  const write = (extra: Record<string, unknown>) => {
    const path = join(dir, `config-${files++}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        configVersion: 1,
        workspace,
        stateDir,
        providers: { fake: { model: 'fixture' } },
        ...extra,
      }),
    );
    return path;
  };
  const config = await engineConfig(
    await loadConfig(
      write({ verificationEnvironment: 'minimal', verificationInheritEnv: ['CI', 'NODE_OPTIONS'] }),
    ),
  );
  assert.equal(config.verificationEnvironment, 'minimal');
  assert.deepEqual(config.verificationInheritEnv, ['CI', 'NODE_OPTIONS']);
  const plain = await engineConfig(await loadConfig(write({})));
  assert.equal(plain.verificationEnvironment, undefined);
  for (const extra of [
    { verificationEnvironment: 'none' },
    { verificationInheritEnv: ['BAD-NAME'] },
    { verificationInheritEnv: 'CI' },
  ])
    await assert.rejects(
      loadConfig(write(extra)),
      { code: 'INVALID_CONFIG' },
      JSON.stringify(extra),
    );
});
