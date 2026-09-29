import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0045 U01: a local Codex dispatch says its usage is complete only when it can show it.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const MODELS = JSON.stringify([[{ id: 'gpt-a', model: 'gpt-a' }]]);
const counts = (input: number, cached: number, output: number) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  totalTokens: input + output,
});

async function complete(
  t: any,
  env: Record<string, string>,
  input: Partial<RuntimeInput> = {},
): Promise<boolean | undefined> {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0045-u-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of ['workspace', 'state', 'codex-home', 'user']) await mkdir(join(base, dir));
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: join(base, 'user'), FIXTURE_MODELS: MODELS, ...env },
    connection: { home: join(base, 'codex-home') },
    executionStop: 'owner-reconcile',
    policy: () => ({ mode: 'auto' }),
  } as never);
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'gpt-a',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: join(base, 'workspace'),
      stateDir: join(base, 'state'),
      signal: new AbortController().signal,
      reportExecutionEvidence: () => {},
      ...input,
    } as RuntimeInput))
      events.push(event);
  } finally {
    await adapter.close?.();
  }
  const last = events.at(-1);
  assert.equal(last?.type, 'result', JSON.stringify(last));
  return (last as { usageComplete?: boolean }).usageComplete;
}
const usage = (...observations: object[]) => ({ FIXTURE_USAGE: JSON.stringify(observations) });

test('AC-0045-U01 a new thread whose totals start at its first request is complete', async (t) => {
  assert.equal(await complete(t, { FIXTURE_USAGE: '1' }), true, 'one observation');
  assert.equal(
    await complete(
      t,
      usage(
        { last: counts(10, 0, 2), total: counts(10, 0, 2) },
        { last: counts(12, 1, 3), total: counts(22, 1, 5) },
      ),
    ),
    true,
    'two, as differences of the totals',
  );
});

test('AC-0045-U01 a resumed thread is complete from the totals of its last dispatch', async (t) => {
  const resumed = {
    providerSessionId: 'thread',
    usageBaseline: { dispatchId: 'earlier', totals: { codexThreadTotal: counts(10, 0, 2) } },
  } as Partial<RuntimeInput>;
  const next = usage({ last: counts(12, 1, 3), total: counts(22, 1, 5) });
  assert.equal(await complete(t, next, resumed), true);
  assert.equal(
    await complete(t, next, { providerSessionId: 'thread' }),
    undefined,
    'without its baseline the first count is only the last request',
  );
});

test('AC-0045-U01 anything it cannot show leaves usage unconfirmed', async (t) => {
  const cases: [string, Record<string, string>][] = [
    ['no usage', {}],
    [
      'a first total larger than its request',
      usage({ last: counts(12, 1, 3), total: counts(22, 1, 5) }),
    ],
    ['no totals', usage({ last: counts(12, 1, 3) })],
    ['a count missing', usage({ last: { inputTokens: 5 }, total: { inputTokens: 5 } })],
    ['a compaction', { FIXTURE_USAGE: '1', FIXTURE_COMPACTION: '1' }],
  ];
  for (const [name, env] of cases) assert.equal(await complete(t, env), undefined, name);
});
