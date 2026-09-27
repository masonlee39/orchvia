import { fail } from './errors.ts';
import { fields, integer, object, string } from './validation.ts';
import type {
  ContextEstimateInput,
  ContextEstimateResult,
  ContextEstimateScenario,
  Json,
  Pricing,
  MoneyBudget,
  UsageRecord,
} from './types.ts';
const SCALE = 18;
export function moneyUnits(value: string, scale = SCALE): bigint {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    fail('VALIDATION_ERROR', 'Money must be a nonnegative decimal string');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale)
    fail('VALIDATION_ERROR', `Money supports at most ${scale} decimal places`);
  return BigInt(whole + fraction.padEnd(scale, '0'));
}
export function moneyString(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const text = (units < 0n ? -units : units).toString().padStart(SCALE + 1, '0');
  const fraction = text.slice(-SCALE).replace(/0+$/, '');
  return sign + text.slice(0, -SCALE) + (fraction ? '.' + fraction : '');
}
export function validateBudget(value: unknown): MoneyBudget {
  const budget = object(value, 'budget');
  fields(budget, ['currency', 'maxCost', 'reservePerDispatch']);
  const currency = string(budget.currency, 'budget.currency', 3);
  if (!/^[A-Z]{3}$/.test(currency))
    fail('VALIDATION_ERROR', 'currency must be an ISO currency code');
  const maxCost = string(budget.maxCost, 'budget.maxCost', 64),
    reservePerDispatch = string(budget.reservePerDispatch, 'budget.reservePerDispatch', 64);
  if (moneyUnits(maxCost) < moneyUnits(reservePerDispatch) || moneyUnits(reservePerDispatch) <= 0n)
    fail('VALIDATION_ERROR', 'Budget reserve must be positive and at most maxCost');
  return { currency, maxCost, reservePerDispatch };
}
export function validatePricing(value: unknown): Pricing {
  const p = object(value, 'pricing');
  fields(p, ['provider', 'model', 'currency', 'version', 'inputTokenMode', 'perMillion']);
  const currency = string(p.currency, 'pricing.currency', 3);
  if (!/^[A-Z]{3}$/.test(currency) || !['total', 'uncached'].includes(String(p.inputTokenMode)))
    fail('VALIDATION_ERROR', 'Invalid currency or token accounting mode');
  const rates = object(p.perMillion, 'perMillion');
  // SPEC-0033 C01: cache writes may also be priced by how long they live.
  fields(rates, ['input', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'output']);
  for (const key of ['input', 'output'])
    if (rates[key] === undefined) fail('VALIDATION_ERROR', `Missing ${key} price`);
  for (const value of Object.values(rates)) moneyUnits(string(value, 'price', 64), 12);
  return {
    provider: string(p.provider, 'provider', 128),
    model: string(p.model, 'model', 256),
    currency,
    version: string(p.version, 'pricing.version', 128),
    inputTokenMode: p.inputTokenMode as Pricing['inputTokenMode'],
    perMillion: { ...rates } as Pricing['perMillion'],
  };
}
export type TokenUsage = Pick<
  UsageRecord,
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'outputTokens'
  | 'cacheWrite5mInputTokens'
  | 'cacheWrite1hInputTokens'
>;
export interface PricedUsage {
  currency: string;
  pricingVersion: string;
  amount: string | null;
  amountUnits: string | null;
  tokens: {
    ordinary: number | null;
    cached: number | null;
    cacheWrite: number | null;
    /** The cache writes by duration, only for a record with the split (SPEC-0033 C02). */
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    output: number | null;
  };
  completeness: 'estimated' | 'unknown';
  reason?: string;
}
/** Prices are per million; multiply integer token counts by 10^-18 currency units. */
export function priceUsage(usage: TokenUsage, rawPricing: Pricing): PricedUsage {
  const pricing = validatePricing(rawPricing);
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
  ] as const)
    if (usage[key] !== null) integer(usage[key], 'token count', 0);
  const cached = usage.cachedInputTokens,
    cacheWrite = usage.cacheWriteInputTokens;
  const rates = pricing.perMillion;
  // SPEC-0033 C02 to C04: cache writes leave ordinary input once any of their prices is set.
  const writesPriced =
    rates.cacheWrite !== undefined ||
    rates.cacheWrite5m !== undefined ||
    rates.cacheWrite1h !== undefined;
  const split =
    usage.cacheWrite5mInputTokens !== undefined && usage.cacheWrite1hInputTokens !== undefined;
  let ordinary = usage.inputTokens;
  if (pricing.inputTokenMode === 'total')
    ordinary =
      ordinary === null || cached === null || (writesPriced && cacheWrite === null)
        ? null
        : ordinary - cached - (writesPriced ? cacheWrite! : 0);
  const tokens = {
    ordinary,
    cached,
    cacheWrite,
    ...(split
      ? {
          cacheWrite5m: usage.cacheWrite5mInputTokens!,
          cacheWrite1h: usage.cacheWrite1hInputTokens!,
        }
      : {}),
    output: usage.outputTokens,
  };
  const base = { currency: pricing.currency, pricingVersion: pricing.version, tokens };
  if (Object.values(tokens).some((value) => value !== null && value < 0))
    return {
      ...base,
      amount: null,
      amountUnits: null,
      completeness: 'unknown',
      reason: 'overlapping_or_inconsistent_usage',
    };
  // Each duration takes its own price, else cacheWrite's; a record without the split takes
  // cacheWrite's. With no cache write price at all, total mode keeps them in ordinary input.
  const writes: [number | null, string | undefined][] =
    !writesPriced && pricing.inputTokenMode === 'total'
      ? []
      : split && writesPriced
        ? [
            [usage.cacheWrite5mInputTokens!, rates.cacheWrite5m ?? rates.cacheWrite],
            [usage.cacheWrite1hInputTokens!, rates.cacheWrite1h ?? rates.cacheWrite],
          ]
        : [[cacheWrite, rates.cacheWrite]];
  const buckets: [number | null, string | undefined, string][] = [
    [ordinary, rates.input, 'missing_usage_or_price'],
    [cached, rates.cacheRead, 'missing_usage_or_price'],
    ...writes.map(
      ([count, rate]) =>
        [
          count,
          rate,
          writesPriced && count !== null ? 'cache_write_rate_missing' : 'missing_usage_or_price',
        ] as [number | null, string | undefined, string],
    ),
    [usage.outputTokens, rates.output, 'missing_usage_or_price'],
  ];
  let amount = 0n;
  for (const [tokens, rate, reason] of buckets) {
    if (tokens === 0) continue;
    if (tokens === null || rate === undefined)
      return { ...base, amount: null, amountUnits: null, completeness: 'unknown', reason };
    amount += BigInt(tokens) * moneyUnits(rate, 12);
  }
  return {
    ...base,
    amount: moneyString(amount),
    amountUnits: amount.toString(),
    completeness: 'estimated',
  };
}

export function estimateStrategies(input: {
  pricing: Pricing;
  keep: TokenUsage[];
  compact: TokenUsage[];
  compaction: TokenUsage;
  intervalsKnown: boolean;
  recoveryCost?: string;
  qualityVerified?: boolean;
  measuredBenefit?: boolean;
}): {
  keep: { amount: string | null; requests: number };
  compact: { amount: string | null; requests: number };
  automaticSelection: false;
  reason: string;
} {
  const sum = (items: TokenUsage[], overhead = '0') => {
    let units = moneyUnits(overhead);
    for (const usage of items) {
      const priced = priceUsage(usage, input.pricing);
      if (priced.amountUnits === null) return { amount: null, requests: items.length };
      units += BigInt(priced.amountUnits);
    }
    return { amount: moneyString(units), requests: items.length };
  };
  if (input.keep.length > 1000 || input.compact.length > 1000)
    fail('VALIDATION_ERROR', 'At most 1000 predicted requests per strategy');
  return {
    keep: sum(input.keep),
    compact: sum([input.compaction, ...input.compact], input.recoveryCost),
    automaticSelection: false,
    reason: !input.intervalsKnown
      ? 'unknown_future_intervals'
      : !input.qualityVerified
        ? 'quality_unverified'
        : !input.measuredBenefit
          ? 'benefit_unverified'
          : 'explicit_owner_selection_required',
  };
}

/** Produce separate sustained-hit, TTL-rebuild and partial-prefix paths with explicit growth. */
export function estimateContext(
  input: Omit<ContextEstimateInput, 'provider' | 'model'> & { pricing: Pricing },
): ContextEstimateResult {
  if (input.requests === null)
    return { status: 'unknown', reason: 'unknown_future_request_count', automaticSelection: false };
  for (const key of [
    'keepHistoryTokens',
    'compactHistoryTokens',
    'growthTokens',
    'outputTokens',
    'retainedPrefixTokens',
    'ttlMs',
  ] as const)
    integer(input[key], key, 0);
  integer(input.requests, 'requests', 1, 1000);
  if (!Array.isArray(input.intervalsMs) || input.intervalsMs.length !== input.requests)
    fail('VALIDATION_ERROR', 'One observed/predicted interval is required per request');
  for (const value of input.intervalsMs) if (value !== null) integer(value, 'intervalMs', 0);
  const scenarios = {} as Record<
    'sustained_hit' | 'ttl_rebuild' | 'partial_prefix',
    ContextEstimateScenario
  >;
  const ranges: Record<'keep' | 'compact', bigint[]> = { keep: [], compact: [] };
  for (const scenario of ['sustained_hit', 'ttl_rebuild', 'partial_prefix'] as const) {
    const sequence = (history: number, compact: boolean): TokenUsage[] =>
      Array.from({ length: input.requests! }, (_, i) => {
        const total = history + i * input.growthTokens;
        const expired =
          scenario === 'ttl_rebuild' &&
          (input.intervalsMs[i] === null || input.intervalsMs[i]! > input.ttlMs);
        const cached = expired
          ? 0
          : scenario === 'partial_prefix' || (compact && i === 0)
            ? Math.min(input.retainedPrefixTokens, total)
            : total;
        const write = expired && input.pricing.perMillion.cacheWrite !== undefined ? total : 0;
        return {
          inputTokens: input.pricing.inputTokenMode === 'total' ? total : total - cached - write,
          cachedInputTokens: cached,
          cacheWriteInputTokens: write,
          outputTokens: input.outputTokens,
        };
      });
    const keep = sequence(input.keepHistoryTokens, false),
      compact = sequence(input.compactHistoryTokens, true);
    const comparison = estimateStrategies({
      pricing: input.pricing,
      keep,
      compact,
      compaction: input.compaction,
      intervalsKnown: input.intervalsMs.every((x) => x !== null),
    });
    for (const key of ['keep', 'compact'] as const)
      if (comparison[key].amount !== null) ranges[key].push(moneyUnits(comparison[key].amount));
    scenarios[scenario] = { ...comparison, keepRequests: keep, compactRequests: compact };
  }
  const range = (values: bigint[]) =>
    values.length !== 3
      ? null
      : {
          min: moneyString(values.reduce((a, b) => (a < b ? a : b))),
          max: moneyString(values.reduce((a, b) => (a > b ? a : b))),
          currency: input.pricing.currency,
        };
  return {
    scenarios,
    range: { keep: range(ranges.keep), compact: range(ranges.compact) },
    assumptions: input as unknown as Json,
    automaticSelection: false,
    cacheHitsGuaranteed: false,
  };
}
