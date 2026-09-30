// Sets the one Orchvia version in every copy (SPEC-0021 P08). The root package.json holds it, and
// this script is the only way to change it; tests/contract/version.test.ts checks every copy.
// node scripts/set-version.mjs X.Y.Z[-alpha.N|-beta.N|-rc.N] [--root DIR]
// It also replaces the compatibility baseline after checking it (SPEC-0051 G02).
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const positional = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
  else positional.push(args[i]);
const [version] = positional;
if (positional.length !== 1 || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs X.Y.Z[-alpha.N|-beta.N|-rc.N] [--root DIR]');
  process.exit(1);
}
// PEP 440 spells 0.2.0-rc.1 as 0.2.0rc1, and alpha and beta as a and b.
const python = version.replace('-alpha.', 'a').replace('-beta.', 'b').replace('-rc.', 'rc');
const PACKAGES = ['engine', 'sdk-typescript', 'adapter-claude', 'adapter-codex', 'cli'];

// Every file is read and checked before any is written.
const edits = [];
async function json(path, change) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  change(value);
  edits.push([path, JSON.stringify(value, null, 2) + '\n']);
}
async function line(path, prefix, value) {
  const text = await readFile(join(root, path), 'utf8');
  const pattern = new RegExp(`^${prefix}(['"])[^'"]*\\1(;?)$`, 'm');
  const count = text.match(new RegExp(pattern.source, 'gm'))?.length ?? 0;
  if (count !== 1) throw new Error(`${path}: expected one version line, found ${count}`);
  edits.push([
    path,
    text.replace(pattern, (_, quote, end) => `${prefix}${quote}${value}${quote}${end}`),
  ]);
}
await json('package.json', (pkg) => (pkg.version = version));
for (const name of PACKAGES)
  await json(`packages/${name}/package.json`, (pkg) => (pkg.version = version));
await json('package-lock.json', (lock) => {
  lock.version = version;
  for (const key of ['', ...PACKAGES.map((name) => `packages/${name}`)]) {
    if (!lock.packages?.[key]) throw new Error(`package-lock.json has no entry "${key}"`);
    lock.packages[key].version = version;
  }
});
await line('packages/engine/src/version.ts', 'export const VERSION = ', version);
await line('python/pyproject.toml', 'version = ', python);
await line('python/src/orchvia/_version.py', 'VERSION = ', python);

// SPEC-0051 G02: a breaking change against the baseline stops the version change before anything
// is written; the new version's baseline is written after the version.
const baseline = existsSync(join(root, 'schemas/compat-baseline.json'));
const compat = baseline && (await import('./compat-baseline.mjs'));
if (compat) {
  const result = await compat.checkBaseline(root, { version });
  if (!result.ok) {
    for (const line of result.unaccepted) console.error(`BREAKING ${line}`);
    console.error(
      'A breaking change needs a higher minor version, or an entry with a reason in ' +
        'schemas/compat-accepted.json when the change breaks nothing.',
    );
    process.exit(1);
  }
}
for (const [path, text] of edits) await writeFile(join(root, path), text);
if (compat) await compat.checkBaseline(root, { version, write: true });
console.log(
  `${version} (Python ${python}) in ${edits.length} files${compat ? ', and its compatibility baseline' : ''}`,
);
