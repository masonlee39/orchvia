/**
 * SPEC-0051 P01: the Python SDK and the host across one release. Runs one round trip, a fake task
 * created, accepted and completed through `Orchestrator.local`, in both directions:
 *   1. the working tree's Python SDK with the previous published `@orchvia/cli` as its host;
 *   2. the previous published `orchvia` from PyPI, in a new virtual environment, with the working
 *      tree's CLI as its host.
 *
 * Usage: node scripts/compat-python.mjs [--previous X.Y.Z] [--keep]
 * Needs npm, PyPI and Python 3.11+. Exits 1 when a direction fails and 2 on invalid arguments.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previousRelease } from './compat-rollback.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// The round trip, written against the SDK surface both releases have.
const ROUND_TRIP = String.raw`
import asyncio, json, sys
import orchvia
from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec

async def main(command):
    orch = await Orchestrator.local(engine_command=command, close_timeout=5)
    try:
        task = await orch.tasks.create(
            TaskSpec(goal="a fixture across versions", runtime=RuntimeSpec(provider="fake", model="fake-model"),
                     acceptance=AcceptanceSpec(criteria=["the fixture result"]), label="compat"),
            idempotency_key="compat-task")
        async with asyncio.timeout(20):
            async for event in orch.events(task_id=task.id):
                if event.type == "approval.requested":
                    request = await orch.approvals.get(event.data.approval_id)
                    await orch.approvals.decide(request.approval_id,
                        {"choice": "approve", "expected_revision": request.revision},
                        idempotency_key="compat-approval")
                    break
        final = await task.wait(timeout=20)
        listed = await orch.tasks.list(label="compat")
        return {"sdk": orchvia.__version__, "sdkPath": orchvia.__file__,
                "host": orch.info.engine_version, "status": final.status, "result": final.result,
                "label": final.spec["label"], "listed": len(listed.tasks)}
    finally:
        await orch.close(timeout=5)

print(json.dumps(asyncio.run(main(json.loads(sys.argv[1])))))
`;

/** Runs the round trip with `interpreter` against the host `command`; returns its report. */
function roundTrip(work, name, interpreter, env, command) {
  const base = join(work, name);
  mkdirSync(join(base, 'workspace'), { recursive: true });
  mkdirSync(join(base, 'state'));
  const config = join(base, 'orchestrator.json');
  writeFileSync(
    config,
    JSON.stringify({
      configVersion: 1,
      workspace: join(base, 'workspace'),
      stateDir: join(base, 'state'),
      storage: { emergencyBytes: 4096 },
      providers: {
        fake: { model: 'fake-model', result: 'across versions', permissionProfile: 'read-only' },
      },
    }),
  );
  const script = join(work, 'round_trip.py');
  writeFileSync(script, ROUND_TRIP);
  const run = spawnSync(
    interpreter,
    [script, JSON.stringify([...command, 'host', '--stdio', '--config', config])],
    { cwd: work, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } },
  );
  if (run.status !== 0)
    throw new Error(`${name}: ${run.stderr.trim().split('\n').slice(-8).join('\n')}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

async function main() {
  const known = option('previous');
  if (known && !/^\d+\.\d+\.\d+$/.test(known)) {
    console.error(`--previous must be a version such as 0.1.25, not ${known}`);
    process.exit(2);
  }
  const previous =
    known ??
    previousRelease(
      JSON.parse(
        execFileSync(npm, ['view', '@orchvia/cli', 'versions', '--json'], { encoding: 'utf8' }),
      ),
      current,
    );
  if (!previous) throw new Error(`No published @orchvia/cli below ${current}`);
  // The configuration needs real paths: macOS's temporary directory is under a symbolic link.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'orchvia-python-compat-')));
  const failures = [];
  const check = (name, report, sdk, host) => {
    const problems = [];
    if (report.sdk !== sdk) problems.push(`SDK ${report.sdk}, not ${sdk}`);
    if (report.host !== host) problems.push(`host ${report.host}, not ${host}`);
    if (report.status !== 'completed') problems.push(`status ${report.status}`);
    if (report.result !== 'across versions')
      problems.push(`result ${JSON.stringify(report.result)}`);
    if (report.label !== 'compat' || report.listed !== 1) problems.push('label or listing');
    console.log(`${name}: SDK ${report.sdk} with host ${report.host}: ${report.status}`);
    failures.push(...problems.map((problem) => `${name}: ${problem}`));
  };
  try {
    // 1. The working tree's SDK, the previous CLI.
    const install = join(work, 'cli');
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
        `@orchvia/cli@${previous}`,
      ],
      { cwd: install, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const cli = join(install, 'node_modules/@orchvia/cli');
    const bin = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).bin.orchvia;
    check(
      'current SDK, previous host',
      roundTrip(work, 'forward', python, { PYTHONPATH: join(root, 'python/src') }, [
        process.execPath,
        join(cli, bin),
      ]),
      current.replace('-alpha.', 'a').replace('-beta.', 'b').replace('-rc.', 'rc'),
      previous,
    );

    // 2. The previous SDK from PyPI, the working tree's CLI.
    const venv = join(work, 'venv');
    execFileSync(python, ['-m', 'venv', venv], { stdio: 'inherit' });
    const venvPython = join(
      venv,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    execFileSync(
      venvPython,
      ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', `orchvia==${previous}`],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const back = roundTrip(work, 'backward', venvPython, { PYTHONPATH: '' }, [
      process.execPath,
      join(root, 'packages/cli/src/main.ts'),
    ]);
    if (back.sdkPath.startsWith(root))
      failures.push('previous SDK, current host: imported the working tree');
    check('previous SDK, current host', back, previous, current);

    if (failures.length) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
    } else console.log('Both directions completed the round trip.');
  } finally {
    if (args.includes('--keep')) console.log(`Kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

await main();
