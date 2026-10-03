import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
async function command(args: string[]) {
  const proc = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  proc.stdout.on('data', (b) => {
    stdout += b;
  });
  proc.stderr.on('data', (b) => {
    stderr += b;
  });
  const [code] = await once(proc, 'exit');
  return { code, stdout, stderr };
}
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-cli-test-')));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const config = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    providers: { fake: { model: 'fake-model', result: 'Protocol fixture result' } },
    storage: { emergencyBytes: 4096 },
  };
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, configPath };
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exit = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
  await exit;
  clearTimeout(timer);
}

test(
  'AC12 real CLI socket + TS SDK create/events/approve/terminal; closing client preserves host',
  { timeout: 15000 },
  async (t) => {
    const { root, config, configPath } = await fixture(t);
    const offline = await command(['doctor', '--config', configPath]);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(JSON.parse(offline.stdout).runtimeAcceptance, 'not_run');
    assert.deepEqual(await readdir(config.stateDir), []);
    const socketPath = join(root, 'host.sock');
    const proc = spawn(process.execPath, [
      cli,
      'host',
      '--config',
      configPath,
      '--socket',
      socketPath,
    ]);
    t.after(() => stop(proc));
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (b) => {
      stdout += b;
    });
    const ready = new Promise<void>((resolve, reject) => {
      proc.stderr.on('data', (b) => {
        stderr += b;
        if (stderr.includes('listening on')) resolve();
      });
      proc.once('exit', (code) => reject(new Error(`Host exited ${code}: ${stderr}`)));
    });
    await ready;
    const taskPath = join(root, 'task.json');
    await writeFile(
      taskPath,
      JSON.stringify({
        goal: 'Read-only contract',
        runtime: { provider: 'fake', model: 'fake-model' },
        acceptance: { mode: 'human', criteria: ['review'] },
      }),
    );
    const submit = await command([
      'submit',
      '--socket',
      socketPath,
      '--task',
      taskPath,
      '--idempotency-key',
      'cli-task',
    ]);
    assert.equal(submit.code, 0, submit.stderr);
    const task = JSON.parse(submit.stdout);
    const client = await connectOrchestrator({ socketPath });
    t.after(() => client.close());
    for await (const event of client.events({
      taskId: task.id,
      signal: AbortSignal.timeout(3000),
    })) {
      if (event.type !== 'approval.requested') continue;
      const approval = await client.approvals.get(String(event.data.approvalId));
      const approve = await command([
        'approve',
        '--socket',
        socketPath,
        '--approval',
        approval.approvalId,
        '--revision',
        String(approval.revision),
        '--decision',
        'approve',
        '--idempotency-key',
        'cli-approve',
      ]);
      assert.equal(approve.code, 0, approve.stderr);
      assert.equal(JSON.parse(approve.stdout).status, 'completed');
      break;
    }
    const status = await command(['status', '--socket', socketPath, '--task', task.id]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, 'completed');
    await client.close();
    const online = await command(['doctor', '--socket', socketPath]);
    assert.equal(online.code, 0, online.stderr);
    assert.equal(JSON.parse(online.stdout).protocolVersion, '2.0');
    assert.equal(stdout, '', 'Socket host must keep stdout clean');
  },
);

test('CLI rejects unsupported commands, implicit fake, arbitrary adapter module and unknown flags', async (t) => {
  const { config, configPath } = await fixture(t);
  const unknown = await command(['not-a-command']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /UNSUPPORTED_COMMAND/);
  assert.equal(unknown.stdout, '');
  for (const providers of [
    {},
    { fake: { model: 'fake-model', adapter: 'https://untrusted.invalid/code.js' } },
    { codex: { model: 'test', executable: '/ignored/path' } },
    { claude: { model: 'test', auth: { mode: 'env' } } },
    { codex: { model: 'test', unknownOption: true } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...config, providers }));
    const result = await command(['doctor', '--config', configPath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /INVALID_CONFIG/);
  }
  const flags = await command([
    'host',
    '--config',
    configPath,
    '--stdio',
    '--socket',
    '/tmp/unused.sock',
  ]);
  assert.equal(flags.code, 1);
  assert.match(flags.stderr, /mutually exclusive/);
});

test('0021-P07 --version prints the version of the CLI package, and --help lists it', async () => {
  const { version } = JSON.parse(
    await readFile(new URL('../../packages/cli/package.json', import.meta.url), 'utf8'),
  );
  const result = await command(['--version']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  const help = await command(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^orchvia --version$/m);
  // No short form: the CLI has no short options, and -v often means verbose.
  const short = await command(['-v']);
  assert.equal(short.code, 1);
  assert.match(short.stderr, /UNSUPPORTED_COMMAND/);
});

test('doctor rejects limits and deadlines that the engine cannot accept', async (t) => {
  const { config, configPath } = await fixture(t);
  for (const invalid of [
    // SPEC-0014 C01 raised the owner limit to eight.
    { limits: { maxActiveSessions: 9 } },
    { limits: { maxTurnsPerTask: 1001 } },
    { approvalTtlMs: 0.5 },
    { approvalTtlMs: 604800001 },
    { shutdown: { timeoutMs: 0.5 } },
    { shutdown: { timeoutMs: 3600001 } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...config, ...invalid }));
    const result = await command(['doctor', '--config', configPath]);
    assert.equal(result.code, 1, JSON.stringify(invalid));
    assert.match(result.stderr, /INVALID_CONFIG/);
  }
});

test(
  'AC-F14 CLI run/attach/control preserve approval and exact targets on a shared host',
  { timeout: 15000 },
  async (t) => {
    const { root, configPath } = await fixture(t);
    const socketPath = join(root, 'control.sock');
    const proc = spawn(process.execPath, [
      cli,
      'host',
      '--config',
      configPath,
      '--socket',
      socketPath,
    ]);
    t.after(() => stop(proc));
    await new Promise<void>((resolve, reject) => {
      proc.stderr.on('data', (b) => {
        if (String(b).includes('listening on')) resolve();
      });
      proc.once('exit', (code) => reject(new Error(`host ${code}`)));
    });
    const taskPath = join(root, 'run.json');
    await writeFile(
      taskPath,
      JSON.stringify({
        goal: 'run fixture',
        runtime: { provider: 'fake', model: 'fake-model' },
        acceptance: { mode: 'human', criteria: ['review'] },
      }),
    );
    const run = await command([
      'run',
      '--socket',
      socketPath,
      '--task',
      taskPath,
      '--idempotency-key',
      'run-K',
      '--timeout-ms',
      '3000',
    ]);
    assert.equal(run.code, 0, run.stderr);
    const records = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const created = records.find((row) => row.kind === 'task').task;
    assert.equal(records.at(-1).task.status, 'waiting_approval');
    const attached = await command([
      'attach',
      '--socket',
      socketPath,
      '--task',
      created.id,
      '--timeout-ms',
      '3000',
    ]);
    assert.equal(attached.code, 0, attached.stderr);
    assert.match(attached.stdout, /waiting_approval/);
    const client = await connectOrchestrator({ socketPath });
    try {
      const task = await client.tasks.get(created.id),
        session = await client.sessions.get(task.sessionId!);
      const target = {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId,
        expectedState: session.status,
      };
      const targetPath = join(root, 'target.json');
      await writeFile(targetPath, JSON.stringify(target));
      const control = await command([
        'control',
        '--socket',
        socketPath,
        '--target',
        targetPath,
        '--action',
        'pause',
        '--mode',
        'drain',
        '--idempotency-key',
        'pause-K',
      ]);
      assert.equal(control.code, 0, control.stderr);
      assert.equal((await client.sessions.get(task.sessionId!)).status, 'paused');
      assert.equal((await client.tasks.get(created.id)).status, 'waiting_approval');
      const stale = await command([
        'control',
        '--socket',
        socketPath,
        '--target',
        targetPath,
        '--action',
        'resume',
        '--idempotency-key',
        'stale-K',
      ]);
      assert.equal(stale.code, 1);
      assert.match(stale.stderr, /STALE_TARGET/);
      assert.equal((await client.approvals.get(task.approvalId!)).status, 'pending');
    } finally {
      await client.close();
    }
  },
);

test('AC-F14 doctor checks actual offline dependencies without opening state or calling models', async (t) => {
  const { config, configPath } = await fixture(t);
  const good = await command(['doctor', '--config', configPath]);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).mode, 'offline-preflight');
  assert.ok(JSON.parse(good.stdout).checks.some((row: any) => row.name === 'sqlite' && row.ok));
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      providers: {
        codex: {
          model: 'fixture',
          command: '/nonexistent/orchvia-codex',
          executionStop: 'owner-reconcile',
        },
      },
    }),
  );
  const missing = await command(['doctor', '--config', configPath]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /RUNTIME_UNAVAILABLE/);
  assert.deepEqual(await readdir(config.stateDir), []);
});
