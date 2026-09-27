/**
 * SPEC-0031 C01, C02 and SPEC-0032 C03 to C05: the real Claude Code binary against a loopback-only
 * scripted gateway; no credentials, no paid models. The gateway answers each kind of call with its
 * own token counts, so that the usage records show which calls the engine recorded. One native
 * session runs five dispatches in turn, so every dispatch after the first is a resumed one, and the
 * records must be the same whether the SDK's totals start again (before Claude Code 2.1.277) or
 * continue (from 2.1.277 on).
 *
 * Usage: node scripts/native-usage-smoke.mjs EVIDENCE.json [SDK_MODULE_PATH]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createOrchestrator } from '../packages/sdk-typescript/src/index.ts';
import { createClaudeAdapter } from '../packages/adapter-claude/src/index.ts';

const [outputPath, sdkPath] = process.argv.slice(2);
if (!outputPath)
  throw new Error('Usage: node scripts/native-usage-smoke.mjs EVIDENCE.json [SDK_MODULE_PATH]');
const MODEL = 'claude-sonnet-4-6';
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-usage-')));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  home = join(root, 'home');
for (const directory of [workspace, stateDir, home]) await mkdir(directory, { mode: 0o700 });
await writeFile(join(workspace, 'notes.txt'), 'notes');
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
};

// A main-loop call that reads a file with an almost full context makes Claude Code compact before
// its next call (C02). Each kind of call has its own counts.
const usageOf = {
  read: {
    input_tokens: 190000,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  answer: {
    input_tokens: 1000,
    output_tokens: 30,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 12,
  },
  compact: {
    input_tokens: 7000,
    output_tokens: 700,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 300,
  },
};
const split = {
  read: [0, 0],
  answer: [9, 3],
  compact: [300, 0],
};
const calls = [];
// Each marker makes one main-loop call read the file with an almost full context (C02, C04).
const readMarkers = new Map([
  ['ORCH_AUTO_COMPACT', false],
  ['ORCH_AGAIN_COMPACT', false],
]);
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) throw new Error('Request too large');
    }
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{"input_tokens":100}');
    }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages'))
      return response.writeHead(404).end();
    if (calls.length >= 40) throw new Error('Bounded gateway request count exhausted');
    const body = JSON.parse(raw);
    const history = JSON.stringify(body.messages ?? []);
    const marker = [...readMarkers].find(([name, done]) => !done && history.includes(name))?.[0];
    const kind = history.includes('create a detailed summary')
      ? 'compact'
      : marker
        ? 'read'
        : 'answer';
    if (kind === 'read') readMarkers.set(marker, true);
    calls.push({ kind, model: body.model });
    const usage = {
      ...usageOf[kind],
      cache_creation: {
        ephemeral_5m_input_tokens: split[kind][0],
        ephemeral_1h_input_tokens: split[kind][1],
      },
    };
    const text = kind === 'compact' ? '<summary>Scripted summary.</summary>' : 'ORCH_OK';
    const block =
      kind === 'read'
        ? {
            type: 'tool_use',
            id: 'toolu_auto_read',
            name: 'Read',
            input: { file_path: join(workspace, 'notes.txt') },
          }
        : { type: 'text', text };
    const message = {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [block],
      stop_reason: kind === 'read' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage,
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
          ? { type: 'text_delta', text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    send(response, 'content_block_stop', { index: 0 });
    send(response, 'message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    send(response, 'message_stop', {});
    response.end();
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const require = createRequire(import.meta.url);
const sdkModule = sdkPath ?? require.resolve('@anthropic-ai/claude-agent-sdk');
const sdk = await import(pathToFileURL(sdkModule).href);
const evidence = {
  sdk: JSON.parse(await readFile(join(dirname(sdkModule), 'package.json'), 'utf8')).version,
  node: process.version,
  startedAt: new Date().toISOString(),
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  results: [],
  cases: [],
};
const adapter = createClaudeAdapter({
  query(request) {
    const native = sdk.query(request);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of native) {
          if (message.type === 'system' && message.subtype === 'init')
            evidence.claudeCode ??= message.claude_code_version;
          if (message.type === 'result')
            evidence.results.push({ usage: message.usage, modelUsage: message.modelUsage });
          yield message;
        }
      },
      close: () => native.close(),
      interrupt: () => native.interrupt(),
    };
  },
});
const orch = await createOrchestrator({
  workspace,
  stateDir,
  adapters: [adapter],
  providers: { claude: { models: [MODEL] } },
  storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  timeouts: { acceptanceMs: 30000, turnMs: 60000 },
  limits: { maxActiveSessions: 1 },
});
const until = async (taskId, status) => {
  const deadline = performance.now() + 65000;
  for (;;) {
    const task = await orch.tasks.get(taskId);
    if (task.status === status) return task;
    if (['failed', 'blocked', 'cancelled'].includes(task.status))
      throw new Error(JSON.stringify(task));
    if (performance.now() >= deadline) throw new Error(`Task deadline: ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const records = async (taskId) =>
  (await orch.usage.get(taskId)).records.map((record) => ({
    kind: record.id.includes(':outside:') ? 'outside' : 'main',
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cachedInputTokens,
    cacheWrite: record.cacheWriteInputTokens,
    model: record.model,
  }));
const create = (goal) =>
  orch.tasks.create({
    goal,
    runtime: { provider: 'claude', model: MODEL },
    acceptance: { mode: 'human', criteria: ['Scripted response'] },
  });
let exitCode = 0;
try {
  const target = (value) => ({
    sessionId: value.id,
    expectedGeneration: value.generation,
    expectedRevision: value.revision,
    expectedState: value.status,
    expectedDispatchId: value.activeDispatchId,
  });
  const approve = async (taskId) => {
    const delivered = await orch.tasks.get(taskId);
    const approval = await orch.approvals.get(delivered.approvalId);
    await orch.approvals.decide(delivered.approvalId, {
      choice: 'approve',
      expectedRevision: approval.revision,
    });
    return until(taskId, 'completed');
  };
  // A later task continues a given session: a resumed dispatch, or a fork's first one.
  const resumed = async (parentTaskId, sessionId, goal) => {
    const handle = await orch.tasks.create({
      goal,
      runtime: { provider: 'claude', model: MODEL },
      acceptance: { mode: 'human', criteria: ['Scripted response'] },
      parentTaskId,
      contextPlan: {
        requestedMode: 'reuse',
        independent: true,
        candidateSessionId: sessionId,
        maxQueueWaitMs: 1000,
        fallbackModes: [],
        dependencyTaskIds: [],
        contextRefs: [],
      },
    });
    await until(handle.id, 'waiting_approval');
    return handle;
  };
  const compacted = (compactions, main) => [
    main,
    {
      kind: 'outside',
      input: 7000 * compactions,
      output: 700 * compactions,
      cacheRead: 0,
      cacheWrite: 300 * compactions,
      model: MODEL,
    },
  ];
  const readTurn = {
    kind: 'main',
    input: 191000,
    output: 50,
    cacheRead: 5,
    cacheWrite: 12,
    model: MODEL,
  };
  const plainTurn = {
    kind: 'main',
    input: 1000,
    output: 30,
    cacheRead: 5,
    cacheWrite: 12,
    model: MODEL,
  };
  const compactionsSince = (before) =>
    calls.slice(before).filter((call) => call.kind === 'compact').length;

  // C02: Claude Code compacts in the middle of the session's first dispatch.
  const auto = await create('ORCH_AUTO_COMPACT: read notes.txt, then answer ORCH_OK');
  await until(auto.id, 'waiting_approval');
  const autoCompactions = compactionsSince(0);
  assert.ok(autoCompactions >= 1, `Claude Code did not compact: ${JSON.stringify(calls)}`);
  const autoRecords = await records(auto.id);
  evidence.autoCompact = { calls: [...calls], records: autoRecords };
  assert.deepEqual(autoRecords, compacted(autoCompactions, readTurn));
  evidence.cases.push('auto-compaction-in-a-dispatch-recorded-under-the-dispatch-model');
  const first = await approve(auto.id);
  const sessionId = first.sessionId;

  // C03 (SPEC-0032): a plain second dispatch; nothing ran outside its main loop.
  const plain = await resumed(auto.id, sessionId, 'ORCH_PLAIN: answer ORCH_OK');
  const plainRecords = await records(plain.id);
  evidence.resumedPlain = { records: plainRecords };
  assert.deepEqual(plainRecords, [plainTurn]);
  await approve(plain.id);
  evidence.cases.push('resumed-dispatch-records-only-its-own-calls');

  // C04 (SPEC-0032): the session compacts again in the middle of a resumed dispatch.
  let before = calls.length;
  const again = await resumed(
    auto.id,
    sessionId,
    'ORCH_AGAIN_COMPACT: read notes.txt, then answer ORCH_OK',
  );
  const againCompactions = compactionsSince(before);
  assert.ok(againCompactions >= 1, `Claude Code did not compact again: ${JSON.stringify(calls)}`);
  const againRecords = await records(again.id);
  evidence.resumedAutoCompact = { calls: calls.slice(before), records: againRecords };
  assert.deepEqual(againRecords, compacted(againCompactions, readTurn));
  const latest = await approve(again.id);
  evidence.cases.push('resumed-auto-compaction-records-only-its-own-compaction');

  // C05 (SPEC-0032): a fork continues from its source's totals; its first dispatch is its own.
  const source = await orch.sessions.get(sessionId);
  const fork = await orch.sessions.fork(target(source), latest.artifactRefs[0]);
  const branch = await resumed(auto.id, fork.id, 'ORCH_PLAIN branch: answer ORCH_OK');
  const branchRecords = await records(branch.id);
  evidence.forkFirstDispatch = { records: branchRecords };
  assert.deepEqual(branchRecords, [plainTurn]);
  await approve(branch.id);
  evidence.cases.push('fork-first-dispatch-records-only-its-own-calls');

  // C01: the engine's own compaction, the session's fourth dispatch.
  const session = await orch.sessions.get(sessionId);
  before = calls.length;
  const compact = await orch.sessions.compact({
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedState: session.status,
    expectedDispatchId: session.activeDispatchId,
  });
  const done = await compact.wait({ timeoutMs: 65000 });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  const compactionTask = (await orch.tasks.list({ sessionId: session.id })).tasks.find(
    (task) => task.kind === 'compaction',
  );
  assert.ok(compactionTask, 'the compaction has a task');
  const manualRecords = await records(compactionTask.id);
  evidence.manualCompact = { calls: calls.slice(before), records: manualRecords };
  assert.deepEqual(
    manualRecords,
    compacted(compactionsSince(before), {
      kind: 'main',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: MODEL,
    }),
  );
  evidence.cases.push('manual-compaction-recorded-under-the-session-model');
  evidence.status = 'passed';
} catch (error) {
  exitCode = 1;
  evidence.status = 'failed';
  evidence.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  await orch.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
  await adapter.close().catch(() => {});
  server.close();
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
