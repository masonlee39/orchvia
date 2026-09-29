import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TESTED_CODEX_VERSIONS,
  codexConnection,
  createCodexAdapter,
} from '../../packages/adapter-codex/src/index.ts';
import { doctor } from '../../packages/cli/src/doctor.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0043 A03, M: which Codex versions were tested, and models Codex does not list.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const efforts = (...names: string[]) =>
  names.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
const MODELS = JSON.stringify([
  [
    {
      id: 'gpt-a',
      model: 'gpt-a',
      supportedReasoningEfforts: efforts('low'),
      defaultReasoningEffort: 'low',
    },
  ],
  [
    {
      id: 'gpt-secret',
      model: 'gpt-secret',
      hidden: true,
      supportedReasoningEfforts: efforts('low'),
      defaultReasoningEffort: 'low',
    },
  ],
]);

async function paths(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0043-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirs = {
    base,
    workspace: join(base, 'workspace'),
    state: join(base, 'state'),
    home: join(base, 'codex-home'),
    user: join(base, 'user'),
  };
  for (const dir of Object.values(dirs).slice(1)) await mkdir(dir);
  return dirs;
}
type Paths = Awaited<ReturnType<typeof paths>>;
const requested = (log: string, method: string): any[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'request' && entry.method === method)
    : [];

async function dispatch(
  dirs: Paths,
  name: string,
  model: string,
  env: Record<string, string>,
  config: Record<string, unknown> = {},
) {
  const log = join(dirs.base, `${name}.log`);
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: dirs.user, FIXTURE_LOG: log, ...env },
    connection: { home: dirs.home },
    executionStop: 'owner-reconcile',
    policy: () => ({ mode: 'auto' }),
    ...config,
  } as never);
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: name,
      providerSessionId: null,
      model,
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: dirs.workspace,
      stateDir: dirs.state,
      signal: new AbortController().signal,
      reportExecutionEvidence: () => {},
    } as RuntimeInput))
      events.push(event);
  } finally {
    await adapter.close?.();
  }
  const last = events.at(-1);
  return {
    log,
    last,
    message: last?.type === 'error' ? last.message : '',
    outcome: (last as { outcome?: string } | undefined)?.outcome,
  };
}

test('AC-0043-A03 the tested Codex versions, and probe() says whether the binary is one', async (t) => {
  const dirs = await paths(t);
  assert.deepEqual([...TESTED_CODEX_VERSIONS], ['0.153.4', '0.157.1', '0.158.0']);
  const probe = (agent?: string) =>
    codexConnection({
      home: dirs.home,
      command: process.execPath,
      args: [fixture],
      env: agent ? { FIXTURE_USER_AGENT: agent } : {},
    }).probe();
  const pinned = await probe();
  assert.equal(pinned.version, '0.157.1');
  assert.equal(pinned.tested, true);
  const newer = await probe('orchvia_test/0.159.0 (fixture)');
  assert.deepEqual([newer.supported, newer.tested], [true, false]);
  const older = await probe('orchvia_test/0.150.0 (fixture)');
  assert.deepEqual([older.supported, older.tested], [false, false]);
});

test('AC-0043-A03 doctor reports whether the configured Codex was tested, and passes either way', async (t) => {
  const dirs = await paths(t);
  const rows: Record<string, unknown>[] = [];
  for (const version of ['0.158.0', '0.159.0']) {
    const binary = join(dirs.base, `codex-${version}`);
    await writeFile(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`);
    await chmod(binary, 0o755);
    const report = await doctor({
      workspace: dirs.workspace,
      stateDir: dirs.state,
      providers: { codex: { command: binary } },
    } as never);
    assert.equal(report.ok, true, JSON.stringify(report));
    rows.push(report.checks.find((row) => row.name === 'codex-cli')!);
  }
  assert.deepEqual(
    rows.map((row) => [row.version, row.tested]),
    [
      ['codex-cli 0.158.0', true],
      ['codex-cli 0.159.0', false],
    ],
  );
});

test('AC-0043-M01 a model Codex does not list ends the dispatch before its thread', async (t) => {
  const dirs = await paths(t);
  const refused = await dispatch(dirs, 'unlisted', 'gpt-zzz', { FIXTURE_MODELS: MODELS });
  assert.equal(
    refused.message,
    "CODEX_MODEL_UNLISTED: gpt-zzz is not among Codex's models: gpt-a, gpt-secret",
  );
  assert.equal(refused.outcome, 'failed');
  assert.equal(requested(refused.log, 'thread/start').length, 0);
  // A hidden model is listed.
  const hidden = await dispatch(dirs, 'hidden', 'gpt-secret', { FIXTURE_MODELS: MODELS });
  assert.equal(hidden.last?.type, 'result', hidden.message);
  // A list that says nothing, or cannot be read, cannot tell.
  const empty = await dispatch(dirs, 'empty', 'gpt-zzz', {});
  assert.equal(empty.last?.type, 'result', empty.message);
  const unreadable = await dispatch(dirs, 'unreadable', 'gpt-zzz', {
    FIXTURE_MODELS_ERROR: 'catalog unavailable',
  });
  assert.equal(unreadable.last?.type, 'result', unreadable.message);
});

test('AC-0043-M02 allowUnlistedModel lets such a model proceed, and needs connection', async (t) => {
  const dirs = await paths(t);
  const allowed = await dispatch(
    dirs,
    'allowed',
    'gpt-zzz',
    { FIXTURE_MODELS: MODELS },
    { allowUnlistedModel: true },
  );
  assert.equal(allowed.last?.type, 'result', allowed.message);
  assert.equal(requested(allowed.log, 'thread/start').length, 1);
  for (const config of [
    { executionStop: 'owner-reconcile', allowUnlistedModel: true },
    {
      executionStop: 'owner-reconcile',
      connection: { home: dirs.home },
      allowUnlistedModel: 'yes',
    },
  ])
    assert.throws(() => createCodexAdapter(config as never), { code: 'INVALID_ADAPTER_CONFIG' });
});
