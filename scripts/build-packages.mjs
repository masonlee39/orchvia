import ts from 'typescript';
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  cp,
  chmod,
  access,
} from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'dist', 'release'));
const versionIndex = process.argv.indexOf('--version');
const releaseVersion = versionIndex < 0 ? undefined : process.argv[versionIndex + 1];
if (versionIndex >= 0 && !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(releaseVersion ?? ''))
  throw new Error('--version requires an explicit release version, e.g. 0.1.0 or 0.2.0-rc.1');
// SPEC-0021 P08: the root package.json holds the one version; --version replaces it in the build.
const sourceVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const version = releaseVersion ?? sourceVersion;
if (
  releaseVersion &&
  (await access(join(out, 'npm-manifest.json')).then(
    () => true,
    () => false,
  ))
)
  throw new Error(
    'Release output already contains a manifest; choose a new version and output directory',
  );
const temp = await mkdtemp(join(tmpdir(), 'orchvia-build-'));
const repository = 'https://github.com/masonlee39/orchvia';
const packageNames = {
  engine: '@orchvia/engine',
  'sdk-typescript': '@orchvia/sdk',
  'adapter-claude': '@orchvia/adapter-claude',
  'adapter-codex': '@orchvia/adapter-codex',
  cli: '@orchvia/cli',
};
/** Each package's exported source modules and their public names: `engine/types` -> `@orchvia/engine/types`. */
const publicEntries = {};
for (const [directory, name] of Object.entries(packageNames)) {
  const manifest = JSON.parse(
    await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'),
  );
  for (const [key, value] of Object.entries(manifest.exports ?? {}))
    publicEntries[`${directory}/${value.replace(/^\.\/src\//, '').replace(/\.ts$/, '')}`] =
      key === '.' ? name : `${name}/${key.slice(2)}`;
}
const descriptions = {
  engine:
    'Orchvia engine: one local scheduler with durable SQLite state for Claude Code and Codex agents.',
  'sdk-typescript': 'TypeScript SDK for Orchvia: run Claude Code and Codex agents as a team.',
  'adapter-claude': 'Claude Code runtime adapter for Orchvia.',
  'adapter-codex': 'Codex runtime adapter for Orchvia.',
  cli: 'Orchvia host and command-line tools.',
};
/** The README that npm shows for one package. */
function packageReadme(name, directory, version) {
  const install =
    directory === 'cli'
      ? 'npm install @orchvia/cli @orchvia/engine @orchvia/adapter-claude'
      : 'npm install @orchvia/sdk @orchvia/engine @orchvia/adapter-claude';
  return [
    `# ${name}`,
    '',
    `${descriptions[directory]} Part of [Orchvia](${repository}), version ${version}.`,
    '',
    'Orchvia runs Claude Code and Codex agents as a team from your own application: warm sessions that keep their history, a durable mailbox, human approval of results, and per-task token records.',
    '',
    '```sh',
    install,
    '```',
    '',
    'A Claude application installs the SDK, the engine and the Claude adapter; use `@orchvia/adapter-codex` for Codex. The Claude adapter loads `@anthropic-ai/claude-agent-sdk` when it is installed, or takes host-supplied callbacks. It needs no Zod.',
    '',
    '- Requires Node.js 22.18 or later. The packages are ESM-only.',
    '- Python applications use the [`orchvia`](https://pypi.org/project/orchvia/) package, which talks to a Node host from `@orchvia/cli`.',
    `- [Quickstart and documentation](${repository}#readme). This project is alpha software; see its [status](${repository}/blob/main/docs/status.md).`,
    '',
    'MIT licensed; see LICENSE. Third-party SDKs and runtimes keep their own licenses.',
    '',
  ].join('\n');
}
async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(full)));
    else result.push(full);
  }
  return result;
}
try {
  await mkdir(out, { recursive: true });
  const inputs = (await files(join(root, 'packages'))).filter((path) => path.endsWith('.ts'));
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    declaration: true,
    rewriteRelativeImportExtensions: true,
    rootDir: join(root, 'packages'),
    outDir: join(temp, 'compiled'),
    types: ['node'],
    verbatimModuleSyntax: true,
  };
  const program = ts.createProgram(inputs, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  const result = program.emit();
  if (result.emitSkipped) throw new Error('TypeScript package emission failed');
  const manifest = [];
  for (const [directory, name] of Object.entries(packageNames)) {
    const stage = join(temp, 'staged', directory),
      destination = join(stage, 'dist');
    await mkdir(stage, { recursive: true });
    await cp(join(temp, 'compiled', directory, 'src'), destination, { recursive: true });
    for (const path of await files(join(root, 'packages', directory, 'src')))
      if (path.endsWith('.json')) {
        const target = join(destination, relative(join(root, 'packages', directory, 'src'), path));
        await mkdir(dirname(target), { recursive: true });
        await cp(path, target);
      }
    const mapSpecifier = (value) => {
      const match = value.match(/^\.\.\/\.\.\/([^/]+)\/src\/(.+)\.(?:ts|js)$/);
      // SPEC-0027 T03: a module that a package exports keeps its public name, such as
      // @orchvia/engine/types, so that declarations refer to internal modules only when they must.
      if (match && packageNames[match[1]])
        return (
          publicEntries[`${match[1]}/${match[2]}`] ??
          `${packageNames[match[1]]}/internal/${match[2]}`
        );
      return value.replace(/^(\.\.?\/.*)\.ts$/, '$1.js');
    };
    for (const path of await files(destination))
      if (/\.(?:js|ts)$/.test(path)) {
        let code = await readFile(path, 'utf8');
        // Resolve executable/resource URLs through package exports after crossing package boundaries.
        code = code.replace(
          /new URL\((['"])(\.\.\/\.\.\/[^'"\n]+)\1,\s*import\.meta\.url\)/g,
          (_, quote, value) =>
            `new URL(import.meta.resolve(${JSON.stringify(mapSpecifier(value))}))`,
        );
        code = code.replace(
          /(['"])(\.{1,2}\/[^'"\n]+\.(?:ts|js))\1/g,
          (_, quote, value) => `${quote}${mapSpecifier(value)}${quote}`,
        );
        await writeFile(path, code);
      }
    // SPEC-0021 P09: the built engine reports the build's version wherever code reads it.
    if (directory === 'engine')
      for (const file of ['version.js', 'version.d.ts']) {
        const path = join(destination, file);
        const code = await readFile(path, 'utf8');
        if (code.match(/\bVERSION = (['"])[^'"]*\1/g)?.length !== 1)
          throw new Error(`Expected one version in the engine's ${file}`);
        await writeFile(path, code.replace(/(\bVERSION = )(['"])[^'"]*\2/, `$1$2${version}$2`));
      }
    // The source manifests stay private so that nothing publishes from the workspace by mistake.
    const { private: _workspaceOnly, ...original } = JSON.parse(
      await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'),
    );
    if (original.version !== sourceVersion)
      throw new Error(
        `packages/${directory}/package.json says ${original.version}, not ${sourceVersion}: use scripts/set-version.mjs`,
      );
    const exported = {};
    for (const [key, value] of Object.entries(original.exports ?? {})) {
      const target = value.replace('./src/', './dist/').replace(/\.ts$/, '.js');
      if (key.endsWith('.mjs')) {
        // SPEC-0039 H03: a program a host copies elsewhere, one module that imports only node:*.
        const standalone = target.replace(/\.js$/, '.mjs');
        const code = await readFile(join(stage, target), 'utf8');
        if (/\bfrom\s+['"](?!node:)|\bimport\s*\(\s*['"](?!node:)/.test(code))
          throw new Error(`${key} must import only node: modules`);
        await writeFile(join(stage, standalone), code);
        exported[key] = standalone;
        continue;
      }
      exported[key] = { types: target.replace(/\.js$/, '.d.ts'), import: target };
    }
    exported['./internal/*'] = { types: './dist/*.d.ts', import: './dist/*.js' };
    exported['./package.json'] = './package.json';
    const dependencies =
      directory === 'engine'
        ? {}
        : {
            '@orchvia/engine': version,
            ...(directory === 'cli' ? { '@orchvia/sdk': version } : {}),
          };
    const peers =
      directory === 'cli'
        ? {
            '@orchvia/adapter-claude': version,
            '@orchvia/adapter-codex': version,
          }
        : original.peerDependencies;
    const peerMeta =
      directory === 'cli'
        ? {
            '@orchvia/adapter-claude': { optional: true },
            '@orchvia/adapter-codex': { optional: true },
          }
        : original.peerDependenciesMeta;
    const pkg = {
      ...original,
      version,
      description: descriptions[directory],
      keywords: ['orchvia', 'multi-agent', 'claude-code', 'codex', 'orchestration', 'agents'],
      homepage: `${repository}#readme`,
      bugs: { url: `${repository}/issues` },
      repository: {
        type: 'git',
        url: `git+${repository}.git`,
        directory: `packages/${directory}`,
      },
      publishConfig: { access: 'public' },
      license: 'MIT',
      engines: { node: '>=22.18.0' },
      files: ['dist', 'README.md', 'LICENSE'],
      exports: exported,
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(peers ? { peerDependencies: peers, peerDependenciesMeta: peerMeta } : {}),
      ...(directory === 'cli' ? { bin: { orchvia: './dist/main.js' } } : {}),
    };
    await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    await writeFile(join(stage, 'README.md'), packageReadme(name, directory, version));
    if (directory === 'cli') await chmod(join(destination, 'main.js'), 0o755);
    if (
      releaseVersion &&
      (await access(join(out, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)).then(
        () => true,
        () => false,
      ))
    )
      throw new Error('A tarball with this version already exists; never overwrite it');
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], {
        cwd: stage,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_cache: join(temp, 'npm-cache'),
          npm_config_offline: 'true',
        },
      }),
    )[0];
    const bytes = await readFile(join(out, packed.filename));
    manifest.push({
      name,
      version,
      file: packed.filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  await writeFile(
    join(out, 'npm-manifest.json'),
    JSON.stringify({ node: process.version, packages: manifest }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ output: out, packages: manifest }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
