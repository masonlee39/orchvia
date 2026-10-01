/**
 * SPEC-0056 N01: steering a Claude member, with the real Claude Code binary against a scripted
 * loopback gateway; no credentials, no paid model.
 *   tool: a steer while a tool call runs joins the turn with the tool's result, and is delivered;
 *   text: a steer while the model writes its last answer is never given to Claude Code, is reported
 *         as not delivered, and no model request carries it.
 * Usage: node scripts/native-claude-steer-smoke.mjs EVIDENCE.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createClaudeAdapter } from '../packages/adapter-claude/src/index.ts';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/native-claude-steer-smoke.mjs EVIDENCE.json');
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-claude-steer-')));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  home = join(root, 'home');
for (const directory of [workspace, stateDir, home]) await mkdir(directory, { mode: 0o700 });
await writeFile(join(workspace, 'notes.txt'), 'notes for the fixture\n');
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
};
const STEER = 'ORCH_STEER_MARKER keep the notes as they are';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let state;
const sendEvent = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{"input_tokens":100}');
    }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages'))
      return response.writeHead(404).end();
    const body = JSON.parse(raw);
    const history = JSON.stringify(body.messages ?? []);
    const main = history.includes('ORCH_STEER_PROMPT');
    state.requests.push({ main, steer: history.includes('ORCH_STEER_MARKER') });
    if (state.requests.length > 12) return response.writeHead(500).end();
    const first = main && !state.started;
    if (first) state.started = true;
    const blocks =
      first && state.scenario === 'tool'
        ? [
            {
              type: 'tool_use',
              id: 'toolu_steer_read',
              name: 'Read',
              input: { file_path: join(workspace, 'notes.txt') },
            },
          ]
        : [{ type: 'text', text: 'ORCH_STEER_DONE' }];
    const message = {
      id: `msg_${state.requests.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks,
      stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(message));
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    sendEvent(response, 'message_start', {
      message: { ...message, content: [], stop_reason: null },
    });
    for (const [index, block] of blocks.entries()) {
      sendEvent(response, 'content_block_start', {
        index,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
      });
      if (block.type === 'text' && first && state.scenario === 'text') {
        // The last answer, written slowly: the steer arrives while it streams.
        for (let part = 0; part < 6; part++) {
          sendEvent(response, 'content_block_delta', {
            index,
            delta: { type: 'text_delta', text: `part${part} ` },
          });
          await sleep(400);
        }
      }
      sendEvent(response, 'content_block_delta', {
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: block.text }
            : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      sendEvent(response, 'content_block_stop', { index });
    }
    sendEvent(response, 'message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    sendEvent(response, 'message_stop', {});
    response.end();
  } catch (error) {
    state.gatewayError = String(error);
    response.writeHead(500).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const req = createRequire(import.meta.url);
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const evidence = {
  sdk: JSON.parse(
    await readFile(
      join(dirname(req.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
      'utf8',
    ),
  ).version,
  node: process.version,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  cases: [],
};

async function run(scenario) {
  state = { scenario, requests: [], started: false };
  const outcomes = [];
  const steerId = crypto.randomUUID();
  let steered;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 5000,
    query(request) {
      // The tool call stays outstanding long enough for the steer to be given during it.
      const delay = async () => {
        await sleep(1500);
        return {};
      };
      const native = sdk.query({
        ...request,
        options: {
          ...request.options,
          hooks: {
            ...request.options.hooks,
            PreToolUse: [...(request.options.hooks?.PreToolUse ?? []), { hooks: [delay] }],
          },
        },
      });
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of native) yield message;
        },
        close: () => native.close(),
        interrupt: (options) => native.interrupt(options),
      };
    },
  });
  const events = [];
  // The steer is sent once the turn runs: the first model request has arrived.
  const steering = (async () => {
    while (!state.started) await sleep(20);
    await sleep(scenario === 'tool' ? 100 : 600);
    steered = await adapter.steer(
      { sessionId: 'session', dispatchId: 'dispatch', generation: 1 },
      STEER,
      steerId,
    );
  })();
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'claude-sonnet-5',
      prompt: 'ORCH_STEER_PROMPT read the notes',
      permissionProfile: 'read-only',
      workspace,
      stateDir,
      signal: AbortSignal.timeout(60_000),
      reportExecutionEvidence: () => {},
      reportSteerOutcome: (outcome) => outcomes.push(outcome),
    }))
      events.push(event.type);
    await steering;
  } finally {
    await adapter.close?.();
  }
  const record = {
    scenario,
    steered,
    outcomes: outcomes.map((outcome) => outcome.delivered),
    events,
    modelRequests: state.requests.filter((request) => request.main).length,
    requestsWithSteer: state.requests.filter((request) => request.steer).length,
    gatewayError: state.gatewayError ?? null,
  };
  evidence.cases.push(record);
  return record;
}

try {
  const tool = await run('tool');
  assert.deepEqual(tool.steered, { status: 'accepted', outcomePending: true });
  assert.deepEqual(tool.outcomes, [true], 'the steer joined the turn with the tool result');
  assert.equal(tool.requestsWithSteer, 1);
  assert.equal(tool.events.at(-1), 'result');
  const text = await run('text');
  assert.deepEqual(text.steered, { status: 'accepted', outcomePending: true });
  assert.deepEqual(text.outcomes, [false], 'a turn without a tool call takes no steer');
  assert.equal(text.requestsWithSteer, 0, 'no model request carried the steer');
  assert.equal(text.modelRequests, 1, 'no second turn ran');
  assert.equal(text.events.at(-1), 'result');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  server.close();
  await mkdir(dirname(outputPath), { recursive: true }).catch(() => {});
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(evidence));
}
