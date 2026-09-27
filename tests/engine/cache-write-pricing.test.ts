import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, validatePricing } from '../../packages/engine/src/accounting.ts';
import type { Pricing } from '../../packages/engine/src/types.ts';

// SPEC-0033 C (#45): cache writes that live five minutes and one hour take their own prices.

const pricing = (
  perMillion: Record<string, string>,
  inputTokenMode: 'total' | 'uncached' = 'uncached',
) =>
  ({
    provider: 'p',
    model: 'm',
    currency: 'USD',
    version: 'v1',
    inputTokenMode,
    perMillion: { input: '3', output: '15', ...perMillion },
  }) as Pricing;
const usage = (extra: Record<string, number> = {}) => ({
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 1_000_000,
  outputTokens: 0,
  ...extra,
});
const split = usage({ cacheWrite5mInputTokens: 600_000, cacheWrite1hInputTokens: 400_000 });

test('0033-C01 pricing accepts a five-minute and a one-hour cache write price', () => {
  const valid = validatePricing(pricing({ cacheWrite5m: '3.75', cacheWrite1h: '6' }));
  assert.deepEqual(valid.perMillion, {
    input: '3',
    output: '15',
    cacheWrite5m: '3.75',
    cacheWrite1h: '6',
  });
  for (const bad of [
    { cacheWrite5m: '-1' },
    { cacheWrite1h: 'six' },
    { cacheWrite2h: '1' },
  ] as Record<string, string>[])
    assert.throws(() => validatePricing(pricing(bad)), { code: 'VALIDATION_ERROR' });
});

test('0033-C02 a split record prices each duration at its own price', () => {
  const priced = priceUsage(
    split,
    pricing({ cacheWrite: '3.75', cacheWrite5m: '3.75', cacheWrite1h: '6' }),
  );
  // 3 input + 0.6 x 3.75 + 0.4 x 6.
  assert.equal(priced.amount, '7.65');
  assert.deepEqual(priced.tokens, {
    ordinary: 1_000_000,
    cached: 0,
    cacheWrite: 1_000_000,
    cacheWrite5m: 600_000,
    cacheWrite1h: 400_000,
    output: 0,
  });
  // Without its own price, a duration takes cacheWrite's.
  assert.equal(
    priceUsage(split, pricing({ cacheWrite: '3.75', cacheWrite1h: '6' })).amount,
    '7.65',
  );
  assert.equal(priceUsage(split, pricing({ cacheWrite: '4' })).amount, '7');
});

test('0033-C03 a record without a split takes cacheWrite, else its cost is unknown', () => {
  const tiers = { cacheWrite5m: '3.75', cacheWrite1h: '6' };
  assert.equal(priceUsage(usage(), pricing({ ...tiers, cacheWrite: '4' })).amount, '7');
  const missing = priceUsage(usage(), pricing(tiers));
  assert.equal(missing.amount, null);
  assert.equal(missing.completeness, 'unknown');
  assert.equal(missing.reason, 'cache_write_rate_missing');
  assert.equal('cacheWrite5m' in missing.tokens, false, 'no split, no durations');
  // A split whose duration has no price of its own and no cacheWrite is unknown too.
  assert.equal(
    priceUsage(split, pricing({ cacheWrite1h: '6' })).reason,
    'cache_write_rate_missing',
  );
});

test('0033-C04 total mode leaves the cache writes out of ordinary input once any write has a price', () => {
  const total = usage({ inputTokens: 2_000_000 });
  const splitTotal = {
    ...total,
    cacheWrite5mInputTokens: 600_000,
    cacheWrite1hInputTokens: 400_000,
  };
  // 1M ordinary x 3 + 0.6 x 3.75 + 0.4 x 6.
  assert.equal(
    priceUsage(splitTotal, pricing({ cacheWrite5m: '3.75', cacheWrite1h: '6' }, 'total')).amount,
    '7.65',
  );
  // With no cache write price at all, as before: every input token is ordinary.
  assert.equal(priceUsage(splitTotal, pricing({}, 'total')).amount, '6');
});
