import { createHash } from 'node:crypto';
import { validateBudget } from './accounting.ts';
import { fail } from './errors.ts';
import type { TaskSpec, MessageSpec, ContextPlan, RoutingMode, Json } from './types.ts';

export function object(value: unknown, name = 'params'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('VALIDATION_ERROR', `${name} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((k) => !allowed.includes(k));
  if (unknown) fail('VALIDATION_ERROR', `Unknown field: ${unknown}`);
}
export function string(value: unknown, name: string, max = 65536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail('VALIDATION_ERROR', `${name} must be a nonempty string (max ${max})`);
  return value;
}
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail('VALIDATION_ERROR', `${name} must be an integer between ${min} and ${max}`);
  return value as number;
}
export function strings(value: unknown, name: string, min = 0, max = 100): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail('VALIDATION_ERROR', `${name} must contain ${min}..${max} strings`);
  return value.map((v: unknown) => string(v, name));
}
/** A host label: a string of 1 to 256 UTF-8 bytes (SPEC-0027 L01). */
export function label(value: unknown, name = 'label'): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256)
    fail('VALIDATION_ERROR', `${name} must be a string of 1 to 256 UTF-8 bytes`);
  return value;
}
/** Host metadata: a JSON object of at most 4096 bytes when encoded and 16 levels (SPEC-0027 L01). */
export function metadata(value: unknown, name = 'metadata'): { [key: string]: Json } {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    // Not JSON: refused below.
  }
  const copy = encoded === undefined ? undefined : (JSON.parse(encoded) as unknown);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    fail('VALIDATION_ERROR', `${name} must be a JSON object`);
  if (Buffer.byteLength(encoded!) > 4096)
    fail('VALIDATION_ERROR', `${name} must be at most 4096 bytes when encoded as JSON`);
  const depth = (item: unknown): number =>
    item && typeof item === 'object'
      ? 1 + Math.max(0, ...Object.values(item).map((child) => depth(child)))
      : 0;
  if (depth(copy) > 16) fail('VALIDATION_ERROR', `${name} must be at most 16 levels deep`);
  return copy as { [key: string]: Json };
}
/** The longest queue wait a task or the host default may request (SPEC-0015 Q03). */
export const MAX_QUEUE_WAIT_MS = 604800000;
/** Context references as `contextPlan` and `context.checkRefs` accept them, `min` to 20 entries. */
export function contextRefs(value: unknown, min = 0): ContextPlan['contextRefs'] {
  if (!Array.isArray(value) || value.length < min || value.length > 20)
    fail(
      'VALIDATION_ERROR',
      min
        ? `contextRefs must contain ${min} to 20 artifact references`
        : 'contextRefs must contain at most 20 artifact references',
    );
  return value.map((entry) => {
    const ref = object(entry, 'contextRef');
    fields(ref, ['artifactRef', 'version']);
    if (ref.version !== 1) fail('UNSUPPORTED_CAPABILITY', 'Unsupported context reference version');
    return { artifactRef: string(ref.artifactRef, 'artifactRef', 128), version: 1 as const };
  });
}
export function contextPlan(value: unknown, defaultQueueWaitMs = 30000): ContextPlan {
  const p = object(value, 'contextPlan');
  fields(p, [
    'requestedMode',
    'independent',
    'dependencyTaskIds',
    'contextRefs',
    'candidateSessionId',
    'snapshotRef',
    'fallbackModes',
    'maxQueueWaitMs',
  ]);
  const modes = ['continue', 'parallel_tools', 'reuse', 'fork', 'fresh'];
  if (!modes.includes(p.requestedMode as string) || typeof p.independent !== 'boolean')
    fail('VALIDATION_ERROR', 'contextPlan requires an explicit mode and independence');
  const fallbackModes = strings(p.fallbackModes ?? [], 'fallbackModes', 0, 4) as RoutingMode[];
  if (
    fallbackModes.some((mode) => !modes.includes(mode)) ||
    new Set(fallbackModes).size !== fallbackModes.length ||
    fallbackModes.includes(p.requestedMode as RoutingMode)
  )
    fail('VALIDATION_ERROR', 'Invalid fallbackModes');
  const refs = contextRefs(p.contextRefs ?? []);
  return {
    requestedMode: p.requestedMode as RoutingMode,
    independent: p.independent,
    dependencyTaskIds: strings(p.dependencyTaskIds ?? [], 'dependencyTaskIds'),
    contextRefs: refs,
    ...(p.candidateSessionId !== undefined
      ? { candidateSessionId: string(p.candidateSessionId, 'candidateSessionId', 128) }
      : {}),
    ...(p.snapshotRef !== undefined
      ? { snapshotRef: string(p.snapshotRef, 'snapshotRef', 128) }
      : {}),
    fallbackModes,
    maxQueueWaitMs: integer(
      p.maxQueueWaitMs ?? defaultQueueWaitMs,
      'maxQueueWaitMs',
      0,
      MAX_QUEUE_WAIT_MS,
    ),
  };
}
/** SPEC-0065 H01, E01: a task that the host completes has no runtime fields. */
function hostTaskSpec(s: Record<string, unknown>): TaskSpec {
  if (s.executor !== 'host') fail('VALIDATION_ERROR', "executor must be 'host'");
  for (const field of [
    'runtime',
    'acceptance',
    'writeScope',
    'writePath',
    'contextPlan',
    'contextEstimate',
  ])
    if (s[field] !== undefined) fail('VALIDATION_ERROR', `A host task has no ${field}`);
  const dependencies =
    s.dependencyTaskIds === undefined
      ? undefined
      : strings(s.dependencyTaskIds, 'dependencyTaskIds');
  if (dependencies && new Set(dependencies).size !== dependencies.length)
    fail('VALIDATION_ERROR', 'Dependencies must be unique');
  let expiresAt: string | undefined;
  if (s.expiresAt !== undefined) {
    const at = typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN;
    if (
      typeof s.expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(
        s.expiresAt,
      ) ||
      Number.isNaN(at)
    )
      fail('VALIDATION_ERROR', 'expiresAt must be an ISO 8601 time with a time zone');
    expiresAt = new Date(at).toISOString();
  }
  return {
    goal: string(s.goal, 'goal'),
    executor: 'host',
    ...(dependencies?.length ? { dependencyTaskIds: dependencies } : {}),
    ...(s.parentTaskId !== undefined
      ? { parentTaskId: string(s.parentTaskId, 'parentTaskId', 128) }
      : {}),
    ...(s.label !== undefined ? { label: label(s.label) } : {}),
    ...(s.metadata !== undefined ? { metadata: metadata(s.metadata) } : {}),
    ...(s.budget !== undefined ? { budget: validateBudget(s.budget) } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
export function taskSpec(value: unknown, defaultQueueWaitMs?: number): TaskSpec {
  const s = object(value, 'spec');
  fields(s, [
    'goal',
    'runtime',
    'acceptance',
    'dependencyTaskIds',
    'parentTaskId',
    'writeScope',
    'writePath',
    'contextPlan',
    'budget',
    'contextEstimate',
    'label',
    'metadata',
    'executor',
    'expiresAt',
  ]);
  if (s.executor !== undefined) return hostTaskSpec(s);
  if (s.expiresAt !== undefined) fail('VALIDATION_ERROR', 'Only a host task has expiresAt');
  const runtime = object(s.runtime, 'runtime');
  fields(runtime, ['provider', 'model']);
  const acceptance = object(s.acceptance, 'acceptance');
  let accepted: TaskSpec['acceptance'];
  if (acceptance.mode === 'human') {
    fields(acceptance, ['mode', 'criteria']);
    accepted = { mode: 'human', criteria: strings(acceptance.criteria, 'criteria', 1) };
  } else if (acceptance.mode === 'checks') {
    fields(acceptance, ['mode', 'ruleRefs', 'maxRepairs']);
    if (
      !Array.isArray(acceptance.ruleRefs) ||
      !acceptance.ruleRefs.length ||
      acceptance.ruleRefs.length > 20
    )
      fail('VALIDATION_ERROR', 'ruleRefs must contain 1..20 registered rules');
    accepted = {
      mode: 'checks',
      ruleRefs: acceptance.ruleRefs.map((value) => {
        const ref = object(value, 'ruleRef');
        fields(ref, ['id', 'version']);
        return {
          id: string(ref.id, 'rule.id', 128),
          version: string(ref.version, 'rule.version', 128),
        };
      }),
      ...(acceptance.maxRepairs !== undefined
        ? { maxRepairs: integer(acceptance.maxRepairs, 'maxRepairs', 0, 20) }
        : {}),
    };
  } else fail('UNSUPPORTED_CAPABILITY', 'Unknown acceptance mode');
  const plan =
    s.contextPlan === undefined ? undefined : contextPlan(s.contextPlan, defaultQueueWaitMs);
  const dependencies =
    s.dependencyTaskIds === undefined
      ? undefined
      : strings(s.dependencyTaskIds, 'dependencyTaskIds');
  if (dependencies && new Set(dependencies).size !== dependencies.length)
    fail('VALIDATION_ERROR', 'Dependencies must be unique');
  return {
    goal: string(s.goal, 'goal'),
    runtime: {
      provider: string(runtime.provider, 'provider', 128),
      model: string(runtime.model, 'model', 256),
    },
    acceptance: accepted,
    ...(dependencies || plan?.dependencyTaskIds.length
      ? {
          dependencyTaskIds: [
            ...new Set([...(dependencies ?? []), ...(plan?.dependencyTaskIds ?? [])]),
          ],
        }
      : {}),
    ...(s.parentTaskId !== undefined
      ? { parentTaskId: string(s.parentTaskId, 'parentTaskId', 128) }
      : {}),
    ...(s.writeScope !== undefined ? { writeScope: string(s.writeScope, 'writeScope', 128) } : {}),
    ...(s.writePath !== undefined
      ? (() => {
          if (s.writeScope === undefined) fail('VALIDATION_ERROR', 'writePath requires writeScope');
          return { writePath: string(s.writePath, 'writePath', 4096) };
        })()
      : {}),
    ...(plan ? { contextPlan: plan } : {}),
    ...(s.label !== undefined ? { label: label(s.label) } : {}),
    ...(s.metadata !== undefined ? { metadata: metadata(s.metadata) } : {}),
    ...(s.budget !== undefined ? { budget: validateBudget(s.budget) } : {}),
    ...(s.contextEstimate !== undefined
      ? {
          contextEstimate: (() => {
            const estimate = object(s.contextEstimate, 'contextEstimate');
            fields(estimate, ['inputTokens', 'outputReserveTokens', 'toolReserveTokens']);
            return {
              inputTokens: integer(estimate.inputTokens, 'inputTokens', 0),
              outputReserveTokens: integer(estimate.outputReserveTokens, 'outputReserveTokens', 0),
              toolReserveTokens: integer(estimate.toolReserveTokens, 'toolReserveTokens', 0),
            };
          })(),
        }
      : {}),
  };
}
export function messageSpec(value: unknown): MessageSpec {
  const s = object(value, 'spec');
  fields(s, [
    'taskId',
    'toSessionId',
    'expectedGeneration',
    'kind',
    'summary',
    'artifactRefs',
    'ttlMs',
    'replyToMessageId',
  ]);
  if (!['assignment', 'finding', 'result', 'question', 'control'].includes(s.kind as string))
    fail('VALIDATION_ERROR', 'Unknown message kind');
  if (s.kind === 'control')
    fail('UNSUPPORTED_CAPABILITY', 'Use sessions.control for authorized control, not a message');
  return {
    taskId: string(s.taskId, 'taskId', 128),
    toSessionId: string(s.toSessionId, 'toSessionId', 128),
    expectedGeneration: integer(s.expectedGeneration, 'expectedGeneration', 1),
    kind: s.kind as MessageSpec['kind'],
    summary: string(s.summary, 'summary'),
    artifactRefs: s.artifactRefs === undefined ? [] : strings(s.artifactRefs, 'artifactRefs'),
    ...(s.ttlMs !== undefined ? { ttlMs: integer(s.ttlMs, 'ttlMs', 1, 604800000) } : {}),
    ...(s.replyToMessageId !== undefined
      ? { replyToMessageId: string(s.replyToMessageId, 'replyToMessageId', 128) }
      : {}),
  };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
