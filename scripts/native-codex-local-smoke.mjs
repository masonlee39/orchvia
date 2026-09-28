/**
 * SPEC-0035: the real Codex binary as a local member, on a connection home, behind a loopback
 * scripted gateway, with synthetic credentials and no paid models. Internet checks (N01) run only
 * with ORCH_INTERNET=1. Usage: node scripts/native-codex-local-smoke.mjs EVIDENCE.json [BINARY]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexConnection, createCodexAdapter } from '../packages/adapter-codex/src/index.ts';

const [outputPath, executable] = process.argv.slice(2);
if (!outputPath)
  throw new Error('Usage: node scripts/native-codex-local-smoke.mjs EVIDENCE.json [BINARY]');
if (process.platform === 'win32') throw new Error('The local Codex smoke needs macOS or Linux');
const internet = process.env.ORCH_INTERNET === '1';
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-local-')));
const userHome = join(root, 'user');
await mkdir(userHome, { mode: 0o700 });
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = { PATH: process.env.PATH, HOME: userHome, TMPDIR: tmpdir() };
const binary = executable?.includes('/') ? resolve(executable) : (executable ?? 'codex');
const evidence = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  binary: execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(),
  internet,
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  cases: {},
};
const failures = [];
const check = (run, message) => {
  try {
    run();
  } catch (error) {
    failures.push(`${message}: ${error.message.split('\n')[0]}`);
  }
};

// Each case scripts the model's calls; after the last one the model answers with text.
let steps = [];
let requests = 0;
// What the model saw from its last tool call: the next request carries it.
let toolOutputs = [];
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const gateway = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (request.method !== 'POST' || !request.url.startsWith('/v1/responses'))
    return response.writeHead(404).end();
  if (++requests > 200) return response.writeHead(500).end();
  const body = JSON.parse(raw);
  for (const entry of body.input ?? [])
    if (/_call_output$/.test(entry.type ?? ''))
      toolOutputs.push(
        typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output),
      );
  const step = steps.shift();
  const n = requests;
  let item;
  if (step?.patch)
    item = {
      type: 'custom_tool_call',
      id: `item_${n}`,
      call_id: `call_${n}`,
      status: 'completed',
      name: 'apply_patch',
      input: step.patch,
    };
  else if (step?.cmd)
    item = {
      type: 'function_call',
      id: `item_${n}`,
      call_id: `call_${n}`,
      status: 'completed',
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: step.cmd,
        ...(step.yield ? { yield_time_ms: step.yield } : {}),
      }),
    };
  else if (step?.search)
    item = {
      type: 'tool_search_call',
      id: `item_${n}`,
      call_id: `call_${n}`,
      status: 'completed',
      execution: 'client',
      arguments: { query: step.search, limit: 5 },
    };
  else if (step?.call) {
    const found = (body.input ?? [])
      .filter((entry) => entry.type === 'tool_search_output')
      .flatMap((entry) => entry.tools ?? []);
    const flat = found.flatMap((tool) =>
      tool.type === 'namespace'
        ? (tool.tools ?? []).map((inner) => ({ ns: tool.name, name: inner.name }))
        : [{ name: tool.name }],
    );
    const tool = flat.find((candidate) => candidate.name === step.call) ?? { name: step.call };
    item = {
      type: 'function_call',
      id: `item_${n}`,
      call_id: `call_${n}`,
      status: 'completed',
      name: tool.name,
      ...(tool.ns ? { namespace: tool.ns } : {}),
      arguments: JSON.stringify({ text: 'hello' }),
    };
  } else
    item = {
      type: 'message',
      id: `item_${n}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ORCH_LOCAL_OK', annotations: [] }],
    };
  const usage = step?.usage ?? {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 },
  };
  const result = {
    id: `resp_${n}`,
    object: 'response',
    status: 'completed',
    output: [item],
    usage,
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send(response, 'response.created', {
    response: { ...result, output: [], status: 'in_progress' },
  });
  send(response, 'response.output_item.done', { output_index: 0, item });
  send(response, 'response.completed', { response: result });
  response.end();
});
await new Promise((ready) => gateway.listen(0, '127.0.0.1', ready));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const providerArgs = [
  'app-server',
  '-c',
  'model_provider="local_fixture"',
  '-c',
  `model_providers.local_fixture={name="Local scripted gateway",base_url="${gatewayUrl}/v1",wire_api="responses",env_key="ORCH_GATEWAY_KEY",request_max_retries=0,stream_max_retries=0}`,
];

/** A member on `home`; every dispatch of a case gets a workspace and a state directory. */
function member(home, options = {}) {
  return createCodexAdapter({
    command: binary,
    args: options.args ?? providerArgs,
    env: { ...process.env, ORCH_GATEWAY_KEY: 'synthetic-offline-key', ...options.env },
    connection: { home },
    requestTimeoutMs: 60000,
    turnTimeoutMs: 120000,
    closeTimeoutMs: 3000,
    executionStop: 'owner-reconcile',
    ...options.config,
  });
}
async function dispatch(name, adapter, script, input = {}) {
  const workspace = join(root, name);
  const stateDir = join(root, `${name}-state`);
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  steps = script(workspace);
  toolOutputs = [];
  const record = (evidence.cases[name] = { asked: [], events: [] });
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: name,
      dispatchId: name,
      providerSessionId: null,
      workspace,
      stateDir,
      model: 'gpt-5.4',
      prompt: 'Run the scripted steps.',
      permissionProfile: 'workspace-write',
      signal: new AbortController().signal,
      async requestPermission(request) {
        record.asked.push(request.toolName);
        return input.allow ?? true;
      },
      ...input,
    })) {
      record.events.push(
        event.type === 'result'
          ? 'result'
          : event.type === 'error'
            ? `error:${event.message}`
            : event.type,
      );
      if (event.type === 'usage') (record.usage ??= []).push(event.usage.inputTokens);
    }
  } finally {
    await adapter.close?.();
  }
  record.toolOutputs = [...new Set(toolOutputs)].map((output) => output.slice(0, 600));
  return { record, workspace, stateDir, seen: record.toolOutputs.join(' ') };
}

try {
  const home = join(root, 'codex-home');
  await mkdir(home, { mode: 0o700 });
  const CANARY = 'synthetic-credential-canary-5c1e';
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: CANARY }));
  chmodSync(join(home, 'auth.json'), 0o600);
  // Outside the workspace and outside the temporary directory, which the writable profile opens.
  const outside = join(process.cwd(), `.orch-local-outside-${process.pid}`);
  await mkdir(outside);

  // AC-0035-B01, B04: what a command of each profile can read and write.
  for (const [mode, permissionProfile] of [
    ['plan', 'read-only'],
    ['auto', 'workspace-write'],
  ]) {
    const name = `fence-${mode}`;
    const secret = join(root, name, 'secret');
    const probe = (workspace) =>
      [
        `cat '${join(home, 'auth.json')}' > /dev/null 2>&1 && echo home=read || echo home=denied`,
        `cat '${join(secret, 'key.txt')}' > /dev/null 2>&1 && echo deny=read || echo deny=denied`,
        `(echo x > '${join(workspace, 'w.txt')}') 2>/dev/null && echo ws=written || echo ws=denied`,
        `(echo x > "$TMPDIR/orch-local-$$") 2>/dev/null && echo tmp=written || echo tmp=denied`,
        `(echo x > '${join(outside, `${mode}.txt`)}') 2>/dev/null && echo outside=written || echo outside=denied`,
        'echo ssh=${SSH_AUTH_SOCK:-unset} key=${ORCH_GATEWAY_KEY:-unset}',
      ].join('; ');
    await mkdir(secret, { recursive: true });
    writeFileSync(join(secret, 'key.txt'), 'x');
    const adapter = member(home, {
      env: { SSH_AUTH_SOCK: join(root, 'agent.sock') },
      config: { denyRead: ['secret'], policy: () => ({ mode }) },
    });
    const { record, seen: out } = await dispatch(
      name,
      adapter,
      (workspace) => [{ cmd: probe(workspace) }],
      {
        permissionProfile,
      },
    );
    check(() => assert.equal(record.events.at(-1), 'result'), `${name} ended`);
    check(() => assert.match(out, /home=denied/), `${name}: a command read the connection home`);
    check(() => assert.match(out, /deny=denied/), `${name}: a command read a denyRead path`);
    check(
      () => assert.match(out, /outside=denied/),
      `${name}: a command wrote outside the workspace`,
    );
    check(
      () => assert.match(out, /ssh=unset key=unset/),
      `${name}: a command saw an agent socket or a key`,
    );
    if (mode === 'auto') {
      check(() => assert.match(out, /ws=written/), 'auto: the workspace is writable');
      check(() => assert.match(out, /tmp=written/), 'auto: the temporary directory is writable');
    } else check(() => assert.match(out, /ws=denied/), 'plan: the workspace is read-only');
  }

  // AC-0035-F01: which requests reach the host in each writable mode.
  const patch = (workspace, file) =>
    `*** Begin Patch\n*** Add File: ${join(workspace, file)}\n+x\n*** End Patch\n`;
  for (const mode of ['default', 'acceptEdits', 'auto']) {
    const name = `mode-${mode}`;
    const adapter = member(home, { config: { policy: () => ({ mode }) } });
    const { record, workspace } = await dispatch(name, adapter, (workspace) => [
      { cmd: `echo ran > '${join(workspace, 'cmd.txt')}'` },
      { patch: patch(workspace, 'edit.txt') },
    ]);
    record.commandRan = existsSync(join(workspace, 'cmd.txt'));
    record.edited = existsSync(join(workspace, 'edit.txt'));
    const expected = {
      default: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'],
      acceptEdits: ['item/commandExecution/requestApproval'],
      auto: [],
    }[mode];
    check(
      () => assert.deepEqual(record.asked, expected),
      `${mode}: the host was asked ${JSON.stringify(record.asked)}`,
    );
    check(
      () => assert.equal(record.commandRan && record.edited, true),
      `${mode}: the approved command and edit ran`,
    );
  }

  // AC-0035-N02, N03, N04: direct network through the proxy.
  const agentSock = join(await mkdtemp('/tmp/orch-agent-'), 'a.sock');
  const agent = spawnSync('ssh-agent', ['-a', agentSock], { encoding: 'utf8' });
  const agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent.stdout ?? '')?.[1]);
  const dockerSock = join(await mkdtemp('/tmp/orch-docker-'), 'docker.sock');
  const docker = createNetServer((socket) => socket.end('HTTP/1.1 200 OK\r\n\r\n'));
  await new Promise((ready) => docker.listen(dockerSock, ready));
  const TOKEN = 'synthetic-host-tool-token-91ad';
  let toolCalls = 0;
  const tools = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return response.writeHead(401).end();
    // Codex's own MCP handshake carries the token; only a tool call counts.
    if (/"tools\/call"/.test(body)) toolCalls++;
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise((ready) => tools.listen(0, '127.0.0.1', ready));
  const toolsUrl = `http://127.0.0.1:${tools.address().port}/mcp`;
  const netProbe = [
    `SSH_AUTH_SOCK='${agentSock}' ssh-add -l > /dev/null 2>&1; echo agent=$?`,
    `echo docker=$(curl -s -m 3 --unix-socket '${dockerSock}' -o /dev/null -w '%{http_code}' http://localhost/version)`,
    `echo tool=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST -d '{}' ${toolsUrl})`,
    `echo environ=$(cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${TOKEN}')`,
  ];
  // One command each, with time to finish: after 10 s Codex hands back what a command has
  // printed so far and lets it run on.
  const internetProbes = internet
    ? [
        'mkdir -p tmp; export TMPDIR="$PWD/tmp"; npm_config_cache="$PWD/.npm" npm install is-number --no-audit --no-fund --no-save --prefix ./npm > /dev/null 2>&1; echo npm=$?',
        'mkdir -p tmp; export TMPDIR="$PWD/tmp"; git clone --depth 1 -q https://github.com/octocat/Hello-World.git hello > /dev/null 2>&1; echo git=$?',
        "echo https=$(curl -s -m 20 -o /dev/null -w '%{http_code}' https://example.com)",
        "echo direct=$(curl --noproxy '*' -s -m 8 -o /dev/null -w '%{http_code}' https://example.com)",
      ].map((cmd) => ({ cmd, yield: 30000 }))
    : [];
  {
    const name = 'network-direct';
    const adapter = member(home, {
      config: {
        policy: () => ({ mode: 'auto', network: 'direct' }),
        hostMcpServers: { host_tools: { url: toolsUrl, token: TOKEN } },
      },
    });
    const { record, seen: out } = await dispatch(name, adapter, () => [
      { cmd: netProbe.join('; '), yield: 15000 },
      ...internetProbes,
    ]);
    record.toolCalls = toolCalls;
    record.localPort = /tool=401/.test(out)
      ? 'reached, 401'
      : /tool=000/.test(out)
        ? 'unreachable'
        : 'other';
    check(
      () => assert.equal(record.events.at(-1), 'result'),
      `${name} ended: ${record.events.at(-1)}`,
    );
    if (agentPid)
      check(() => assert.match(out, /agent=2\b/), `${name}: a command reached the ssh-agent`);
    check(() => assert.match(out, /docker=000/), `${name}: a command reached the Docker socket`);
    check(
      // macOS reaches the port and is refused without the token; Linux's sandbox reaches no local
      // port at all under the proxy. Either way no tool runs, which toolCalls checks.
      () => assert.match(out, /tool=(401|000)\b/),
      `${name}: the host tool port answered otherwise than 401`,
    );
    check(() => assert.equal(toolCalls, 0), `${name}: a command called a host tool`);
    check(() => assert.match(out, /environ=0/), `${name}: a command read the token from /proc`);
    if (internet) {
      check(() => assert.match(out, /npm=0/), `${name}: npm install`);
      check(() => assert.match(out, /git=0/), `${name}: git clone over https`);
      check(() => assert.match(out, /https=200/), `${name}: an https request`);
      check(
        () => assert.match(out, /direct=000/),
        `${name}: a direct connection outside the proxy`,
      );
    }
  }
  if (agentPid) process.kill(agentPid);
  docker.close();
  tools.close();

  // AC-0035-N06: a Codex whose proxy does not come up is refused, never run with plain network.
  {
    const name = 'network-no-proxy';
    const wrapper = join(root, 'codex-without-proxy');
    writeFileSync(wrapper, `#!/bin/sh\nexec '${binary}' "$@" -c features.network_proxy=false\n`, {
      mode: 0o755,
    });
    const adapter = createCodexAdapter({
      command: wrapper,
      args: providerArgs,
      env: { ...process.env, ORCH_GATEWAY_KEY: 'synthetic-offline-key' },
      connection: { home },
      executionStop: 'owner-reconcile',
      policy: () => ({ mode: 'auto', network: 'direct' }),
    });
    const before = requests;
    const { record } = await dispatch(name, adapter, () => [{ text: 'never' }]);
    check(
      () => assert.match(record.events.at(-1) ?? '', /^error:CODEX_NETWORK_PROXY_UNAVAILABLE: /),
      `${name}: ${record.events.at(-1)}`,
    );
    check(() => assert.equal(requests, before), `${name}: a model request was made`);
  }

  // AC-0035-G01, H01: a host MCP tool call asks the host through an elicitation.
  {
    const name = 'host-mcp';
    const server = join(root, 'mcp-echo.mjs');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'host', version: '0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'host_echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params?.arguments?.text }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`,
    );
    const adapter = member(home, {
      config: {
        policy: () => ({ mode: 'auto' }),
        hostMcpServers: { host: { command: process.execPath, args: [server] } },
      },
    });
    const { record } = await dispatch(
      name,
      adapter,
      () => [{ search: 'host_echo' }, { call: 'host_echo' }],
      { model: 'gpt-6-astra' },
    );
    check(
      () => assert.ok(record.asked.includes('mcpServer/elicitation/request')),
      `${name}: the host was asked ${JSON.stringify(record.asked)}`,
    );
  }

  // AC-0035-C01: the connection API on a scratch home, with a synthetic API key.
  {
    const scratchHome = join(root, 'connection-home');
    await mkdir(scratchHome, { mode: 0o700 });
    const connection = codexConnection({
      home: scratchHome,
      command: binary,
      args: ['app-server', '-c', 'cli_auth_credentials_store="file"'],
      env: process.env,
      clientInfo: { name: 'orch_smoke', title: 'Smoke', version: '0' },
    });
    const record = (evidence.cases.connection = {});
    const probe = await connection.probe();
    record.probe = {
      version: probe.version,
      supported: probe.supported,
      userAgent: probe.userAgent,
    };
    check(() => assert.equal(probe.supported, true), 'connection: probe supported');
    check(
      () => assert.match(probe.userAgent ?? '', /^orch_smoke\//),
      'connection: clientInfo in userAgent',
    );
    record.before = await connection.account();
    await connection.login({ type: 'apiKey', apiKey: 'sk-synthetic-not-a-key' });
    record.signedIn = existsSync(join(scratchHome, 'auth.json'));
    await connection.logout();
    record.signedOut = !existsSync(join(scratchHome, 'auth.json'));
    check(
      () => assert.equal(record.signedIn && record.signedOut, true),
      'connection: API key sign-in and out',
    );
    const browser = await connection.login({ type: 'chatgpt' });
    record.browser = { loginId: !!browser.loginId, authUrl: typeof browser.authUrl === 'string' };
    record.cancel = await connection.cancel(browser.loginId);
    check(
      () => assert.equal(record.cancel.status, 'canceled'),
      'connection: a browser sign-in cancelled',
    );
    await connection.close();
  }

  // AC-0035-A02: two members on one home at once.
  {
    const adapters = [member(home), member(home)];
    const results = await Promise.all(
      adapters.map((adapter, i) =>
        dispatch(`together-${i}`, adapter, () => [], { permissionProfile: 'read-only' }),
      ),
    );
    evidence.cases.together = results.map(({ record }) => record.events.at(-1));
    check(
      () => assert.deepEqual(evidence.cases.together, ['result', 'result']),
      'two members on one home',
    );
  }

  evidence.failures = failures;
  // In a CI log, what each failing case's commands printed.
  if (failures.length)
    for (const [name, record] of Object.entries(evidence.cases))
      if (record?.toolOutputs?.length)
        console.error(
          `${name}: ${record.toolOutputs.join(' | ').replace(/\s+/g, ' ').slice(0, 1500)}`,
        );
  assert.deepEqual(failures, [], failures.join('; '));
  evidence.passed = true;
} finally {
  gateway.close();
  await rm(join(process.cwd(), `.orch-local-outside-${process.pid}`), {
    recursive: true,
    force: true,
  });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
