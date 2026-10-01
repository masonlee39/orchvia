import type { Store } from './store.ts';
import type {
  ApprovalRequest,
  MessageSnapshot,
  OperationSnapshot,
  SessionSnapshot,
  TaskSnapshot,
} from './types.ts';

// Which rows startup recovery changes. The engine's recovery acts on exactly these, and a read-only
// view reports whether any exist, from the same definitions (SPEC-0027 R05).

/** Runtime-permission approvals still pending: a restarted owner invalidates them. */
export function pendingRuntimeApprovals(store: Store): ApprovalRequest[] {
  return store
    .all<ApprovalRequest>('approvals')
    .filter(
      (approval) => approval.purpose === 'runtime_permission' && approval.status === 'pending',
    );
}

/** Steers whose runtime never said whether its turn took them (SPEC-0058 D04). */
export function pendingSteers(store: Store): MessageSnapshot[] {
  return (
    store.db
      .prepare("SELECT data FROM messages WHERE json_extract(data,'$.steerDelivery')='pending'")
      .all() as { data: string }[]
  ).map((row) => JSON.parse(row.data) as MessageSnapshot);
}

/**
 * What recovery does to a task: `pause_task` pauses a queued task whose session holds another task;
 * `pause` pauses a queued task and its session; `block` blocks a task whose dispatch may have run.
 */
export function recoveryAction(
  task: TaskSnapshot,
  session: SessionSnapshot,
): 'pause_task' | 'pause' | 'block' | null {
  if (session.taskId !== task.id) return task.status === 'queued' ? 'pause_task' : null;
  if (task.status === 'running' || task.status === 'verifying' || session.activeDispatchId)
    return 'block';
  return task.status === 'queued' ? 'pause' : null;
}

/** Operations whose outcome the previous owner never recorded. */
export function unfinishedOperations(store: Store): OperationSnapshot[] {
  return store.operations().filter((operation) => operation.status === 'persisted');
}

/** Closed sessions that still have persisted messages, which stores from rc.10 and earlier hold. */
export function closedSessionsWithMessages(store: Store): string[] {
  return (
    store.db
      .prepare(
        "SELECT DISTINCT json_extract(data,'$.toSessionId') AS id FROM messages WHERE json_extract(data,'$.status')='persisted'",
      )
      .all() as { id: string }[]
  )
    .map((row) => row.id)
    .filter((id) => store.get<SessionSnapshot>('sessions', id)?.status === 'closed');
}

/** Whether starting an engine on this store would change rows during recovery. */
export function recoveryPending(store: Store): boolean {
  if (pendingRuntimeApprovals(store).length || pendingSteers(store).length) return true;
  for (const task of store.all<TaskSnapshot>('tasks')) {
    const session = store.get<SessionSnapshot>('sessions', task.sessionId);
    if (session && recoveryAction(task, session)) return true;
  }
  return unfinishedOperations(store).length > 0 || closedSessionsWithMessages(store).length > 0;
}
