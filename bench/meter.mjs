// SPEC-0047: every arm of the benchmark is counted the same way, and priced per model.

// US dollars per million tokens: Anthropic's list prices, checked on 2026-09-23 at
// https://platform.claude.com/docs/en/about-claude/pricing. A cache write lasts 5 minutes or 1
// hour at different rates. A subscription plan is not billed per token; the estimate then
// measures usage, not a bill.
export const PRICES = {
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/**
 * Whether Claude Code continues a resumed session's totals: from 2.1.277, as the Claude adapter
 * decides (SPEC-0032 A01); undefined for a version it cannot read.
 */
export function continuesTotals(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major !== 2 ? major > 2 : minor !== 1 ? minor > 1 : patch >= 277;
}

/** A model's price: its own name, or its name before a date suffix such as `-20251001`. */
export function priceFor(model) {
  return PRICES[model] ?? PRICES[String(model).replace(/-\d{8}$/, '')];
}

/** Adds parts field by field; a field is unknown when any part's is. */
function sum(parts) {
  const total = { model: '*', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const part of parts)
    for (const field of FIELDS)
      total[field] =
        total[field] === null || part[field] === null ? null : total[field] + part[field];
  return total;
}

/**
 * One request of a direct arm, from the Agent SDK's result: its main loop from `usage`, and the
 * calls outside it from `modelUsage`, per model. For a resumed session, `previous` is its totals
 * after the previous request and `continues` whether Claude Code continued them (see
 * `continuesTotals`): they are then subtracted, and when that is unknown the calls outside the
 * main loop are too. `totals` is returned for the next request.
 */
export function directUsage(result, model, previous, continues) {
  const u = result.usage ?? {};
  const cacheWrite = count(u.cache_creation_input_tokens);
  const fiveMinutes = count(u.cache_creation?.ephemeral_5m_input_tokens);
  const oneHour = count(u.cache_creation?.ephemeral_1h_input_tokens);
  const main = {
    model,
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite,
    ...(cacheWrite !== null &&
    fiveMinutes !== null &&
    oneHour !== null &&
    fiveMinutes + oneHour === cacheWrite
      ? { cacheWrite5m: fiveMinutes, cacheWrite1h: oneHour }
      : {}),
  };
  const totals = {};
  const outside = [];
  for (const [key, entry] of Object.entries(result.modelUsage ?? {})) {
    const now = [
      count(entry?.inputTokens),
      count(entry?.outputTokens),
      count(entry?.cacheReadInputTokens),
      count(entry?.cacheCreationInputTokens),
    ];
    totals[key] = now;
    const earlier = !previous
      ? [0, 0, 0, 0]
      : continues === true
        ? (previous[key] ?? [0, 0, 0, 0])
        : continues === false
          ? [0, 0, 0, 0]
          : [null, null, null, null];
    const loop =
      key === model || String(key).replace(/-\d{8}$/, '') === model
        ? FIELDS.map((field) => main[field])
        : [0, 0, 0, 0];
    const rest = now.map((value, index) =>
      value === null ||
      earlier[index] === null ||
      loop[index] === null ||
      value - earlier[index] - loop[index] < 0
        ? null
        : value - earlier[index] - loop[index],
    );
    if (rest.every((value) => value === 0)) continue;
    outside.push({
      model: key,
      input: rest[0],
      output: rest[1],
      cacheRead: rest[2],
      cacheWrite: rest[3],
    });
  }
  return { main, outside, total: sum([main, ...outside]), totals };
}

/** One request of the orchvia arm, from the engine's usage records of its task. */
export function engineUsage(records, model) {
  const part = (record) => ({
    model: record.model ?? model,
    input: count(record.inputTokens),
    output: count(record.outputTokens),
    cacheRead: count(record.cachedInputTokens),
    cacheWrite: count(record.cacheWriteInputTokens),
    ...(record.cacheWrite5mInputTokens !== undefined && record.cacheWrite1hInputTokens !== undefined
      ? {
          cacheWrite5m: record.cacheWrite5mInputTokens,
          cacheWrite1h: record.cacheWrite1hInputTokens,
        }
      : {}),
  });
  const mains = records.filter((record) => !String(record.id).includes(':outside:')).map(part);
  const main = mains.length === 1 ? mains[0] : { ...sum(mains), model };
  const outside = records.filter((record) => String(record.id).includes(':outside:')).map(part);
  return { main, outside, total: sum([main, ...outside]) };
}

/**
 * A part's estimated cost: null when a count is unknown or the model has no price. A cache write
 * without its split is priced at the 5-minute rate, and `estimated5m` says so.
 */
export function costOf(part) {
  const price = priceFor(part.model);
  if (!price || FIELDS.some((field) => part[field] === null))
    return { usd: null, estimated5m: false };
  const split = part.cacheWrite5m !== undefined && part.cacheWrite1h !== undefined;
  const writes = split
    ? part.cacheWrite5m * price.cacheWrite5m + part.cacheWrite1h * price.cacheWrite1h
    : part.cacheWrite * price.cacheWrite5m;
  return {
    usd:
      (part.input * price.input +
        part.output * price.output +
        part.cacheRead * price.cacheRead +
        writes) /
      1e6,
    estimated5m: !split && part.cacheWrite > 0,
  };
}
