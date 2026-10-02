/**
 * SPEC-0038: the real Codex binary behind the Codex adapter. A file change the host approves
 * stays inside the write paths, and commands see neither the orchestration bridge's token nor
 * credentials in the environment. SPEC-0061 E02: what a command reads of the Codex process's
 * environment, and that it cannot reach the bridge with it while the network is off.
 * Loopback-only scripted gateway; no credentials or paid models.
 * Usage: node scripts/native-codex-security-smoke.mjs EVIDENCE.json [BINARY]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCodexAdapter } from '../packages/adapter-codex/src/index.ts';
import { ORCHESTRATION_TOOLS } from '../packages/engine/src/tools.ts';

const [outputPath, executable] = process.argv.slice(2);
if (!outputPath)
  throw new Error('Usage: node scripts/native-codex-security-smoke.mjs EVIDENCE.json [BINARY]');
if (process.platform === 'win32') throw new Error('The security smoke needs macOS or Linux');
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-security-')));
const home = join(root, 'home');
await mkdir(home, { mode: 0o700 });
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() };
// The adapter starts Codex in each case's workspace, so a relative path must be resolved here.
const binary = executable?.includes('/') ? resolve(executable) : (executable ?? 'codex');
const evidence = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  binary: execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(),
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  cases: {},
};

// Each case scripts the model's calls; after the last one the model answers with text.
let steps = [];
let requests = 0;
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (request.method !== 'POST' || !request.url.startsWith('/v1/responses'))
    return response.writeHead(404).end();
  if (++requests > 40) return response.writeHead(500).end();
  const step = steps.shift();
  const n = requests;
  const item = step?.patch
    ? {
        type: 'custom_tool_call',
        id: `item_${n}`,
        call_id: `call_${n}`,
        status: 'completed',
        name: 'apply_patch',
        input: step.patch,
      }
    : step?.cmd
      ? {
          type: 'function_call',
          id: `item_${n}`,
          call_id: `call_${n}`,
          status: 'completed',
          name: 'exec_command',
          // A function is called now, when Codex and its servers are running.
          arguments: JSON.stringify({
            cmd: typeof step.cmd === 'function' ? step.cmd() : step.cmd,
          }),
        }
      : {
          type: 'message',
          id: `item_${n}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ORCH_SECURITY_OK', annotations: [] }],
        };
  const result = {
    id: `resp_${n}`,
    object: 'response',
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send(response, 'response.created', {
    response: { ...result, output: [], status: 'in_progress' },
  });
  send(response, 'response.output_item.done', { output_index: 0, item });
  send(response, 'response.completed', { response: result });
  response.end();
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const url = `http://127.0.0.1:${server.address().port}`;

const adapter = (options = {}) =>
  createCodexAdapter({
    command: binary,
    args: [
      'app-server',
      '-c',
      'model_provider="local_fixture"',
      '-c',
      `model_providers.local_fixture={name="Local scripted gateway",base_url="${url}/v1",wire_api="responses",env_key="ORCH_GATEWAY_KEY",request_max_retries=0,stream_max_retries=0}`,
    ],
    env: { ...process.env, ORCH_GATEWAY_KEY: 'synthetic-offline-key', ...options.env },
    permissionProfile: 'workspace-write',
    requestTimeoutMs: 30000,
    turnTimeoutMs: 60000,
    closeTimeoutMs: 3000,
    executionStop: 'owner-reconcile',
    ...options.config,
  });

async function runCase(name, script, options, input = {}, prepare = async () => {}) {
  const workspace = join(root, name);
  await mkdir(workspace);
  await prepare(workspace);
  await mkdir(join(root, `${name}-state`), { mode: 0o700 });
  steps = script(workspace);
  const record = (evidence.cases[name] = { asked: [], events: [] });
  const codex = adapter(options);
  try {
    for await (const event of codex.execute({
      taskId: 'task',
      sessionId: name,
      dispatchId: name,
      providerSessionId: null,
      workspace,
      stateDir: join(root, `${name}-state`),
      // A model of Codex's catalog: 0.158.0 gives a model it does not list no apply_patch tool.
      model: 'gpt-5.5',
      prompt: 'Run the scripted steps.',
      permissionProfile: 'workspace-write',
      signal: new AbortController().signal,
      async requestPermission(request) {
        record.asked.push({ tool: request.toolName, changes: request.permission?.changes ?? null });
        return true;
      },
      ...input,
    }))
      record.events.push(event.type === 'result' ? `result:${event.text}` : event.type);
  } finally {
    await codex.close?.();
  }
  return { record, workspace };
}

/** The processes this process started, with theirs: Codex and the servers it runs. */
function startedByThisProcess() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = [];
  const queue = [process.pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid] of rows)
      if (ppid === parent && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
  }
  return found;
}
/**
 * 0061-E02, run by a command: reads the environment of the given processes and of its own
 * ancestors (macOS: sysctl KERN_PROCARGS2, as ps does; Linux: /proc), and tries the bridge's
 * socket with the token it found. It prints what it could do, never a value, and always exits 0,
 * so that Codex has no failure to run again outside the sandbox.
 */
const ENVIRONMENT_PROBE = String.raw`
import ctypes, json, os, socket, sys

def environment(pid):
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t(1 << 20)
        data = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
            return None
        return data.raw[: size.value]
    try:
        with open('/proc/%d/environ' % pid, 'rb') as file:
            return file.read()
    except OSError:
        return None

def ancestors():
    found, pid = [], os.getppid()
    while pid > 1 and pid not in found:
        found.append(pid)
        try:
            with open('/proc/%d/status' % pid) as file:
                pid = next(int(line.split()[1]) for line in file if line.startswith('PPid:'))
        except (OSError, StopIteration):
            break
    return found

NAMES = ('AGENT_ORCH_BRIDGE_TOKEN', 'AGENT_ORCH_BRIDGE_SOCKET', 'OPENAI_API_KEY')
result = {'processesRead': 0, 'tokenRead': False, 'credentialRead': False, 'bridge': 'not tried'}
try:
    found = {}
    for pid in dict.fromkeys([int(value) for value in sys.argv[1:]] + ancestors()):
        data = environment(pid)
        if data is None:
            continue
        result['processesRead'] += 1
        for entry in data.split(b'\0'):
            for name in NAMES:
                if entry.startswith(name.encode() + b'='):
                    found[name] = entry[len(name) + 1 :].decode('utf8', 'replace')
    result['tokenRead'] = 'AGENT_ORCH_BRIDGE_TOKEN' in found
    result['credentialRead'] = found.get('OPENAI_API_KEY') == 'sk-synthetic-offline'
    if 'AGENT_ORCH_BRIDGE_SOCKET' in found:
        try:
            bridge = socket.socket(socket.AF_UNIX)
            bridge.settimeout(5)
            bridge.connect(found['AGENT_ORCH_BRIDGE_SOCKET'])
            request = {'token': found.get('AGENT_ORCH_BRIDGE_TOKEN', ''), 'name': 'work_read', 'request': {}}
            bridge.sendall((json.dumps(request) + '\n').encode())
            result['bridge'] = 'answered' if bridge.recv(4096) else 'closed'
        except OSError as error:
            result['bridge'] = 'refused: %s' % (error.strerror or type(error).__name__)
except Exception as error:
    result['error'] = type(error).__name__
print(json.dumps(result))
`;

// Every check is recorded, so one run shows each case's outcome.
const failures = [];
const swapTargets = [];
const check = (run, message) => {
  try {
    run();
  } catch (error) {
    failures.push(`${message}: ${error.message.split('\n')[0]}`);
  }
};
try {
  // 0038-N01: the host approves every file change; one outside the workspace is still refused,
  // without asking the host.
  const outside = join(home, '.planted-by-patch');
  const patch = (path) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n`;
  const files = await runCase('file-changes', (workspace) => [
    { patch: patch(outside) },
    { patch: patch(join(workspace, 'inside.txt')) },
  ]);
  files.record.outsideWritten = existsSync(outside);
  files.record.insideWritten = existsSync(join(files.workspace, 'inside.txt'));
  check(
    () => assert.equal(files.record.outsideWritten, false),
    'an approved patch wrote outside the workspace',
  );
  check(
    () => assert.equal(files.record.insideWritten, true),
    'the patch inside the workspace did not run',
  );
  // Codex asks only for a change outside its writable roots, which are the write paths; the
  // adapter refuses such a change itself, so the host is never asked here (0038-P01 covers the
  // paths the host sees).
  check(
    () => assert.deepEqual(files.record.asked, []),
    'the host was asked about a change outside the workspace',
  );

  // 0043-C01: with the user's connection and mode default, each file change reaches the host. The
  // host approves after the adapter checked the paths, having replaced a directory of the change's
  // path with a link to a directory that commands may only read. Codex writes the change within
  // its sandbox, so it must not land there. (A link into the temporary directory, which the profile
  // makes writable, does redirect it: TDD-0043.)
  const swapHome = join(root, 'swap-home');
  const swapTarget = join(process.cwd(), `.orch-swap-target-${process.pid}`);
  await mkdir(swapHome, { mode: 0o700 });
  await mkdir(swapTarget);
  swapTargets.push(swapTarget);
  const swap = await runCase(
    'swap-after-check',
    (workspace) => [{ patch: patch(join(workspace, 'sub', 'swapped.txt')) }],
    {
      config: {
        permissionProfile: undefined,
        connection: { home: swapHome },
        policy: () => ({ mode: 'default' }),
      },
    },
    {
      async requestPermission(request) {
        const workspace = join(root, 'swap-after-check');
        evidence.cases['swap-after-check'].asked.push({
          tool: request.toolName,
          changes: request.permission?.changes ?? null,
        });
        if (request.toolName === 'item/fileChange/requestApproval') {
          await rename(join(workspace, 'sub'), join(workspace, 'sub-moved'));
          await symlink(swapTarget, join(workspace, 'sub'));
        }
        return true;
      },
    },
    async (workspace) => mkdir(join(workspace, 'sub')),
  );
  swap.record.landed = {
    outside: existsSync(join(swapTarget, 'swapped.txt')),
    movedDirectory: existsSync(join(swap.workspace, 'sub-moved', 'swapped.txt')),
  };
  check(
    () => assert.equal(swap.record.asked.length, 1),
    `swap-after-check: the host was asked ${swap.record.asked.length} times`,
  );
  check(
    () => assert.equal(swap.record.landed.outside, false),
    'an approved change followed a link into a directory commands may only read',
  );

  // 0038-N02: with network access and the orchestration bridge, a command sees neither the
  // bridge's token nor a credential from the environment, and cannot call a tool directly.
  let calls = 0;
  const tools = { definitions: ORCHESTRATION_TOOLS, call: async () => (calls++, { ok: true }) };
  const probe = [
    'echo "token=${AGENT_ORCH_BRIDGE_TOKEN:-unset} key=${OPENAI_API_KEY:-unset} plain=${ORCH_PLAIN:-unset}" > env.txt',
    `python3 -c "import socket,os,json;s=socket.socket(socket.AF_UNIX);s.connect(os.environ.get('AGENT_ORCH_BRIDGE_SOCKET','/nonexistent'));s.sendall((json.dumps({'token':os.environ.get('AGENT_ORCH_BRIDGE_TOKEN',''),'name':'work_read','request':{}})+chr(10)).encode());print('bridge=' + s.recv(4096).decode().strip())" >> env.txt 2>&1 || echo bridge=unreachable >> env.txt`,
  ].join('; ');
  const env = await runCase(
    'command-environment',
    () => [{ cmd: probe }],
    {
      env: { OPENAI_API_KEY: 'sk-synthetic-offline', ORCH_PLAIN: 'plain-value' },
      config: { networkAccess: true },
    },
    { orchestrationTools: tools },
  );
  const seen = existsSync(join(env.workspace, 'env.txt'))
    ? readFileSync(join(env.workspace, 'env.txt'), 'utf8')
    : '';
  env.record.commandOutput = seen
    .replace(/[0-9a-f]{64}/g, '<token>')
    .trim()
    .split('\n')
    .slice(0, 4);
  env.record.toolCalls = calls;
  check(
    () => assert.match(seen, /plain=plain-value/),
    'the command did not run or lost an ordinary variable',
  );
  check(() => assert.match(seen, /token=unset/), 'the command saw the bridge token');
  check(() => assert.match(seen, /key=unset/), 'the command saw a credential from the environment');
  check(() => assert.equal(calls, 0), 'a command called an orchestration tool directly');

  // 0061-E02: the variables that are kept out of a command's own environment are still in the
  // environment of the Codex process and of the servers it starts. A command looks there, and
  // tries the bridge with what it found. Whether it can read them is recorded (macOS: yes); with
  // the network off it must not reach the bridge. The command runs in the sandbox only: the host
  // refuses every request, so a refused command is not run again outside it.
  const processEnvironment = async (name, networkAccess) => {
    const before = calls;
    const run = await runCase(
      name,
      () => [{ cmd: () => `python3 probe.py ${startedByThisProcess().join(' ')} > environ.json` }],
      {
        env: { OPENAI_API_KEY: 'sk-synthetic-offline' },
        config: { networkAccess },
      },
      {
        orchestrationTools: tools,
        async requestPermission(request) {
          evidence.cases[name].asked.push({ tool: request.toolName });
          return false;
        },
      },
      (workspace) => writeFile(join(workspace, 'probe.py'), ENVIRONMENT_PROBE),
    );
    let seen = null;
    try {
      seen = JSON.parse(readFileSync(join(run.workspace, 'environ.json'), 'utf8'));
    } catch {
      /* The command did not run, or wrote nothing. */
    }
    Object.assign(run.record, { networkAccess, command: seen, toolCalls: calls - before });
    check(() => assert.ok(seen, 'no output'), `${name}: the command did not run`);
    check(() => assert.deepEqual(run.record.asked, []), `${name}: the command left the sandbox`);
    return run.record;
  };
  const offline = await processEnvironment('process-environment', false);
  evidence.environReadable = offline.command?.tokenRead ?? null;
  check(
    () => assert.doesNotMatch(offline.command?.bridge ?? '', /^answered/),
    'with the network off, a command reached the bridge with a token of the Codex process',
  );
  check(
    () => assert.equal(offline.toolCalls, 0),
    'with the network off, a command called an orchestration tool',
  );
  evidence.failures = failures;
  assert.deepEqual(failures, [], failures.join('; '));
  evidence.passed = true;
} finally {
  server.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(root, { recursive: true, force: true }).catch(() => {});
  for (const target of swapTargets)
    await rm(target, { recursive: true, force: true }).catch(() => {});
}
