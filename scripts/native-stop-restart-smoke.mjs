/**
 * SPEC-0036 C01: with the real Claude binary and a loopback scripted gateway (no credentials, no
 * paid models), a host whose Claude Code left `nohup sleep 600 &` running is killed, and the next
 * host's sweep ends the command; the synchronous cleanup ends one within 300 ms.
 * Usage: node scripts/native-stop-restart-smoke.mjs EVIDENCE.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeAdapter,
  staleStopMarkers,
  sweepStopMarkers,
} from '../packages/adapter-claude/src/index.ts';

const COMMAND = 'nohup sleep 600 &';
const allow = async (_tool, input) => ({ behavior: 'allow', updatedInput: input });
const pids = () => {
  try {
    return execFileSync('pgrep', ['-f', '^sleep 600$'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};
const adapterFor = async (directory, extra = {}) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return createClaudeAdapter({
    permissionProfile: 'workspace-write',
    stopMarker: { directory, ...extra },
    options: { canUseTool: allow },
    query: (request) => sdk.query(request),
    requestTimeoutMs: 30000,
    turnTimeoutMs: 60000,
    cleanupTimeoutMs: 5000,
  });
};
const input = (workspace, stateDir, dispatchId) => ({
  taskId: `task-${dispatchId}`,
  sessionId: `session-${dispatchId}`,
  dispatchId,
  providerSessionId: null,
  model: 'claude-sonnet-4-6',
  workspace,
  stateDir,
  prompt: 'ORCH_NATIVE_RESTART: run the scripted command',
  permissionProfile: 'workspace-write',
  signal: new AbortController().signal,
});

// Host A, started by the parent below: runs one dispatch until the parent kills it.
if (process.argv[2] === '--host') {
  const [, , , directory, workspace, stateDir] = process.argv;
  const adapter = await adapterFor(directory);
  for await (const event of adapter.execute(input(workspace, stateDir, 'restart-dispatch')))
    process.stdout.write(JSON.stringify(event) + '\n');
  process.exit(0);
}

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: node scripts/native-stop-restart-smoke.mjs EVIDENCE.json');
if (process.platform === 'win32') throw new Error('The restart smoke needs macOS or Linux');
const base = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-restart-')));
const home = join(base, 'home');
await mkdir(home, { mode: 0o700 });
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
};
const evidence = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  command: COMMAND,
  cases: {},
};

// The first request runs COMMAND; the one carrying its result waits until `release` is called.
let ran, release;
const reset = () => {
  ran = Promise.withResolvers();
  release = Promise.withResolvers();
};
reset();
let requests = 0;
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
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages'))
      return response.writeHead(404).end();
    if (++requests > 20) throw new Error('Bounded gateway request count exhausted');
    const body = JSON.parse(raw);
    const history = JSON.stringify(body.messages);
    const done = history.includes('tool_result');
    if (done) {
      const at = history.indexOf('tool_result');
      ran.resolve(history.slice(at, at + 400));
      await release.promise;
    }
    const block = done
      ? { type: 'text', text: 'ORCH_RESTART_OK' }
      : {
          type: 'tool_use',
          id: `toolu_${requests}`,
          name: 'Bash',
          input: { command: COMMAND, description: 'scripted' },
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
    response.end();
  } catch (error) {
    evidence.gatewayError = error.message;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const space = async (name) => {
  const root = join(base, name);
  const paths = {
    directory: join(root, 'markers'),
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
  };
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  return paths;
};
const toolRan = (output) =>
  !/denied|tool_use_error|hook error|"is_error":true|exited with code [1-9]|bwrap:/.test(output);

try {
  // Claude Code's Linux sandbox runs each command in a PID namespace of its own, so COMMAND's
  // sleep ends with it there (SPEC-0034): on Linux both cases are recorded, not asserted.
  const linuxSandbox = () => process.platform === 'linux' && !pids().length;
  // 0036-C01 restart: host A is killed after COMMAND ran; host B, this process, sweeps.
  restart: {
    const record = (evidence.cases.restart = {});
    const { directory, workspace, stateDir } = await space('restart');
    const host = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--host', directory, workspace, stateDir],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    host.stderr.resume();
    host.stdout.resume();
    record.toolOutput = await Promise.race([
      ran.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('COMMAND never ran')), 60000)),
    ]);
    assert.ok(toolRan(record.toolOutput), record.toolOutput);
    if (linuxSandbox()) {
      record.sandboxEndedBackground = true;
      host.kill('SIGKILL');
      release.resolve();
      break restart;
    }
    // Under load Claude Code can run the scripted command twice; each copy must end.
    record.before = pids();
    assert.ok(record.before.length >= 1, 'COMMAND left sleep 600');
    host.kill('SIGKILL');
    await new Promise((resolve) => host.once('exit', resolve));
    release.resolve();
    // The killed host's Claude Code exits when its input closes; the sweep counts it until then.
    const stale = await staleStopMarkers(directory);
    record.stale = stale.dispatches.map(({ dispatchId, holders, stopped, reason }) => ({
      dispatchId,
      holders: holders.length,
      stopped,
      reason,
    }));
    assert.equal(stale.dispatches[0]?.dispatchId, 'restart-dispatch');
    const sorted = (list) => [...(list ?? [])].sort((a, b) => a - b);
    assert.deepEqual(
      sorted(stale.dispatches[0]?.holders),
      sorted(record.before),
      'the stale check finds it',
    );
    assert.deepEqual(sorted(pids()), sorted(record.before), 'the stale check ends nothing');
    // Each sweep is recorded. The killed host's Claude Code stays in the workspace until it sees
    // its input close, and the sweep waits for it within its time; one sweep should do.
    const observed = [];
    record.sweeps = [];
    let swept;
    for (const end = performance.now() + 15000; performance.now() < end; ) {
      swept = await sweepStopMarkers(directory, { onObservation: (item) => observed.push(item) });
      const described = swept.dispatches.flatMap(({ strays }) =>
        strays.map((pid) => {
          try {
            return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
              encoding: 'utf8',
            }).trim();
          } catch {
            return 'gone';
          }
        }),
      );
      record.sweeps.push({ stopped: swept.stopped, dispatches: swept.dispatches, described });
      if (swept.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record.observed = observed;
    assert.equal(record.sweeps.length, 1, 'one sweep');
    assert.equal(swept.stopped, true, JSON.stringify(swept));
    record.after = pids();
    assert.deepEqual(record.after, [], 'the sweep ended sleep 600');
  }
  // 0036-Y01: the synchronous cleanup of a live host, while its dispatch still runs.
  sync: {
    reset();
    const record = (evidence.cases.sync = {});
    const { directory, workspace, stateDir } = await space('sync');
    const observed = [];
    const adapter = await adapterFor(directory, { onObservation: (item) => observed.push(item) });
    const running = (async () => {
      const events = [];
      for await (const event of adapter.execute(input(workspace, stateDir, 'sync-dispatch')))
        events.push(event);
      return events;
    })();
    record.toolOutput = await ran.promise;
    assert.ok(toolRan(record.toolOutput), record.toolOutput);
    if (linuxSandbox()) {
      record.sandboxEndedBackground = true;
      release.resolve();
      await running;
      await adapter.close();
      break sync;
    }
    record.before = pids();
    assert.ok(record.before.length >= 1);
    const started = performance.now();
    record.result = adapter.endStopMarkersSync(300);
    record.elapsedMs = Math.round(performance.now() - started);
    // A killed process is gone once the system has reaped it, which can take a moment.
    for (let i = 0; i < 40 && pids().length; i++) await new Promise((r) => setTimeout(r, 50));
    record.after = pids();
    release.resolve();
    record.lastEvent = (await running).at(-1);
    await adapter.close().catch((error) => (record.closeError = String(error)));
    record.observed = observed;
    // The host's criterion: within 300 ms, and what is not verified in time is left to the next
    // start's sweep. Everywhere: within the time, the command ended, and never stopped while it
    // runs. That the last listing fits as well is asserted on Apple silicon only; the slower
    // x86-64 macOS runner may not verify in time, which the result then says (SPEC-0036 Y01).
    assert.ok(record.elapsedMs < 300, `${record.elapsedMs} ms`);
    assert.equal(record.result.holders, record.before.length, JSON.stringify(record.result));
    assert.deepEqual(record.after, [], 'the command was ended');
    if (process.arch === 'arm64')
      assert.equal(record.result.stopped, true, JSON.stringify(record.result));
    else record.verifiedInTime = record.result.stopped;
  }
  evidence.passed = true;
} finally {
  for (const pid of pids())
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  server.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
