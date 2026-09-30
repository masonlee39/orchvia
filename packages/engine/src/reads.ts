import { costSummary } from './cost-ledger.ts';
import { OrchestrationError, fail } from './errors.ts';
import {
  contextRefs as validateContextRefs,
  fields,
  integer,
  label,
  string,
} from './validation.ts';
import type { Store } from './store.ts';
import type {
  ApprovalRequest,
  EventPage,
  HandoffListResult,
  HandoffRequest,
  MessageSnapshot,
  SessionSnapshot,
  TaskGetManyResult,
  TaskListResult,
  TaskSnapshot,
  TaskStatus,
  UsageByTaskResult,
  UsageModelTotals,
  UsageRecord,
  UsageSummary,
  UsageTotals,
} from './types.ts';

// Reads that a running engine and a read-only view answer through the same code (SPEC-0027 R03).

/** The inline limit of one context reference, for admission, the prompt and `context.checkRefs`. */
/** SPEC-0053 F01: a list of 0 or 1 to 50 event types. */
function eventTypes(value: unknown, name: string, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 50)
    fail('VALIDATION_ERROR', `${name} must be a list of ${min} to 50 event types`);
  return value.map((type, index) => string(type, `${name}[${index}]`, 128));
}
export const CONTEXT_REF_MAX_BYTES = 32768;

/**
 * Reads one context reference as admission, the prompt and `context.checkRefs` do (SPEC-0020). A
 * read failure that is not already an engine error becomes ARTIFACT_UNREADABLE.
 */
export function contextRefText(store: Store, artifactRef: string): string {
  try {
    return store.artifactText(artifactRef, CONTEXT_REF_MAX_BYTES);
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    return fail('ARTIFACT_UNREADABLE', 'Context reference could not be read', {
      ref: artifactRef,
    });
  }
}

/** A session with its active dispatch's execution state. */
export function sessionSnapshot(store: Store, id: string): SessionSnapshot {
  const session = store.require<SessionSnapshot>('sessions', id);
  if (session.activeDispatchId) {
    const d = store.require<{
      id: string;
      executionLease: NonNullable<SessionSnapshot['execution']>['lease'];
      quarantined: boolean;
      lastEvidence: string;
      budget?: NonNullable<SessionSnapshot['execution']>['budget'];
    }>('dispatches', session.activeDispatchId);
    session.execution = {
      dispatchId: d.id,
      lease: d.executionLease,
      quarantined: d.quarantined,
      lastEvidence: d.lastEvidence,
      ...(d.budget ? { budget: d.budget } : {}),
    };
  }
  return session;
}

function pageCursor(value: unknown): number {
  if (value === undefined) return 0;
  const raw = string(value, 'afterCursor', 19);
  const after = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after))
    fail('VALIDATION_ERROR', 'afterCursor must come from a previous page');
  return after;
}

const TASK_STATUSES = new Set<TaskStatus>([
  'queued',
  'waiting_dependency',
  'running',
  'verifying',
  'waiting_approval',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
/** 1 to `max` distinct nonempty strings. */
function distinct(value: unknown, name: string, max: number, maxLength = 128): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    fail('VALIDATION_ERROR', `${name} must list 1 to ${max} items`);
  const items = value.map((item) => string(item, name, maxLength));
  if (new Set(items).size !== items.length)
    fail('VALIDATION_ERROR', `${name} must not repeat an item`);
  return items;
}
/** Completeness as `usage.get` reports it: every record reports its input and output counts. */
function completeness(records: UsageRecord[]): 'reported' | 'unknown' {
  return records.length && records.every((r) => r.inputTokens !== null && r.outputTokens !== null)
    ? 'reported'
    : 'unknown';
}
function totals(records: UsageRecord[]): UsageTotals {
  const sum = (
    key:
      | 'inputTokens'
      | 'cachedInputTokens'
      | 'cacheWriteInputTokens'
      | 'cacheWrite5mInputTokens'
      | 'cacheWrite1hInputTokens'
      | 'outputTokens',
  ) => records.reduce((total, record) => total + (record[key] ?? 0), 0);
  return {
    records: records.length,
    inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens'),
    // SPEC-0030 A04: over the records that split them; the rest of the cache writes has no split.
    cacheWrite5mInputTokens: sum('cacheWrite5mInputTokens'),
    cacheWrite1hInputTokens: sum('cacheWrite1hInputTokens'),
    outputTokens: sum('outputTokens'),
    unknownRecords: records.filter((r) => r.inputTokens === null || r.outputTokens === null).length,
  };
}
/**
 * The model of each record: its own, or for a record written before SPEC-0028 E01, the model of
 * its dispatch's session, or null once either was collected. One resolver serves one read.
 */
function modelResolver(store: Store): (record: UsageRecord) => string | null {
  const sessions = new Map<string, string | null>();
  return (record) => {
    if (typeof record.model === 'string') return record.model;
    if (!sessions.has(record.dispatchId)) {
      const dispatch = store.get<{ sessionId?: string }>('dispatches', record.dispatchId);
      const session = dispatch?.sessionId
        ? store.get<{ model?: string }>('sessions', dispatch.sessionId)
        : undefined;
      sessions.set(record.dispatchId, session?.model ?? null);
    }
    return sessions.get(record.dispatchId)!;
  };
}
/** Records per provider and model, ordered by provider and then model with null last (P03). */
function modelTotals(records: UsageRecord[], modelOf: (record: UsageRecord) => string | null) {
  const groups = new Map<
    string,
    { provider: string; model: string | null; records: UsageRecord[] }
  >();
  for (const record of records) {
    const model = modelOf(record);
    const key = JSON.stringify([record.provider, model]);
    if (!groups.has(key)) groups.set(key, { provider: record.provider, model, records: [] });
    groups.get(key)!.records.push(record);
  }
  const byModel: UsageModelTotals[] = [...groups.values()]
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        (a.model === null ? 1 : 0) - (b.model === null ? 1 : 0) ||
        (a.model ?? '').localeCompare(b.model ?? ''),
    )
    .map((group) => ({ provider: group.provider, model: group.model, ...totals(group.records) }));
  return { byModel, totals: totals(records), completeness: completeness(records) };
}
/**
 * Token totals of a root task and of every task whose rootTaskId names it, per provider and model
 * (SPEC-0028 P03). A record written before E01 has no model and takes its dispatch's session's.
 */
function usageSummary(store: Store, rootTaskId: string): UsageSummary {
  const root = store.require<TaskSnapshot>('tasks', rootTaskId);
  if (root.spec.parentTaskId !== undefined)
    fail('VALIDATION_ERROR', 'usage.summary needs a root task; this task has a parent', {
      rootTaskId: root.rootTaskId ?? null,
    });
  const records = store.treeUsage(rootTaskId);
  // A root task written without rootTaskId still counts its own records.
  if (root.rootTaskId === undefined) records.push(...store.taskUsage(rootTaskId));
  return { rootTaskId, ...modelTotals(records, modelResolver(store)) };
}
/**
 * Each task's own totals, as `usage.summary` computes a tree's (SPEC-0029 A01): the records of all
 * the tasks come from one statement (A02).
 */
/**
 * SPEC-0042 E05: the distinct efforts that a task's records report as `raw._reasoningEffort`, the
 * convention of the Codex adapter, in the order they were first recorded.
 */
function reasoningEfforts(records: UsageRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    const effort = (record.raw as { _reasoningEffort?: { effective?: unknown } } | null)
      ?._reasoningEffort?.effective;
    if (typeof effort === 'string') seen.add(effort);
  }
  return [...seen];
}

function usageByTask(store: Store, ids: string[]): UsageByTaskResult {
  const found = store.existingTaskIds(ids);
  const present = ids.filter((id) => found.has(id));
  const records = new Map<string, UsageRecord[]>(present.map((id) => [id, []]));
  for (const record of store.usageOfTasks(present)) records.get(record.taskId)?.push(record);
  const modelOf = modelResolver(store);
  return {
    tasks: present.map((taskId) => ({
      taskId,
      ...modelTotals(records.get(taskId)!, modelOf),
      reasoningEfforts: reasoningEfforts(records.get(taskId)!),
    })),
    missing: ids.filter((id) => !found.has(id)),
  };
}

export const SHARED_READS = new Set([
  'tasks.get',
  'tasks.getMany',
  'tasks.list',
  'sessions.get',
  'usage.get',
  'usage.getRecord',
  'usage.summary',
  'usage.byTask',
  'events.read',
  'operations.get',
  'operations.lookup',
  'approvals.get',
  'messages.get',
  'handoffs.get',
  'handoffs.list',
  'costs.get',
  'context.checkRefs',
]);

/**
 * Answers one of SHARED_READS from `store`. A running engine passes `expireHandoffs`, which runs
 * where handoff reads have always expired due handoffs, and `blockedBy`, which adds why each waiting
 * task of a result waits (SPEC-0028 B01). A read-only view passes neither.
 */
export function readCall(
  store: Store,
  method: string,
  p: Record<string, unknown>,
  hooks: { expireHandoffs?: () => void; blockedBy?: (tasks: TaskSnapshot[]) => void } = {},
): unknown {
  switch (method) {
    case 'tasks.get': {
      fields(p, ['taskId']);
      const task = store.require<TaskSnapshot>('tasks', string(p.taskId, 'taskId', 128));
      hooks.blockedBy?.([task]);
      return task;
    }
    case 'tasks.getMany': {
      fields(p, ['taskIds']);
      const ids = distinct(p.taskIds, 'taskIds', 100);
      const found = store.tasksById(ids);
      const tasks = ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
      hooks.blockedBy?.(tasks);
      return {
        tasks,
        missing: ids.filter((id) => !found.has(id)),
      } satisfies TaskGetManyResult;
    }
    case 'tasks.list': {
      fields(p, ['parentTaskId', 'sessionId', 'label', 'status', 'order', 'limit', 'afterCursor']);
      if ([p.parentTaskId, p.sessionId, p.label].filter((v) => v !== undefined).length > 1)
        fail('VALIDATION_ERROR', 'Use at most one of parentTaskId, sessionId and label');
      const status = p.status === undefined ? undefined : distinct(p.status, 'status', 10);
      if (status?.some((item) => !TASK_STATUSES.has(item as TaskStatus)))
        fail('VALIDATION_ERROR', 'Unknown task status');
      if (p.order !== undefined && p.order !== 'asc' && p.order !== 'desc')
        fail('VALIDATION_ERROR', 'order must be asc or desc');
      const page = store.listTasks(
        {
          ...(p.parentTaskId !== undefined
            ? { parentTaskId: string(p.parentTaskId, 'parentTaskId', 128) }
            : p.sessionId !== undefined
              ? { sessionId: string(p.sessionId, 'sessionId', 128) }
              : p.label !== undefined
                ? { label: label(p.label) }
                : {}),
          ...(status ? { status } : {}),
        },
        p.afterCursor === undefined ? undefined : pageCursor(p.afterCursor),
        p.limit === undefined ? 50 : integer(p.limit, 'limit', 1, 100),
        (p.order as 'asc' | 'desc' | undefined) ?? 'asc',
      );
      hooks.blockedBy?.(page.tasks);
      return {
        tasks: page.tasks,
        nextCursor: page.next === null ? null : String(page.next),
      } satisfies TaskListResult;
    }
    case 'sessions.get':
      fields(p, ['sessionId']);
      return sessionSnapshot(store, string(p.sessionId, 'sessionId', 128));
    case 'usage.get': {
      fields(p, ['taskId']);
      const id = string(p.taskId, 'taskId', 128);
      store.require('tasks', id);
      // Through usage_task, not the whole table (SPEC-0028 P04).
      const records = store.taskUsage(id);
      return { records, completeness: completeness(records) };
    }
    case 'usage.getRecord':
      fields(p, ['usageRecordId']);
      return store.require<UsageRecord>('usage', string(p.usageRecordId, 'usageRecordId', 512));
    case 'usage.summary':
      fields(p, ['rootTaskId']);
      return usageSummary(store, string(p.rootTaskId, 'rootTaskId', 128));
    case 'usage.byTask':
      fields(p, ['taskIds']);
      return usageByTask(store, distinct(p.taskIds, 'taskIds', 100));
    case 'events.read':
      fields(p, ['afterCursor', 'storeId', 'taskId', 'limit', 'types', 'excludeTypes']);
      if (p.types !== undefined && p.excludeTypes !== undefined)
        fail('VALIDATION_ERROR', 'Give types or excludeTypes, not both');
      return store.events(
        p.afterCursor === undefined ? '0' : string(p.afterCursor, 'afterCursor', 30),
        p.storeId === undefined ? undefined : string(p.storeId, 'storeId', 128),
        p.taskId === undefined ? undefined : string(p.taskId, 'taskId', 128),
        p.limit === undefined ? 100 : integer(p.limit, 'limit', 1, 1000),
        {
          ...(p.types !== undefined ? { types: eventTypes(p.types, 'types', 1) } : {}),
          ...(p.excludeTypes !== undefined
            ? { excludeTypes: eventTypes(p.excludeTypes, 'excludeTypes', 0) }
            : {}),
        },
      ) satisfies EventPage;
    case 'operations.get':
      fields(p, ['operationId']);
      return store.operation(string(p.operationId, 'operationId', 128));
    case 'operations.lookup': {
      fields(p, ['method', 'scope', 'idempotencyKey']);
      const result = store.findOperation(
        string(p.method, 'method', 128),
        string(p.scope, 'scope', 128),
        string(p.idempotencyKey, 'idempotencyKey', 256),
      );
      if (!result) fail('NOT_FOUND', 'Idempotent operation not found');
      store.assertDetails(result.operation);
      return result.operation;
    }
    case 'approvals.get':
      fields(p, ['approvalId']);
      return store.require<ApprovalRequest>('approvals', string(p.approvalId, 'approvalId', 128));
    case 'messages.get':
      fields(p, ['messageId']);
      return store.require<MessageSnapshot>('messages', string(p.messageId, 'messageId', 128));
    case 'handoffs.get':
      fields(p, ['handoffId']);
      hooks.expireHandoffs?.();
      return store.require<HandoffRequest>('handoffs', string(p.handoffId, 'handoffId', 128));
    case 'handoffs.list': {
      fields(p, ['status', 'targetSessionId', 'limit', 'afterCursor']);
      if (
        p.status !== undefined &&
        !['pending', 'accepted', 'rejected', 'expired', 'invalidated'].includes(p.status as string)
      )
        fail('VALIDATION_ERROR', 'Unknown handoff status');
      const after = pageCursor(p.afterCursor);
      hooks.expireHandoffs?.();
      const page = store.listHandoffs(
        {
          ...(p.status !== undefined ? { status: p.status as string } : {}),
          ...(p.targetSessionId !== undefined
            ? { targetSessionId: string(p.targetSessionId, 'targetSessionId', 128) }
            : {}),
        },
        after,
        p.limit === undefined ? 50 : integer(p.limit, 'limit', 1, 100),
      );
      return {
        handoffs: page.handoffs,
        nextCursor: page.next === null ? null : String(page.next),
      } satisfies HandoffListResult;
    }
    case 'costs.get': {
      fields(p, ['taskId', 'scope']);
      const scope = p.scope ?? 'direct';
      if (!['direct', 'tree', 'host_overhead'].includes(String(scope)))
        fail('VALIDATION_ERROR', 'Invalid cost scope');
      return costSummary(
        store,
        p.taskId === undefined ? undefined : string(p.taskId, 'taskId', 128),
        scope as 'direct' | 'tree' | 'host_overhead',
      );
    }
    case 'context.checkRefs':
      // SPEC-0020: what admission would decide for each reference now. Reads only; returns no content.
      fields(p, ['contextRefs']);
      return {
        contextRefs: validateContextRefs(p.contextRefs, 1).map(({ artifactRef }) => {
          const record = store.get<{ sizeBytes?: unknown }>('artifacts', artifactRef);
          const bytes = typeof record?.sizeBytes === 'number' ? { bytes: record.sizeBytes } : {};
          try {
            contextRefText(store, artifactRef);
            return { artifactRef, admissible: true, ...bytes };
          } catch (error) {
            if (!(error instanceof OrchestrationError)) throw error;
            return { artifactRef, admissible: false, code: error.code, ...bytes };
          }
        }),
      };
    default:
      return fail('NOT_FOUND', `Not a shared read: ${method}`);
  }
}
