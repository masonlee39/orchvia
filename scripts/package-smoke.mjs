import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { smokeClaudeBundles } from './package-bundles-smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = resolve(process.argv[2] ?? join(root, 'dist/release'));
const pythonRelease = resolve(process.env.PACKAGE_PYTHON_RELEASE ?? release);
const python = process.env.PACKAGE_TEST_PYTHON ?? 'python3';
const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-install-')));
const env = {
  ...process.env,
  npm_config_cache: join(base, 'npm-cache'),
  npm_config_offline: 'true',
  PYTHONPATH: '',
  NODE_PATH: '',
};
const manifest = JSON.parse(await readFile(join(release, 'npm-manifest.json'), 'utf8'));
const releaseVersions = new Set(manifest.packages.map((pkg) => pkg.version));
assert.equal(releaseVersions.size, 1, 'All npm packages must share one release version');
const releaseVersion = [...releaseVersions][0];
const pythonVersion = releaseVersion
  .replace('-alpha.', 'a')
  .replace('-beta.', 'b')
  .replace('-rc.', 'rc');
const pythonManifest = JSON.parse(
  await readFile(join(pythonRelease, 'python-manifest.json'), 'utf8'),
);
assert.equal(pythonManifest.releaseVersion, releaseVersion);
assert.equal(pythonManifest.version, pythonVersion);
for (const file of pythonManifest.files)
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(pythonRelease, file.file)))
      .digest('hex'),
    file.sha256,
    file.file,
  );
const archive = (name) => join(release, manifest.packages.find((pkg) => pkg.name === name).file);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: base, env, encoding: 'utf8', timeout: 60000, ...options });
const results = [];
try {
  for (const pkg of manifest.packages)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(release, pkg.file)))
        .digest('hex'),
      pkg.sha256,
      pkg.name,
    );
  await writeFile(
    join(base, 'package.json'),
    '{"name":"offline-package-fixture","private":true,"type":"module"}\n',
  );
  run('npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=true',
    ...['@orchvia/engine', '@orchvia/sdk', '@orchvia/cli'].map(archive),
  ]);
  const lock = JSON.parse(await readFile(join(base, 'package-lock.json'), 'utf8'));
  for (const name of ['@orchvia/engine', '@orchvia/sdk', '@orchvia/cli']) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.match(entry.resolved, /^file:/);
    assert.match(entry.integrity, /^sha512-/);
  }
  // SPEC-0027 T03: the SDK's declarations name only public engine modules.
  const declarations = async (directory) => {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) found.push(...(await declarations(join(directory, entry.name))));
      else if (entry.name.endsWith('.d.ts')) found.push(join(directory, entry.name));
    return found;
  };
  const internal = [];
  for (const file of await declarations(join(base, 'node_modules/@orchvia/sdk/dist')))
    for (const match of (await readFile(file, 'utf8')).matchAll(
      /@orchvia\/[a-z-]+\/internal\/[\w/.-]+/g,
    ))
      internal.push(`${file.slice(base.length + 1)}: ${match[0]}`);
  assert.deepEqual(internal, [], 'The SDK declarations must not name internal modules');
  // SPEC-0021 P01 and R10: the archives can be published as built, and describe themselves.
  const packed = (file, path) => run('tar', ['-xzOf', join(release, file), `package/${path}`]);
  for (const pkg of manifest.packages) {
    const meta = JSON.parse(packed(pkg.file, 'package.json'));
    assert.equal(meta.private, undefined, `${pkg.name} must be publishable`);
    assert.deepEqual(meta.publishConfig, { access: 'public' });
    assert.equal(meta.repository.url, 'git+https://github.com/masonlee39/orchvia.git');
    assert.equal(meta.homepage, 'https://github.com/masonlee39/orchvia#readme');
    assert.match(meta.description, /Orchvia/);
    const readme = packed(pkg.file, 'README.md');
    assert.doesNotMatch(readme, /unpublished/i, `${pkg.name} README`);
    assert.match(readme, /npm install @orchvia\//);
  }
  const cliPackage = manifest.packages.find((pkg) => pkg.name === '@orchvia/cli');
  assert.deepEqual(Object.keys(JSON.parse(packed(cliPackage.file, 'package.json')).bin), [
    'orchvia',
  ]);
  const wheelMetadata = run('unzip', [
    '-p',
    join(pythonRelease, `orchvia-${pythonVersion}-py3-none-any.whl`),
    `orchvia-${pythonVersion}.dist-info/METADATA`,
  ]);
  assert.match(wheelMetadata, /^Name: orchvia$/m);
  assert.match(
    wheelMetadata,
    /^Project-URL: Repository, https:\/\/github\.com\/masonlee39\/orchvia$/m,
  );
  assert.doesNotMatch(wheelMetadata, /unpublished/i);
  for (const name of ['work', 'state']) await mkdir(join(base, name));
  const embedded = `import assert from 'node:assert/strict';
import {createOrchestrator,validateWire} from '@orchvia/sdk';
import {createJevJudge,createRouter} from '@orchvia/sdk/routing';
import {createFakeAdapter} from '@orchvia/engine/fake';
const client=await createOrchestrator({workspace:${JSON.stringify(join(base, 'work'))},stateDir:${JSON.stringify(join(base, 'state'))},storage:{emergencyBytes:4096,minFreeBytes:0},adapters:[createFakeAdapter()]});
try {
 assert.equal(client.info.engineVersion,${JSON.stringify(releaseVersion)});
 const task=await client.tasks.create({goal:'offline packaged acceptance',runtime:{provider:'fake',model:'fixture'},acceptance:{mode:'human',criteria:['fixture output']}});
 for await(const event of client.events({taskId:task.id,signal:AbortSignal.timeout(5000)})) {
  if(event.type==='approval.requested'){const approval=await client.approvals.get(String(event.data.approvalId));await client.approvals.decide(approval.approvalId,{choice:'approve',expectedRevision:approval.revision});break;}
 }
 const done=await task.wait({timeoutMs:5000});assert.equal(done.status,'completed');validateWire('TaskSnapshot',done);
 assert.equal(typeof createJevJudge,'function');
 const judge={async evaluate({questions}){const answers={};for(const [id,q] of Object.entries(questions))answers[id]=q.type==='choice'?{type:'choice',choice:'A1',probabilities:{A1:0.95,fresh:0.05},confidence:0.95}:q.type==='yesno'?{type:'yesno',probability:0.9}:{type:'score',probabilities:q.levels.map((_,i)=>i===1?1:0),confidence:1};return{answers};}};
 const router=createRouter({orchestrator:client,judge,runtimes:{readOnly:{provider:'fake',model:'fixture'}}});
 const proposal=await router.route({goal:'packaged follow-up',acceptance:{mode:'human',criteria:['fixture output']},members:[done.sessionId],rootTaskId:done.id,needsWrites:false});
 assert.deepEqual(proposal.decision,{mode:'reuse',sessionId:done.sessionId});
 console.log(JSON.stringify({mode:'installed-embedded',status:done.status,routing:proposal.decision.mode,modelCalls:0}));
}finally{await client.close();}`;
  await writeFile(join(base, 'embedded.mjs'), embedded);
  results.push(JSON.parse(run(process.execPath, ['embedded.mjs'])));
  const cli = join(base, 'node_modules/@orchvia/cli/dist/main.js');
  run(process.execPath, [cli, '--help']);
  // SPEC-0021 P07: the installed CLI reports the version of the package it was built as.
  assert.equal(run(process.execPath, [cli, '--version']), `${releaseVersion}\n`);
  for (const selected of ['codex', 'claude']) {
    const isolated = join(base, selected);
    await mkdir(isolated);
    await writeFile(join(isolated, 'package.json'), '{"private":true,"type":"module"}');
    run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        archive('@orchvia/engine'),
        archive(`@orchvia/adapter-${selected}`),
        ...(selected === 'claude' ? [archive('@orchvia/sdk')] : []),
      ],
      { cwd: isolated },
    );
    await writeFile(
      join(isolated, 'check.mjs'),
      `import assert from 'node:assert/strict';\nimport * as selected from '@orchvia/adapter-${selected}';\nassert.equal(typeof selected.${selected === 'codex' ? 'createCodexAdapter' : 'createClaudeAdapter'},'function');\ntry{import.meta.resolve('@orchvia/adapter-${selected === 'codex' ? 'claude' : 'codex'}');throw new Error('Unexpected second adapter');}catch(e){assert.equal(e.code,'ERR_MODULE_NOT_FOUND');}\nconsole.log('ok');`,
    );
    assertOutput(run(process.execPath, ['check.mjs'], { cwd: isolated }), 'ok');
    if (selected === 'claude') {
      // SPEC-0026 Z02: the MCP server needs neither the Claude SDK nor Zod, and neither is installed.
      await writeFile(
        join(isolated, 'without-peers.mjs'),
        `import assert from 'node:assert/strict';
import {createClaudeMcpServer} from '@orchvia/adapter-claude';
import {ORCHESTRATION_TOOLS} from '@orchvia/engine/internal/tools';
for (const name of ['zod','@anthropic-ai/claude-agent-sdk']) await assert.rejects(import(name),{code:'ERR_MODULE_NOT_FOUND'});
const server=await createClaudeMcpServer({definitions:ORCHESTRATION_TOOLS,call:async()=>null});
const transport={async start(){},async close(){},async send(message){transport.answer(message);}};
await server.instance.connect(transport);
const answer=await new Promise(resolve=>{transport.answer=resolve;transport.onmessage({jsonrpc:'2.0',id:1,method:'tools/list'});});
assert.deepEqual(answer.result.tools.map(tool=>tool.name),ORCHESTRATION_TOOLS.map(tool=>tool.name));
console.log('without-peers-ok');`,
      );
      assertOutput(
        run(process.execPath, ['without-peers.mjs'], { cwd: isolated }),
        'without-peers-ok',
      );
      await rm(join(isolated, 'without-peers.mjs'));
      results.push(...(await smokeClaudeBundles({ root, isolated, run })));
    }
    if (selected === 'codex') {
      const ts = (await import('typescript')).default;
      let peer = ts.transpileModule(
        await readFile(join(root, 'tests/fixtures/codex-tools.ts'), 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } },
      ).outputText;
      peer = peer.replace('../../packages/engine/src/tools.ts', '@orchvia/engine/internal/tools');
      peer = peer.replace('./orchestration-actions.ts', './orchestration-actions.mjs');
      const actions = ts.transpileModule(
        await readFile(join(root, 'tests/fixtures/orchestration-actions.ts'), 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } },
      ).outputText;
      await writeFile(join(isolated, 'orchestration-actions.mjs'), actions);
      await writeFile(join(isolated, 'peer.mjs'), peer);
      await mkdir(join(isolated, 'work'));
      await mkdir(join(isolated, 'state'));
      await writeFile(
        join(isolated, 'bridge.mjs'),
        `import assert from 'node:assert/strict';
import {createCodexAdapter} from '@orchvia/adapter-codex';
import {ORCHESTRATION_TOOLS} from '@orchvia/engine/internal/tools';
const adapter=createCodexAdapter({executionStop:'owner-reconcile',command:process.execPath,args:[${JSON.stringify(join(isolated, 'peer.mjs'))}]});
const calls=[];const events=[];
try{for await(const event of adapter.execute({taskId:'task',sessionId:'session',dispatchId:'dispatch',providerSessionId:null,model:'fixture',workspace:${JSON.stringify(join(isolated, 'work'))},stateDir:${JSON.stringify(join(isolated, 'state'))},permissionProfile:'read-only',prompt:'offline tools',signal:new AbortController().signal,orchestrationTools:{definitions:ORCHESTRATION_TOOLS,async call(name){calls.push(name);return {ok:true};}}}))events.push(event);
assert.equal(events.at(-1).type,'result',JSON.stringify(events));assert.equal(calls.length,4);console.log('bridge-ok');}finally{await adapter.close();}`,
      );
      assertOutput(run(process.execPath, ['bridge.mjs'], { cwd: isolated }), 'bridge-ok');
      results.push({ mode: 'installed-codex-private-mcp', tools: 4, modelCalls: 0 });
      // SPEC-0039 H03: the hook program resolves under every condition and runs from a copy with no
      // package beside it; the default command is still 0.1.15's.
      const copied = join(base, 'hook-copy');
      await mkdir(copied);
      await writeFile(
        join(isolated, 'hook.mjs'),
        `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hostHookProgram} from '@orchvia/adapter-codex';
import {hostHookCommand} from '@orchvia/adapter-codex/internal/local';
const imported=fileURLToPath(import.meta.resolve('@orchvia/adapter-codex/hook.mjs'));
const required=createRequire(import.meta.url).resolve('@orchvia/adapter-codex/hook.mjs');
assert.equal(imported,required);assert.equal(hostHookProgram(),imported);assert.match(imported,/dist\\/hook\\.mjs$/);
assert.match(hostHookCommand(),/dist\\/hook\\.js'$/);
const copy=${JSON.stringify(join(copied, 'hook.mjs'))};copyFileSync(imported,copy);
const ran=spawnSync(process.execPath,[copy],{input:'{}',encoding:'utf8',env:{PATH:process.env.PATH,ORCHVIA_HOOK_SOCKET:'/nonexistent/s',ORCHVIA_HOOK_TOKEN:'x'}});
assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision,'deny',ran.stderr);
// SPEC-0039 B02: the tool bridge serves the tools from a copy, started through a symbolic link.
const {toolBridgeProgram}=await import('@orchvia/adapter-codex');
const {createToolBridge}=await import('@orchvia/engine/internal/tool-bridge');
const {ORCHESTRATION_TOOLS,TOOL_NAMES}=await import('@orchvia/engine/internal/tools');
const {symlinkSync}=await import('node:fs');
const bridgeFile=fileURLToPath(import.meta.resolve('@orchvia/adapter-codex/tool-bridge.mjs'));
assert.equal(createRequire(import.meta.url).resolve('@orchvia/adapter-codex/tool-bridge.mjs'),bridgeFile);
assert.equal(toolBridgeProgram(),bridgeFile);
const bridgeCopy=${JSON.stringify(join(copied, 'tool-bridge.mjs'))};copyFileSync(bridgeFile,bridgeCopy);
const linked=${JSON.stringify(join(copied, 'linked.mjs'))};symlinkSync(bridgeCopy,linked);
const bridge=await createToolBridge({definitions:ORCHESTRATION_TOOLS,call:async()=>({ok:true})},new AbortController().signal);
const listed=spawnSync(process.execPath,[linked],{input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\\n',encoding:'utf8',env:{PATH:process.env.PATH,...bridge.env},timeout:10000});
await bridge.close();
assert.deepEqual(JSON.parse(listed.stdout.split('\\n')[0]).result.tools.map((tool)=>tool.name),TOOL_NAMES,listed.stderr);
console.log('hook-ok');`,
      );
      assertOutput(run(process.execPath, ['hook.mjs'], { cwd: isolated }), 'hook-ok');
      results.push({
        mode: 'installed-codex-hook-and-bridge-programs',
        standalone: true,
        modelCalls: 0,
      });
    }
    results.push({
      mode: `installed-${selected}-only`,
      imported: true,
      modelCalls: 0,
      nativeDependency:
        selected === 'claude' ? 'pinned-sdk-mcp-with-offline-peer' : 'not_installed_or_invoked',
    });
  }
  const venv = join(base, 'venv');
  run(python, ['-m', 'venv', venv]);
  const vpython = join(venv, 'bin', 'python');
  run(vpython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-index',
    '--no-deps',
    join(pythonRelease, `orchvia-${pythonVersion}-py3-none-any.whl`),
  ]);
  const pythonScript = `import asyncio,json\nfrom orchvia import Orchestrator,TaskSpec,RuntimeSpec,AcceptanceSpec,validate_wire\nfrom orchvia import wire_types\nimport orchvia,orchvia.client\nassert (orchvia.__version__,orchvia.client.SDK_VERSION)==(${JSON.stringify(pythonVersion)},)*2,(orchvia.__version__,orchvia.client.SDK_VERSION)\nasync def main():\n client=await Orchestrator.local(engine_command=${JSON.stringify([process.execPath, cli, 'host', '--stdio', '--config', join(base, 'python-config.json')])},close_timeout=3)\n try:\n  assert client.info.engine_version==${JSON.stringify(releaseVersion)},client.info.engine_version\n  task=await client.tasks.create(TaskSpec(goal='installed Python managed host',runtime=RuntimeSpec('fake','fixture'),acceptance=AcceptanceSpec(criteria=['fixture review'])))\n  async for event in client.events(task_id=task.id):\n   if event.type=='approval.requested':\n    approval=await client.approvals.get(event.data.approval_id)\n    await client.approvals.decide(approval.approval_id,{'choice':'approve','expected_revision':approval.revision})\n    break\n  done=await task.wait(timeout=5)\n  assert done.status=='completed'\n  print(json.dumps({'mode':'installed-python-managed','status':done.status,'modelCalls':0}))\n finally: await client.close(timeout=3)\nasyncio.run(main())\n`;
  await mkdir(join(base, 'python-state'));
  await writeFile(
    join(base, 'python-config.json'),
    JSON.stringify({
      workspace: join(base, 'work'),
      stateDir: join(base, 'python-state'),
      providers: { fake: { model: 'fixture' } },
      storage: { emergencyBytes: 4096, minFreeBytes: 0 },
    }),
  );
  await writeFile(join(base, 'python-roundtrip.py'), pythonScript);
  results.push(JSON.parse(run(vpython, ['python-roundtrip.py'])));
  const builder = process.env.PACKAGE_BUILD_PYTHON;
  if (builder) {
    const extracted = join(base, 'sdist');
    await mkdir(extracted);
    run(builder, [
      '-c',
      'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter="data")',
      join(pythonRelease, `orchvia-${pythonVersion}.tar.gz`),
      extracted,
    ]);
    const rebuilt = join(base, 'rebuilt');
    await mkdir(rebuilt);
    run(builder, [
      '-m',
      'build',
      '--no-isolation',
      '--wheel',
      '--outdir',
      rebuilt,
      join(extracted, `orchvia-${pythonVersion}`),
    ]);
    run(vpython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-index',
      '--no-deps',
      '--force-reinstall',
      join(rebuilt, `orchvia-${pythonVersion}-py3-none-any.whl`),
    ]);
    const roundtrip = JSON.parse(run(vpython, ['python-roundtrip.py']));
    results.push({ ...roundtrip, mode: 'installed-wheel-rebuilt-from-sdist' });
  } else
    throw new Error(
      'PACKAGE_BUILD_PYTHON must name an offline environment with the pinned build dependencies',
    );
  console.log(JSON.stringify({ offline: true, node: process.version, results }));
} finally {
  await rm(base, { recursive: true, force: true });
}
function assertOutput(actual, expected) {
  if (actual.trim() !== expected) throw new Error(actual);
}
