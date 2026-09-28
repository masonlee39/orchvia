import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

import { withClaudeProcess } from '../fixtures/claude-process.ts';
import { controlledExecutionBudget } from '../fixtures/execution-budget.ts';

function input(overrides: Partial<RuntimeInput> = {}): RuntimeInput {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    dispatchId: 'dispatch-1',
    providerSessionId: null,
    model: 'test-model',
    workspace: process.cwd(),
    stateDir: '/tmp/orchvia-adapter-test',
    prompt: 'Read this project',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('AC adapter Claude: SDK init acknowledges a real session, resume is passed through, missing usage stays null', async () => {
  const calls: unknown[] = [];
  const adapter = createClaudeAdapter({
    query: withClaudeProcess((request) => {
      calls.push(request);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-session-1',
          result: 'done',
        };
      })();
    }),
  });
  assert.deepEqual(
    await collect(adapter.execute(input({ providerSessionId: 'claude-session-1' }))),
    [
      { type: 'accepted', providerSessionId: 'claude-session-1' },
      {
        type: 'usage',
        usageId: 'dispatch-1:result',
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: null,
          raw: null,
        },
      },
      { type: 'result', text: 'done', providerSessionId: 'claude-session-1' },
    ],
  );
  assert.equal((calls[0] as { options: { resume?: string } }).options.resume, 'claude-session-1');
  assert.deepEqual(adapter.capabilities().permissionProfiles, ['read-only']);
});

test('AC adapter Claude: loss before or after init is outcome_unknown without invented acceptance', async () => {
  const before = createClaudeAdapter({
    query: withClaudeProcess(() =>
      (async function* () {
        throw new Error('connect failed');
      })(),
    ),
  });
  assert.deepEqual(await collect(before.execute(input())), [
    { type: 'error', message: 'connect failed', outcome: 'unknown' },
  ]);
  const after = createClaudeAdapter({
    query: withClaudeProcess(() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session-2' };
        throw new Error('stream disconnected');
      })(),
    ),
  });
  assert.deepEqual(await collect(after.execute(input())), [
    { type: 'accepted', providerSessionId: 'claude-session-2' },
    { type: 'error', message: 'stream disconnected', outcome: 'unknown' },
  ]);
});

test('AC adapter Claude: signal cancellation is not reported as confirmed interruption without SDK terminal proof', async () => {
  const controller = new AbortController();
  const adapter = createClaudeAdapter({
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session-3' };
        controller.abort();
        throw new Error('aborted');
      })(),
  });
  const events = await collect(adapter.execute(input({ signal: controller.signal })));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
});

test('AC adapter Claude: construction is offline and unsupported write profile never invokes SDK', async () => {
  let called = false;
  const adapter = createClaudeAdapter({
    query: () => {
      called = true;
      throw new Error('should not call');
    },
  });
  assert.equal(adapter.capabilities().interrupt, true);
  assert.deepEqual(
    await collect(adapter.execute(input({ permissionProfile: 'workspace-write' }))),
    [{ type: 'error', message: 'Claude adapter supports read-only only', outcome: 'failed' }],
  );
  assert.equal(called, false);
});

const fixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const mode = process.argv[1];
if (process.env.FIXTURE_CAPTURE) fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({argv:process.argv.slice(2), env:{CODEX_HOME:process.env.CODEX_HOME,CODEX_SQLITE_HOME:process.env.CODEX_SQLITE_HOME},pid:process.pid}));
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = 'codex-thread-1';
let turnId = 'codex-turn-1';
let initialized = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (process.env.FIXTURE_REQUESTS) fs.appendFileSync(process.env.FIXTURE_REQUESTS, request.method + '\n');
  if (request.method === 'initialize') {
    if (mode === 'stall-initialize') return;
    if (mode === 'flood') {
      for (let n=0;n<400;n++) send({method:'unrelated',params:{n}});
      return;
    }
    setTimeout(() => send({id: request.id, result: {userAgent: 'fixture'}}), Number(process.env.FIXTURE_STARTUP_DELAY || 0));
  } else if (request.method === 'initialized') {
    initialized = true;
  } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (!initialized) throw new Error('missing handshake');
    if (request.params.sandbox !== 'read-only' || request.params.approvalPolicy !== 'never') throw new Error('thread is not read-only');
    if (mode === 'reject-thread') return send({id:request.id,error:{code:-32000,message:'thread rejected'}});
    if (request.method === 'thread/resume') threadId = request.params.threadId;
    send({id: request.id, result: {thread: {id: threadId}}});
  } else if (request.method === 'turn/start') {
    if (request.params.threadId !== threadId || !Array.isArray(request.params.input)) throw new Error('bad turn');
    if (request.params.sandboxPolicy?.type !== 'readOnly' || request.params.sandboxPolicy?.networkAccess !== false || request.params.approvalPolicy !== 'never') throw new Error('turn is not read-only');
    if (mode === 'disconnect-before-turn-ack') return process.exit(0);
    if (mode === 'stall-turn-ack') return;
    send({id: request.id, result: {turn: {id: turnId, status: 'inProgress'}}});
    if (mode === 'disconnect') return process.exit(0);
    if (mode === 'cancel' || mode === 'stall-terminal' || mode === 'ignore-term') return;
    if (mode === 'spam-terminal') return setInterval(() => send({method:'unrelated',params:{threadId,turnId}}), 1);
    send({method:'item/completed', params:{threadId,turnId,item:{id:'answer-1',type:'agentMessage',text:'finished',phase:'final_answer'}}});
    if (mode !== 'no-usage') {
      const usage = {total:{totalTokens:5,inputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:2,reasoningOutputTokens:0},last:{totalTokens:5,inputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:2,reasoningOutputTokens:0},modelContextWindow:null};
      send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:usage}});
      send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:usage}});
    }
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  } else if (request.method === 'turn/interrupt') {
    send({id: request.id, result:{}});
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});
  }
});`;

function codex(mode: string) {
  return createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: ['-e', fixture, mode],
  });
}

test('AC adapter Codex: handshake, thread and turn ack, deduplicated usage, terminal result', async () => {
  const adapter = codex('complete');
  const events = await collect(adapter.execute(input()));
  assert.deepEqual(events, [
    { type: 'accepted', providerSessionId: 'codex-thread-1' },
    {
      type: 'usage',
      usageId: 'codex-turn-1:total:5:1',
      // The thread's totals, the next dispatch's baseline (SPEC-0035 J01).
      sessionTotals: {
        codexThreadTotal: {
          totalTokens: 5,
          inputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
      },
      usage: {
        inputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        raw: {
          totalTokens: 5,
          inputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          _cumulative: {
            totalTokens: 5,
            inputTokens: 3,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
          _basis: 'last_observed_request',
        },
      },
    },
    {
      type: 'result',
      text: 'finished',
      providerSessionId: 'codex-thread-1',
      nativeCheckpoint: 'codex-turn-1',
    },
  ]);
  assert.deepEqual(adapter.capabilities().permissionProfiles, ['read-only']);
});

test('AC adapter Codex: process loss after turn ack is outcome_unknown', async () => {
  assert.deepEqual(
    await collect(codex('disconnect').execute(input())).then((events) => events.slice(-1)),
    [
      {
        type: 'error',
        message: 'Codex app-server disconnected before turn completion',
        outcome: 'unknown',
      },
    ],
  );
});

test('AC adapter Codex: disconnect after sending turn/start but before ack is outcome_unknown without acceptance', async () => {
  const events = await collect(codex('disconnect-before-turn-ack').execute(input()));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.equal((events[0] as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
});

test('AC adapter Codex: failed thread start is not accepted and missing usage remains null', async () => {
  assert.deepEqual(await collect(codex('reject-thread').execute(input())), [
    { type: 'error', message: 'thread rejected', outcome: 'failed' },
  ]);
  assert.deepEqual(
    await collect(codex('no-usage').execute(input({ providerSessionId: 'previous-thread' }))),
    [
      { type: 'accepted', providerSessionId: 'previous-thread' },
      {
        type: 'usage',
        usageId: 'codex-turn-1:missing',
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: null,
          raw: null,
        },
      },
      {
        type: 'result',
        text: 'finished',
        providerSessionId: 'previous-thread',
        nativeCheckpoint: 'codex-turn-1',
      },
    ],
  );
});

test('AC adapter Codex: interrupt requires observed interrupted terminal notification', async () => {
  const controller = new AbortController();
  const events: RuntimeEvent[] = [];
  for await (const event of codex('cancel').execute(input({ signal: controller.signal }))) {
    events.push(event);
    if (event.type === 'accepted') controller.abort();
  }
  assert.deepEqual(events, [
    { type: 'accepted', providerSessionId: 'codex-thread-1' },
    { type: 'interrupted' },
  ]);
});

test('AC adapter Codex: unsupported write profile does not spawn app-server', async () => {
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: '/nonexistent/codex',
  });
  assert.equal(adapter.capabilities().interrupt, true);
  assert.deepEqual(
    await collect(adapter.execute(input({ permissionProfile: 'workspace-write' }))),
    [{ type: 'error', message: 'Codex adapter supports read-only only', outcome: 'failed' }],
  );
});

test('AC adapter Codex: isolated managed home and defensive flags override inherited user state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchvia-codex-'));
  const capture = join(dir, 'capture.json');
  try {
    const adapter = createCodexAdapter({
      executionStop: 'owner-reconcile',
      command: process.execPath,
      args: ['-e', fixture, 'complete'],
      env: {
        ...process.env,
        CODEX_HOME: '/user/codex',
        CODEX_SQLITE_HOME: '/user/sqlite',
        FIXTURE_CAPTURE: capture,
      },
    });
    const events = await collect(adapter.execute(input({ stateDir: dir })));
    assert.equal(events.at(-1)?.type, 'result');
    const observed = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(observed.env.CODEX_HOME, await realpath(join(dir, 'runtime', 'codex')));
    assert.equal(observed.env.CODEX_SQLITE_HOME, observed.env.CODEX_HOME);
    const managedConfig = await readFile(join(dir, 'runtime', 'codex', 'config.toml'), 'utf8');
    assert.match(managedConfig, /mcp_servers = \{\}/);
    assert.match(managedConfig, /enabled = false/);
    assert.match(managedConfig, /multi_agent_v2 = false/);
    assert.equal(observed.argv.filter((x: string) => x === '--disable').length >= 3, true);
    assert.match(observed.argv.join(' '), /multi_agent_v2/);
    assert.match(observed.argv.join(' '), /plugins/);
    assert.match(observed.argv.join(' '), /projects\..*trust_level/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC adapter Codex: refuses modified managed configuration before spawn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchvia-config-'));
  try {
    const home = join(dir, 'runtime', 'codex');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), '[mcp_servers.writer]\ncommand="touch"\n');
    const events = await collect(
      createCodexAdapter({
        executionStop: 'owner-reconcile',
        command: '/nonexistent/codex',
      }).execute(input({ stateDir: dir })),
    );
    assert.equal(events.length, 1);
    assert.equal((events[0] as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
    assert.match(
      (events[0] as Extract<RuntimeEvent, { type: 'error' }>).message,
      /managed config differs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function stalledCodex(t: TestContext, mode: string) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-codex-boundary-'));
  const requests = join(dir, 'requests'),
    capture = join(dir, 'child.json');
  const clock = controlledExecutionBudget();
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: ['-e', fixture, mode],
    env: {
      FIXTURE_CAPTURE: capture,
      FIXTURE_REQUESTS: requests,
      FIXTURE_STARTUP_DELAY: '150',
    },
    closeTimeoutMs: 50,
  });
  const events: RuntimeEvent[] = [];
  let ended = false;
  const finished = (async () => {
    try {
      for await (const event of adapter.execute(
        input({ stateDir: dir, executionBudget: clock.budget }),
      ))
        events.push(event);
    } finally {
      ended = true;
    }
  })();
  t.after(async () => {
    clock.expire();
    await finished;
    await adapter.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  const boundary = mode === 'stall-initialize' ? 'initialize' : 'turn/start';
  const needsAcceptance = !['stall-initialize', 'stall-turn-ack'].includes(mode);
  const deadline = performance.now() + 10000;
  while (true) {
    const observed = await readFile(requests, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (
      observed.split('\n').includes(boundary) &&
      (!needsAcceptance || events.some((e) => e.type === 'accepted'))
    )
      break;
    assert.equal(
      ended,
      false,
      `Native fixture ended before ${boundary}: ${JSON.stringify(events)}`,
    );
    assert.ok(performance.now() < deadline, `Native fixture did not reach ${boundary}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  clock.expire();
  await finished;
  return { events, capture };
}

test('AC adapter Codex: request and terminal waits are bounded with unknown after turn submission', async (t) => {
  const { events: before } = await stalledCodex(t, 'stall-initialize');
  assert.equal((before.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  const { events: ack } = await stalledCodex(t, 'stall-turn-ack');
  assert.equal((ack.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  const { events: terminal } = await stalledCodex(t, 'stall-terminal');
  assert.equal((terminal.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  const { events: noisy } = await stalledCodex(t, 'spam-terminal');
  assert.equal((noisy.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
});

test('AC adapter Codex: excessive uncorrelated messages fail bounded queue', async () => {
  const events = await collect(
    createCodexAdapter({
      executionStop: 'owner-reconcile',
      command: process.execPath,
      args: ['-e', fixture, 'flood'],
      requestTimeoutMs: 1000,
      closeTimeoutMs: 100,
    }).execute(input()),
  );
  assert.equal(events.at(-1)?.type, 'error');
  assert.match((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).message, /queue limit/i);
});

test('AC adapter Codex: escalates to SIGKILL and waits for owned child exit', async (t) => {
  const { events, capture } = await stalledCodex(t, 'ignore-term');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  const { pid } = JSON.parse(await readFile(capture, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('AC adapter Claude: closes SDK iterator when next throws', async () => {
  let returned = false;
  const adapter = createClaudeAdapter({
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('stream failed');
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  const events = await collect(adapter.execute(input()));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(returned, true);
});
