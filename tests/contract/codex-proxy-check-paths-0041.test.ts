import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0041: a proxy check the sandbox cannot read, and npm's download delay.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const PROXY_OK = JSON.stringify({ proxy: true, unix: 'EPERM', outside: 'EPERM' });

async function paths(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0041-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirs = {
    base,
    workspace: join(base, 'workspace'),
    state: join(base, 'state'),
    home: join(base, 'codex-home'),
    user: join(base, 'user'),
    denied: join(base, 'user-data'),
    readable: join(base, 'app'),
  };
  for (const dir of Object.values(dirs).slice(1)) await mkdir(dir);
  for (const dir of [dirs.denied, dirs.readable, dirs.home, dirs.state])
    await writeFile(join(dir, 'proxy-check.mjs'), '');
  return dirs;
}
type Paths = Awaited<ReturnType<typeof paths>>;
const spawned = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'spawn').length
    : 0;

async function dispatch(
  dirs: Paths,
  name: string,
  extra: Partial<Parameters<typeof createCodexAdapter>[0]>,
) {
  const log = join(dirs.base, `${name}.log`);
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: dirs.user, FIXTURE_LOG: log, FIXTURE_EXEC_STDOUT: PROXY_OK },
    connection: { home: dirs.home },
    executionStop: 'owner-reconcile',
    denyRead: [dirs.denied],
    policy: () => ({ mode: 'auto', network: 'direct' }),
    ...extra,
  });
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: name,
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
  } finally {
    await adapter.close?.();
  }
  const last = events.at(-1);
  return {
    last,
    message: last?.type === 'error' ? last.message : '',
    outcome: (last as { outcome?: string }).outcome,
    started: spawned(log),
  };
}

test('AC-0041-C01 a check the sandbox cannot read ends the dispatch before Codex, naming it', async (t) => {
  const dirs = await paths(t);
  for (const [name, proxyCheck, blocked, under] of [
    [
      'program under denyRead',
      { command: process.execPath, args: [join(dirs.denied, 'proxy-check.mjs')] },
      join(dirs.denied, 'proxy-check.mjs'),
      dirs.denied,
    ],
    [
      'runtime under denyRead',
      { command: join(dirs.denied, 'proxy-check.mjs'), args: [] },
      join(dirs.denied, 'proxy-check.mjs'),
      dirs.denied,
    ],
    [
      'program in the Codex home',
      { command: process.execPath, args: [join(dirs.home, 'proxy-check.mjs')] },
      join(dirs.home, 'proxy-check.mjs'),
      dirs.home,
    ],
    [
      'program in the state directory',
      { command: process.execPath, args: [join(dirs.state, 'proxy-check.mjs')] },
      join(dirs.state, 'proxy-check.mjs'),
      dirs.state,
    ],
  ] as const) {
    const result = await dispatch(dirs, name.replace(/ /g, '-'), {
      proxyCheck: { command: proxyCheck.command, args: [...proxyCheck.args] },
    });
    assert.match(result.message, /^CODEX_NETWORK_PROXY_UNAVAILABLE: /, name);
    assert.ok(result.message.includes(blocked), `${name}: ${result.message}`);
    assert.ok(result.message.includes(under), `${name}: ${result.message}`);
    assert.equal(result.outcome, 'failed', name);
    assert.equal(result.started, 0, `${name}: no app-server was started`);
  }
});

test('AC-0041-C01 a readable check, a non-path argument or no network passes', async (t) => {
  const dirs = await paths(t);
  const readable = await dispatch(dirs, 'readable', {
    proxyCheck: {
      command: process.execPath,
      args: ['--no-warnings', join(dirs.readable, 'proxy-check.mjs')],
    },
  });
  assert.equal(readable.last?.type, 'result', readable.message);
  // Without network there is no check, wherever its program lies.
  const offline = await dispatch(dirs, 'offline', {
    policy: () => ({ mode: 'auto' }),
    proxyCheck: { command: process.execPath, args: [join(dirs.denied, 'proxy-check.mjs')] },
  });
  assert.equal(offline.last?.type, 'result', offline.message);
  // The built-in check with its Node readable.
  const builtIn = await dispatch(dirs, 'built-in', {});
  assert.equal(builtIn.last?.type, 'result', builtIn.message);
});

test('AC-0041-C03 the registry check retries npm install', () => {
  const script = readFileSync(join(root, 'scripts/registry-check.mjs'), 'utf8');
  assert.match(
    script,
    /await eventually\(\s*`npm install of \$\{version\}`,\s*\(\) =>\s*run\('npm', \[\s*'install',/,
  );
});
