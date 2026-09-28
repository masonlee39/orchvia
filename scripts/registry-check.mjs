// Install a published release from npm and PyPI into empty directories and run it (SPEC-0021 P04).
// node scripts/registry-check.mjs VERSION [BUILT_DIR]
// With BUILT_DIR, each npm archive on the registry must have the same bytes as the one built there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [version, built] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version))
  throw new Error('Usage: node scripts/registry-check.mjs VERSION [BUILT_DIR]');
const pythonVersion = version.replace('-alpha.', 'a').replace('-beta.', 'b').replace('-rc.', 'rc');
const python = process.env.REGISTRY_CHECK_PYTHON ?? 'python3';
const names = ['engine', 'adapter-claude', 'adapter-codex', 'sdk', 'cli'];
const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-registry-')));
const env = { ...process.env, npm_config_cache: join(base, 'npm-cache'), PYTHONPATH: '' };
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: base, env, encoding: 'utf8', timeout: 300_000, ...options });

/** Retries while a registry has not caught up with a new release yet. */
async function eventually(what, read, minutes = 10) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    try {
      return read();
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`${what} did not become available`, { cause: error });
      await sleep(15_000);
    }
  }
}

try {
  for (const name of names) {
    const integrity = await eventually(`@orchvia/${name}@${version}`, () =>
      JSON.parse(run('npm', ['view', `@orchvia/${name}@${version}`, 'dist.integrity', '--json'])),
    );
    if (built) {
      const bytes = await readFile(resolve(built, `orchvia-${name}-${version}.tgz`));
      const local = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      assert.equal(integrity, local, `@orchvia/${name}@${version} differs from the built archive`);
    }
  }
  await writeFile(
    join(base, 'package.json'),
    '{"name":"registry-check","private":true,"type":"module"}\n',
  );
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    ...['sdk', 'engine', 'cli'].map((name) => `@orchvia/${name}@${version}`),
  ]);
  for (const name of ['work', 'state', 'python-state'])
    await mkdir(join(base, name), { mode: 0o700 });
  await writeFile(
    join(base, 'quickstart.mjs'),
    `import assert from 'node:assert/strict';
import {createOrchestrator} from '@orchvia/sdk';
import {createFakeAdapter} from '@orchvia/engine/fake';
const orch=await createOrchestrator({workspace:${JSON.stringify(join(base, 'work'))},stateDir:${JSON.stringify(join(base, 'state'))},adapters:[createFakeAdapter()],providers:{fake:{model:'fixture'}},allowCrossRootReuse:true});
assert.equal(orch.info.engineVersion,${JSON.stringify(version)});
const run=async(spec)=>{const task=await orch.tasks.create(spec);for await(const event of orch.events({taskId:task.id,signal:AbortSignal.timeout(10000)})){if(event.type!=='approval.requested')continue;const a=await orch.approvals.get(String(event.data.approvalId));await orch.approvals.decide(a.approvalId,{choice:'approve',expectedRevision:a.revision});break;}return task.wait({timeoutMs:10000});};
try{const runtime={provider:'fake',model:'fixture'},acceptance={mode:'human',criteria:['reviewed']};
const first=await run({goal:'first',runtime,acceptance});
const second=await run({goal:'second',runtime,acceptance,contextPlan:{requestedMode:'reuse',candidateSessionId:first.sessionId,independent:true,dependencyTaskIds:[],contextRefs:[],fallbackModes:[],maxQueueWaitMs:30000}});
assert.equal(second.status,'completed');assert.equal(second.sessionId,first.sessionId);
console.log(JSON.stringify({mode:'npm-registry',status:second.status,reused:true}));}finally{await orch.close();}`,
  );
  const npmResult = JSON.parse(run(process.execPath, ['quickstart.mjs']).trim().split('\n').at(-1));

  const venv = join(base, 'venv');
  run(python, ['-m', 'venv', venv]);
  const vpython = join(venv, 'bin', 'python');
  // SPEC-0040 R02: PyPI's simple index once took more than 10 minutes to list a new release.
  await eventually(
    `orchvia==${pythonVersion} on PyPI`,
    () =>
      run(vpython, [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        `orchvia==${pythonVersion}`,
      ]),
    25,
  );
  const cli = join(base, 'node_modules/@orchvia/cli/dist/main.js');
  // SPEC-0021 P09: the installed packages report the release version.
  assert.equal(run(process.execPath, [cli, '--version']), `${version}\n`);
  await writeFile(
    join(base, 'python-config.json'),
    JSON.stringify({
      workspace: join(base, 'work'),
      stateDir: join(base, 'python-state'),
      providers: { fake: { model: 'fixture' } },
    }),
  );
  await writeFile(
    join(base, 'roundtrip.py'),
    `import asyncio,json
from orchvia import Orchestrator,TaskSpec,RuntimeSpec,AcceptanceSpec
import orchvia,orchvia.client
assert (orchvia.__version__,orchvia.client.SDK_VERSION)==(${JSON.stringify(pythonVersion)},)*2,(orchvia.__version__,orchvia.client.SDK_VERSION)
async def main():
    client=await Orchestrator.local(engine_command=${JSON.stringify([process.execPath, cli, 'host', '--stdio', '--config', join(base, 'python-config.json')])},close_timeout=5)
    try:
        assert client.info.engine_version==${JSON.stringify(version)},client.info.engine_version
        task=await client.tasks.create(TaskSpec(goal='registry Python check',runtime=RuntimeSpec('fake','fixture'),acceptance=AcceptanceSpec(criteria=['reviewed'])))
        async for event in client.events(task_id=task.id):
            if event.type=='approval.requested':
                approval=await client.approvals.get(event.data.approval_id)
                await client.approvals.decide(approval.approval_id,{'choice':'approve','expected_revision':approval.revision})
                break
        done=await task.wait(timeout=10)
        assert done.status=='completed'
        print(json.dumps({'mode':'pypi-registry','status':done.status}))
    finally:
        await client.close(timeout=5)
asyncio.run(main())
`,
  );
  const pythonResult = JSON.parse(run(vpython, ['roundtrip.py']).trim().split('\n').at(-1));
  console.log(JSON.stringify({ version, pythonVersion, results: [npmResult, pythonResult] }));
} finally {
  await rm(base, { recursive: true, force: true });
}
