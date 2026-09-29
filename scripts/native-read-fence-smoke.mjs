/**
 * SPEC-0014 F04: the writable Claude profile's OS sandbox with the installed Claude binary and a
 * loopback scripted gateway. No credentials or paid models. It needs an available OS sandbox
 * (macOS Seatbelt or Linux bubblewrap). The native CI job runs it on each runner (SPEC-0043 C02).
 *
 * Usage: node scripts/native-read-fence-smoke.mjs EVIDENCE.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createClaudeAdapter } from '../packages/adapter-claude/src/index.ts';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/native-read-fence-smoke.mjs EVIDENCE.json');
const req = createRequire(import.meta.url);
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-read-fence-')));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  home = join(root, 'home');
for (const directory of [workspace, stateDir, home, join(workspace, 'secrets')])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const files = {
  home: join(home, 'secret.txt'),
  workspace: join(workspace, 'inside.txt'),
  denied: join(workspace, 'secrets', 'key.txt'),
};
await writeFile(files.home, 'ORCH_BASH_HOME_SECRET');
await writeFile(files.workspace, 'ORCH_BASH_WORKSPACE_OK');
await writeFile(files.denied, 'ORCH_BASH_DENIED_IN_WORKSPACE');
// Property writes reach the real process environment, so os.homedir() is the isolated home.
for (const key of Object.keys(process.env))
  if (!['PATH', 'TMPDIR'].includes(key)) delete process.env[key];
Object.assign(process.env, {
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
});
const evidence = {
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  startedAt: new Date().toISOString(),
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  modelCalls: 0,
};
const requests = [];
const probes = Object.values(files).map((path, index) => ({
  type: 'tool_use',
  id: `toolu_fence_${index}`,
  name: 'Bash',
  input: { command: `cat ${path}`, description: 'Read fence probe' },
}));
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (request.method !== 'POST') return response.writeHead(404).end();
  const body = JSON.parse(raw);
  if (request.url.includes('count_tokens')) {
    response.setHeader('content-type', 'application/json');
    return response.end('{"input_tokens":100}');
  }
  if (!request.url.startsWith('/v1/messages') || requests.length >= 8)
    return response.writeHead(404).end();
  requests.push(body.messages ?? []);
  const first = !JSON.stringify(body.messages).includes('toolu_fence_0');
  const blocks = first ? probes : [{ type: 'text', text: 'ORCH_READ_FENCE_DONE' }];
  const message = {
    id: `msg_${requests.length}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: blocks,
    stop_reason: first ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify(message));
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send(response, 'message_start', { message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    send(response, 'content_block_start', {
      index,
      content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
    });
    send(response, 'content_block_delta', {
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    send(response, 'content_block_stop', { index });
  });
  send(response, 'message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send(response, 'message_stop', {});
  response.end();
});
let adapter;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  evidence.binary = execFileSync(
    join(
      dirname(
        req.resolve(
          `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
        ),
      ),
      'claude',
    ),
    ['--version'],
    { encoding: 'utf8', timeout: 5000 },
  ).trim();
  // Stop evidence is not under test here; the writable profile only needs an observer.
  adapter = createClaudeAdapter({
    permissionProfile: 'workspace-write',
    denyRead: ['secrets'],
    query: (request) => {
      evidence.sandbox = request.options.sandbox;
      return sdk.query(request);
    },
    // A scripted attestation; the observer contract is a boolean.
    observeExecutionStop: async () => true,
  });
  const events = [];
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    generation: 1,
    providerSessionId: null,
    model: 'fixture-model',
    workspace,
    stateDir,
    prompt: 'Run the read fence probe',
    permissionProfile: 'workspace-write',
    signal: new AbortController().signal,
    writePaths: [workspace],
  }))
    events.push(event.type);
  evidence.events = events;
  const results = Object.fromEntries(
    (requests.at(-1) ?? [])
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((block) => block.type === 'tool_result')
      .map((block) => [
        block.tool_use_id,
        { isError: block.is_error === true, content: JSON.stringify(block.content).slice(0, 300) },
      ]),
  );
  evidence.results = results;
  assert.equal(events.at(-1), 'result', JSON.stringify(events));
  assert.ok(results.toolu_fence_0?.isError, 'Bash read the home directory');
  assert.ok(!results.toolu_fence_0.content.includes('ORCH_BASH_HOME_SECRET'));
  assert.ok(
    results.toolu_fence_1?.content.includes('ORCH_BASH_WORKSPACE_OK'),
    'Workspace read failed',
  );
  assert.ok(results.toolu_fence_2?.isError, 'Bash read a denyRead path inside the workspace');
  assert.ok(!results.toolu_fence_2.content.includes('ORCH_BASH_DENIED_IN_WORKSPACE'));
  evidence.cases = [
    'bash-home-read-blocked-by-os-sandbox',
    'bash-workspace-read-allowed',
    'bash-denyread-inside-workspace-blocked',
  ];
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await adapter?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  evidence.requests = requests.length;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputPath), JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({ status: evidence.status, cases: evidence.cases, error: evidence.error }),
  );
}
