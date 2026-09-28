import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter, proxyCheckProgram } from '../../packages/adapter-codex/src/index.ts';
import { PROXY_CHECK_SCRIPT, proxyCheckSocket } from '../../packages/adapter-codex/src/local.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0040: the host's proxy check command, and two release fixes.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const PROXY_OK = JSON.stringify({ proxy: true, unix: 'EPERM', outside: 'EPERM' });

async function paths(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0040-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirs = {
    base,
    workspace: join(base, 'workspace'),
    state: join(base, 'state'),
    home: join(base, 'codex-home'),
    user: join(base, 'user'),
    log: join(base, 'fixture.log'),
  };
  for (const dir of [dirs.workspace, dirs.state, dirs.home, dirs.user]) await mkdir(dir);
  return dirs;
}
type Paths = Awaited<ReturnType<typeof paths>>;
const requested = (log: string, method: string): any[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'request' && entry.method === method)
    : [];
const spawnEnv = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'spawn');

function member(
  dirs: Paths,
  env: Record<string, string>,
  extra: Partial<Parameters<typeof createCodexAdapter>[0]>,
) {
  return createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: dirs.user, FIXTURE_LOG: dirs.log, ...env },
    connection: { home: dirs.home },
    executionStop: 'owner-reconcile',
    policy: () => ({ mode: 'auto', network: 'direct' }),
    ...extra,
  });
}
async function run(adapter: ReturnType<typeof createCodexAdapter>, dirs: Paths) {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    model: 'offline',
    prompt: 'go',
    permissionProfile: 'workspace-write',
    workspace: dirs.workspace,
    stateDir: dirs.state,
    signal: new AbortController().signal,
    reportExecutionEvidence: () => {},
  } as RuntimeInput))
    events.push(event);
  return events;
}

test('AC-0040-P01 proxyCheck is checked and needs connection', async (t) => {
  const dirs = await paths(t);
  const make = (extra: Record<string, unknown>) => () =>
    createCodexAdapter({
      executionStop: 'owner-reconcile',
      connection: { home: dirs.home },
      ...extra,
    } as never);
  for (const [name, proxyCheck] of [
    ['not an object', 'node'],
    ['relative command', { command: 'node' }],
    ['args not a list', { command: process.execPath, args: 'x' }],
    ['a bad name', { command: process.execPath, env: { '1X': '1' } }],
    ['a proxy variable', { command: process.execPath, env: { HTTPS_PROXY: 'http://x' } }],
    ['a lowercase one', { command: process.execPath, env: { no_proxy: '*' } }],
    ['another key', { command: process.execPath, cwd: '/' }],
  ] as const)
    assert.throws(make({ proxyCheck }), { code: 'INVALID_ADAPTER_CONFIG' }, name);
  assert.throws(
    () =>
      createCodexAdapter({
        executionStop: 'owner-reconcile',
        proxyCheck: { command: process.execPath },
      } as never),
    { code: 'INVALID_ADAPTER_CONFIG' },
    'without connection',
  );
  make({ proxyCheck: { command: process.execPath, args: ['/x.mjs'], env: { A: '1' } } })();
});

test("AC-0040-P02 the host's check command runs with its variables, which the app-server lacks", async (t) => {
  const dirs = await paths(t);
  const proxyCheck = {
    command: '/opt/host/Host',
    args: ['/opt/host/proxy-check.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const adapter = member(dirs, { FIXTURE_EXEC_STDOUT: PROXY_OK }, { proxyCheck });
  t.after(() => adapter.close?.());
  const events = await run(adapter, dirs);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  const [exec] = requested(dirs.log, 'command/exec');
  assert.equal(exec.params.command.length, 3);
  assert.deepEqual(exec.params.command.slice(0, 2), [
    '/opt/host/Host',
    '/opt/host/proxy-check.mjs',
  ]);
  assert.match(exec.params.command[2], /\/s$/, 'the socket comes last');
  assert.deepEqual(exec.params.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(
    Object.keys(spawnEnv(dirs.log).env).includes('ELECTRON_RUN_AS_NODE'),
    false,
    'the app-server never has it',
  );
  // The verdict is the same: a result that is not the check's refuses the dispatch.
  const log = join(dirs.base, 'garbage.log');
  const refused = member({ ...dirs, log }, { FIXTURE_EXEC_STDOUT: 'garbage' }, { proxyCheck });
  t.after(() => refused.close?.());
  const failed = await run(refused, dirs);
  const last = failed.at(-1);
  assert.match(last?.type === 'error' ? last.message : '', /^CODEX_NETWORK_PROXY_UNAVAILABLE: /);
  assert.equal(requested(log, 'thread/start').length, 0);
});

test('AC-0040-P02 without proxyCheck the command is the built-in check', async (t) => {
  const dirs = await paths(t);
  const adapter = member(dirs, { FIXTURE_EXEC_STDOUT: PROXY_OK }, {});
  t.after(() => adapter.close?.());
  await run(adapter, dirs);
  const [exec] = requested(dirs.log, 'command/exec');
  assert.deepEqual(exec.params.command.slice(0, 3), [process.execPath, '-e', PROXY_CHECK_SCRIPT]);
  assert.equal(exec.params.env, undefined);
});

test('AC-0040-P03 the check program prints what the built-in check prints', async (t) => {
  const program = proxyCheckProgram();
  assert.ok(existsSync(program), program);
  const socket = await proxyCheckSocket();
  t.after(() => socket.close());
  const env = { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:9' };
  const builtIn = spawnSync(process.execPath, ['-e', PROXY_CHECK_SCRIPT, socket.path], {
    encoding: 'utf8',
    env,
    timeout: 15000,
  });
  const copied = spawnSync(process.execPath, [program, socket.path], {
    encoding: 'utf8',
    env,
    timeout: 15000,
  });
  const result = JSON.parse(builtIn.stdout);
  assert.equal(result.proxy, true);
  assert.equal(result.unix, 'connected', 'outside a sandbox the socket answers');
  assert.deepEqual(JSON.parse(copied.stdout), result, copied.stderr);
});

test('AC-0040-R02 the registry check waits long enough for PyPI', () => {
  const script = readFileSync(join(root, 'scripts/registry-check.mjs'), 'utf8');
  const pypi =
    /eventually\(\s*`orchvia==\$\{pythonVersion\} on PyPI`,[\s\S]*?\),\s*(\d+),?\s*\);/.exec(
      script,
    );
  assert.equal(pypi?.[1], '25', 'PyPI gets 25 minutes');
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const registry = workflow.slice(workflow.indexOf('\n  registry:'));
  assert.match(registry, /^\s+timeout-minutes: 45$/m);
});
