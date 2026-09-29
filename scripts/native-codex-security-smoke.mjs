/**
 * SPEC-0038: the real Codex binary behind the Codex adapter. A file change the host approves
 * stays inside the write paths, and commands see neither the orchestration bridge's token nor
 * credentials in the environment. Loopback-only scripted gateway; no credentials or paid models.
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
          arguments: JSON.stringify({ cmd: step.cmd }),
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
