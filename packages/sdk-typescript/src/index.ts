// Everything public comes from the engine's public entries, so that the declarations refer to no
// internal module (SPEC-0027 T03).
export { validateWire } from '../../engine/src/index.ts';
export type { WireTypes } from '../../engine/src/index.ts';
import { requestDigest } from '../../engine/src/identity.ts';
import { randomUUID } from 'node:crypto';
import {
  createEngine,
  openReadOnlyEngine,
  type ReadOnlyStoreInfo,
} from '../../engine/src/index.ts';
import { VERSION } from '../../engine/src/version.ts';
import type {
  ApprovalRequest,
  CloseOptions,
  ContextEstimateInput,
  ContextEstimateResult,
  ContextRefCheck,
  CostSummary,
  RetryIdentity,
  RolloverRecord,
  SessionControlCommand,
  StateSnapshotPage,
  StoragePolicy,
  StorageStatus,
  TaskSpecInput,
  Engine,
  EngineConfig,
  EventEnvelope,
  EventPage,
  ExecutionConflict,
  HandoffListResult,
  HandoffRequest,
  MessageSnapshot,
  MessageSpec,
  OperationSnapshot,
  ReconcileEvidence,
  RuntimeCapabilities,
  SchedulerSnapshot,
  SessionControlTarget,
  SessionSnapshot,
  SessionOpenSpec,
  RegisteredVerificationRule,
  TaskGetManyResult,
  TaskListQuery,
  TaskListResult,
  TaskSnapshot,
  TaskSpec,
  UsageByTaskResult,
  UsageRecord,
  UsageSummary,
  VerificationRule,
  WorkflowFeature,
  ContextPlan,
} from '../../engine/src/types.ts';
import { OrchestratorError, UnixRpcClient, type Caller, type RequestOptions } from './transport.ts';
export { OrchestratorError } from './transport.ts';
export type { RequestOptions } from './transport.ts';
export type * from '../../engine/src/types.ts';

export interface MutationOptions extends RequestOptions {
  idempotencyKey?: string;
  retryIdentity?: RetryIdentity;
}
export interface SessionForkOptions extends MutationOptions {
  /** Another allowed model of the source provider; the fork cannot reuse the prompt cache. */
  model?: string;
  /** Required when `model` differs from the source model. */
  acknowledgeCacheLoss?: boolean;
}
export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface EventOptions extends RequestOptions {
  afterCursor?: string;
  storeId?: string;
  taskId?: string;
  limit?: number;
}
export interface InitializeResult {
  protocolVersion: string;
  engineVersion: string;
  schemaVersion: number;
  instanceId: string;
  storeId: string;
  capabilities: Record<string, unknown>;
}
export interface UsageResult {
  records: UsageRecord[];
  completeness: 'unknown' | 'reported';
}
const taskTerminal = new Set(['completed', 'failed', 'cancelled']);
const operationTerminal = new Set(['completed', 'noop', 'rejected', 'failed', 'outcome_unknown']);
/**
 * Engine errors that can follow a commit, or whose commit is unknown: a retry identity that meets
 * one is kept, so that a retry goes to the original request's store (SPEC-0027 K04).
 */
const KEEP_IDENTITY = new Set([
  'RESOURCE_CLEANUP_INCOMPLETE',
  'ROLLOVER_IN_PROGRESS',
  'ROLLOVER_BLOCKED',
  'STORE_SWITCH_IN_PROGRESS',
  'SHUTDOWN_INCOMPLETE',
  'OUTCOME_UNKNOWN',
  'OPERATION_HISTORY_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
  'STORAGE_DEGRADED',
]);
/** Retry identities kept per client; the least recently used goes first (SPEC-0027 K03). */
const MAX_IDENTITIES = 10_000;

function key(options: MutationOptions = {}) {
  return options.idempotencyKey ?? randomUUID();
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled');
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function boundedRead<T>(
  read: (options: RequestOptions) => Promise<T>,
  remaining: number,
  signal?: AbortSignal,
): Promise<T> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const stop = (error: OrchestratorError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      controller.abort();
    };
    const cancel = () =>
      stop(new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (Number.isFinite(remaining))
      timer = setTimeout(
        () =>
          stop(new OrchestratorError('TIMEOUT', 'Wait timed out; remote work was not cancelled')),
        Math.max(0, remaining),
      );
    read({
      signal: controller.signal,
      ...(Number.isFinite(remaining) ? { timeoutMs: Math.max(1, Math.ceil(remaining)) } : {}),
    }).then(
      (value) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      },
    );
  });
}
/** The client's polling interval: an integer from 1 to 60000 milliseconds (SPEC-0033 T01). */
function pollInterval(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000)
    throw new OrchestratorError(
      'INVALID_PARAMS',
      'pollIntervalMs must be an integer from 1 to 60000',
    );
  return value;
}
async function waitFor<T extends { status: string }>(
  read: (options: RequestOptions) => Promise<T>,
  terminal: Set<string>,
  options: WaitOptions,
  intervalMs: number,
): Promise<T> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    throw new OrchestratorError('INVALID_PARAMS', 'timeoutMs must be a finite non-negative number');
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  while (true) {
    aborted(options.signal);
    const snapshot = await boundedRead(read, deadline - Date.now(), options.signal);
    aborted(options.signal);
    if (terminal.has(snapshot.status)) return snapshot;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new OrchestratorError('TIMEOUT', 'Wait timed out; remote work was not cancelled');
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

/** SPEC-0044 T01: where settling a task stopped, with what the caller needs to act. */
export interface SettledTask {
  task: TaskSnapshot;
  reason: 'terminal' | 'waiting_approval' | 'paused' | 'blocked';
  /** The pending approval, when the task waits for one that no handler decided. */
  approval?: ApprovalRequest;
  /** The task's session, when the task is blocked: its status may be `outcome_unknown`. */
  session?: SessionSnapshot;
}
export interface SettleOptions extends WaitOptions {
  /**
   * Called once for each pending approval and revision. `'approve'` or `'deny'` is submitted with
   * that revision and settling goes on; nothing ends settling with `'waiting_approval'`.
   */
  onApproval?: (
    approval: ApprovalRequest,
    task: TaskSnapshot,
  ) => 'approve' | 'deny' | undefined | void | Promise<'approve' | 'deny' | undefined | void>;
}

export class TaskHandle {
  readonly id: string;
  readonly initial: TaskSnapshot;
  private client: Orchestrator;
  constructor(client: Orchestrator, snapshot: TaskSnapshot) {
    this.client = client;
    this.id = snapshot.id;
    this.initial = snapshot;
  }
  get(options?: RequestOptions) {
    return this.client.tasks.get(this.id, options);
  }
  wait(options: WaitOptions = {}) {
    return waitFor(
      (request) => this.get(request),
      taskTerminal,
      options,
      this.client.pollIntervalMs,
    );
  }
  cancel(options: MutationOptions = {}) {
    return this.client.tasks.cancel(this.id, options);
  }
  resume(options: MutationOptions = {}) {
    return this.client.tasks.resume(this.id, options);
  }
  /**
   * SPEC-0044 T: reads the task until it ends, is paused or blocked, or waits for an approval that
   * no handler decides. It never decides an approval by itself, and never retries, resends or
   * reconciles anything; a timeout leaves the task as it is.
   */
  async settle(options: SettleOptions = {}): Promise<SettledTask> {
    const handled = new Set<string>();
    let outcome: SettledTask | undefined;
    await waitFor(
      async (request) => {
        const task = await this.get(request);
        if (taskTerminal.has(task.status)) outcome = { task, reason: 'terminal' };
        else if (task.status === 'paused') outcome = { task, reason: 'paused' };
        else if (task.status === 'blocked')
          outcome = {
            task,
            reason: 'blocked',
            session: await this.client.sessions.get(task.sessionId, request),
          };
        else if (task.status === 'waiting_approval' && task.approvalId) {
          const approval = await this.client.approvals.get(task.approvalId, request);
          const identity = `${approval.approvalId}:${approval.revision}`;
          // Decided meanwhile: read the task again.
          if (approval.status !== 'pending') return task;
          if (!options.onApproval || handled.has(identity))
            outcome = { task, reason: 'waiting_approval', approval };
          else {
            handled.add(identity);
            const choice = await options.onApproval(approval, task);
            if (choice === 'approve' || choice === 'deny') {
              await this.client.approvals.decide(approval.approvalId, {
                choice,
                expectedRevision: approval.revision,
              });
              return task;
            }
            outcome = { task, reason: 'waiting_approval', approval };
          }
        }
        return outcome ? { ...task, status: 'settled' } : task;
      },
      new Set(['settled']),
      options,
      this.client.pollIntervalMs,
    );
    return outcome!;
  }
}
export class OperationHandle {
  readonly id: string;
  readonly initial: OperationSnapshot;
  private client: Orchestrator;
  constructor(client: Orchestrator, snapshot: OperationSnapshot) {
    this.client = client;
    this.id = snapshot.id;
    this.initial = snapshot;
  }
  get(options?: RequestOptions) {
    return this.client.ops.get(this.id, options);
  }
  wait(options: WaitOptions = {}) {
    return waitFor(
      (request) => this.get(request),
      operationTerminal,
      options,
      this.client.pollIntervalMs,
    );
  }
}

export interface ClientOptions {
  /**
   * How long `events()` waits after an empty page and a handle's `wait()` between reads, in
   * milliseconds: an integer from 1 to 60000, 50 by default, as Python's `poll_interval`.
   */
  pollIntervalMs?: number;
}
export class Orchestrator {
  readonly info: InitializeResult;
  /** SPEC-0033 T02, T03. */
  readonly pollIntervalMs: number;
  private caller: Caller;
  private owner: boolean;
  private identities = new Map<string, RetryIdentity>();
  private closed = false;
  private closeResult?: { status: 'closed'; operationId: string };
  constructor(caller: Caller, info: InitializeResult, owner: boolean, pollIntervalMs = 50) {
    this.caller = caller;
    this.info = info;
    this.owner = owner;
    this.pollIntervalMs = pollInterval(pollIntervalMs);
  }
  private call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ) {
    if (this.closed)
      return Promise.reject<T>(new OrchestratorError('CLIENT_CLOSED', 'Client is closed'));
    return this.caller.call<T>(method, params, options);
  }
  private async mutation<T>(
    method: string,
    scope: string,
    params: Record<string, unknown>,
    options?: MutationOptions,
  ): Promise<T> {
    if (
      this.info.protocolVersion !== '2.0' ||
      (this.info.capabilities?.storeNamespaces as any)?.version !== 1 ||
      !this.info.storeId
    )
      throw new OrchestratorError(
        'UNSUPPORTED_CAPABILITY',
        'Namespace-bound writes require a confirmed protocol 2.0 store',
      );
    const requestedKey = options?.retryIdentity?.idempotencyKey ?? key(options);
    const identityKey = JSON.stringify([method, scope, requestedKey]);
    const existing = this.identities.get(identityKey);
    // This call claims the key only when nothing held it before (SPEC-0027 K01, K02).
    const claimed = !options?.retryIdentity && !existing;
    const identity: RetryIdentity = options?.retryIdentity ??
      existing ?? {
        storeId: this.info.storeId,
        method,
        scope,
        idempotencyKey: requestedKey,
        digestVersion: 1,
        requestDigest: requestDigest(method, params),
      };
    const stored = { ...identity };
    // Re-inserting marks the identity as the most recently used one.
    this.identities.delete(identityKey);
    this.identities.set(identityKey, stored);
    if (this.identities.size > MAX_IDENTITIES)
      this.identities.delete(this.identities.keys().next().value!);
    const idempotencyKey = identity.idempotencyKey;
    try {
      if (
        identity.method !== method ||
        identity.scope !== scope ||
        identity.digestVersion !== 1 ||
        identity.requestDigest !== requestDigest(method, params)
      )
        throw new OrchestratorError('IDEMPOTENCY_CONFLICT', 'Retry identity or payload changed');
      const result = await this.call<T>(
        method,
        {
          ...params,
          idempotencyKey,
          expectedStoreId: identity.storeId,
          requestDigest: identity.requestDigest,
        },
        options,
      );
      if (
        ['stores.rollover', 'stores.import'].includes(method) &&
        (result as any)?.status === 'completed'
      )
        await this.refresh();
      return result && typeof result === 'object' ? { ...result, retryIdentity: identity } : result;
    } catch (error) {
      const original = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      const data =
        original.data && typeof original.data === 'object'
          ? (original.data as Record<string, unknown>)
          : original.details && typeof original.details === 'object'
            ? (original.details as Record<string, unknown>)
            : {};
      // An engine error carries its code in its data too; the SDK's and the transport's own errors
      // do not. The engine committed nothing for a rejection outside KEEP_IDENTITY, so the key this
      // call claimed is free again for a corrected request (SPEC-0027 K01).
      if (
        claimed &&
        typeof original.code === 'string' &&
        data.code === original.code &&
        !KEEP_IDENTITY.has(original.code) &&
        this.identities.get(identityKey) === stored
      )
        this.identities.delete(identityKey);
      // Each failed request gets its own error: transport disconnect may reject many calls together.
      const failure = new OrchestratorError(
        typeof original.code === 'string' ? original.code : 'REQUEST_FAILED',
        typeof original.message === 'string' ? original.message : String(error),
        { ...data, method, scope, idempotencyKey, retryIdentity: identity },
      );
      failure.cause = error;
      throw failure;
    }
  }
  async refresh(): Promise<InitializeResult> {
    const info = await this.call<InitializeResult>('initialize', {
      protocolVersion: '2.0',
      sdkVersion: VERSION,
    });
    if (
      info.protocolVersion !== '2.0' ||
      (info.capabilities?.storeNamespaces as any)?.version !== 1
    )
      throw new OrchestratorError('PROTOCOL_MISMATCH', 'Refreshed host lacks namespace support');
    Object.assign(this.info, info);
    return this.info;
  }
  retry<T = Record<string, unknown>>(
    identity: RetryIdentity,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ) {
    return this.mutation<T>(identity.method, identity.scope, params, {
      ...options,
      retryIdentity: { ...identity },
    });
  }
  /**
   * Forgets the retry identities of `idempotencyKey` for every method and scope, and returns how
   * many there were. The engine still refuses another request under a key it committed
   * (SPEC-0027 K03).
   */
  forgetIdempotencyKey(idempotencyKey: string): number {
    let removed = 0;
    for (const [identityKey, identity] of [...this.identities])
      if (identity.idempotencyKey === idempotencyKey) {
        this.identities.delete(identityKey);
        removed++;
      }
    return removed;
  }
  private async operation(
    method: string,
    scope: string,
    params: Record<string, unknown>,
    options?: MutationOptions,
  ) {
    return new OperationHandle(
      this,
      await this.mutation<OperationSnapshot>(method, scope, params, options),
    );
  }
  private requireExecutionIsolation() {
    const capability = this.info.capabilities.executionIsolation;
    if (
      !capability ||
      typeof capability !== 'object' ||
      !('version' in capability) ||
      capability.version !== 1 ||
      !('resourceRelease' in capability) ||
      capability.resourceRelease !== true ||
      !('schedulerStatus' in capability) ||
      capability.schedulerStatus !== true ||
      !('ownerConflictResolution' in capability) ||
      capability.ownerConflictResolution !== true ||
      !('budgetVersion' in capability) ||
      capability.budgetVersion !== 2
    ) {
      throw new OrchestratorError(
        'UNSUPPORTED_CAPABILITY',
        'Host does not advertise execution isolation v1 with budget policy v2',
      );
    }
  }
  readonly scheduler = {
    get: async (options?: RequestOptions) => {
      this.requireExecutionIsolation();
      return this.call<SchedulerSnapshot>('scheduler.get', {}, options);
    },
    getConflict: async (query: { conflictId: string }, options?: RequestOptions) => {
      this.requireExecutionIsolation();
      return this.call<ExecutionConflict>('scheduler.getConflict', query, options);
    },
    resolveConflict: async (
      request: { conflictId: string; expectedRevision: number; evidence: ReconcileEvidence },
      options?: MutationOptions,
    ) => {
      this.requireExecutionIsolation();
      return this.operation('scheduler.resolveConflict', request.conflictId, request, options);
    },
  };
  /** Fails before sending when the host did not advertise a SPEC-0014 workflow feature. */
  private requireWorkflow(feature: WorkflowFeature): void {
    const workflow = this.info.capabilities.workflow as Record<string, unknown> | undefined;
    if (workflow?.version !== 1 || workflow[feature] !== true)
      throw new OrchestratorError('UNSUPPORTED_CAPABILITY', `Host does not support ${feature}`);
  }
  readonly tasks = {
    create: async (spec: TaskSpecInput, options?: MutationOptions) => {
      if (spec.writePath !== undefined) this.requireWorkflow('writePath');
      if (spec.label !== undefined || spec.metadata !== undefined) this.requireWorkflow('labels');
      return new TaskHandle(
        this,
        await this.mutation<TaskSnapshot>('tasks.create', 'local', { spec }, options),
      );
    },
    get: (taskId: string, options?: RequestOptions) =>
      this.call<TaskSnapshot>('tasks.get', { taskId }, options),
    /**
     * A page in creation order, or newest first with `order: 'desc'`; set at most one of
     * parentTaskId, sessionId and label, and optionally `status` (SPEC-0028 P01).
     */
    list: async (query: TaskListQuery = {}, options?: RequestOptions) => {
      this.requireWorkflow('taskList');
      if (query.label !== undefined) this.requireWorkflow('labels');
      if (query.status !== undefined || query.order !== undefined)
        this.requireWorkflow('taskQueries');
      return this.call<TaskListResult>('tasks.list', query, options);
    },
    /** 1 to 100 tasks by ID, in the order requested, and the IDs not found (SPEC-0028 P02). */
    getMany: async (taskIds: string[], options?: RequestOptions) => {
      this.requireWorkflow('taskQueries');
      return this.call<TaskGetManyResult>('tasks.getMany', { taskIds }, options);
    },
    resume: (taskId: string, options?: MutationOptions) =>
      this.operation('tasks.resume', taskId, { taskId }, options),
    cancel: (taskId: string, options?: MutationOptions) =>
      this.operation('tasks.cancel', taskId, { taskId }, options),
  };
  readonly sessions = {
    inspect: (sessionId: string, options: { timeoutMs?: number; limit?: number } = {}) =>
      this.call<
        import('../../engine/src/types.ts').RuntimeInspection & {
          target: import('../../engine/src/types.ts').Json;
        }
      >('sessions.inspect', { sessionId, ...options }),
    get: (sessionId: string, options?: RequestOptions) =>
      this.call<SessionSnapshot>('sessions.get', { sessionId }, options),
    control: (
      target: SessionControlTarget,
      command: SessionControlCommand,
      options?: MutationOptions,
    ) => this.operation('sessions.control', target.sessionId, { target, command }, options),
    reconcile: async (
      target: SessionControlTarget,
      evidence: ReconcileEvidence,
      options?: MutationOptions,
    ) => {
      const capability = this.info.capabilities.lifecycle;
      if (
        !capability ||
        typeof capability !== 'object' ||
        !('version' in capability) ||
        capability.version !== 1 ||
        !('reconcile' in capability) ||
        capability.reconcile !== 'owner-attestation' ||
        !('durableDeadlines' in capability) ||
        capability.durableDeadlines !== true
      ) {
        throw new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'Host does not advertise lifecycle v1 owner-attestation reconciliation',
        );
      }
      return this.operation('sessions.reconcile', target.sessionId, { target, evidence }, options);
    },
    open: async (spec: SessionOpenSpec, options?: MutationOptions) => {
      if (spec.writePath !== undefined) this.requireWorkflow('writePath');
      if (spec.label !== undefined || spec.metadata !== undefined) this.requireWorkflow('labels');
      const capability = this.info.capabilities.sessionLifecycle as { open?: boolean } | undefined;
      if (capability?.open !== true)
        throw new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'Host does not support logical session opening',
        );
      return this.mutation<SessionSnapshot>('sessions.open', 'local', { spec }, options);
    },
    fork: async (
      target: SessionControlTarget,
      snapshotRef: string,
      options: SessionForkOptions = {},
    ) => {
      const { model, acknowledgeCacheLoss, ...mutation } = options;
      const capability = this.info.capabilities.sessionLifecycle as
        | { forkModel?: boolean }
        | undefined;
      if (model !== undefined && capability?.forkModel !== true)
        throw new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'Host does not support model-changing forks',
        );
      return this.mutation<SessionSnapshot>(
        'sessions.fork',
        target.sessionId,
        {
          target,
          snapshotRef,
          ...(model !== undefined ? { model } : {}),
          ...(acknowledgeCacheLoss !== undefined ? { acknowledgeCacheLoss } : {}),
        },
        mutation,
      );
    },
    compact: (target: SessionControlTarget, options?: MutationOptions) =>
      this.operation('sessions.compact', target.sessionId, { target }, options),
    rotate: (target: SessionControlTarget, options?: MutationOptions) =>
      this.operation('sessions.rotate', target.sessionId, { target }, options),
    stop: (
      target: SessionControlTarget,
      mode: 'drain' | 'interrupt' = 'drain',
      options?: MutationOptions,
    ) =>
      this.operation(
        'sessions.control',
        target.sessionId,
        { target, command: { action: 'stop', mode } },
        options,
      ),
  };
  readonly costs = {
    /** Money totals of registered-price estimates, not token counts and not a provider bill. */
    get: (taskId?: string, scope: 'direct' | 'tree' | 'host_overhead' = 'direct') =>
      this.call<CostSummary>('costs.get', { ...(taskId ? { taskId } : {}), scope }),
    recordOverhead: (
      record: {
        billingId: string;
        currency: string;
        amount: string | null;
        pricingVersion: string;
        summary: string;
      },
      options?: MutationOptions,
    ) => this.operation('costs.recordOverhead', 'host', record, options),
  };
  readonly context = {
    estimate: (input: ContextEstimateInput, options?: RequestOptions) =>
      this.call<ContextEstimateResult>('context.estimate', { ...input }, options),
    /**
     * What task admission would decide now for each context reference (SPEC-0020). Read-only; the
     * content is never returned, and admission checks again when a task is submitted.
     */
    checkRefs: (contextRefs: ContextPlan['contextRefs'], options?: RequestOptions) => {
      this.requireWorkflow('contextCheck');
      return this.call<ContextRefCheck>('context.checkRefs', { contextRefs }, options);
    },
  };
  readonly messages = {
    send: (spec: MessageSpec, options?: MutationOptions) =>
      this.mutation<MessageSnapshot>('messages.send', spec.toSessionId, { spec }, options),
    get: (messageId: string, options?: RequestOptions) =>
      this.call<MessageSnapshot>('messages.get', { messageId }, options),
  };
  readonly ops = {
    get: (operationId: string, options?: RequestOptions) =>
      this.call<OperationSnapshot>('operations.get', { operationId }, options),
    lookup: (
      query: { method: string; scope: string; idempotencyKey: string },
      options?: RequestOptions,
    ) => this.call<OperationSnapshot>('operations.lookup', query, options),
  };
  readonly operations = this.ops;
  readonly approvals = {
    get: (approvalId: string, options?: RequestOptions) =>
      this.call<ApprovalRequest>('approvals.get', { approvalId }, options),
    decide: async (
      approvalId: string,
      decision: {
        choice: 'approve' | 'deny' | 'revise';
        expectedRevision: number;
        /** Required for `revise`; the next dispatch receives it as the reviewer's request. */
        comment?: string;
      },
      options?: MutationOptions,
    ) => {
      if (decision.choice === 'revise' || decision.comment !== undefined)
        this.requireWorkflow('revise');
      return this.operation('approvals.decide', approvalId, { approvalId, decision }, options);
    },
  };
  readonly handoffs = {
    get: async (handoffId: string, options?: RequestOptions) => {
      this.requireWorkflow('handoffs');
      return this.call<HandoffRequest>('handoffs.get', { handoffId }, options);
    },
    list: async (
      query: {
        status?: HandoffRequest['status'];
        targetSessionId?: string;
        limit?: number;
        afterCursor?: string;
      } = {},
      options?: RequestOptions,
    ) => {
      this.requireWorkflow('handoffs');
      return this.call<HandoffListResult>('handoffs.list', query, options);
    },
    /** Accepting links the task the host created; the engine never creates it. */
    resolve: async (
      handoffId: string,
      resolution: {
        expectedRevision: number;
        outcome: 'accepted' | 'rejected';
        taskId?: string;
        comment?: string;
      },
      options?: MutationOptions,
    ) => {
      this.requireWorkflow('handoffs');
      return this.operation('handoffs.resolve', handoffId, { handoffId, ...resolution }, options);
    },
  };
  readonly rules = {
    /** Owner only; appends a verification rule version for tasks admitted afterwards. */
    register: async (rule: VerificationRule, options?: MutationOptions) => {
      this.requireWorkflow('runtimeRules');
      return this.operation('rules.register', 'local', { rule }, options);
    },
    /**
     * Owner only; retires a rule registered at runtime, so that tasks admitted afterwards cannot
     * name it and it no longer counts toward the effective rules (SPEC-0028 U01).
     */
    retire: async (rule: { id: string; version: string }, options?: MutationOptions) => {
      this.requireWorkflow('ruleRetirement');
      return this.operation(
        'rules.retire',
        'local',
        { id: rule.id, version: rule.version },
        options,
      );
    },
    /** The effective rules; with `includeRetired`, the retired ones after them (SPEC-0028 U04). */
    list: async (options: RequestOptions & { includeRetired?: boolean } = {}) => {
      const { includeRetired, ...request } = options;
      this.requireWorkflow('runtimeRules');
      if (includeRetired !== undefined) this.requireWorkflow('ruleRetirement');
      return this.call<{ rules: RegisteredVerificationRule[] }>(
        'rules.list',
        includeRetired === undefined ? {} : { includeRetired },
        request,
      );
    },
  };
  readonly usage = {
    getRecord: (usageRecordId: string, options?: RequestOptions) =>
      this.call<UsageRecord>('usage.getRecord', { usageRecordId }, options),
    get: (query: { taskId: string } | string, options?: RequestOptions) =>
      this.call<UsageResult>(
        'usage.get',
        typeof query === 'string' ? { taskId: query } : query,
        options,
      ),
    /** Token totals of a root task and every task under it, by model (SPEC-0028 P03). */
    summary: async (rootTaskId: string, options?: RequestOptions) => {
      this.requireWorkflow('taskQueries');
      return this.call<UsageSummary>('usage.summary', { rootTaskId }, options);
    },
    /** Each of 1 to 100 tasks' own token totals by model, in order, and the missing IDs (SPEC-0029 A). */
    byTask: async (taskIds: string[], options?: RequestOptions) => {
      this.requireWorkflow('usageByTask');
      return this.call<UsageByTaskResult>('usage.byTask', { taskIds }, options);
    },
  };
  readonly stores = {
    rollover: (options?: MutationOptions) =>
      this.mutation<RolloverRecord>('stores.rollover', 'local', {}, options),
    importBackup: (backupId: string, options?: MutationOptions) =>
      this.mutation<RolloverRecord>('stores.import', 'local', { backupId }, options),
    rolloverStatus: (rolloverId: string, options?: RequestOptions) =>
      this.call<RolloverRecord>('rollovers.get', { rolloverId }, options),
  };
  readonly archives = {
    lookup: (
      query: {
        storeId: string;
        method: string;
        scope: string;
        idempotencyKey: string;
        requestDigest?: string;
      },
      options?: RequestOptions,
    ) => this.call<OperationSnapshot>('archives.lookup', query, options),
    readArtifact: (
      query: { storeId: string; artifactRef: string; maxBytes?: number },
      options?: RequestOptions,
    ) =>
      this.call<{ storeId: string; artifactRef: string; text: string }>(
        'archives.readArtifact',
        query,
        options,
      ),
  };
  readonly storage = {
    backup: (options?: MutationOptions) =>
      this.mutation<{ backupId: string; storeId: string; retryIdentity: RetryIdentity }>(
        'storage.backup',
        'local',
        {},
        options,
      ),
    status: (options?: RequestOptions) => this.call<StorageStatus>('storage.status', {}, options),
    configure: (policy: Partial<StoragePolicy>, options?: MutationOptions) =>
      this.operation('storage.configure', 'local', { policy }, options),
    collect: (options?: MutationOptions) => this.operation('storage.gc', 'local', {}, options),
    pin: (ref: string, reason: string, options?: MutationOptions) =>
      this.operation('storage.pin', 'local', { ref, reason }, options),
    unpin: (ref: string, options?: MutationOptions) =>
      this.operation('storage.unpin', 'local', { ref }, options),
  };
  readonly state = {
    snapshot: (
      query: { snapshotId?: string; offset?: number; limit?: number } = {},
      options?: RequestOptions,
    ) => this.call<StateSnapshotPage>('state.snapshot', query, options),
    releaseSnapshot: (snapshotId: string, options?: RequestOptions) =>
      this.call<{ released: boolean }>('state.releaseSnapshot', { snapshotId }, options),
  };
  readonly capabilities = Object.assign(
    (query: { provider?: string } = {}, options?: RequestOptions) =>
      this.call<RuntimeCapabilities | Record<string, unknown>>('capabilities.get', query, options),
    {
      get: (query: { provider?: string } = {}, options?: RequestOptions) =>
        this.call<RuntimeCapabilities | Record<string, unknown>>(
          'capabilities.get',
          query,
          options,
        ),
    },
  );
  readonly events = Object.assign((options: EventOptions = {}) => this.iterateEvents(options), {
    read: (options: Omit<EventOptions, 'signal' | 'timeoutMs'> = {}, request?: RequestOptions) =>
      this.call<EventPage>('events.read', options, request),
  });
  private async *iterateEvents(options: EventOptions): AsyncGenerator<EventEnvelope> {
    let cursor = options.afterCursor ?? '0';
    let storeId = options.storeId;
    while (!this.closed) {
      aborted(options.signal);
      const params: Record<string, unknown> = { afterCursor: cursor };
      if (storeId !== undefined) params.storeId = storeId;
      if (options.taskId !== undefined) params.taskId = options.taskId;
      if (options.limit !== undefined) params.limit = options.limit;
      const page = await this.call<EventPage>('events.read', params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      storeId = page.storeId;
      for (const event of page.events) {
        aborted(options.signal);
        yield event;
      }
      cursor = page.cursor;
      if (!page.events.length) await sleep(this.pollIntervalMs, options.signal);
    }
  }
  async close(
    options: CloseOptions = {},
  ): Promise<{ status: 'closed'; operationId: string } | void> {
    if (this.closed) return this.closeResult;
    if (!this.owner) {
      this.closed = true;
      this.caller.disconnect();
      return;
    }
    // Refused before sending, and the client stays open (SPEC-0028 S04).
    if (options.mode === 'pause') this.requireWorkflow('pauseClose');
    try {
      const params = {
        expectedStoreId: this.info.storeId,
        mode: options.mode ?? 'drain',
        timeoutMs: options.timeoutMs ?? 30_000,
        ...(options.operationId ? { operationId: options.operationId } : {}),
      };
      const result = await this.call<{ status: 'closed'; operationId: string }>(
        options.operationId ? 'host.shutdown.continue' : 'host.shutdown',
        params,
        // Allow the host its full cleanup budget plus time to return its final receipt.
        { timeoutMs: params.timeoutMs + 1000 },
      );
      this.closeResult = result;
      this.closed = true;
      this.caller.disconnect();
      return result;
    } catch (error) {
      const failure = error as {
        code?: string;
        data?: Record<string, unknown>;
        details?: Record<string, unknown>;
      };
      const details = failure?.data ?? failure?.details;
      if (
        failure?.code === 'STORAGE_DEGRADED_CLOSED' &&
        details?.status === 'closed' &&
        details?.durableReceipt === false
      ) {
        this.closed = true;
        this.caller.disconnect();
      }
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'SHUTDOWN_INCOMPLETE'
      ) {
        const failure = error as {
          client?: unknown;
          operationId?: string;
          data?: Record<string, unknown>;
        };
        failure.client = this;
        if (!failure.operationId && typeof failure.data?.operationId === 'string')
          failure.operationId = failure.data.operationId;
      }
      throw error;
    }
  }
}

async function initialize(caller: Caller, owner: boolean, pollIntervalMs = 50) {
  try {
    const info = await caller.call<InitializeResult>(
      'initialize',
      { protocolVersion: '2.0', sdkVersion: VERSION },
      { timeoutMs: 5000 },
    );
    if (info.protocolVersion !== '2.0')
      throw new OrchestratorError('PROTOCOL_MISMATCH', 'Host did not negotiate protocol 2.0');
    if ((info.capabilities?.storeNamespaces as { version?: number })?.version !== 1)
      throw new OrchestratorError(
        'UNSUPPORTED_CAPABILITY',
        'Host must support namespace-bound writes',
      );
    return new Orchestrator(caller, info, owner, pollIntervalMs);
  } catch (error) {
    caller.disconnect();
    throw error;
  }
}
/**
 * The error a socket client receives for `error`, built as the host's `errorData` in
 * packages/cli/src/host.ts builds it: the code, or INTERNAL_ERROR, the message, and data holding the
 * details and the code (SPEC-0025 E01).
 */
function hostError(error: unknown): OrchestratorError {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const data = {
    ...(value.details && typeof value.details === 'object'
      ? (value.details as Record<string, unknown>)
      : {}),
    ...(value.data && typeof value.data === 'object'
      ? (value.data as Record<string, unknown>)
      : {}),
  };
  const code =
    typeof value.code === 'string'
      ? value.code
      : typeof data.code === 'string'
        ? data.code
        : 'INTERNAL_ERROR';
  const failure = new OrchestratorError(
    code,
    typeof value.message === 'string' ? value.message : String(error),
    {
      ...data,
      code,
      ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    },
  );
  failure.cause = error;
  return failure;
}
export async function createOrchestrator(
  config: EngineConfig,
  options: ClientOptions = {},
): Promise<Orchestrator> {
  // An invalid interval starts no engine (SPEC-0033 T01).
  const intervalMs = pollInterval(options.pollIntervalMs);
  const engine = await createEngine(config);
  const caller: Caller = {
    call: async <T>(
      method: string,
      params: Record<string, unknown> = {},
      options: RequestOptions = {},
    ) => {
      // The SDK's own errors, such as ABORTED here, are raised before the engine is called (E02).
      aborted(options.signal);
      try {
        return (await engine.call(method, params, { owner: true, signal: options.signal })) as T;
      } catch (error) {
        throw hostError(error);
      }
    },
    disconnect() {},
  };
  try {
    return await initialize(caller, true, intervalMs);
  } catch (error) {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    throw error;
  }
}
/**
 * Reads of a store whose engine is not running: no lock, recovery, scheduler, adapters or writes.
 * Its methods are the reads of Orchestrator; `info()` describes the store (SPEC-0027 R).
 */
export class ReadOnlyOrchestrator {
  readonly storeId: string;
  private caller: Caller;
  private shut: () => Promise<unknown>;
  private closed = false;
  constructor(caller: Caller, storeId: string, close: () => Promise<unknown>) {
    this.caller = caller;
    this.storeId = storeId;
    this.shut = close;
  }
  private call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ) {
    if (this.closed)
      return Promise.reject<T>(new OrchestratorError('CLIENT_CLOSED', 'Client is closed'));
    return this.caller.call<T>(method, params, options);
  }
  /** The store's identity and role, and whether an engine start would recover rows (R05). */
  info(options?: RequestOptions) {
    return this.call<ReadOnlyStoreInfo>('store.info', {}, options);
  }
  readonly tasks = {
    get: (taskId: string, options?: RequestOptions) =>
      this.call<TaskSnapshot>('tasks.get', { taskId }, options),
    list: (query: TaskListQuery = {}, options?: RequestOptions) =>
      this.call<TaskListResult>('tasks.list', query, options),
    getMany: (taskIds: string[], options?: RequestOptions) =>
      this.call<TaskGetManyResult>('tasks.getMany', { taskIds }, options),
  };
  readonly sessions = {
    get: (sessionId: string, options?: RequestOptions) =>
      this.call<SessionSnapshot>('sessions.get', { sessionId }, options),
  };
  readonly usage = {
    getRecord: (usageRecordId: string, options?: RequestOptions) =>
      this.call<UsageRecord>('usage.getRecord', { usageRecordId }, options),
    get: (query: { taskId: string } | string, options?: RequestOptions) =>
      this.call<UsageResult>(
        'usage.get',
        typeof query === 'string' ? { taskId: query } : query,
        options,
      ),
    summary: (rootTaskId: string, options?: RequestOptions) =>
      this.call<UsageSummary>('usage.summary', { rootTaskId }, options),
    byTask: (taskIds: string[], options?: RequestOptions) =>
      this.call<UsageByTaskResult>('usage.byTask', { taskIds }, options),
  };
  readonly events = {
    read: (options: Omit<EventOptions, 'signal' | 'timeoutMs'> = {}, request?: RequestOptions) =>
      this.call<EventPage>('events.read', options, request),
  };
  readonly operations = {
    get: (operationId: string, options?: RequestOptions) =>
      this.call<OperationSnapshot>('operations.get', { operationId }, options),
    lookup: (
      query: { method: string; scope: string; idempotencyKey: string },
      options?: RequestOptions,
    ) => this.call<OperationSnapshot>('operations.lookup', query, options),
  };
  readonly approvals = {
    get: (approvalId: string, options?: RequestOptions) =>
      this.call<ApprovalRequest>('approvals.get', { approvalId }, options),
  };
  readonly messages = {
    get: (messageId: string, options?: RequestOptions) =>
      this.call<MessageSnapshot>('messages.get', { messageId }, options),
  };
  readonly handoffs = {
    get: (handoffId: string, options?: RequestOptions) =>
      this.call<HandoffRequest>('handoffs.get', { handoffId }, options),
    list: (
      query: {
        status?: HandoffRequest['status'];
        targetSessionId?: string;
        limit?: number;
        afterCursor?: string;
      } = {},
      options?: RequestOptions,
    ) => this.call<HandoffListResult>('handoffs.list', query, options),
  };
  readonly costs = {
    get: (taskId?: string, scope: 'direct' | 'tree' | 'host_overhead' = 'direct') =>
      this.call<CostSummary>('costs.get', { ...(taskId ? { taskId } : {}), scope }),
  };
  readonly context = {
    checkRefs: (contextRefs: ContextPlan['contextRefs'], options?: RequestOptions) =>
      this.call<ContextRefCheck>('context.checkRefs', { contextRefs }, options),
  };
  readonly rules = {
    /** Only the rules registered at runtime; a configuration's rules are unknown offline. */
    list: (options: RequestOptions & { includeRetired?: boolean } = {}) => {
      const { includeRetired, ...request } = options;
      return this.call<{ rules: RegisteredVerificationRule[] }>(
        'rules.list',
        includeRetired === undefined ? {} : { includeRetired },
        request,
      );
    },
  };
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.shut();
  }
}
/** Opens a store read-only, without starting an engine (SPEC-0027 R01). */
export async function openOrchestratorReadOnly(options: {
  stateDir: string;
}): Promise<ReadOnlyOrchestrator> {
  const engine = await openReadOnlyEngine({ stateDir: options.stateDir });
  const caller: Caller = {
    call: async <T>(
      method: string,
      params: Record<string, unknown> = {},
      request: RequestOptions = {},
    ) => {
      aborted(request.signal);
      try {
        return (await engine.call(method, params, { owner: true, signal: request.signal })) as T;
      } catch (error) {
        throw hostError(error);
      }
    },
    disconnect() {},
  };
  return new ReadOnlyOrchestrator(caller, engine.storeId, () => engine.close());
}
export async function connectOrchestrator(
  options: {
    socketPath: string;
    timeoutMs?: number;
    requestTimeoutMs?: number;
  } & ClientOptions,
): Promise<Orchestrator> {
  const intervalMs = pollInterval(options.pollIntervalMs);
  const caller = await UnixRpcClient.connect(
    options.socketPath,
    options.timeoutMs,
    options.requestTimeoutMs,
  );
  return initialize(caller, false, intervalMs);
}
