import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

// SPEC-0021 P08 and P09: one version number, written once and reported everywhere.
const root = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = ['engine', 'sdk-typescript', 'adapter-claude', 'adapter-codex', 'cli'];
const PYTHON_COPIES = ['python/pyproject.toml', 'python/src/orchvia/_version.py'];
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  ...PACKAGES.map((name) => `packages/${name}/package.json`),
  'packages/engine/src/version.ts',
  ...PYTHON_COPIES,
];
const pep440 = (version: string) =>
  version.replace('-alpha.', 'a').replace('-beta.', 'b').replace('-rc.', 'rc');
const rootVersion = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** Every copy of the version under `base`, by where it is written. */
function versionCopies(base: string) {
  const text = (path: string) =>
    existsSync(join(base, path)) ? readFileSync(join(base, path), 'utf8') : '';
  const json = (path: string) => JSON.parse(text(path) || '{}');
  const lock = json('package-lock.json');
  const copies: Record<string, string | undefined> = {
    'package.json': json('package.json').version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
  };
  for (const name of PACKAGES) {
    copies[`packages/${name}/package.json`] = json(`packages/${name}/package.json`).version;
    copies[`package-lock.json packages/${name}`] = lock.packages?.[`packages/${name}`]?.version;
  }
  copies['packages/engine/src/version.ts'] = /^export const VERSION = '([^']+)';$/m.exec(
    text('packages/engine/src/version.ts'),
  )?.[1];
  copies['python/pyproject.toml'] = /^version = "([^"]+)"$/m.exec(
    text('python/pyproject.toml'),
  )?.[1];
  copies['python/src/orchvia/_version.py'] = /^VERSION = "([^"]+)"$/m.exec(
    text('python/src/orchvia/_version.py'),
  )?.[1];
  return copies;
}

/** The copies that differ from `version`, in the spelling that each file uses. */
const mismatches = (base: string, version: string) =>
  Object.entries(versionCopies(base))
    .filter(
      ([where, value]) => value !== (PYTHON_COPIES.includes(where) ? pep440(version) : version),
    )
    .map(([where, value]) => `${where}: ${value ?? 'missing'}`);

test('0021-P08 package source writes the version only in version.ts and _version.py', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages', 'python/src'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (file) =>
        (/^packages\/[^/]+\/src\/.+\.ts$/.test(file) ||
          /^python\/src\/orchvia\/.+\.py$/.test(file)) &&
        !file.includes('/generated/') &&
        !['packages/engine/src/version.ts', 'python/src/orchvia/_version.py'].includes(file) &&
        existsSync(join(root, file)),
    );
  const found: string[] = [];
  for (const file of files)
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // Versions of other software: the zod peer, the Jev model and Claude Code (SPEC-0032 A01).
        for (const match of line.matchAll(/\b\d+\.\d+\.\d+\b/g))
          if (!/(?:zod |jev-|Claude Code )$/.test(line.slice(0, match.index)))
            found.push(`${file}:${index + 1}: ${line.trim()}`);
      });
  assert.deepEqual(found, []);
});

test('0021-P08 every copy of the version is the root version, and the changelog has its section', () => {
  const version = rootVersion();
  assert.deepEqual(mismatches(root, version), []);
  const heading = new RegExp(
    `^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    'm',
  );
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), heading);
  const python = spawnSync(
    'python3',
    [
      '-c',
      'import orchvia, orchvia.client; print(orchvia.__version__, orchvia.client.SDK_VERSION)',
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'python/src') } },
  );
  assert.equal(python.stdout.trim(), `${pep440(version)} ${pep440(version)}`, python.stderr);
});

test('0021-P08 the engine reports the root version to the TypeScript SDK', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-version-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'work'));
  await mkdir(join(base, 'state'), { mode: 0o700 });
  const orch = await createOrchestrator({
    workspace: join(base, 'work'),
    stateDir: join(base, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { model: 'fake-model' } },
    storage: { emergencyBytes: 4096 },
  });
  try {
    assert.equal(orch.info.engineVersion, rootVersion());
  } finally {
    await orch.close();
  }
});

test('0021-P08 set-version writes the version to every copy and changes nothing else', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-set-version-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const original = new Map<string, string>();
  for (const file of VERSION_FILES)
    if (existsSync(join(root, file))) {
      await mkdir(dirname(join(base, file)), { recursive: true });
      await cp(join(root, file), join(base, file));
      original.set(file, await readFile(join(root, file), 'utf8'));
    }
  const setVersion = (version: string) =>
    spawnSync(process.execPath, [join(root, 'scripts/set-version.mjs'), version, '--root', base], {
      encoding: 'utf8',
    });
  const next = setVersion('0.2.0-rc.7');
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(mismatches(base, '0.2.0-rc.7'), []);
  const invalid = setVersion('1.2');
  assert.equal(invalid.status, 1);
  assert.deepEqual(mismatches(base, '0.2.0-rc.7'), []);
  const back = setVersion(rootVersion());
  assert.equal(back.status, 0, back.stderr);
  for (const [file, text] of original)
    assert.equal(await readFile(join(base, file), 'utf8'), text, `${file} round-trips`);
});

/** A repository whose main has `package.json` at 0.1.0 and changelog sections for 0.1.1 and 0.1.0. */
async function releaseRepository(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-release-version-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: base, encoding: 'utf8' },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(base, 'package.json'), '{"version": "0.1.0"}\n');
  await writeFile(
    join(base, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.1.1] - 2026-09-23\n\n## [0.1.0] - 2026-09-23\n',
  );
  git('add', '.');
  git('commit', '--quiet', '-m', 'main');
  const onMain = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', onMain);
  git('switch', '--quiet', '-c', 'side');
  await writeFile(join(base, 'side.txt'), 'not on main\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'side');
  const offMain = git('rev-parse', 'HEAD');
  const release = (ref: string, sha: string) =>
    spawnSync(process.execPath, [join(root, 'scripts/release-version.mjs')], {
      cwd: base,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_RUN_NUMBER: '42' },
    });
  return { onMain, offMain, release };
}

test('0021-P09 a release tag must equal the source version, have a changelog section and be on main', async (t) => {
  const { onMain, offMain, release } = await releaseRepository(t);
  const ok = release('refs/tags/v0.1.0', onMain);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '0.1.0\n');
  const problems: string[] = [];
  for (const [ref, sha, why] of [
    ['refs/tags/v0.1.1', onMain, 'differs from package.json'],
    ['refs/tags/v0.1.2', onMain, 'has no changelog section'],
    ['refs/tags/v0.1.0', offMain, 'is not on main'],
  ]) {
    const result = release(ref!, sha!);
    if (result.status !== 1) problems.push(`${ref} (${why}) exited with ${result.status}`);
  }
  assert.deepEqual(problems, []);
  const dryRun = release('refs/pull/5/merge', offMain);
  assert.equal(dryRun.stdout, '0.0.0-rc.42\n', dryRun.stderr);
});
