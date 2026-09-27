import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import type { Json, RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';

// SPEC-0032 A: from Claude Code 2.1.277 on, a resumed or forked session's `modelUsage` continues
// from its earlier dispatches. The adapter subtracts the totals of the dispatch before.

type UsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
const MODEL = 'claude-sonnet-4-6';
const NATIVE = 'native-session';
const mainLoop = {
  input_tokens: 1000,
  output_tokens: 30,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 12,
};
/** A `modelUsage` entry; counts are input, cache read, cache write, output. */
const entry = (counts: number[], extra: Record<string, unknown> = {}) => ({
  inputTokens: counts[0],
  cacheReadInputTokens: counts[1],
  cacheCreationInputTokens: counts[2],
  outputTokens: counts[3],
  webSearchRequests: 0,
  costUSD: 0.01,
  contextWindow: 200000,
  maxOutputTokens: 32000,
  ...extra,
});
const totals = (models: Record<string, number[]>, sessionId = NATIVE, cumulative = true) => ({
  version: 1,
  sessionId,
  cumulative,
  models,
});
const unknown = {
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
};

interface Case {
  version?: string;
  modelUsage: Record<string, unknown>;
  resume?: boolean;
  fork?: boolean;
  baseline?: { dispatchId: string; totals: Json } | null;
}
/** One scripted dispatch; returns its observations and the totals its main observation carries. */
async function observe(c: Case) {
  const reported: UsageEvent[] = [];
  const observed = c.fork ? 'forked-session' : NATIVE;
  const adapter = createClaudeAdapter({
    query: withClaudeProcess(() =>
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: observed,
          ...(c.version !== undefined ? { claude_code_version: c.version } : {}),
        };
        // A notice raised during the turn is ignored like any unrecognized system message (B01).
        yield { type: 'system', subtype: 'informational', session_id: observed, text: 'notice' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: observed,
          result: 'done',
          usage: mainLoop,
          modelUsage: c.modelUsage,
        };
      })(),
    ),
  });
  const input = {
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: c.resume ? NATIVE : null,
    ...(c.fork
      ? {
          forkSource: {
            sessionId: 'source',
            generation: 1,
            providerSessionId: NATIVE,
            nativeCheckpoint: 'point',
            snapshotRef: 'sha256:' + '0'.repeat(64),
          },
        }
      : {}),
    ...(c.baseline !== undefined ? { usageBaseline: c.baseline } : {}),
    workspace: process.cwd(),
    stateDir: '/private/tmp/unused-session-usage-state',
    model: MODEL,
    prompt: 'fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportUsage: (event: UsageEvent) => reported.push(event),
  } as RuntimeInput;
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute(input)) events.push(event);
  } finally {
    await adapter.close();
  }
  assert.ok(
    events.some((event) => event.type === 'result'),
    JSON.stringify(events),
  );
  const usage = events.filter((event): event is UsageEvent => event.type === 'usage');
  assert.deepEqual(reported, usage);
  return {
    outside: usage.slice(1).map(({ usageId, usage }) => ({ usageId, usage })),
    totals: (usage[0] as UsageEvent & { sessionTotals?: Json }).sessionTotals,
  };
}
const outside = (counts: number[], raw: unknown, model?: string) => ({
  usageId: `dispatch:outside:${model ?? MODEL}`,
  usage: {
    inputTokens: counts[0],
    cachedInputTokens: counts[1],
    cacheWriteInputTokens: counts[2],
    outputTokens: counts[3],
    ...(model ? { model } : {}),
    raw,
  },
});

test('0032-A01 a resumed dispatch on Claude Code 2.1.277 or later subtracts the totals before it', async () => {
  // 198000/5/312/750 before this dispatch, as in the reproduction; this dispatch adds its main
  // loop's 1000/5/12/30 and 7000/0/300/700 outside it.
  const cumulative = entry([206000, 10, 624, 1480]);
  const { outside: observed } = await observe({
    version: '2.1.283',
    resume: true,
    modelUsage: { [MODEL]: cumulative },
    baseline: { dispatchId: 'before', totals: totals({ [MODEL]: [198000, 5, 312, 750] }) },
  });
  assert.deepEqual(observed, [outside([7000, 0, 300, 700], cumulative)]);
  // A plain second dispatch: everything is its main loop, so nothing is outside it.
  const plain = await observe({
    version: '2.1.283',
    resume: true,
    modelUsage: { [MODEL]: entry([2000, 10, 24, 60]) },
    baseline: { dispatchId: 'before', totals: totals({ [MODEL]: [1000, 5, 12, 30] }) },
  });
  assert.deepEqual(plain.outside, []);
});

test('0032-A01 an earlier Claude Code keeps per-query totals and ignores a baseline', async () => {
  const perQuery = entry([8000, 5, 312, 730]);
  const { outside: observed } = await observe({
    version: '2.1.274',
    resume: true,
    modelUsage: { [MODEL]: perQuery },
    baseline: { dispatchId: 'before', totals: totals({ [MODEL]: [1000, 5, 12, 30] }) },
  });
  assert.deepEqual(observed, [outside([7000, 0, 300, 700], perQuery)]);
});

test('0032-A02 the main observation carries the native session’s totals after the dispatch', async () => {
  const later = await observe({
    version: '2.1.283',
    resume: true,
    modelUsage: { [MODEL]: entry([2000, 10, 24, 60]), 'vendor-model': entry([3, 0, 0, 1]) },
    baseline: { dispatchId: 'before', totals: totals({ [MODEL]: [1000, 5, 12, 30] }) },
  });
  assert.deepEqual(
    later.totals,
    totals({ [MODEL]: [2000, 10, 24, 60], 'vendor-model': [3, 0, 0, 1] }),
  );
  const earlier = await observe({
    version: '2.1.274',
    modelUsage: { [MODEL]: entry([1, 0, 0, 1]) },
  });
  assert.deepEqual(earlier.totals, totals({ [MODEL]: [1, 0, 0, 1] }, NATIVE, false));
  // A result without complete counts has no totals to carry.
  const partial = await observe({
    version: '2.1.283',
    modelUsage: { [MODEL]: { inputTokens: 1 } },
  });
  assert.equal(partial.totals, undefined);
});

test('0032-A03 a resumed cumulative dispatch without a usable baseline is unknown outside its main loop', async () => {
  const cumulative = { [MODEL]: entry([2000, 10, 24, 60]) };
  const cases: [string, Partial<Case>][] = [
    ['no baseline', { baseline: null }],
    ['absent baseline', {}],
    [
      'another native session',
      { baseline: { dispatchId: 'b', totals: totals({ [MODEL]: [1, 0, 0, 1] }, 'other') } },
    ],
    [
      'per-query baseline',
      {
        baseline: {
          dispatchId: 'b',
          totals: totals({ [MODEL]: [1000, 5, 12, 30] }, NATIVE, false),
        },
      },
    ],
    ['malformed baseline', { baseline: { dispatchId: 'b', totals: { models: 'x' } } }],
  ];
  for (const [name, extra] of cases)
    assert.deepEqual(
      (await observe({ version: '2.1.283', resume: true, modelUsage: cumulative, ...extra }))
        .outside,
      [{ usageId: 'dispatch:outside:unknown', usage: { ...unknown, raw: cumulative } }],
      name,
    );
  // Without a version, whether totals continue is unknown too.
  assert.deepEqual(
    (
      await observe({
        resume: true,
        modelUsage: cumulative,
        baseline: { dispatchId: 'b', totals: totals({ [MODEL]: [1000, 5, 12, 30] }) },
      })
    ).outside,
    [{ usageId: 'dispatch:outside:unknown', usage: { ...unknown, raw: cumulative } }],
  );
});

test('0032-A04 a key below its baseline is unknown; a new session needs no baseline', async () => {
  const below = entry([500, 5, 12, 30]);
  const { outside: observed } = await observe({
    version: '2.1.283',
    resume: true,
    modelUsage: { [MODEL]: entry([2000, 10, 24, 60]), 'vendor-model': below },
    baseline: {
      dispatchId: 'b',
      totals: totals({ [MODEL]: [1000, 5, 12, 30], 'vendor-model': [900, 5, 12, 30] }),
    },
  });
  assert.deepEqual(observed, [
    {
      usageId: 'dispatch:outside:vendor-model',
      usage: { ...unknown, model: 'vendor-model', raw: below },
    },
  ]);
  // The first dispatch of a new native session starts from zero on every version.
  const fresh = entry([8000, 5, 312, 730]);
  assert.deepEqual(
    (await observe({ version: '2.1.283', modelUsage: { [MODEL]: fresh } })).outside,
    [outside([7000, 0, 300, 700], fresh)],
  );
});

test('0032-A05 a fork’s first dispatch subtracts its source’s totals', async () => {
  // The reproduction: the fork's result showed 3000 after its source's 2000.
  const cumulative = entry([3000, 15, 36, 90]);
  const forked = await observe({
    version: '2.1.283',
    fork: true,
    modelUsage: { [MODEL]: cumulative },
    baseline: { dispatchId: 'source-latest', totals: totals({ [MODEL]: [2000, 10, 24, 60] }) },
  });
  assert.deepEqual(forked.outside, []);
  assert.deepEqual(
    forked.totals,
    totals({ [MODEL]: [3000, 15, 36, 90] }, 'forked-session'),
    'the fork’s totals name the fork',
  );
});

test('0032-B02 the host’s environment reaches Claude Code unchanged, and the adapter sets none', async () => {
  const seen: Record<string, unknown>[] = [];
  const run = async (extendOptions?: () => Record<string, unknown>) => {
    const adapter = createClaudeAdapter({
      ...(extendOptions ? { extendOptions, executionStop: 'owner-reconcile' as const } : {}),
      query: withClaudeProcess((request) => {
        seen.push({ ...(request.options as Record<string, unknown>) });
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: NATIVE };
          yield { type: 'result', subtype: 'success', session_id: NATIVE, result: 'done' };
        })();
      }),
    });
    const input = {
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      workspace: process.cwd(),
      stateDir: '/private/tmp/unused-session-usage-state',
      model: MODEL,
      prompt: 'fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
    } as RuntimeInput;
    try {
      for await (const _ of adapter.execute(input));
    } finally {
      await adapter.close();
    }
  };
  await run();
  assert.equal(seen[0].env, undefined, 'without the host, the SDK uses the process environment');
  const env = { PATH: '/usr/bin', CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  await run(() => ({ env }));
  assert.deepEqual(seen[1].env, env);
});
