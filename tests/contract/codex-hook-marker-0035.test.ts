import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexConnection, createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

// SPEC-0035 R, C08, I (0.1.15): the host's command hook, its trust, and Codex stop markers.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const hookProgram = fileURLToPath(
  new URL('../../packages/adapter-codex/src/hook.ts', import.meta.url),
);

async function paths(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0035b-')));
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
const entries = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const requested = (log: string, method: string) =>
  entries(log).filter((entry) => entry.event === 'request' && entry.method === method);

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
    ...extra,
  });
}
async function run(
  adapter: ReturnType<typeof createCodexAdapter>,
  dirs: Paths,
  input: Partial<RuntimeInput> = {},
) {
  const events: RuntimeEvent[] = [];
  const evidence: ExecutionEvidence[] = [];
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
    reportExecutionEvidence: (item: ExecutionEvidence) => evidence.push(item),
    ...input,
  } as RuntimeInput))
    events.push(event);
  return { events, evidence };
}
const failure = (events: RuntimeEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'error' ? last.message : `no error: ${JSON.stringify(events)}`;
};
const PATCH = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n';

test('AC-0035-R01 hostHook needs a connection and a function', async (t) => {
  const dirs = await paths(t);
  for (const [name, config] of [
    ['without connection', { executionStop: 'owner-reconcile', hostHook: () => ({ allow: true }) }],
    [
      'not a function',
      { executionStop: 'owner-reconcile', connection: { home: dirs.home }, hostHook: 'x' },
    ],
  ] as const)
    assert.throws(
      () => createCodexAdapter(config as never),
      { code: 'INVALID_ADAPTER_CONFIG' },
      name,
    );
});

test('AC-0035-R02 a dispatch whose hook is not trusted is refused before its thread', async (t) => {
  const dirs = await paths(t);
  const adapter = member(
    dirs,
    {},
    {
      executionStop: 'owner-reconcile',
      hostHook: () => ({ allow: true }),
    },
  );
  t.after(() => adapter.close?.());
  const { events } = await run(adapter, dirs);
  assert.match(failure(events), /^HOST_HOOK_UNTRUSTED: /);
  assert.equal(requested(dirs.log, 'thread/start').length, 0);
});

test('AC-0035-R01 each command and patch goes through the host before it runs', async (t) => {
  const dirs = await paths(t);
  const seen: unknown[] = [];
  const adapter = member(
    dirs,
    {
      FIXTURE_HOOK_TRUST: 'trusted',
      FIXTURE_HOOK_EVENTS: JSON.stringify([
        { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        { tool_name: 'apply_patch', tool_input: { command: PATCH } },
      ]),
    },
    {
      executionStop: 'owner-reconcile',
      async hostHook(event) {
        seen.push(event);
        if (event.kind === 'command' && /\brm\b/.test(event.command ?? ''))
          return { allow: false, reason: 'no rm here' };
        if (event.kind === 'fileChange') return { allow: false, reason: 'no edits' };
        return { allow: true };
      },
    },
  );
  t.after(() => adapter.close?.());
  const { events } = await run(adapter, dirs, { dispatchId: 'hooked' });
  const last = events.at(-1);
  assert.equal(last?.type, 'result', JSON.stringify(events));
  const outputs = JSON.parse(last?.type === 'result' ? last.text : '[]') as {
    status: number;
    stdout: string;
  }[];
  const decision = (stdout: string) =>
    stdout ? JSON.parse(stdout).hookSpecificOutput?.permissionDecision : 'allow';
  assert.deepEqual(
    outputs.map((output) => decision(output.stdout)),
    ['deny', 'allow', 'deny'],
  );
  assert.match(outputs[0]!.stdout, /no rm here/);
  assert.deepEqual(
    seen.map((event: any) => [event.kind, event.command ?? event.patch, event.dispatchId]),
    [
      ['command', 'rm -rf build', 'hooked'],
      ['command', 'ls', 'hooked'],
      ['fileChange', PATCH, 'hooked'],
    ],
  );
  const spawn = entries(dirs.log).find((entry) => entry.event === 'spawn');
  const exclude = spawn.args.find((arg: string) =>
    arg.startsWith('shell_environment_policy.exclude='),
  );
  assert.ok(exclude.includes('"ORCHVIA_HOOK_*"'), 'commands never see the hook channel');
  assert.equal(spawn.env.ORCHVIA_HOOK_TOKEN, 'set');
});

test('AC-0035-R01 the hook refuses when it cannot ask the host', () => {
  const run = spawnSync(process.execPath, [hookProgram], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ORCHVIA_HOOK_SOCKET: '/nonexistent/s', ORCHVIA_HOOK_TOKEN: 'x' },
  });
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny', run.stderr);
});

test("AC-0035-C08 trustHostHook trusts the adapter's hook through Codex", async (t) => {
  const dirs = await paths(t);
  const connection = codexConnection({
    home: dirs.home,
    command: process.execPath,
    args: [fixture],
    env: { FIXTURE_LOG: dirs.log },
  });
  t.after(() => connection.close());
  assert.deepEqual(await connection.trustHostHook(), {
    key: '/<session-flags>/config.toml:pre_tool_use:0:0',
    hash: 'sha256:fixture',
  });
  const [write] = requested(dirs.log, 'config/batchWrite');
  assert.deepEqual(write.params.edits, [
    {
      keyPath: 'hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0".trusted_hash',
      value: 'sha256:fixture',
      mergeStrategy: 'upsert',
    },
  ]);
  // The hook it trusts is the one a dispatch configures.
  const trusted = entries(dirs.log)
    .find((entry) => entry.event === 'spawn')
    .args.find((arg: string) => arg.startsWith('hooks.PreToolUse='));
  const adapter = member(
    dirs,
    { FIXTURE_HOOK_TRUST: 'trusted' },
    {
      executionStop: 'owner-reconcile',
      hostHook: () => ({ allow: true }),
    },
  );
  t.after(() => adapter.close?.());
  await run(adapter, dirs);
  const dispatched = entries(dirs.log)
    .filter((entry) => entry.event === 'spawn')
    .at(-1)
    .args.find((arg: string) => arg.startsWith('hooks.PreToolUse='));
  assert.equal(dispatched, trusted);
  assert.deepEqual(readdirSync(dirs.home), [], 'Orchvia itself wrote nothing to the home');
});

test('AC-0035-I01 stopMarker and executionStop or an observer exclude each other', async (t) => {
  const dirs = await paths(t);
  for (const extra of [
    { executionStop: 'owner-reconcile' },
    { observeExecutionStop: async () => true },
  ])
    assert.throws(
      () =>
        createCodexAdapter({
          connection: { home: dirs.home },
          stopMarker: true,
          ...(extra as object),
        }),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
  // stopMarker supplies the stop proof by itself.
  const adapter = createCodexAdapter({ connection: { home: dirs.home }, stopMarker: true });
  await adapter.close?.();
});

test("AC-0035-I01 every zsh and bash command holds the marker, and the user's startup still runs", async (t) => {
  const dirs = await paths(t);
  await writeFile(join(dirs.user, '.zshenv'), 'export USER_STARTUP=zshenv\n');
  await writeFile(join(dirs.user, 'bash-env'), 'export USER_STARTUP=bash_env\n');
  // The stop observation lists the marker's holders with lsof, which takes seconds on a loaded
  // machine; a tight budget leaves the stop unproven, which is safe but not what this checks.
  const adapter = member(
    dirs,
    { BASH_ENV: join(dirs.user, 'bash-env') },
    { stopMarker: true, closeTimeoutMs: 20000 },
  );
  t.after(() => adapter.close?.());
  const { events, evidence } = await run(adapter, dirs);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  const shells = entries(dirs.log).find((entry) => entry.event === 'shells')?.shells;
  assert.ok(shells, 'the app-server had a stop marker');
  if (shells['/bin/zsh'] !== 'missing') assert.equal(shells['/bin/zsh'], 'held startup=zshenv');
  assert.equal(shells['/bin/bash'], 'held startup=bash_env');
  // Nothing outlived the dispatch, so the markers prove it stopped.
  assert.ok(
    evidence.some((item) => item.remoteExecution === 'stopped'),
    JSON.stringify(evidence),
  );
  // The dispatch's marker goes with it once it is proven stopped (SPEC-0034 A03).
  const marker = entries(dirs.log).find((entry) => entry.event === 'spawn').env.ORCHVIA_STOP_MARKER;
  assert.ok(marker, 'the app-server was given a marker');
  assert.equal(existsSync(marker), false, 'the marker is removed after the dispatch');
});

test('AC-0035-I03 a login shell other than zsh or bash refuses the dispatch', async (t) => {
  const dirs = await paths(t);
  const original = os.userInfo();
  mock.method(os, 'userInfo', () => ({ ...original, shell: '/usr/local/bin/fish' }));
  t.after(() => mock.restoreAll());
  const adapter = member(dirs, {}, { stopMarker: true });
  t.after(() => adapter.close?.());
  const { events } = await run(adapter, dirs);
  assert.match(failure(events), /^STOP_MARKER_UNSUPPORTED_SHELL: /);
  assert.equal(entries(dirs.log).length, 0, 'no app-server was started');
});

test('AC-0035-I04 a command run by /bin/sh interrupts the turn and keeps the lease', async (t) => {
  const dirs = await paths(t);
  const adapter = member(
    dirs,
    { FIXTURE_ITEM_COMMAND: "/bin/sh -c 'sleep 1'" },
    // The end of the dispatch lists the marker's holders with lsof, which takes seconds on a
    // loaded machine; within a tight time the marker would stay.
    { stopMarker: true, closeTimeoutMs: 20000 },
  );
  t.after(() => adapter.close?.());
  const { events, evidence } = await run(adapter, dirs);
  assert.match(failure(events), /^STOP_MARKER_BYPASSED: /);
  assert.equal(requested(dirs.log, 'turn/interrupt').length, 1);
  assert.notEqual(evidence.at(-1)?.remoteExecution, 'stopped', 'no automatic release');
  // Unobserved, the dispatch still ends what holds its marker and, without a host directory,
  // removes it (SPEC-0034 A03).
  const marker = entries(dirs.log).find((entry) => entry.event === 'spawn').env.ORCHVIA_STOP_MARKER;
  assert.equal(existsSync(marker), false, 'the marker is removed after the dispatch');
  const fine = member(
    { ...dirs, log: join(dirs.base, 'zsh.log') },
    { FIXTURE_ITEM_COMMAND: "/bin/zsh -lc 'sleep 1'" },
    { stopMarker: true, closeTimeoutMs: 20000 },
  );
  t.after(() => fine.close?.());
  const zsh = await run(fine, dirs, { dispatchId: 'zsh' });
  assert.equal(zsh.events.at(-1)?.type, 'result', JSON.stringify(zsh.events));
  assert.equal(requested(join(dirs.base, 'zsh.log'), 'turn/interrupt').length, 0);
});

test('AC-0035-I01 the Codex adapter ends its markers synchronously', async (t) => {
  const dirs = await paths(t);
  const adapter = createCodexAdapter({ connection: { home: dirs.home }, stopMarker: true });
  t.after(() => adapter.close?.());
  assert.deepEqual(adapter.endStopMarkersSync(300), { stopped: true, holders: 0, ended: 0 });
  const plain = createCodexAdapter({ executionStop: 'owner-reconcile' });
  assert.deepEqual(plain.endStopMarkersSync(300), { stopped: true, holders: 0, ended: 0 });
});

test('AC-0035-R01 the hook channel answers only with its token', async (t) => {
  const { hostHookChannel } = await import('../../packages/adapter-codex/src/local.ts');
  const { connect } = await import('node:net');
  let asked = 0;
  const channel = await hostHookChannel(() => (asked++, { allow: true }), {
    taskId: 't',
    sessionId: 's',
    dispatchId: 'd',
  });
  t.after(() => channel.close());
  const ask = (token: string) =>
    new Promise<{ allow: boolean; reason?: string }>((resolve, reject) => {
      const socket = connect({ path: channel.env.ORCHVIA_HOOK_SOCKET! });
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({ token, event: { tool_name: 'Bash', tool_input: { command: 'ls' } } }) +
            '\n',
        ),
      );
      socket.on('data', (data: string) => (buffer += data));
      socket.on('end', () => resolve(JSON.parse(buffer)));
      socket.on('error', reject);
    });
  assert.equal((await ask('0'.repeat(64))).allow, false, 'a wrong token is refused');
  assert.equal(asked, 0, 'and the host is not asked');
  assert.equal((await ask(channel.env.ORCHVIA_HOOK_TOKEN!)).allow, true);
  assert.equal(asked, 1);
});
