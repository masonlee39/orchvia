/**
 * SPEC-0034: a command that the real Claude Code or Codex binary leaves running in the background
 * must not let its dispatch release the execution lease. Loopback-only scripted gateway; no
 * credentials or paid models. Usage: node scripts/native-stop-smoke.mjs claude|codex EVIDENCE.json [BINARY]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../packages/sdk-typescript/src/index.ts';
import { createClaudeAdapter, processGroupsStopped } from '../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../packages/adapter-codex/src/index.ts';

const [provider, outputPath, executable] = process.argv.slice(2);
if (!['claude', 'codex'].includes(provider) || !outputPath)
  throw new Error('Usage: node scripts/native-stop-smoke.mjs claude|codex EVIDENCE.json [BINARY]');
if (process.platform === 'win32') throw new Error('The stop smoke needs macOS or Linux');
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-stop-')));
const home = join(root, 'home');
await mkdir(home, { mode: 0o700 });
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
  ORCH_GATEWAY_KEY: 'synthetic-offline-key',
};
const evidence = {
  provider,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  cases: {},
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
const pids = (pattern) => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};
const until = async (check, ms) => {
  const end = performance.now() + ms;
  while (!(await check()) && performance.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 50));
};

// One scripted command per case: the first request runs it, the next one ends the turn.
let command = '';
let requests = 0;
let toolOutput = null;
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{"input_tokens":10}');
    }
    if (request.method !== 'POST') return response.writeHead(404).end();
    if (++requests > 40) throw new Error('Bounded gateway request count exhausted');
    const body = JSON.parse(raw);
    const history = JSON.stringify(body.messages ?? body.input ?? []);
    const done = history.includes('tool_result') || history.includes('function_call_output');
    const at = history.search(/tool_result|function_call_output/);
    if (done) toolOutput = history.slice(at, at + 600);
    if (request.url.startsWith('/v1/messages')) {
      const block = done
        ? { type: 'text', text: 'ORCH_STOP_OK' }
        : {
            type: 'tool_use',
            id: `toolu_${requests}`,
            name: 'Bash',
            input: { description: 'scripted', ...command },
          };
      const message = {
        id: `msg_${requests}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [block],
        stop_reason: done ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify(message));
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send(response, 'message_start', { message: { ...message, content: [], stop_reason: null } });
      send(response, 'content_block_start', {
        index: 0,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
      });
      send(response, 'content_block_delta', {
        index: 0,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: block.text }
            : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      send(response, 'content_block_stop', { index: 0 });
      send(response, 'message_delta', {
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      send(response, 'message_stop', {});
      return response.end();
    }
    if (!request.url.startsWith('/v1/responses')) return response.writeHead(404).end();
    const item = done
      ? {
          type: 'message',
          id: `item_${requests}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ORCH_STOP_OK', annotations: [] }],
        }
      : {
          type: 'function_call',
          id: `item_${requests}`,
          call_id: `call_${requests}`,
          status: 'completed',
          name: 'exec_command',
          arguments: JSON.stringify(command),
        };
    const result = {
      id: `resp_${requests}`,
      object: 'response',
      status: 'completed',
      output: [item],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
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
  } catch (error) {
    evidence.gatewayError = error.message;
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

/** Runs one task on a fresh engine; `inspect` sees it settled, before the engine closes. */
async function runCase(name, adapter, model, inspect, afterClose) {
  const workspace = join(root, name, 'workspace'),
    stateDir = join(root, name, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  requests = 0;
  toolOutput = null;
  const orch = await createOrchestrator({
    workspace,
    stateDir,
    adapters: [adapter],
    providers: {
      [adapter.provider]: {
        models: [model],
        ...(adapter.provider === 'claude' ? { permissionProfile: 'workspace-write' } : {}),
      },
    },
    storage: { emergencyBytes: 4096, minFreeBytes: 0 },
    timeouts: { acceptanceMs: 30000, turnMs: 60000 },
  });
  const record = (evidence.cases[name] = {});
  try {
    const task = await orch.tasks.create({
      goal: 'ORCH_NATIVE_STOP: run the scripted command',
      runtime: { provider: adapter.provider, model },
      acceptance: { mode: 'human', criteria: ['Scripted stop evidence'] },
    });
    let current;
    await until(async () => {
      current = await orch.tasks.get(task.id);
      return ['waiting_approval', 'blocked', 'failed', 'completed'].includes(current.status);
    }, 60000);
    const scheduler = await orch.scheduler.get();
    Object.assign(record, {
      status: current.status,
      reason: current.reason,
      executionOccupied: scheduler.executionOccupied,
      quarantined: scheduler.quarantined,
    });
    record.toolOutput = toolOutput;
    // The scripted command must have run: a refused one proves nothing.
    assert.doesNotMatch(toolOutput ?? '', /denied|tool_use_error|hook error/, name);
    await inspect(record, current);
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 10000 }).catch((error) => {
      record.closeError = String(error);
    });
    await adapter.close?.().catch(() => {});
  }
  await afterClose?.(record);
  return record;
}

try {
  if (provider === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    process.env.ANTHROPIC_BASE_URL = url;
    evidence.binary = 'SDK-owned Claude Code';
    const claude = (extra) =>
      createClaudeAdapter({
        permissionProfile: 'workspace-write',
        query: (request) => sdk.query(request),
        requestTimeoutMs: 30000,
        turnTimeoutMs: 60000,
        cleanupTimeoutMs: 5000,
        ...extra,
      });
    // 0034-B01: the marker holds the lease until its observer ended the background command. A
    // bare `&` is refused in the adapter's dontAsk mode, so the command starts one through sh.
    command = { command: "sh -c 'sleep 116 >/dev/null 2>&1 &'" };
    const marked = await runCase(
      'claude-marker-background',
      claude({ stopMarker: true }),
      'claude-sonnet-4-6',
      async (record, task) => {
        record.result = task.result;
        record.backgroundAlive = pids('sleep 116').length > 0;
      },
    );
    assert.equal(marked.status, 'waiting_approval', JSON.stringify(marked));
    assert.equal(marked.result, 'ORCH_STOP_OK');
    assert.equal(marked.executionOccupied, 0, 'the lease was released');
    assert.equal(marked.backgroundAlive, false, 'the background command was ended');
    // 0034-B03: Python's subprocess closes inherited descriptors, so what it starts drops the
    // marker. It stays in the workspace, so the lease is held; it is not ended.
    command = {
      command:
        "python3 -c \"import subprocess;subprocess.Popen(['sleep','112'],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\"",
    };
    const dropped = await runCase(
      'claude-marker-dropped',
      claude({ stopMarker: true }),
      'claude-sonnet-4-6',
      async (record) => {
        record.backgroundAlive = pids('sleep 112').length > 0;
      },
    );
    assert.equal(dropped.status, 'blocked', JSON.stringify(dropped));
    assert.ok(dropped.executionOccupied + dropped.quarantined > 0, 'the lease was not released');
    assert.equal(dropped.backgroundAlive, true, 'left running for the owner');
    // 0034-A02: why processGroupsStopped is no longer suggested; recorded, not asserted.
    command = { command: "sh -c 'sleep 115 >/dev/null 2>&1 &'" };
    let groupsAnswer;
    const groups = await runCase(
      'claude-marker-process-groups',
      claude({
        observeExecutionStop: (context) => (groupsAnswer = processGroupsStopped(context)),
      }),
      'claude-sonnet-4-6',
      async (record) => {
        record.processGroupsStopped = groupsAnswer;
        record.backgroundAlive = pids('sleep 115').length > 0;
      },
    );
    groups.missedBackground = groups.processGroupsStopped === true && groups.backgroundAlive;
  } else {
    const binary = executable ?? 'codex';
    evidence.binary = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const codex = () =>
      createCodexAdapter({
        command: binary,
        args: [
          'app-server',
          '-c',
          'model_provider="local_fixture"',
          '-c',
          `model_providers.local_fixture={name="Local scripted gateway",base_url="${url}/v1",wire_api="responses",env_key="ORCH_GATEWAY_KEY",request_max_retries=0,stream_max_retries=0}`,
        ],
        env: process.env,
        requestTimeoutMs: 30000,
        turnTimeoutMs: 60000,
        closeTimeoutMs: 3000,
        executionStop: 'owner-reconcile',
      });
    // 0034-C01: an exec_command that yields keeps running after turn/completed. The lease stays
    // held, and the dispatch ends the command with its app-server, whose descendant it still is
    // (A03).
    command = { cmd: 'sleep 114', yield_time_ms: 1000 };
    const yielded = await runCase('codex-yielded-command', codex(), 'gpt-5.4', async (record) => {
      // A killed command can take a moment to be reaped.
      await until(() => !pids('sleep 114').length, 2000);
      record.commandAlive = pids('sleep 114').length > 0;
    });
    assert.equal(yielded.status, 'blocked', JSON.stringify(yielded));
    assert.match(yielded.toolOutput ?? '', /Process running/, 'the command outlived its turn');
    assert.ok(yielded.executionOccupied + yielded.quarantined > 0, 'the lease was not released');
    assert.equal(yielded.commandAlive, false, 'the dispatch ended the command');
    // A command whose shell already exited leaves the app-server's tree, so it outlives the
    // dispatch; the lease still holds. Recorded, not asserted: a known limit until SPEC-0035.
    command = { cmd: 'sleep 113 >/dev/null 2>&1 &', yield_time_ms: 1000 };
    const detached = await runCase(
      'codex-detached-command',
      codex(),
      'gpt-5.4',
      async (record) => {
        record.commandAlive = pids('sleep 113').length > 0;
      },
      async (record) => {
        record.commandAliveAfterClose = pids('sleep 113').length > 0;
      },
    );
    assert.equal(detached.status, 'blocked', JSON.stringify(detached));
    assert.ok(detached.executionOccupied + detached.quarantined > 0, 'the lease was not released');
  }
  evidence.passed = true;
} finally {
  for (const pattern of ['sleep 116', 'sleep 115', 'sleep 114', 'sleep 113', 'sleep 112'])
    for (const pid of pids(pattern)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  server.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
