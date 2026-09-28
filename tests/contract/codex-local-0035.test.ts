import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0035: the local Codex CLI as a member.

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function dirs(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0035-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace'),
    state = join(base, 'state');
  await mkdir(workspace);
  await mkdir(state);
  return { base, workspace, state };
}

async function run(adapter: ReturnType<typeof createCodexAdapter>, input: Partial<RuntimeInput>) {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    model: 'offline',
    prompt: 'go',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    ...input,
  } as RuntimeInput))
    events.push(event);
  return events;
}
/** Input tokens by usage record: the engine keeps one record per usageId. */
const inputTokens = (events: RuntimeEvent[]) => [
  ...new Map(
    events.flatMap((event) =>
      event.type === 'usage' ? [[event.usageId, event.usage.inputTokens] as const] : [],
    ),
  ).values(),
];

test('AC-0035-J01 a dispatch hands the engine one set of thread totals, after its last request', async (t) => {
  const { workspace, state } = await dirs(t);
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture('codex-compact-usage.ts')],
    env: { FIXTURE_TWO_REQUESTS: '1' },
  });
  t.after(() => adapter.close?.());
  const events = await run(adapter, { workspace, stateDir: state });
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  const totals = events.flatMap((event) =>
    event.type === 'usage' && event.sessionTotals !== undefined ? [event.sessionTotals] : [],
  );
  // The engine refuses a second, different set for one dispatch (SPEC-0032 E01).
  assert.equal(
    new Set(totals.map((value) => JSON.stringify(value))).size,
    1,
    JSON.stringify(totals),
  );
  assert.equal(
    (totals[0] as { codexThreadTotal: { inputTokens: number } }).codexThreadTotal.inputTokens,
    1500,
    'the totals after the last request',
  );
});

test('AC-0035-J01 usage held for the thread totals still reaches the host when the turn fails', async (t) => {
  const { workspace, state } = await dirs(t);
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture('codex-compact-usage.ts')],
    env: { FIXTURE_DIE: '1' },
  });
  t.after(() => adapter.close?.());
  const events = await run(adapter, { workspace, stateDir: state });
  assert.equal(events.at(-1)?.type, 'error', JSON.stringify(events));
  assert.deepEqual(inputTokens(events), [1000]);
});

test('AC-0035-J01 a compaction on a resumed thread counts its own request once', async (t) => {
  const { workspace, state } = await dirs(t);
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture('codex-compact-usage.ts')],
  });
  t.after(() => adapter.close?.());
  const first = await run(adapter, { dispatchId: 'd1', workspace, stateDir: state });
  assert.deepEqual(inputTokens(first), [1000]);
  assert.equal(first.at(-1)?.type, 'result');
  const totals = first
    .flatMap((event) =>
      event.type === 'usage' && event.sessionTotals !== undefined ? [event.sessionTotals] : [],
    )
    .at(-1);
  assert.ok(totals !== undefined, 'the dispatch reports the thread totals for the next one');
  const compacted = await run(adapter, {
    dispatchId: 'd2',
    workspace,
    stateDir: state,
    providerSessionId: 'thread',
    nativeAction: 'compact',
    usageBaseline: { dispatchId: 'd1', totals: totals! },
  });
  assert.equal(compacted.at(-1)?.type, 'result', JSON.stringify(compacted));
  // The engine keeps one set of totals per dispatch and refuses a different second one.
  for (const events of [first, compacted])
    assert.equal(
      new Set(
        events.flatMap((event) =>
          event.type === 'usage' && event.sessionTotals !== undefined
            ? [JSON.stringify(event.sessionTotals)]
            : [],
        ),
      ).size,
      1,
      'one set of thread totals per dispatch',
    );
  assert.deepEqual(
    inputTokens(compacted).filter((tokens) => tokens !== 0),
    [2000],
    'the earlier request, sent again under the compaction, is not counted again',
  );
});

// ---- A local member on a connection home, against tests/fixtures/codex-local.ts ----

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { codexConnection } from '../../packages/adapter-codex/src/index.ts';

async function home(t: any) {
  const paths = await dirs(t);
  const codexHome = join(paths.base, 'codex-home');
  await mkdir(codexHome);
  return { ...paths, home: codexHome, log: join(paths.base, 'fixture.log') };
}
type Entry = {
  event: string;
  pid: number;
  at: number;
  method?: string;
  params?: any;
  args?: string[];
  env?: any;
};
const entries = (log: string): Entry[] =>
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
  paths: { home: string; log: string },
  env: Record<string, string> = {},
  extra: Partial<Parameters<typeof createCodexAdapter>[0]> = {},
) {
  return createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture('codex-local.ts')],
    env: { FIXTURE_LOG: paths.log, ...env },
    connection: { home: paths.home },
    ...extra,
  });
}
const failure = (events: RuntimeEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'error' ? last.message : `no error: ${JSON.stringify(events)}`;
};
const setting = (args: string[] | undefined, prefix: string) =>
  (args ?? []).find((arg) => arg.startsWith(prefix));

test('AC-0035-A01 the connection home is used and nothing is written to it', async (t) => {
  const paths = await home(t);
  const adapter = member(paths);
  t.after(() => adapter.close?.());
  const events = await run(adapter, { workspace: paths.workspace, stateDir: paths.state });
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  assert.equal(
    entries(paths.log).find((entry) => entry.event === 'spawn')?.env.CODEX_HOME,
    paths.home,
  );
  assert.deepEqual(readdirSync(paths.home), [], 'Orchvia wrote nothing to the home');
});

test('AC-0035-A01 a home overlapping the workspace or state directory is refused', async (t) => {
  const paths = await home(t);
  for (const [name, codexHome] of [
    ['inside the workspace', join(paths.workspace, 'codex')],
    ['containing the state directory', paths.base],
  ]) {
    await mkdir(codexHome, { recursive: true });
    const adapter = member({ ...paths, home: codexHome });
    const events = await run(adapter, { workspace: paths.workspace, stateDir: paths.state });
    await adapter.close?.();
    assert.match(failure(events), /^CODEX_HOME_OVERLAP: /, name);
  }
  assert.equal(entries(paths.log).length, 0, 'no app-server was started');
});

test('AC-0035-A01 connection configuration is checked when the adapter is made', async (t) => {
  const paths = await home(t);
  const cases: [string, Parameters<typeof createCodexAdapter>[0]][] = [
    ['relative home', { executionStop: 'owner-reconcile', connection: { home: 'codex-home' } }],
    [
      'missing home',
      { executionStop: 'owner-reconcile', connection: { home: join(paths.base, 'none') } },
    ],
    [
      'policy without connection',
      { executionStop: 'owner-reconcile', policy: () => ({ mode: 'auto' }) },
    ],
    ['denyRead without connection', { executionStop: 'owner-reconcile', denyRead: ['x'] }],
    [
      'networkAccess with connection',
      { executionStop: 'owner-reconcile', connection: { home: paths.home }, networkAccess: true },
    ],
    ['bad clientInfo', { executionStop: 'owner-reconcile', clientInfo: { name: 'a b' } }],
    [
      'bad host MCP name',
      { executionStop: 'owner-reconcile', hostMcpServers: { agent_orch: { command: 'x' } } },
    ],
    [
      'bad host MCP url',
      { executionStop: 'owner-reconcile', hostMcpServers: { a: { url: 'file:///x' } } },
    ],
  ];
  for (const [name, config] of cases)
    assert.throws(() => createCodexAdapter(config), { code: 'INVALID_ADAPTER_CONFIG' }, name);
});

test('AC-0035-A02 two members on one home start one at a time', async (t) => {
  const paths = await home(t);
  const adapters = [0, 1].map(() => member(paths, { FIXTURE_THREAD_DELAY_MS: '300' }));
  t.after(() => Promise.all(adapters.map((adapter) => adapter.close?.())));
  const workspaces = [paths.workspace, join(paths.base, 'workspace-2')];
  await mkdir(workspaces[1]!);
  const results = await Promise.all(
    adapters.map((adapter, i) =>
      run(adapter, {
        dispatchId: `d${i}`,
        sessionId: `s${i}`,
        workspace: workspaces[i]!,
        stateDir: paths.state,
      }),
    ),
  );
  for (const events of results) assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  const byPid = new Map<number, { spawn: number; opened: number }>();
  for (const entry of entries(paths.log)) {
    const times = byPid.get(entry.pid) ?? { spawn: 0, opened: 0 };
    if (entry.event === 'spawn') times.spawn = entry.at;
    if (entry.event === 'thread-opened') times.opened = entry.at;
    byPid.set(entry.pid, times);
  }
  const [first, second] = [...byPid.values()].sort((a, b) => a.spawn - b.spawn);
  assert.ok(
    second!.spawn >= first!.opened,
    `second started ${second!.spawn - first!.opened} ms before the first opened its thread`,
  );
  assert.deepEqual(readdirSync(paths.home), [], 'the lock is not kept in the home');
});

test('AC-0035-A03 a thread start revoked by a sign-in elsewhere is tried once more', async (t) => {
  const paths = await home(t);
  const adapter = member(paths, {
    FIXTURE_THREAD_FAIL_ONCE: 'application network permission was revoked',
  });
  t.after(() => adapter.close?.());
  const events = await run(adapter, { workspace: paths.workspace, stateDir: paths.state });
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  assert.equal(requested(paths.log, 'thread/start').length, 2);
});

test('AC-0035-B01 each dispatch runs under a named profile that fences the home, state and denyRead', async (t) => {
  const paths = await home(t);
  await mkdir(join(paths.workspace, 'secret'));
  const adapter = member(paths, {}, { denyRead: ['secret', '/etc/hosts'] });
  t.after(() => adapter.close?.());
  for (const permissionProfile of ['read-only', 'workspace-write'] as const) {
    const events = await run(adapter, {
      workspace: paths.workspace,
      stateDir: paths.state,
      permissionProfile,
      dispatchId: permissionProfile,
    });
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  }
  const spawns = entries(paths.log).filter((entry) => entry.event === 'spawn');
  for (const [i, write] of [
    [0, false],
    [1, true],
  ] as const) {
    const args = spawns[i]!.args;
    assert.ok(args!.includes('default_permissions="orchvia"'));
    const profile = setting(args, 'permissions.orchvia=')!;
    for (const denied of [
      paths.home,
      paths.state,
      join(paths.workspace, 'secret'),
      realpathSync('/etc/hosts'),
    ])
      assert.ok(profile.includes(`${JSON.stringify(denied)}="none"`), `${denied} in ${profile}`);
    assert.equal(profile.includes(`${JSON.stringify(paths.workspace)}="write"`), write);
    assert.equal(profile.includes('":tmpdir"="write"'), write, 'the temporary directory (D-35-4)');
  }
  for (const start of requested(paths.log, 'thread/start'))
    assert.equal(start.params.sandbox, undefined);
  for (const turn of requested(paths.log, 'turn/start'))
    assert.equal(turn.params.sandboxPolicy, undefined);
});

test('AC-0035-B04 commands never get an agent socket or a host secret', async (t) => {
  const paths = await home(t);
  const adapter = member(
    paths,
    {},
    {
      hostMcpServers: {
        tools: { url: 'http://127.0.0.1:9/mcp', token: 'secret-token' },
        local: { command: 'node', args: ['server.js'], env: { HOST_SECRET: 'x' } },
      },
    },
  );
  t.after(() => adapter.close?.());
  await run(adapter, { workspace: paths.workspace, stateDir: paths.state });
  const spawn = entries(paths.log).find((entry) => entry.event === 'spawn')!;
  const exclude = JSON.parse(
    setting(spawn.args, 'shell_environment_policy.exclude=')!.split('=').slice(1).join('='),
  );
  for (const name of [
    'AGENT_ORCH_BRIDGE_*',
    'SSH_AUTH_SOCK',
    'ORCHVIA_HOST_MCP_TOKEN_0',
    'HOST_SECRET',
  ])
    assert.ok(exclude.includes(name), `${name} in ${exclude}`);
  assert.equal(spawn.env.ORCHVIA_HOST_MCP_TOKEN_0, 'secret-token', 'the token reaches Codex');
  assert.ok(!spawn.args!.join(' ').includes('secret-token'), 'and never its command line');
});

test('AC-0035-E01 a binary that is missing or too old refuses the dispatch before a thread', async (t) => {
  const paths = await home(t);
  const old = member(paths, { FIXTURE_USER_AGENT: 'orchvia_test/0.153.3 (fixture)' });
  t.after(() => old.close?.());
  assert.match(
    failure(await run(old, { workspace: paths.workspace, stateDir: paths.state })),
    /^CODEX_VERSION_UNSUPPORTED: /,
  );
  const unknown = member(paths, { FIXTURE_USER_AGENT: 'something else' });
  t.after(() => unknown.close?.());
  assert.match(
    failure(await run(unknown, { workspace: paths.workspace, stateDir: paths.state })),
    /^CODEX_VERSION_UNSUPPORTED: /,
  );
  assert.equal(requested(paths.log, 'thread/start').length, 0);
  const missing = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: join(paths.base, 'no-codex-here'),
    connection: { home: paths.home },
  });
  t.after(() => missing.close?.());
  assert.match(
    failure(await run(missing, { workspace: paths.workspace, stateDir: paths.state })),
    /^CODEX_NOT_FOUND: /,
  );
});

const PROXY_OK = JSON.stringify({ proxy: true, unix: 'EPERM', outside: 'EPERM' });

test('AC-0035-F01 each mode opens the thread with its approval policy and network', async (t) => {
  const paths = await home(t);
  const cases = [
    ['read-only', { mode: 'plan' }, 'never', null],
    ['workspace-write', { mode: 'default', network: 'direct' }, 'untrusted', 'direct'],
    [
      'workspace-write',
      { mode: 'acceptEdits', network: { domains: ['registry.npmjs.org'] } },
      'untrusted',
      'domains',
    ],
    ['workspace-write', { mode: 'auto' }, 'on-request', null],
  ] as const;
  for (const [i, [permissionProfile, policy, approval, network]] of cases.entries()) {
    const log = join(paths.base, `f01-${i}.log`);
    const adapter = member(
      { ...paths, log },
      { FIXTURE_EXEC_STDOUT: PROXY_OK },
      { policy: () => policy as never },
    );
    const events = await run(adapter, {
      workspace: paths.workspace,
      stateDir: paths.state,
      permissionProfile,
      requestPermission: async () => true,
    });
    await adapter.close?.();
    assert.equal(events.at(-1)?.type, 'result', `${policy.mode}: ${JSON.stringify(events)}`);
    assert.equal(requested(log, 'thread/start')[0]!.params.approvalPolicy, approval, policy.mode);
    assert.equal(requested(log, 'turn/start')[0]!.params.approvalPolicy, approval, policy.mode);
    const args = entries(log).find((entry) => entry.event === 'spawn')!.args!;
    const profile = setting(args, 'permissions.orchvia=')!;
    if (network === 'direct') {
      assert.ok(
        profile.includes(
          'network={enabled=true,mode="full",allow_local_binding=true,domains={"*"="allow"}}',
        ),
      );
      assert.ok(args.includes('features.network_proxy=true'));
    } else if (network === 'domains') {
      assert.ok(
        profile.includes(
          'network={enabled=true,mode="full",domains={"registry.npmjs.org"="allow"}}',
        ),
      );
      assert.ok(!profile.includes('allow_local_binding'));
    } else {
      assert.ok(!profile.includes('network='), `${policy.mode} has no network`);
      assert.ok(!args.includes('features.network_proxy=true'));
    }
    assert.equal(
      requested(log, 'command/exec').length,
      network ? 1 : 0,
      'the proxy check runs with network only',
    );
  }
});

test('AC-0035-F02 an inconsistent mode, profile or network refuses the dispatch', async (t) => {
  const paths = await home(t);
  const cases: [string, Partial<RuntimeInput>, unknown][] = [
    ['plan on the writable profile', { permissionProfile: 'workspace-write' }, { mode: 'plan' }],
    ['auto on the read profile', { permissionProfile: 'read-only' }, { mode: 'auto' }],
    ['full access', { permissionProfile: 'workspace-write' }, { mode: 'bypassPermissions' }],
    [
      'default without an approval callback',
      { permissionProfile: 'workspace-write' },
      { mode: 'default' },
    ],
    ['plan with network', { permissionProfile: 'read-only' }, { mode: 'plan', network: 'direct' }],
    [
      'bad domains',
      { permissionProfile: 'workspace-write' },
      { mode: 'auto', network: { domains: ['a b'] } },
    ],
    ['no policy', { permissionProfile: 'workspace-write' }, null],
  ];
  for (const [name, input, policy] of cases) {
    const adapter = member(paths, {}, { policy: () => policy as never });
    const events = await run(adapter, {
      workspace: paths.workspace,
      stateDir: paths.state,
      ...input,
    });
    await adapter.close?.();
    assert.match(failure(events), /^CODEX_POLICY_INVALID: /, name);
  }
  const throwing = member(
    paths,
    {},
    {
      policy: () => {
        throw new Error('host broke');
      },
    },
  );
  assert.match(
    failure(await run(throwing, { workspace: paths.workspace, stateDir: paths.state })),
    /^CODEX_POLICY_INVALID: .*host broke/,
  );
  await throwing.close?.();
  assert.equal(entries(paths.log).length, 0, 'no app-server was started');
});

test('AC-0035-N05 a network dispatch whose proxy is not in force never opens a thread', async (t) => {
  const paths = await home(t);
  const cases: [string, Record<string, string>][] = [
    [
      'no proxy variables',
      { FIXTURE_EXEC_STDOUT: JSON.stringify({ proxy: false, unix: 'EPERM', outside: 'EPERM' }) },
    ],
    [
      'a Unix socket reachable',
      { FIXTURE_EXEC_STDOUT: JSON.stringify({ proxy: true, unix: 'connected', outside: 'EPERM' }) },
    ],
    [
      'a direct connection not refused',
      { FIXTURE_EXEC_STDOUT: JSON.stringify({ proxy: true, unix: 'EPERM', outside: 'timeout' }) },
    ],
    ['no result', { FIXTURE_EXEC_STDOUT: 'garbage' }],
    ['the check failing', { FIXTURE_EXEC_ERROR: 'command/exec is not supported' }],
  ];
  for (const [i, [name, env]] of cases.entries()) {
    const log = join(paths.base, `n05-${i}.log`);
    const adapter = member({ ...paths, log }, env, {
      policy: () => ({ mode: 'auto', network: 'direct' }),
    });
    const events = await run(adapter, {
      workspace: paths.workspace,
      stateDir: paths.state,
      permissionProfile: 'workspace-write',
    });
    await adapter.close?.();
    assert.match(failure(events), /^CODEX_NETWORK_PROXY_UNAVAILABLE: /, name);
    assert.equal(requested(log, 'thread/start').length, 0, `${name}: no thread`);
    const exec = requested(log, 'command/exec')[0]!.params;
    assert.equal(exec.command[0], process.execPath, 'the check runs this Node');
  }
});

test('AC-0035-G01 command, file change and MCP tool approvals reach the host; others are declined', async (t) => {
  const paths = await home(t);
  const inside = join(paths.workspace, 'a.txt');
  const requests = [
    {
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'c1', command: 'ls' },
    },
    {
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'f1' },
      item: { type: 'fileChange', id: 'f1', changes: [{ path: inside, kind: { type: 'add' } }] },
    },
    {
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
        message: 'call?',
      },
    },
    {
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread', _meta: { codex_approval_kind: 'other' } },
    },
    { method: 'item/unknown/requestApproval', params: { threadId: 'thread', turnId: 'turn' } },
  ];
  const adapter = member(
    paths,
    { FIXTURE_REQUESTS: JSON.stringify(requests) },
    { policy: () => ({ mode: 'default' }) },
  );
  t.after(() => adapter.close?.());
  const asked: string[] = [];
  const events = await run(adapter, {
    workspace: paths.workspace,
    stateDir: paths.state,
    permissionProfile: 'workspace-write',
    async requestPermission(request) {
      asked.push(request.toolName);
      return true;
    },
  });
  const last = events.at(-1);
  assert.equal(last?.type, 'result', JSON.stringify(events));
  assert.deepEqual(asked.sort(), [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'mcpServer/elicitation/request',
  ]);
  assert.deepEqual(JSON.parse(last?.type === 'result' ? last.text : '[]'), [
    { decision: 'accept' },
    { decision: 'accept' },
    { action: 'accept', content: {} },
    { action: 'decline', content: {} },
    { decision: 'decline' },
  ]);
});

test('AC-0035-F01 acceptEdits takes file changes inside the write paths without asking', async (t) => {
  const paths = await home(t);
  const change = (id: string, path: string) => ({
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: id },
    item: { type: 'fileChange', id, changes: [{ path, kind: { type: 'add' } }] },
  });
  const requests = [
    change('in', join(paths.workspace, 'a.txt')),
    change('out', join(paths.base, 'outside.txt')),
    {
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'c1', command: 'ls' },
    },
  ];
  const adapter = member(
    paths,
    { FIXTURE_REQUESTS: JSON.stringify(requests) },
    { policy: () => ({ mode: 'acceptEdits' }) },
  );
  t.after(() => adapter.close?.());
  const asked: string[] = [];
  const events = await run(adapter, {
    workspace: paths.workspace,
    stateDir: paths.state,
    permissionProfile: 'workspace-write',
    async requestPermission(request) {
      asked.push(request.toolName);
      return false;
    },
  });
  const last = events.at(-1);
  assert.deepEqual(asked, ['item/commandExecution/requestApproval'], 'only the command asks');
  assert.deepEqual(JSON.parse(last?.type === 'result' ? last.text : '[]'), [
    { decision: 'accept' },
    { decision: 'decline' },
    { decision: 'decline' },
  ]);
});

test('AC-0035-H01 host MCP servers reach Codex with their approval mode', async (t) => {
  const paths = await home(t);
  const adapter = member(
    paths,
    {},
    {
      hostMcpServers: {
        tools: { url: 'http://127.0.0.1:9/mcp', token: 'secret-token' },
        local: { command: 'node', args: ['server.js'], approval: 'approve' },
      },
    },
  );
  t.after(() => adapter.close?.());
  await run(adapter, { workspace: paths.workspace, stateDir: paths.state });
  const servers = setting(
    entries(paths.log).find((entry) => entry.event === 'spawn')!.args,
    'mcp_servers=',
  )!;
  assert.ok(
    servers.includes(
      '"tools"={url="http://127.0.0.1:9/mcp",bearer_token_env_var="ORCHVIA_HOST_MCP_TOKEN_0",default_tools_approval_mode="prompt"}',
    ),
    servers,
  );
  assert.ok(
    servers.includes(
      '"local"={command="node",args=["server.js"],default_tools_approval_mode="approve"}',
    ),
    servers,
  );
});

test('AC-0035-C01 the connection API reads, signs in and out without an engine', async (t) => {
  const paths = await home(t);
  const connection = codexConnection({
    home: paths.home,
    command: process.execPath,
    args: [fixture('codex-local.ts')],
    env: { FIXTURE_LOG: paths.log, FIXTURE_LOGIN_COMPLETES: '1' },
    clientInfo: { name: 'host_app', title: 'Host', version: '1' },
  });
  t.after(() => connection.close());
  const probe = await connection.probe();
  assert.deepEqual(
    { version: probe.version, supported: probe.supported, codexHome: probe.codexHome },
    { version: '0.157.1', supported: true, codexHome: paths.home },
  );
  assert.deepEqual(requested(paths.log, 'initialize')[0]!.params.clientInfo, {
    name: 'host_app',
    title: 'Host',
    version: '1',
  });
  assert.deepEqual(await connection.account(), { account: null, requiresOpenaiAuth: true });
  await assert.rejects(connection.rateLimits(), { code: 'CODEX_REQUEST_FAILED' });
  assert.deepEqual(await connection.login({ type: 'apiKey', apiKey: 'sk-synthetic' }), {
    type: 'apiKey',
  });
  // The key went to Codex in its protocol, over stdin, not on a command line.
  assert.equal(requested(paths.log, 'account/login/start')[0]!.params.apiKey, 'sk-synthetic');
  assert.deepEqual(await connection.logout(), {});
  const browser = await connection.login({ type: 'chatgpt' });
  assert.equal(browser.loginId, 'login-1');
  assert.deepEqual(await connection.waitForLogin('login-1', { timeoutMs: 5000 }), {
    loginId: 'login-1',
    success: true,
  });
  assert.deepEqual(readdirSync(paths.home), [], 'nothing written to the home');
});

test('AC-0035-C01 a browser sign-in can be cancelled, and a missing binary is named', async (t) => {
  const paths = await home(t);
  const connection = codexConnection({
    home: paths.home,
    command: process.execPath,
    args: [fixture('codex-local.ts')],
    env: { FIXTURE_LOG: paths.log },
  });
  t.after(() => connection.close());
  const started = await connection.login({ type: 'chatgptDeviceCode' });
  assert.deepEqual(await connection.cancel(started.loginId as string), { status: 'canceled' });
  assert.deepEqual(
    await connection.waitForLogin('login-1').catch((error) => error.code),
    'NOT_FOUND',
  );
  const missing = codexConnection({ home: paths.home, command: join(paths.base, 'no-codex') });
  await assert.rejects(missing.probe(), { code: 'CODEX_NOT_FOUND' });
});

test('AC-0035-G02 the orchestration bridge needs no Codex approval', async (t) => {
  const { workspace, state } = await dirs(t);
  const { ORCHESTRATION_TOOLS } = await import('../../packages/engine/src/tools.ts');
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture('codex-policy.ts')],
  });
  t.after(() => adapter.close?.());
  const events = await run(adapter, {
    workspace,
    stateDir: state,
    orchestrationTools: { definitions: ORCHESTRATION_TOOLS, call: async () => ({}) },
  });
  const last = events.at(-1);
  const args: string[] = JSON.parse(last?.type === 'result' ? last.text : '{}').args;
  const servers = args.find((arg) => arg.startsWith('mcp_servers='))!;
  // Its grant is bound to the dispatch; Codex's `never` would otherwise refuse every call.
  assert.match(servers, /agent_orch=\{[^}]*default_tools_approval_mode="approve"/);
});
