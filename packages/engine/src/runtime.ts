import { fail } from './errors.ts';
import type {
  EngineRuntimeInput,
  Json,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInput,
} from './types.ts';

function invalid(field: string): never {
  fail('INVALID_RUNTIME_CONTRACT', `Invalid runtime contract field: ${field}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Detached JSON only: declarations cannot change an admitted dispatch through shared references. */
function snapshot(value: unknown): Json {
  const ancestors = new Set<object>();
  let values = 0;
  function copy(value: unknown, field: string, depth: number): Json {
    if (++values > 10000 || depth > 32) invalid('capabilities traversal limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') invalid(field);
    if (ancestors.has(value)) invalid(field);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) invalid(field);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const result: Json[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) invalid(field);
          result.push(copy(value[i], `${field}[]`, depth + 1));
        }
        return Object.freeze(result) as unknown as Json[];
      }
      const result: Record<string, Json> = {};
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        // Defining an own data property also preserves a literal __proto__ extension safely.
        Object.defineProperty(result, key, {
          value: copy(child, `${field}.${key}`, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  }
  return copy(value, 'capabilities', 0);
}

/** No model or host work is performed by this synchronous capability preflight. */
/** Validates the provider name a bundled adapter registers under; `fallback` is its default. */
export function adapterProviderName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw Object.assign(new Error('Invalid adapter provider name'), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  return value;
}
export function readRuntimeCapabilities(adapter: RuntimeAdapter): RuntimeCapabilities {
  if (!nonempty(adapter.provider)) invalid('provider');
  let raw: unknown;
  try {
    raw = adapter.capabilities();
  } catch {
    invalid('capabilities()');
  }
  if (raw instanceof Promise) {
    // Observe a rejected async declaration without treating it as supported capabilities.
    void raw.catch(() => {});
    invalid('capabilities() must be synchronous');
  }
  let value: Json;
  try {
    value = snapshot(raw);
  } catch (error) {
    if (record(error) && error.code === 'INVALID_RUNTIME_CONTRACT') throw error;
    invalid('capabilities');
  }
  if (!record(value)) invalid('capabilities');
  if (value.provider !== adapter.provider) invalid('provider');
  for (const key of ['resume', 'interrupt']) if (typeof value[key] !== 'boolean') invalid(key);
  const profiles = value.permissionProfiles;
  if (
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    new Set(profiles).size !== profiles.length ||
    profiles.some((p) => p !== 'read-only' && p !== 'workspace-write')
  )
    invalid('permissionProfiles');
  const budget = value.executionBudget;
  if (!record(budget) || budget.version !== 2)
    fail(
      'UNSUPPORTED_CAPABILITY',
      `Provider ${adapter.provider} requires executionBudget version 2`,
    );
  for (const key of ['acceptanceCapMs', 'turnCapMs'])
    if (budget[key] !== null && (!positive(budget[key]) || budget[key] > 86400000))
      invalid(`executionBudget.${key}`);
  if (Object.hasOwn(value, 'executionEvidence')) {
    const evidence = value.executionEvidence;
    if (!record(evidence)) invalid('executionEvidence');
    if (evidence.version !== 1)
      fail(
        'UNSUPPORTED_CAPABILITY',
        `Provider ${adapter.provider} requires executionEvidence version 1`,
      );
    if (typeof evidence.terminalCoversExecution !== 'boolean')
      invalid('executionEvidence.terminalCoversExecution');
  }
  for (const key of ['forkModelChange', 'readFence', 'steer'])
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') invalid(key);
  return value as unknown as RuntimeCapabilities;
}

/** Check the engine-only context before an existing host accepts any work. Not authentication. */
export function requireEngineRuntimeInput(input: RuntimeInput): EngineRuntimeInput {
  if (!record(input)) invalid('input');
  for (const key of ['taskId', 'sessionId', 'dispatchId'] as const)
    if (!nonempty(input[key])) invalid(key);
  if (!positive(input.generation)) invalid('generation');
  const budget = input.executionBudget;
  if (!record(budget) || budget.policyVersion !== 2) invalid('executionBudget');
  if (!positive(budget.effectiveAcceptanceMs) || !positive(budget.effectiveTurnMs))
    invalid('executionBudget.effective limits');
  if (budget.effectiveAcceptanceMs > budget.effectiveTurnMs)
    invalid('executionBudget.effectiveAcceptanceMs');
  for (const key of ['remainingAcceptanceMs', 'remainingTurnMs'])
    if (typeof budget[key] !== 'function') invalid(`executionBudget.${key}`);
  if (typeof input.reportExecutionEvidence !== 'function') invalid('reportExecutionEvidence');
  const signal = input.signal;
  if (
    !signal ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  )
    invalid('signal');
  return input as EngineRuntimeInput;
}
