import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodexAdapter,
  type CodexAdapterConfig,
} from '../../packages/adapter-codex/src/index.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import { processGroupsStopped } from '../../packages/adapter-claude/src/index.ts';
import { requireStopProof } from '../../packages/engine/src/stop-observation.ts';
import type { RuntimeCapabilities, RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0034 A: a command that Codex or Claude Code runs can outlive the turn and the runtime's
// process group, so no terminal alone shows that a dispatch stopped.

const codex = (config: Record<string, unknown>) => createCodexAdapter(config as CodexAdapterConfig);
const covers = (adapter: { capabilities(): unknown }) =>
  (adapter.capabilities() as RuntimeCapabilities).executionEvidence?.terminalCoversExecution;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

test('0034-A01 a read-only Codex adapter needs proof of stop too', () => {
  for (const profile of [{}, { permissionProfile: 'read-only' }])
    assert.throws(
      () => codex(profile),
      { code: 'INVALID_ADAPTER_CONFIG' },
      JSON.stringify(profile),
    );
  assert.equal(covers(codex({ executionStop: 'owner-reconcile' })), false);
  assert.equal(covers(codex({ observeExecutionStop: async () => true })), true);
});

test('0034-A01 a JSON host must choose owner reconcile for Codex', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-json-stop-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const path = join(root, 'config.json');
  const write = (codex: Record<string, unknown>) =>
    writeFile(
      path,
      JSON.stringify({
        workspace: join(root, 'workspace'),
        stateDir: join(root, 'state'),
        providers: { codex: { model: 'fixture', ...codex } },
      }),
    );
  for (const codex of [{}, { executionStop: 'automatic' }]) {
    await write(codex);
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' }, JSON.stringify(codex));
  }
  await write({ executionStop: 'owner-reconcile' });
  assert.equal((await loadConfig(path)).providers.codex.executionStop, 'owner-reconcile');
});

test('0034-A02 processGroupsStopped keeps its answers, warns once, and is no longer suggested', (t) => {
  const warnings: unknown[] = [];
  t.mock.method(process, 'emitWarning', (warning: unknown) => warnings.push(warning));
  const gone = () => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  const context = { processes: [{ pid: 4242, processGroupId: 4242 }] };
  assert.equal(processGroupsStopped(context, gone), true);
  assert.equal(
    processGroupsStopped(context, () => true),
    false,
  );
  assert.equal(processGroupsStopped({ processes: [] }, gone), false);
  assert.equal(warnings.length, 1, 'one warning per process');
  assert.match(String(warnings[0]), /Bash|own process group|stopMarker/);
  assert.throws(
    () => requireStopProof('Claude adapter', false, {}),
    (error: Error) =>
      !/processGroupsStopped/.test(error.message) && /stopMarker/.test(error.message),
  );
});

test('0034-A03 a Codex dispatch ends the commands its app-server started', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-background-'));
  const pids = join(dir, 'pids.json');
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [new URL('../fixtures/codex-background.ts', import.meta.url).pathname],
    env: { FIXTURE_PIDS: pids },
    executionStop: 'owner-reconcile',
    closeTimeoutMs: 1000,
  });
  let started: number[] = [];
  t.after(async () => {
    for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await adapter.close?.().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    model: 'fixture-model',
    workspace: process.cwd(),
    stateDir: dir,
    prompt: 'Start something in the background',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
  }))
    events.push(event);
  started = JSON.parse(await readFile(pids, 'utf8'));
  assert.ok(
    events.some((event) => event.type === 'result'),
    JSON.stringify(events),
  );
  assert.equal(started.length, 1);
  for (let i = 0; i < 100 && alive(started[0]); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(started[0]), false, 'the backgrounded command was ended with its dispatch');
});
