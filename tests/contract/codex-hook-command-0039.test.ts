import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  codexConnection,
  createCodexAdapter,
  hostHookCommandFor,
  hostHookProgram,
  toolBridgeProgram,
} from '../../packages/adapter-codex/src/index.ts';
import { createToolBridge } from '../../packages/engine/src/tool-bridge.ts';
import { ORCHESTRATION_TOOLS, TOOL_NAMES } from '../../packages/engine/src/tools.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0039: the host's hook and bridge commands, hooks that fail open, client information and
// member instructions.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const sourceHook = fileURLToPath(
  new URL('../../packages/adapter-codex/src/hook.ts', import.meta.url),
);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function paths(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0039-')));
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
const spawned = (log: string) => entries(log).filter((entry) => entry.event === 'spawn');
const hookSetting = (log: string) =>
  spawned(log)
    .at(-1)
    ?.args.find((arg: string) => arg.startsWith('hooks.PreToolUse='));

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
    ...extra,
  });
}
async function run(
  adapter: ReturnType<typeof createCodexAdapter>,
  dirs: Paths,
  input: Partial<RuntimeInput> = {},
) {
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
    ...input,
  } as RuntimeInput))
    events.push(event);
  return events;
}
const failure = (events: RuntimeEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'error' ? last.message : `no error: ${JSON.stringify(events)}`;
};
const outcome = (events: RuntimeEvent[]) => (events.at(-1) as { outcome?: string }).outcome;

test('AC-0039-H01 hostHookCommand is checked, and needs hostHook', async (t) => {
  const dirs = await paths(t);
  const make = (extra: Record<string, unknown>) => () =>
    createCodexAdapter({
      executionStop: 'owner-reconcile',
      connection: { home: dirs.home },
      ...extra,
    } as never);
  const allow = () => ({ allow: true as const });
  for (const [name, extra] of [
    ['without hostHook', { hostHookCommand: 'x' }],
    ['not a string', { hostHook: allow, hostHookCommand: 5 }],
    ['empty', { hostHook: allow, hostHookCommand: '' }],
    ['a line break', { hostHook: allow, hostHookCommand: 'a\nb' }],
    ['NUL', { hostHook: allow, hostHookCommand: 'a\0b' }],
    ['too long', { hostHook: allow, hostHookCommand: 'x'.repeat(4097) }],
  ] as const)
    assert.throws(make(extra), { code: 'INVALID_ADAPTER_CONFIG' }, name);
  make({ hostHook: allow, hostHookCommand: 'x'.repeat(4096) })();
  for (const hostHookCommand of [5, '', 'a\nb'])
    assert.throws(
      () => codexConnection({ home: dirs.home, hostHookCommand } as never),
      { code: 'INVALID_ADAPTER_CONFIG' },
      String(hostHookCommand),
    );
});

test('AC-0039-H01 the host command reaches the dispatch and trustHostHook as given', async (t) => {
  const dirs = await paths(t);
  const command = hostHookCommandFor({
    runtime: process.execPath,
    program: sourceHook,
    env: { ORCH_0039: '1' },
  });
  const connection = codexConnection({
    home: dirs.home,
    command: process.execPath,
    args: [fixture],
    env: { FIXTURE_LOG: dirs.log },
    hostHookCommand: command,
  });
  t.after(() => connection.close());
  assert.deepEqual(await connection.trustHostHook(), {
    key: '/<session-flags>/config.toml:pre_tool_use:0:0',
    hash: 'sha256:fixture',
  });
  const trusted = hookSetting(dirs.log);
  assert.ok(trusted.includes(JSON.stringify(command)), trusted);
  const adapter = member(
    dirs,
    { FIXTURE_HOOK_TRUST: 'trusted' },
    { hostHook: () => ({ allow: true }), hostHookCommand: command },
  );
  t.after(() => adapter.close?.());
  const events = await run(adapter, dirs);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  assert.equal(hookSetting(dirs.log), trusted, 'the dispatch passes the hook it trusted');
});

test('AC-0039-H01 without hostHookCommand the command is the one 0.1.15 trusted', async (t) => {
  const dirs = await paths(t);
  const adapter = member(
    dirs,
    { FIXTURE_HOOK_TRUST: 'trusted' },
    { hostHook: () => ({ allow: true }) },
  );
  t.after(() => adapter.close?.());
  await run(adapter, dirs);
  const command = `${quote(process.execPath)} ${quote(sourceHook)}`;
  assert.equal(
    hookSetting(dirs.log),
    `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(command)},async=false,timeoutSec=600}]}]`,
  );
});

test('AC-0039-H02 hostHookCommandFor quotes each part and a variable prefix', async (t) => {
  const dirs = await paths(t);
  const odd = join(dirs.base, "Application Support/it's");
  await mkdir(odd, { recursive: true });
  const runtime = join(odd, 'run time');
  await writeFile(runtime, '#!/bin/sh\nprintf \'%s\\n\' "$@" "ONE=$ORCH_ONE" "TWO=$ORCH_TWO"\n');
  await chmod(runtime, 0o755);
  const program = join(odd, 'hook "x".mjs');
  const command = hostHookCommandFor({
    runtime,
    program,
    env: { ORCH_ONE: '1', ORCH_TWO: `a 'b' "c" $HOME` },
  });
  assert.equal(
    command,
    `ORCH_ONE=${quote('1')} ORCH_TWO=${quote(`a 'b' "c" $HOME`)} ${quote(runtime)} ${quote(program)}`,
  );
  const ran = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(ran.stdout, `${program}\nONE=1\nTWO=a 'b' "c" $HOME\n`, ran.stderr);
  assert.equal(
    hostHookCommandFor({ runtime, program }),
    `${quote(runtime)} ${quote(program)}`,
    'no prefix without env',
  );
  for (const [name, options] of [
    ['relative runtime', { runtime: 'node', program }],
    ['relative program', { runtime, program: 'hook.mjs' }],
    ['a bad name', { runtime, program, env: { '1X': '1' } }],
    ['a dash in a name', { runtime, program, env: { 'A-B': '1' } }],
    ['a line break', { runtime, program, env: { A: 'x\ny' } }],
    ['NUL', { runtime, program, env: { A: 'x\0y' } }],
    ['not a string', { runtime, program, env: { A: 1 } }],
  ] as const)
    assert.throws(
      () => hostHookCommandFor(options as never),
      { code: 'INVALID_ADAPTER_CONFIG' },
      name,
    );
});

test('AC-0039-H03 the hook program runs from a copy and denies when it cannot ask', async (t) => {
  const dirs = await paths(t);
  const program = hostHookProgram();
  assert.ok(existsSync(program), program);
  // A directory with no package beside it, as a host's own copy would be.
  const copy = join(dirs.base, 'copied', program.endsWith('.ts') ? 'hook.ts' : 'hook.mjs');
  await mkdir(join(dirs.base, 'copied'));
  await copyFile(program, copy);
  const ran = spawnSync(process.execPath, [copy], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ORCHVIA_HOOK_SOCKET: '/nonexistent/s', ORCHVIA_HOOK_TOKEN: 'x' },
  });
  assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision, 'deny', ran.stderr);
});

test('AC-0039-H04 hostHookTrust reports trust and whether the command runs, writing nothing', async (t) => {
  const dirs = await paths(t);
  const check = (env: Record<string, string>, hostHookCommand?: string) =>
    codexConnection({
      home: dirs.home,
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_LOG: dirs.log, ...env },
      ...(hostHookCommand ? { hostHookCommand } : {}),
    }).hostHookTrust();
  assert.deepEqual(await check({}), {
    trusted: false,
    status: 'untrusted',
    key: '/<session-flags>/config.toml:pre_tool_use:0:0',
    hash: 'sha256:fixture',
    runs: true,
  });
  const trusted = await check({ FIXTURE_HOOK_TRUST: 'trusted' });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.status, 'trusted');
  const broken = await check({ FIXTURE_HOOK_TRUST: 'trusted' }, "'/nonexistent/orch-hook'");
  assert.equal(broken.trusted, true);
  assert.equal(broken.runs, false);
  assert.equal(typeof broken.reason, 'string');
  assert.equal(requested(dirs.log, 'config/batchWrite').length, 0);
  assert.deepEqual(readdirSync(dirs.home), [], 'nothing was written to the home');
});

test('AC-0039-H05 a hook command that would fail open refuses the dispatch before Codex starts', async (t) => {
  const dirs = await paths(t);
  const hook = `${quote(process.execPath)} ${quote(sourceHook)}`;
  for (const [name, command] of [
    ['missing', "'/nonexistent/orch-hook'"],
    ['exit 1', "/bin/sh -c 'cat >/dev/null; exit 1'"],
    ['exit 2', "/bin/sh -c 'cat >/dev/null; exit 2'"],
    ['silent', "/bin/sh -c 'cat >/dev/null'"],
    ['garbage', "/bin/sh -c 'cat >/dev/null; echo not-json'"],
    // The program runs, but something before it prints, so Codex could not read the answer.
    ['chatter', `echo hello; ${hook}`],
    ['fails after asking', `${hook}; exit 3`],
  ] as const) {
    const log = join(dirs.base, `${name.replace(/ /g, '-')}.log`);
    const asked: unknown[] = [];
    const adapter = member(
      { ...dirs, log },
      { FIXTURE_HOOK_TRUST: 'trusted' },
      { hostHook: (event) => (asked.push(event), { allow: true }), hostHookCommand: command },
    );
    const events = await run(adapter, dirs, { dispatchId: name.replace(/ /g, '-') });
    await adapter.close?.();
    assert.match(failure(events), /^HOST_HOOK_UNAVAILABLE: /, name);
    assert.equal(outcome(events), 'failed', name);
    assert.equal(spawned(log).length, 0, `${name}: no app-server was started`);
    assert.deepEqual(asked, [], `${name}: the probe never reaches the host`);
  }
  // A working command with a variable prefix passes.
  const prefixed = member(
    dirs,
    { FIXTURE_HOOK_TRUST: 'trusted' },
    {
      hostHook: () => ({ allow: true }),
      hostHookCommand: hostHookCommandFor({
        runtime: process.execPath,
        program: sourceHook,
        env: { ORCH_0039: '1' },
      }),
    },
  );
  t.after(() => prefixed.close?.());
  const events = await run(prefixed, dirs, { dispatchId: 'prefixed' });
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
});

test('AC-0039-H06 an item the host did not allow interrupts the turn', async (t) => {
  const dirs = await paths(t);
  const command = (id: string, text: string) => ({
    tool_name: 'Bash',
    tool_use_id: id,
    turn_id: 'turn',
    tool_input: { command: text },
  });
  const item = (id: string, type = 'commandExecution') =>
    type === 'fileChange'
      ? { type, id, status: 'inProgress', changes: [] }
      : { type, id, command: `/bin/zsh -lc 'echo ${id}'`, status: 'inProgress' };
  const cases: [string, unknown[], boolean][] = [
    [
      'parallel, both allowed',
      [
        { hooks: [command('call_1', 'echo a'), command('call_2', 'echo b')], item: item('call_2') },
        { item: item('call_1') },
      ],
      false,
    ],
    [
      'a patch allowed',
      [
        {
          hooks: [
            { tool_name: 'apply_patch', tool_use_id: 'call_3', tool_input: { command: '*' } },
          ],
          item: item('call_3', 'fileChange'),
        },
      ],
      false,
    ],
    ['a command never asked about', [{ item: item('call_4') }], true],
    ['a file change never asked about', [{ item: item('call_5', 'fileChange') }], true],
    [
      'a command the host refused',
      [{ hooks: [command('call_6', 'rm -rf x')], item: item('call_6') }],
      true,
    ],
    [
      'an item under an id asked about for another call',
      [{ hooks: [command('call_7', 'echo a')], item: item('call_8') }],
      true,
    ],
  ];
  for (const [name, items, bypassed] of cases) {
    const log = join(dirs.base, `${name.replace(/[ ,]+/g, '-')}.log`);
    const adapter = member(
      { ...dirs, log },
      { FIXTURE_HOOK_TRUST: 'trusted', FIXTURE_HOOKED_ITEMS: JSON.stringify(items) },
      {
        hostHook: (event) =>
          /\brm\b/.test(event.command ?? '') ? { allow: false, reason: 'no' } : { allow: true },
      },
    );
    const events = await run(adapter, dirs, { dispatchId: name.replace(/[ ,]+/g, '-') });
    await adapter.close?.();
    if (bypassed) {
      assert.match(failure(events), /^HOST_HOOK_BYPASSED: /, name);
      assert.equal(outcome(events), 'unknown', name);
      assert.equal(requested(log, 'turn/interrupt').length, 1, name);
    } else {
      assert.equal(events.at(-1)?.type, 'result', `${name}: ${JSON.stringify(events)}`);
      assert.equal(requested(log, 'turn/interrupt').length, 0, name);
    }
  }
});

const toolsFixture = fileURLToPath(new URL('../fixtures/codex-tools.ts', import.meta.url));
const engineBridge = fileURLToPath(
  new URL('../../packages/engine/src/tool-bridge.ts', import.meta.url),
);

test('AC-0039-B01 toolBridge is checked', () => {
  for (const [name, toolBridge] of [
    ['not an object', 'node'],
    ['relative command', { command: 'node' }],
    ['args not a list', { command: process.execPath, args: 'x' }],
    ['too many args', { command: process.execPath, args: Array(33).fill('x') }],
    ['a line break in an arg', { command: process.execPath, args: ['a\nb'] }],
    ['a bad name', { command: process.execPath, env: { '1X': '1' } }],
    ['the bridge channel', { command: process.execPath, env: { AGENT_ORCH_BRIDGE_TOKEN: 'x' } }],
    ['a value not text', { command: process.execPath, env: { A: 1 } }],
    ['another key', { command: process.execPath, cwd: '/' }],
  ] as const)
    assert.throws(
      () => createCodexAdapter({ executionStop: 'owner-reconcile', toolBridge } as never),
      { code: 'INVALID_ADAPTER_CONFIG' },
      name,
    );
});

test('AC-0039-B01 the host bridge command serves the tools, its variables to the bridge alone', async (t) => {
  const dirs = await paths(t);
  // A runtime that runs the bridge only with its variable, as Electron runs as Node.
  const runtime = join(dirs.base, 'bridge runtime.sh');
  await writeFile(
    runtime,
    `#!/bin/sh\n[ "$ORCH_0039_BRIDGE" = on ] || exit 1\necho ran > ${quote(join(dirs.base, 'bridge-ran'))}\nexec ${quote(process.execPath)} "$@"\n`,
  );
  await chmod(runtime, 0o755);
  const envOut = join(dirs.base, 'app-server-env.json');
  const calls: string[] = [];
  const configs = {
    host: { command: runtime, args: [engineBridge], env: { ORCH_0039_BRIDGE: 'on' } },
    default: undefined,
  };
  for (const [name, toolBridge] of Object.entries(configs)) {
    const adapter = createCodexAdapter({
      executionStop: 'owner-reconcile',
      command: process.execPath,
      args: [toolsFixture],
      env: { FIXTURE_ENV_OUT: envOut },
      ...(toolBridge ? { toolBridge } : {}),
    });
    const events = await run(adapter, dirs, {
      dispatchId: name,
      permissionProfile: 'read-only',
      orchestrationTools: {
        definitions: ORCHESTRATION_TOOLS,
        async call(tool) {
          calls.push(`${name}:${tool}`);
          return { ok: true };
        },
      },
    });
    await adapter.close?.();
    assert.equal(events.at(-1)?.type, 'result', `${name}: ${JSON.stringify(events)}`);
    if (name === 'host') {
      assert.ok(existsSync(join(dirs.base, 'bridge-ran')), 'the host command started the bridge');
      const names = JSON.parse(readFileSync(envOut, 'utf8')) as string[];
      assert.equal(names.includes('ORCH_0039_BRIDGE'), false, 'the app-server never has it');
    }
  }
  assert.deepEqual(calls, [
    ...TOOL_NAMES.map((tool) => `host:${tool}`),
    ...TOOL_NAMES.map((tool) => `default:${tool}`),
  ]);
});

test('AC-0039-B02 toolBridgeProgram serves the tools over the bridge channel', async (t) => {
  const program = toolBridgeProgram();
  assert.ok(existsSync(program), program);
  const control = new AbortController();
  const bridge = await createToolBridge(
    { definitions: ORCHESTRATION_TOOLS, call: async () => ({ ok: true }) },
    control.signal,
  );
  t.after(() => bridge.close());
  const child = spawn(process.execPath, [program], {
    env: { PATH: process.env.PATH, ...bridge.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const listed = JSON.parse((await lines.next()).value!);
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    TOOL_NAMES,
  );
});

test('AC-0039-K01 clientInfo needs a version', async (t) => {
  const dirs = await paths(t);
  for (const clientInfo of [{ name: 'host' }, { name: 'host', version: '' }]) {
    assert.throws(
      () => createCodexAdapter({ executionStop: 'owner-reconcile', clientInfo } as never),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
    assert.throws(() => codexConnection({ home: dirs.home, clientInfo } as never), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  }
  const adapter = member(dirs, {}, { clientInfo: { name: 'host', version: '2.0.0' } });
  t.after(() => adapter.close?.());
  await run(adapter, dirs);
  assert.deepEqual(requested(dirs.log, 'initialize')[0].params.clientInfo, {
    name: 'host',
    version: '2.0.0',
  });
});

test('AC-0039-D01 a new thread gets the instructions; a resumed or forked one does not', async (t) => {
  const dirs = await paths(t);
  const asked: string[] = [];
  const adapter = member(
    dirs,
    {},
    {
      instructions: (input) => (asked.push(input.dispatchId), `You review ${input.taskId}.`),
    },
  );
  t.after(() => adapter.close?.());
  const started = await run(adapter, dirs, { dispatchId: 'new', prompt: 'the goal' });
  assert.equal(started.at(-1)?.type, 'result', JSON.stringify(started));
  const [start] = requested(dirs.log, 'thread/start');
  assert.equal(start.params.developerInstructions, 'You review task.');
  const [turn] = requested(dirs.log, 'turn/start');
  assert.deepEqual(
    turn.params.input,
    [{ type: 'text', text: 'the goal' }],
    'the prompt is untouched',
  );
  assert.ok(
    !JSON.stringify(started).includes('You review'),
    'the text is in no event the engine records',
  );
  await run(adapter, dirs, { dispatchId: 'resumed', providerSessionId: 'thread' });
  await run(adapter, dirs, {
    dispatchId: 'forked',
    forkSource: { providerSessionId: 'thread', nativeCheckpoint: 'turn' },
  } as never);
  for (const method of ['thread/resume', 'thread/fork'])
    for (const entry of requested(dirs.log, method))
      assert.equal(entry.params.developerInstructions, undefined, method);
  assert.deepEqual(asked, ['new'], 'only the dispatch that starts a thread asks');
});

test('AC-0039-D01 instructions are checked, and a bad result stops the dispatch before Codex', async (t) => {
  const dirs = await paths(t);
  assert.throws(
    () => createCodexAdapter({ executionStop: 'owner-reconcile', instructions: 'text' } as never),
    { code: 'INVALID_ADAPTER_CONFIG' },
  );
  for (const [name, instructions] of [
    ['not text', () => 42],
    ['too long', () => 'x'.repeat(256 * 1024 + 1)],
    [
      'throws',
      () => {
        throw new Error('no instructions today');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('no instructions today');
      },
    ],
  ] as const) {
    const log = join(dirs.base, `${name.replace(/ /g, '-')}.log`);
    const adapter = member({ ...dirs, log }, {}, { instructions } as never);
    const events = await run(adapter, dirs, { dispatchId: name.replace(/ /g, '-') });
    await adapter.close?.();
    assert.equal(events.at(-1)?.type, 'error', name);
    assert.equal(outcome(events), 'failed', name);
    assert.equal(spawned(log).length, 0, `${name}: no app-server was started`);
  }
  // Nothing to say starts the thread without instructions.
  const quiet = member(dirs, {}, { instructions: () => undefined });
  t.after(() => quiet.close?.());
  await run(quiet, dirs, { dispatchId: 'quiet' });
  assert.equal(requested(dirs.log, 'thread/start')[0].params.developerInstructions, undefined);
});
