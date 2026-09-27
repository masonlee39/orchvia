/** Opt-in real binaries against a loopback-only scripted gateway; no credentials or paid models. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  readdir,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectOrchestrator } from '../packages/sdk-typescript/src/index.ts';
import { createEngine } from '../packages/engine/src/index.ts';
import { startUnixHost } from '../packages/cli/src/host.ts';
import { createClaudeAdapter, inspectClaudeSession } from '../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../packages/adapter-codex/src/index.ts';

const [provider, outputPath, executable] = process.argv.slice(2);
if (!['claude', 'codex'].includes(provider) || !outputPath)
  throw new Error(
    'Usage: node scripts/native-gateway-smoke.mjs claude|codex EVIDENCE.json [BINARY]',
  );
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-gateway-')));
const socketRoot = await realpath(await mkdtemp('/tmp/ong-'));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  home = join(root, 'home');
for (const directory of [workspace, stateDir, home]) await mkdir(directory, { mode: 0o700 });
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
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  cases: [],
};
const requests = [];
// SPEC-0014 F04: one file outside every readable root and one inside the workspace.
const fence = {
  secret: join(home, 'fence-secret.txt'),
  inside: join(workspace, 'fence-inside.txt'),
};
await writeFile(fence.secret, 'ORCH_FENCE_SECRET', { mode: 0o600 });
await writeFile(fence.inside, 'ORCH_FENCE_INSIDE');
let taskId,
  scriptedCalls = 0;
const sendEvent = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) throw new Error('Request too large');
    }
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw);
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      response.end('{"input_tokens":100}');
      return;
    }
    if (!request.url.startsWith('/v1/messages') && !request.url.startsWith('/v1/responses')) {
      response.writeHead(404).end();
      return;
    }
    if (requests.length >= 24) throw new Error('Bounded gateway request count exhausted');
    const discovered = (body.input ?? [])
      .filter((item) => item.type === 'tool_search_output')
      .flatMap((item) => item.tools ?? []);
    const tools = [...(body.tools ?? []), ...discovered].flatMap((tool) =>
      tool.type === 'namespace'
        ? (tool.tools ?? []).map((entry) => `${tool.name}.${entry.name}`)
        : [tool.name ?? tool.type],
    );
    requests.push({
      path: request.url,
      model: body.model,
      tools,
      input: body.messages ?? body.input,
    });
    const hasMarker = JSON.stringify(body.messages ?? body.input).includes(
      'ORCH_NATIVE_GATEWAY_ROOT',
    );
    const tool = tools.find((name) => typeof name === 'string' && name.endsWith('work_read'));
    const call = hasMarker && tool && scriptedCalls++ === 0;
    const text = 'ORCH_NATIVE_GATEWAY_OK';
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const history = JSON.stringify(body.messages ?? body.input);
    const fenceTurn =
      provider === 'claude' &&
      history.includes('ORCH_NATIVE_GATEWAY_FENCE') &&
      !history.includes('toolu_fence_inside');
    if (provider === 'claude') {
      const blocks = fenceTurn
        ? [
            {
              type: 'tool_use',
              id: 'toolu_fence_outside',
              name: 'Read',
              input: { file_path: fence.secret },
            },
            {
              type: 'tool_use',
              id: 'toolu_fence_inside',
              name: 'Read',
              input: { file_path: fence.inside },
            },
          ]
        : call
          ? [
              {
                type: 'tool_use',
                id: `toolu_${requests.length}`,
                name: tool,
                input: { request: { kind: 'task', id: taskId } },
              },
            ]
          : [{ type: 'text', text }];
      const message = {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: blocks,
        stop_reason: call || fenceTurn ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage,
      };
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sendEvent(response, 'message_start', {
        message: { ...message, content: [], stop_reason: null },
      });
      blocks.forEach((block, index) => {
        sendEvent(response, 'content_block_start', {
          index,
          content_block:
            block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
        });
        sendEvent(response, 'content_block_delta', {
          index,
          delta:
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
        sendEvent(response, 'content_block_stop', { index });
      });
      sendEvent(response, 'message_delta', {
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      sendEvent(response, 'message_stop', {});
    } else {
      const parts = tool?.split('.');
      const item =
        hasMarker && !tool && requests.length === 1
          ? {
              type: 'tool_search_call',
              id: `item_${requests.length}`,
              call_id: `call_${requests.length}`,
              status: 'completed',
              execution: 'client',
              arguments: {
                query: 'agent_orch work_delegate work_send work_read work_control',
                limit: 4,
              },
            }
          : call
            ? {
                type: 'function_call',
                id: `item_${requests.length}`,
                call_id: `call_${requests.length}`,
                status: 'completed',
                name: parts.at(-1),
                ...(parts.length > 1 ? { namespace: parts[0] } : {}),
                arguments: JSON.stringify({ request: { kind: 'task', id: taskId } }),
              }
            : {
                type: 'message',
                id: `item_${requests.length}`,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text, annotations: [] }],
              };
      const result = {
        id: `resp_${requests.length}`,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sendEvent(response, 'response.created', {
        response: { ...result, output: [], status: 'in_progress' },
      });
      sendEvent(response, 'response.output_item.done', { output_index: 0, item });
      sendEvent(response, 'response.completed', { response: result });
    }
    response.end();
  } catch (error) {
    evidence.gatewayError = error.message;
    response.writeHead(500).end();
  }
});
let client, adapter, engine, host;
let named = [];
try {
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = createRequire(import.meta.url);
  let binary;
  if (provider === 'claude') {
    binary =
      executable ??
      join(
        dirname(
          req.resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
          ),
        ),
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      );
    process.env.ANTHROPIC_BASE_URL = url;
    evidence.sdk = JSON.parse(
      await readFile(
        join(dirname(req.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
        'utf8',
      ),
    ).version;
    if (executable)
      throw new Error(
        'Claude smoke uses the installed SDK-owned binary; custom executable paths require host stop evidence',
      );
    // The adapters serve their own MCP server, which needs neither this SDK nor Zod (SPEC-0026).
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    adapter = createClaudeAdapter({
      query(request) {
        evidence.policy = {
          tools: request.options.tools,
          allowedTools: request.options.allowedTools,
          disallowedTools: request.options.disallowedTools,
          mcpServers: Object.keys(request.options.mcpServers ?? {}),
        };
        const native = sdk.query({
          ...request,
          options: { ...request.options, debugFile: join(root, 'native-debug.log') },
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of native) {
              if (message.type === 'system' && message.subtype === 'init')
                evidence.nativeInit = { tools: message.tools, mcpServers: message.mcp_servers };
              yield message;
            }
          },
          close: () => native.close(),
          interrupt: () => native.interrupt(),
        };
      },
      inspectSession: (input) => inspectClaudeSession(input, sdk),
      requestTimeoutMs: 30000,
      turnTimeoutMs: 60000,
      cleanupTimeoutMs: 5000,
    });
    // SPEC-0014 P02: two more Claude adapters under other names in the same engine, one writable.
    const nameEvidence = (evidence.providerNames = {});
    named = [
      ['claude-read', {}],
      [
        'claude-write',
        {
          permissionProfile: 'workspace-write',
          // The scripted turn runs no tool, so nothing can outlive it; this attests only that, for
          // the exact target, which must carry this adapter's name. A real host observes the stop.
          observeExecutionStop: async ({ target }) => {
            nameEvidence['claude-write'].stopTarget = target.provider;
            return target.provider === 'claude-write';
          },
        },
      ],
    ].map(([name, extra]) =>
      createClaudeAdapter({
        provider: name,
        ...extra,
        query(request) {
          nameEvidence[name] = {
            permissionMode: request.options.permissionMode,
            sandbox: request.options.sandbox?.enabled === true,
          };
          return sdk.query(request);
        },
        inspectSession: (input) => inspectClaudeSession(input, sdk),
        requestTimeoutMs: 30000,
        turnTimeoutMs: 60000,
        cleanupTimeoutMs: 5000,
      }),
    );
  } else {
    binary = executable?.includes('/') ? resolve(executable) : (executable ?? 'codex');
    const settings = {
      model_provider: 'local_fixture',
      'model_providers.local_fixture': {
        name: 'Local scripted gateway',
        base_url: `${url}/v1`,
        wire_api: 'responses',
        env_key: 'ORCH_GATEWAY_KEY',
        request_max_retries: 0,
        stream_max_retries: 0,
      },
      model_reasoning_effort: 'low',
    };
    const toml = (value) =>
      typeof value === 'object'
        ? `{${Object.entries(value)
            .map(([key, val]) => `${key}=${toml(val)}`)
            .join(',')}}`
        : JSON.stringify(value);
    adapter = createCodexAdapter({
      command: binary,
      args: [
        'app-server',
        ...Object.entries(settings).flatMap(([key, val]) => ['-c', `${key}=${toml(val)}`]),
      ],
      env: process.env,
      requestTimeoutMs: 30000,
      turnTimeoutMs: 60000,
      closeTimeoutMs: 5000,
      // SPEC-0034 A01: the scripted turns run no command, so nothing can outlive them; this
      // attests only that, for the exact target. A real host observes the stop.
      observeExecutionStop: async ({ target }) => target.provider === 'codex',
    });
  }
  evidence.binary = execFileSync(binary, ['--version'], {
    env: process.env,
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  const runtimeModel = provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4';
  // SPEC-0013 M05: Claude also allows a second model so a fork can change model.
  const forkModel = provider === 'claude' ? 'claude-haiku-4-5' : undefined;
  engine = await createEngine({
    workspace,
    stateDir,
    adapters: [adapter, ...named],
    ...(forkModel
      ? {
          providers: {
            [provider]: { models: [runtimeModel, forkModel] },
            'claude-read': { model: runtimeModel },
            'claude-write': { model: runtimeModel, permissionProfile: 'workspace-write' },
          },
        }
      : {}),
    tools: { enabled: true },
    storage: { emergencyBytes: 4096, minFreeBytes: 0 },
    timeouts: { acceptanceMs: 30000, turnMs: 60000 },
    limits: { maxActiveSessions: 1 },
  });
  const socketPath = join(socketRoot, 'rpc.sock');
  host = await startUnixHost(engine, { socketPath });
  client = await connectOrchestrator({ socketPath });
  const spec = {
    goal: 'ORCH_NATIVE_GATEWAY_ROOT: inspect the current task once, then return ORCH_NATIVE_GATEWAY_OK',
    runtime: { provider, model: runtimeModel },
    acceptance: {
      mode: 'human',
      criteria: ['Scripted response, correct lifecycle and retained history'],
    },
  };
  const task = await client.tasks.create(spec);
  taskId = task.id;
  const waitApproval = async (handle) => {
    const deadline = performance.now() + 65000;
    for (;;) {
      const current = await handle.get();
      if (current.status === 'waiting_approval') return current;
      if (['failed', 'blocked', 'paused', 'cancelled'].includes(current.status))
        throw new Error(JSON.stringify(current));
      if (performance.now() >= deadline) throw new Error(`Task deadline: ${current.status}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const pending = await waitApproval(task);
  assert.equal(pending.result, 'ORCH_NATIVE_GATEWAY_OK');
  const declared = [...new Set(requests.flatMap((item) => item.tools))];
  for (const name of ['work_delegate', 'work_send', 'work_read', 'work_control'])
    assert.ok(
      declared.some((tool) => tool.endsWith(name)),
      `Native tool inventory missing ${name}: ${declared}`,
    );
  assert.ok(
    !declared.some((name) => /(^|[_.])(Agent|Task|spawn_agent|wait_agent|send_input)$/.test(name)),
    `Native delegation bypass visible: ${declared}`,
  );
  const responses = JSON.stringify(requests.map((item) => item.input));
  assert.ok(responses.includes(task.id), 'Native tool result never returned to the gateway');
  assert.ok(
    responses.includes('parentTaskId') || responses.includes('artifactRefs'),
    'Bound work_read did not return the engine task',
  );
  assert.equal(adapter.hasActiveResources(pending.sessionId), false);
  const scheduler = await client.scheduler.get();
  evidence.scheduler = scheduler;
  const approval = await client.approvals.get(pending.approvalId);
  await client.approvals.decide(approval.approvalId, {
    choice: 'approve',
    expectedRevision: approval.revision,
  });
  assert.equal((await task.wait({ timeoutMs: 5000 })).status, 'completed');
  evidence.cases.push('engine-task-native-mcp-human-approval-resource-release');
  const session = await client.sessions.get(pending.sessionId);
  const inspection = await client.sessions.inspect(session.id);
  assert.equal(inspection.status, 'found', JSON.stringify(inspection));
  assert.equal(inspection.execution, 'unknown');
  assert.ok(inspection.records.length > 0);
  evidence.cases.push('retained-native-history-read-only-inspection');
  evidence.nativeSessionId = session.providerSessionId;
  evidence.usage = await client.usage.get(task.id);
  evidence.nativeToolNames = declared;
  const target = (value) => ({
    sessionId: value.id,
    expectedGeneration: value.generation,
    expectedRevision: value.revision,
    expectedState: value.status,
    expectedDispatchId: value.activeDispatchId,
  });
  const routed = async (
    candidate,
    goal = 'ORCH_NATIVE_GATEWAY_BRANCH: return ORCH_NATIVE_GATEWAY_OK',
  ) => {
    const handle = await client.tasks.create({
      ...spec,
      runtime: { provider, model: candidate.model },
      goal,
      parentTaskId: task.id,
      contextPlan: {
        requestedMode: 'reuse',
        independent: true,
        candidateSessionId: candidate.id,
        maxQueueWaitMs: 1000,
        fallbackModes: [],
        dependencyTaskIds: [],
        contextRefs: [],
      },
    });
    const result = await waitApproval(handle);
    assert.equal(result.result, 'ORCH_NATIVE_GATEWAY_OK');
    const check = await client.approvals.get(result.approvalId);
    await client.approvals.decide(check.approvalId, {
      choice: 'approve',
      expectedRevision: check.revision,
    });
    assert.equal((await handle.wait({ timeoutMs: 5000 })).status, 'completed');
    return client.sessions.get(result.sessionId);
  };
  const fork = await client.sessions.fork(target(session), pending.artifactRefs[0]);
  const branch = await routed(fork);
  assert.notEqual(branch.providerSessionId, session.providerSessionId);
  const branchInspection = await client.sessions.inspect(branch.id);
  assert.equal(branchInspection.status, 'found');
  assert.ok(
    JSON.stringify(branchInspection.records).includes('ORCH_NATIVE_GATEWAY_ROOT'),
    'Fork lost saved parent history',
  );
  evidence.cases.push('fork-distinct-native-identity-and-inherited-history');
  if (forkModel) {
    const source = await client.sessions.get(session.id);
    await assert.rejects(
      client.sessions.fork(target(source), pending.artifactRefs[0], { model: forkModel }),
      { code: 'CACHE_LOSS_NOT_ACKNOWLEDGED' },
    );
    const changed = await client.sessions.fork(target(source), pending.artifactRefs[0], {
      model: forkModel,
      acknowledgeCacheLoss: true,
    });
    assert.equal(changed.model, forkModel);
    const seen = requests.length;
    const moved = await routed(
      changed,
      'ORCH_NATIVE_GATEWAY_MODEL_FORK: return ORCH_NATIVE_GATEWAY_OK',
    );
    const forked = requests.slice(seen);
    assert.ok(forked.length > 0, 'Model-changing fork sent no request');
    assert.deepEqual(
      [...new Set(forked.map((item) => item.model))],
      [forkModel],
      'Model-changing fork did not request the target model',
    );
    const history = forked[0].input;
    const text = JSON.stringify(history);
    assert.ok(text.includes('ORCH_NATIVE_GATEWAY_ROOT'), 'Target model lost the source prompt');
    assert.ok(
      history.some((message) => message.role === 'assistant'),
      'Target model lost the source assistant turn',
    );
    assert.ok(text.includes('ORCH_NATIVE_GATEWAY_MODEL_FORK'), 'Fork prompt missing');
    assert.ok(!text.includes('ORCH_NATIVE_GATEWAY_BRANCH'), 'History beyond the checkpoint leaked');
    assert.notEqual(moved.providerSessionId, source.providerSessionId);
    const unchanged = await client.sessions.get(session.id);
    assert.equal(unchanged.model, runtimeModel);
    assert.equal(unchanged.providerSessionId, source.providerSessionId);
    assert.equal(unchanged.nativeCheckpoint, source.nativeCheckpoint);
    assert.equal(unchanged.revision, source.revision);
    evidence.modelChange = {
      fromModel: runtimeModel,
      toModel: forkModel,
      requestModels: forked.map((item) => item.model),
      forkNativeSessionDiffers: true,
    };
    evidence.cases.push('fork-model-change-resends-source-history-to-target-model');
  }
  if (provider === 'claude') {
    const seen = requests.length;
    const fenced = await client.tasks.create({
      ...spec,
      goal: 'ORCH_NATIVE_GATEWAY_FENCE: read both files, then return ORCH_NATIVE_GATEWAY_OK',
    });
    const read = await waitApproval(fenced);
    const decision = await client.approvals.get(read.approvalId);
    await client.approvals.decide(decision.approvalId, {
      choice: 'approve',
      expectedRevision: decision.revision,
    });
    assert.equal((await fenced.wait({ timeoutMs: 5000 })).status, 'completed');
    const results = JSON.stringify(requests.slice(seen).map((item) => item.input));
    assert.ok(results.includes('toolu_fence_outside'), 'The outside read was never attempted');
    assert.ok(results.includes('ORCH_FENCE_INSIDE'), 'The fence blocked a workspace read');
    assert.ok(!results.includes('ORCH_FENCE_SECRET'), 'A read outside the fence reached the model');
    const outside = requests
      .slice(seen)
      .flatMap((item) => item.input ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_fence_outside');
    const denial = JSON.stringify(outside?.content ?? '');
    assert.ok(
      denial.includes('violates the adapter workspace or private-state policy'),
      `Outside read was not denied by the adapter guard: ${denial}`,
    );
    evidence.readFence = {
      deniedOutsideRead: true,
      allowedWorkspaceRead: true,
      outsideIsError: outside?.is_error === true,
      outsideResult: denial.slice(0, 300),
    };
    evidence.cases.push('read-fence-denies-outside-read-and-allows-workspace-read');
    for (const name of ['claude-read', 'claude-write']) {
      const handle = await client.tasks.create({
        ...spec,
        goal: `ORCH_NATIVE_GATEWAY_NAMES: ${name} returns ORCH_NATIVE_GATEWAY_OK`,
        runtime: { provider: name, model: runtimeModel },
      });
      const done = await waitApproval(handle);
      assert.equal(done.result, 'ORCH_NATIVE_GATEWAY_OK');
      const check = await client.approvals.get(done.approvalId);
      await client.approvals.decide(check.approvalId, {
        choice: 'approve',
        expectedRevision: check.revision,
      });
      assert.equal((await handle.wait({ timeoutMs: 5000 })).status, 'completed');
      const types = (await client.events.read({ taskId: done.id, limit: 1000 })).events.map(
        (event) => event.type,
      );
      assert.ok(types.includes('execution.released'), `${name}: ${types}`);
      assert.ok(!types.includes('execution.evidence_rejected'), `${name}: ${types}`);
      const used = await client.sessions.get(done.sessionId);
      assert.equal(used.provider, name);
      Object.assign(evidence.providerNames[name], {
        profile: used.permissionProfile ?? 'read-only',
        nativeSessionId: used.providerSessionId,
        leaseReleased: true,
        evidenceRejected: false,
      });
    }
    assert.equal(evidence.providerNames['claude-write'].profile, 'workspace-write');
    assert.notEqual(
      evidence.providerNames['claude-read'].nativeSessionId,
      evidence.providerNames['claude-write'].nativeSessionId,
    );
    evidence.cases.push('two-named-claude-adapters-read-only-and-writable-in-one-engine');
  }
  const reused = await routed(await client.sessions.get(session.id));
  assert.equal(reused.providerSessionId, session.providerSessionId);
  evidence.cases.push('serial-reuse-preserves-native-identity');
  const compact = await client.sessions.compact(target(reused));
  const compacted = await compact.wait({ timeoutMs: 65000 });
  assert.equal(compacted.status, 'completed', JSON.stringify(compacted));
  const afterCompact = await client.sessions.get(session.id);
  assert.equal(afterCompact.providerSessionId, session.providerSessionId);
  assert.equal(adapter.hasActiveResources(session.id), false);
  evidence.cases.push('manual-compact-native-boundary-and-resource-release');
  const pythonScript = fileURLToPath(new URL('./native-gateway-smoke.py', import.meta.url));
  const python = await promisify(execFile)(
    'python3',
    [pythonScript, socketPath, provider, spec.runtime.model],
    {
      env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../python/src', import.meta.url)) },
      timeout: 75000,
      maxBuffer: 1024 * 1024,
    },
  );
  evidence.python = JSON.parse(python.stdout);
  assert.equal(evidence.python.status, 'completed');
  evidence.cases.push('python-client-native-task-approval-history-and-usage');
  evidence.requests = requests.length;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.stack ?? String(error);
  evidence.requests = requests;
  evidence.nativeDebug = await readFile(join(root, 'native-debug.log'), 'utf8').then(
    (value) => value.slice(-48000),
    () => undefined,
  );
  const symlinks = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink())
        symlinks.push({ path: target.slice(root.length + 1), target: await readlink(target) });
      else if (entry.isDirectory()) await walk(target);
    }
  };
  await walk(root);
  evidence.symlinks = symlinks;
  process.exitCode = 1;
} finally {
  try {
    await client?.close();
    await host?.close({ mode: 'interrupt', timeoutMs: 10000 });
    if (!host) await engine?.close();
    await adapter?.close();
    for (const extra of named) await extra.close();
  } catch (error) {
    evidence.cleanupError = error.message;
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rm(root, { recursive: true, force: true });
  await rm(socketRoot, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      provider,
      status: evidence.status,
      cases: evidence.cases,
      evidence: resolve(outputPath),
      error: evidence.error,
    }),
  );
}
