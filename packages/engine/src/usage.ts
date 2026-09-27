import { fail } from './errors.ts';
import type { Json, RuntimeUsageEvent, UsageRecord } from './types.ts';

function invalid(): never {
  fail('INVALID_RUNTIME_CONTRACT', 'Usage must contain valid token counts and bounded JSON');
}

/** Snapshot observations before a caller can mutate raw JSON after persistence. */
export function usageRecord(
  event: RuntimeUsageEvent,
  identity: Pick<UsageRecord, 'taskId' | 'dispatchId' | 'provider'>,
): UsageRecord {
  if (
    !event ||
    event.type !== 'usage' ||
    typeof event.usageId !== 'string' ||
    !event.usageId.trim() ||
    event.usageId.length > 256 ||
    !event.usage ||
    typeof event.usage !== 'object' ||
    Array.isArray(event.usage)
  )
    invalid();
  const keys = [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
  ] as const;
  const durations = ['cacheWrite5mInputTokens', 'cacheWrite1hInputTokens'] as const;
  if (
    Object.keys(event.usage).some((key) => ![...keys, ...durations, 'model', 'raw'].includes(key))
  )
    invalid();
  // SPEC-0031 B01: the model that served the calls, when the runtime names it.
  const model = event.usage.model;
  if (model !== undefined && (typeof model !== 'string' || !model || model.length > 256))
    fail('INVALID_RUNTIME_CONTRACT', 'A usage observation names its model in 1 to 256 characters');
  for (const key of keys) {
    const value = event.usage[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) invalid();
  }
  // SPEC-0030 A02: both durations or neither, and together they are the cache writes. A missing
  // one is not a safe integer, so one duration alone is refused as well.
  const split = durations.some((key) => event.usage[key] !== undefined);
  if (
    split &&
    (durations.some((key) => !Number.isSafeInteger(event.usage[key]) || event.usage[key]! < 0) ||
      event.usage.cacheWrite5mInputTokens! + event.usage.cacheWrite1hInputTokens! !==
        event.usage.cacheWriteInputTokens)
  )
    fail(
      'INVALID_RUNTIME_CONTRACT',
      'Cache writes by duration must be two counts that add up to cacheWriteInputTokens',
    );
  let raw: Json;
  try {
    raw = boundedJson(event.usage.raw, 512 * 1024);
  } catch {
    invalid();
  }
  return {
    ...identity,
    id: `${identity.dispatchId}:${event.usageId}`,
    inputTokens: event.usage.inputTokens,
    cachedInputTokens: event.usage.cachedInputTokens,
    cacheWriteInputTokens: event.usage.cacheWriteInputTokens,
    ...(split
      ? {
          cacheWrite5mInputTokens: event.usage.cacheWrite5mInputTokens,
          cacheWrite1hInputTokens: event.usage.cacheWrite1hInputTokens,
        }
      : {}),
    outputTokens: event.usage.outputTokens,
    ...(model !== undefined ? { model } : {}),
    raw,
  };
}

/**
 * A detached copy of the native session totals an observation carries, at most 64 KiB, or
 * undefined when it carries none (SPEC-0032 E05).
 */
export function usageTotals(event: RuntimeUsageEvent): Json | undefined {
  if (event.sessionTotals === undefined) return undefined;
  try {
    return boundedJson(event.sessionTotals, 64 * 1024);
  } catch {
    invalid();
  }
}

/** Plain JSON only: no cycles, prototypes, holes or non-finite numbers, and at most `bytes`. */
function boundedJson(input: unknown, bytes: number): Json {
  const ancestors = new Set<object>();
  let count = 0;
  function copy(value: unknown, depth = 0): Json {
    if (++count > 100000 || depth > 32) invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const result: Json[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) invalid();
          result.push(copy(value[i], depth + 1));
        }
        return result;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) invalid();
      const result: Record<string, Json> = {};
      for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(result, key, { value: copy(child, depth + 1), enumerable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  const copied = copy(input);
  if (Buffer.byteLength(JSON.stringify(copied)) > bytes) invalid();
  return copied;
}

/**
 * The fields that records held before SPEC-0028 E01: identity, token counts and raw. A repeated
 * report of an observation is compared on these, so its later time does not make it a conflict.
 */
export function reportedUsage(record: UsageRecord): UsageRecord {
  const {
    sessionId: _session,
    model: _model,
    rootTaskId: _root,
    recordedAt: _at,
    ...reported
  } = record;
  return reported;
}
