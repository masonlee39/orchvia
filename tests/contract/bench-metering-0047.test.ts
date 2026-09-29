import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: the benchmark is plain JavaScript.
import { continuesTotals, costOf, directUsage, engineUsage, PRICES } from '../../bench/meter.mjs';

// SPEC-0047: every arm of the benchmark is counted the same way.

const root = fileURLToPath(new URL('../../', import.meta.url));
const MODEL = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';
// One request: a main loop, and calls outside it of the main model and of Haiku.
const result = (sessionId: string, totals: Record<string, number[]>) => ({
  type: 'result',
  session_id: sessionId,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
  },
  modelUsage: Object.fromEntries(
    Object.entries(totals).map(([key, [input, output, read, write]]) => [
      key,
      {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: read,
        cacheCreationInputTokens: write,
      },
    ]),
  ),
});
const first = result('s', { [MODEL]: [110, 25, 300, 50], [HAIKU]: [40, 8, 0, 10] });
const part = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
) => ({ model, input, output, cacheRead, cacheWrite });

test('AC-0047-M01 the direct arms count the main loop and every call outside it', () => {
  const metered = directUsage(first, MODEL);
  assert.deepEqual(metered.main, {
    ...part(MODEL, 100, 20, 300, 50),
    cacheWrite5m: 30,
    cacheWrite1h: 20,
  });
  assert.deepEqual(metered.outside, [part(MODEL, 10, 5, 0, 0), part(HAIKU, 40, 8, 0, 10)]);
  assert.deepEqual(metered.total, {
    ...part('*', 150, 33, 300, 60),
  });
});

test('AC-0047-M01 a resumed session subtracts its totals after the previous request', () => {
  const before = directUsage(first, MODEL);
  // Claude Code continues a resumed session's totals: the next result counts both requests.
  const next = result('s', { [MODEL]: [220, 50, 600, 100], [HAIKU]: [40, 8, 0, 10] });
  const metered = directUsage(next, MODEL, before.totals, true);
  assert.deepEqual(metered.outside, [part(MODEL, 10, 5, 0, 0)], 'Haiku was not called again');
  // Before Claude Code 2.1.277 each result counts its own query alone.
  const own = directUsage(first, MODEL, before.totals, false);
  assert.deepEqual(own.outside, before.outside);
  // Without knowing, the calls outside the main loop are unknown.
  const unsure = directUsage(first, MODEL, before.totals, undefined);
  assert.equal(unsure.outside[0].input, null);
  assert.equal(unsure.main.input, 100, 'the main loop is still known');
  // Totals that went down cannot be told apart: unknown, not zero.
  const odd = directUsage(result('s', { [MODEL]: [5, 5, 5, 5] }), MODEL, before.totals, true);
  assert.equal(odd.outside[0].input, null);
  assert.equal(odd.total.input, null);
});

test("AC-0047-M01 the version rule is the Claude adapter's", () => {
  assert.equal(continuesTotals('2.1.274'), false);
  assert.equal(continuesTotals('2.1.277'), true);
  assert.equal(continuesTotals('2.2.0'), true);
  assert.equal(continuesTotals(undefined), undefined);
});

test('AC-0047-M01 a missing count stays unknown', () => {
  const missing = directUsage(
    { ...first, usage: { ...first.usage, output_tokens: undefined } },
    MODEL,
  );
  assert.equal(missing.main.output, null);
  assert.equal(missing.total.output, null);
  assert.equal(costOf(missing.main).usd, null);
});

test('AC-0047-M02 the same calls meter the same through the engine', () => {
  const records = [
    {
      id: 'd:d:result',
      model: MODEL,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 50,
      cacheWrite5mInputTokens: 30,
      cacheWrite1hInputTokens: 20,
    },
    {
      id: `d:d:outside:${MODEL}`,
      model: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
    {
      id: `d:d:outside:${HAIKU}`,
      model: HAIKU,
      inputTokens: 40,
      outputTokens: 8,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 10,
    },
  ];
  const { main, outside, total } = directUsage(first, MODEL);
  assert.deepEqual(engineUsage(records, MODEL), { main, outside, total });
});

test('AC-0047-P01 each model at its own price, and each cache write at its own rate', () => {
  const sonnet = PRICES['claude-sonnet-5'];
  const haiku = PRICES['claude-haiku-4-5'];
  const metered = directUsage(first, MODEL);
  const main = costOf(metered.main);
  assert.equal(
    main.usd,
    (100 * sonnet.input +
      20 * sonnet.output +
      300 * sonnet.cacheRead +
      30 * sonnet.cacheWrite5m +
      20 * sonnet.cacheWrite1h) /
      1e6,
  );
  assert.equal(main.estimated5m, false);
  const outsideHaiku = costOf(metered.outside[1]);
  assert.equal(
    outsideHaiku.usd,
    (40 * haiku.input + 8 * haiku.output + 10 * haiku.cacheWrite5m) / 1e6,
  );
  assert.equal(outsideHaiku.estimated5m, true, 'no split: priced at the 5-minute rate, and marked');
  assert.equal(costOf(part('claude-unpriced-9', 1, 1, 0, 0)).usd, null);
});

test('AC-0047-R01 a fake run reports the parts and the prices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orchvia-bench-0047-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, 'report.json');
  const run = spawnSync(process.execPath, ['bench/run.mjs', '--fake', '--out', out], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(out, 'utf8'));
  assert.ok(report.prices['claude-haiku-4-5'], 'the price table');
  for (const arm of report.runs) {
    for (const request of arm.requests) {
      assert.ok(
        request.usage.main && Array.isArray(request.usage.outside) && request.usage.total,
        arm.arm,
      );
      assert.ok('unpricedParts' in request);
    }
    assert.ok(arm.totals.main && arm.totals.outside, arm.arm);
  }
});
