import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

// SPEC-0042 E and C02: reasoning effort for the local Codex member, and the bridge's error code.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const efforts = (...names: string[]) =>
  names.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
// Two pages: a listed model, then a hidden one that only includeHidden shows.
const MODELS = JSON.stringify([
  [
    {
      id: 'gpt-a',
      model: 'gpt-a',
      supportedReasoningEfforts: efforts('low', 'medium', 'high'),
      defaultReasoningEffort: 'medium',
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
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0042-')));
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
const entries = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const requested = (log: string, method: string) =>
  entries(log).filter((entry) => entry.event === 'request' && entry.method === method);

async function dispatch(
  dirs: Paths,
  name: string,
  options: {
    env?: Record<string, string>;
    policy?: Record<string, unknown>;
    model?: string;
    config?: Record<string, unknown>;
    input?: Partial<RuntimeInput>;
  } = {},
) {
  const log = join(dirs.base, `${name}.log`);
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: dirs.user, FIXTURE_LOG: log, FIXTURE_MODELS: MODELS, ...options.env },
    connection: { home: dirs.home },
    executionStop: 'owner-reconcile',
    policy: () => ({ mode: 'auto', ...options.policy }) as never,
    ...options.config,
  } as never);
  const events: RuntimeEvent[] = [];
  const evidence: ExecutionEvidence[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: name,
      providerSessionId: null,
      model: options.model ?? 'gpt-a',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: dirs.workspace,
      stateDir: dirs.state,
      signal: new AbortController().signal,
      reportExecutionEvidence: (item: ExecutionEvidence) => evidence.push(item),
      ...options.input,
    } as RuntimeInput))
      events.push(event);
  } finally {
    await adapter.close?.();
  }
  const last = events.at(-1);
  return {
    log,
    events,
    evidence,
    last,
    message: last?.type === 'error' ? last.message : '',
    outcome: (last as { outcome?: string } | undefined)?.outcome,
    usage: events.filter((event) => event.type === 'usage') as Extract<
      RuntimeEvent,
      { type: 'usage' }
    >[],
  };
}
const effortOf = (usage: { usage: { raw: unknown } }) =>
  (usage.usage.raw as { _reasoningEffort?: unknown } | null)?._reasoningEffort;

test('AC-0042-E01 an effort is an open string; a malformed one is a policy error', async (t) => {
  const dirs = await paths(t);
  for (const effort of ['', 'a b', 'x'.repeat(65), 5, 'high\n'] as unknown[]) {
    const result = await dispatch(dirs, `bad-${String(effort).length}`, { policy: { effort } });
    assert.match(result.message, /^CODEX_POLICY_INVALID: /, JSON.stringify(effort));
    assert.equal(entries(result.log).length, 0, 'no app-server was started');
  }
  // A value Codex may add later passes the policy; the model list is what refuses it.
  const future = await dispatch(dirs, 'future', {
    policy: { effort: 'hyper-2' },
    model: 'gpt-unlisted',
    config: { allowUnlistedModel: true },
  });
  assert.equal(future.last?.type, 'result', future.message);
});

test('AC-0042-E02 an effort the listed model lacks ends the dispatch before its thread', async (t) => {
  const dirs = await paths(t);
  const refused = await dispatch(dirs, 'hidden', {
    policy: { effort: 'high' },
    model: 'gpt-secret',
  });
  assert.equal(
    refused.message,
    'CODEX_EFFORT_UNSUPPORTED: gpt-secret supports low; high was requested',
  );
  assert.equal(refused.outcome, 'failed');
  assert.equal(requested(refused.log, 'thread/start').length, 0, 'no thread was opened');
  assert.equal(requested(refused.log, 'turn/start').length, 0, 'no model request');
  assert.ok(
    refused.evidence.some(
      (item) => item.source === 'pre_submission' && item.remoteExecution === 'stopped',
    ),
    JSON.stringify(refused.evidence),
  );
  // Every page was read, hidden models included.
  assert.deepEqual(
    requested(refused.log, 'model/list').map((entry) => entry.params),
    [{ includeHidden: true }, { includeHidden: true, cursor: 'page-1' }],
  );
  const supported = await dispatch(dirs, 'supported', {
    policy: { effort: 'high' },
    model: 'gpt-a',
  });
  assert.equal(supported.last?.type, 'result', supported.message);
});

test('AC-0042-E03 a given effort reaches turn/start; none leaves it out', async (t) => {
  const dirs = await paths(t);
  const high = await dispatch(dirs, 'high', { policy: { effort: 'high' } });
  assert.equal(requested(high.log, 'turn/start')[0].params.effort, 'high');
  const none = await dispatch(dirs, 'none');
  assert.equal(Object.hasOwn(requested(none.log, 'turn/start')[0].params, 'effort'), false);
});

test('AC-0042-E04 each usage record says which effort it ran with', async (t) => {
  const dirs = await paths(t);
  const usage = { FIXTURE_USAGE: '1' };
  const cases = [
    [
      'requested',
      { effort: 'high' },
      'gpt-a',
      {},
      { requested: 'high', effective: 'high', source: 'requested' },
    ],
    ['default', {}, 'gpt-a', {}, { requested: null, effective: 'medium', source: 'modelDefault' }],
    [
      'unlisted',
      { effort: 'ultra' },
      'gpt-x',
      {},
      { requested: 'ultra', effective: 'ultra', source: 'unverified' },
    ],
    [
      'unlisted default',
      {},
      'gpt-x',
      {},
      { requested: null, effective: null, source: 'unverified' },
    ],
    [
      'list failed',
      { effort: 'low' },
      'gpt-a',
      { FIXTURE_MODELS_ERROR: 'catalog unavailable' },
      { requested: 'low', effective: 'low', source: 'unverified' },
    ],
  ] as const;
  for (const [name, policy, model, env, expected] of cases) {
    const result = await dispatch(dirs, name.replace(/ /g, '-'), {
      policy,
      model,
      env: { ...usage, ...env },
      // SPEC-0043 M02: a model Codex does not list proceeds only when the host allows it.
      ...(model === 'gpt-x' ? { config: { allowUnlistedModel: true } } : {}),
    });
    assert.equal(result.last?.type, 'result', `${name}: ${result.message}`);
    assert.ok(result.usage.length > 0, `${name}: usage was reported`);
    for (const record of result.usage) assert.deepEqual(effortOf(record), expected, name);
  }
  // A turn that reports no usage still leaves a record of its effort.
  const missing = await dispatch(dirs, 'missing', { policy: { effort: 'low' } });
  assert.deepEqual(effortOf(missing.usage.at(-1)!), {
    requested: 'low',
    effective: 'low',
    source: 'requested',
  });
});

test('AC-0042-C02 a tool bridge Codex cannot start has its own code', async (t) => {
  const dirs = await paths(t);
  const result = await dispatch(dirs, 'bridge', {
    env: {
      FIXTURE_THREAD_FAIL_ONCE:
        'error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: agent_orch: No such file or directory (os error 2)',
    },
  });
  assert.match(result.message, /^CODEX_TOOL_BRIDGE_UNAVAILABLE: .*agent_orch/);
  assert.equal(result.outcome, 'failed');
});
