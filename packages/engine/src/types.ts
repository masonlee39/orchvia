import type { RetryIdentity } from './identity.ts';
export type { RetryIdentity } from './identity.ts';
import type { RuntimeTools } from './tools.ts';
export type { RuntimeTools, OrchestrationToolDefinition, OrchestrationToolName } from './tools.ts';
export type TaskStatus =
  | 'queued'
  | 'waiting_dependency'
  | 'running'
  | 'verifying'
  | 'waiting_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'closed'
  | 'outcome_unknown';
export type OperationStatus =
  | 'persisted'
  | 'completed'
  | 'noop'
  | 'rejected'
  | 'failed'
  | 'outcome_unknown';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RuntimeSpec {
  provider: string;
  model: string;
}
export interface TaskSpec {
  goal: string;
  runtime: RuntimeSpec;
  acceptance:
    | { mode: 'human'; criteria: string[] }
    | { mode: 'checks'; ruleRefs: RuleReference[]; maxRepairs?: number };
  dependencyTaskIds?: string[];
  parentTaskId?: string;
  writeScope?: string;
  /** An existing workspace path inside `writeScope` that narrows the task's write paths. */
  writePath?: string;
  contextPlan?: ContextPlan;
  budget?: MoneyBudget;
  contextEstimate?: { inputTokens: number; outputReserveTokens: number; toolReserveTokens: number };
  /** The host's own filterable label, 1 to 256 UTF-8 bytes (SPEC-0027 L01). */
  label?: string;
  /** The host's own JSON object, at most 4096 bytes when encoded (SPEC-0027 L01). */
  metadata?: { [key: string]: Json };
}
export interface MoneyBudget {
  currency: string;
  maxCost: string;
  reservePerDispatch: string;
}
export interface Pricing {
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputTokenMode: 'total' | 'uncached';
  perMillion: { input: string; cacheRead?: string; cacheWrite?: string; output: string };
}
export type RoutingMode = 'continue' | 'parallel_tools' | 'reuse' | 'fork' | 'fresh';
export interface ContextPlan {
  requestedMode: RoutingMode;
  independent: boolean;
  dependencyTaskIds: string[];
  contextRefs: { artifactRef: string; version: 1 }[];
  candidateSessionId?: string;
  snapshotRef?: string;
  fallbackModes: RoutingMode[];
  maxQueueWaitMs: number;
}
/** What `tasks.create` accepts as `contextPlan`; the engine completes the rest (SPEC-0027 T01). */
export interface ContextPlanInput {
  requestedMode: RoutingMode;
  independent: boolean;
  dependencyTaskIds?: string[];
  contextRefs?: { artifactRef: string; version: 1 }[];
  candidateSessionId?: string;
  snapshotRef?: string;
  fallbackModes?: RoutingMode[];
  /** Defaults to the host's `limits.defaultMaxQueueWaitMs`. */
  maxQueueWaitMs?: number;
}
export interface RoutingDecision {
  policyVersion: 1;
  mode: RoutingMode;
  candidateSessionId: string;
  expectedGeneration: number;
  enqueuedAt: string;
  deadlineAt: string;
  maxQueueWaitMs: number;
  fallbackModes: RoutingMode[];
  reasonCode: string;
  submittedAt?: string;
  expiredAt?: string;
}
export interface SessionOpenSpec {
  runtime: RuntimeSpec;
  writeScope?: string;
  writePath?: string;
  label?: string;
  metadata?: { [key: string]: Json };
}
export interface RuleReference {
  id: string;
  version: string;
}
export interface VerificationRule extends RuleReference {
  argv: string[];
  cwdRelative: string;
  timeoutMs: number;
  permissionProfile: 'read-only' | 'workspace-write';
  success: { exitCode: number };
  maxOutputBytes?: number;
  baselinePaths?: string[];
}
export interface FrozenVerificationRule extends VerificationRule {
  digest: string;
}
export interface TaskSnapshot {
  retryIdentity?: RetryIdentity;
  id: string;
  status: TaskStatus;
  revision: number;
  sessionId: string;
  spec: TaskSpec;
  artifactRefs: string[];
  result: string | null;
  reason: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  rootTaskId?: string;
  writePaths?: string[];
  verificationRules?: FrozenVerificationRule[];
  verificationAttempts?: number;
  routing?: RoutingDecision;
  kind?: 'work' | 'compaction';
  maintenanceOperationId?: string;
  /** A reviewer's `revise` comment, kept until a dispatch that carried it returns a result. */
  revisionRequest?: { approvalId: string; comment: string };
  /** Set once a dispatch that carried the dependency results returned a result. */
  dependencyResultsDelivered?: boolean;
  /**
   * Why a queued task, or a task that waits for its dependencies, waits. Computed by the engine
   * when the task is read; never stored, and absent from a read-only view (SPEC-0028 B).
   */
  blockedBy?: TaskBlocker;
  /**
   * The time the task last delivered a result: its latest review for human acceptance, or its
   * completion when its checks passed (SPEC-0029 B01). Stored with the task.
   */
  deliveredAt?: string;
  /** Set while the task stays paused by a close, and whether its turn was running (SPEC-0029 D). */
  pausedByClose?: { operationId: string; wasRunning: boolean };
}
/** The first condition that keeps the scheduler from dispatching a task (SPEC-0028 B01). */
export type TaskBlockReason =
  | 'scheduler_failed'
  | 'host_stopping'
  | 'capacity'
  | 'quarantine_capacity'
  | 'resource_cleanup'
  | 'execution_conflict'
  | 'storage'
  | 'session_busy'
  | 'write_conflict'
  | 'scheduling'
  | 'dependency';
export interface TaskBlocker {
  reason: TaskBlockReason;
  /** The tasks that hold what this task waits for, or its unfinished dependencies. */
  taskIds?: string[];
  /** The session that `session_busy` waits for. */
  sessionId?: string;
}
/** The query of `tasks.list`; set at most one of parentTaskId, sessionId and label. */
export type TaskListQuery = {
  parentTaskId?: string;
  sessionId?: string;
  /** SPEC-0027 L03: the tasks with this label. */
  label?: string;
  /** SPEC-0028 P01: 1 to 10 distinct statuses, alone or with one of the filters above. */
  status?: TaskStatus[];
  /** SPEC-0028 P01: `desc` starts with the newest task; the default is `asc`. */
  order?: 'asc' | 'desc';
  limit?: number;
  afterCursor?: string;
};
/** The result of `tasks.getMany`, each list in the order requested (SPEC-0028 P02). */
export interface TaskGetManyResult {
  tasks: TaskSnapshot[];
  missing: string[];
}
export interface TaskListResult {
  tasks: TaskSnapshot[];
  nextCursor: string | null;
}
export interface HandoffListResult {
  handoffs: HandoffRequest[];
  nextCursor: string | null;
}
export interface RegisteredVerificationRule extends FrozenVerificationRule {
  source: 'config' | 'runtime';
  /** Set on a retired rule, which `rules.list` returns only with `includeRetired` (SPEC-0028 U). */
  retiredAt?: string;
}
/** What `tasks.create` accepts; task snapshots hold the completed `TaskSpec` (SPEC-0027 T01). */
export interface TaskSpecInput extends Omit<TaskSpec, 'contextPlan'> {
  contextPlan?: ContextPlanInput;
}
/** The command of `sessions.control`; the engine accepts no other action (SPEC-0027 T02). */
export interface SessionControlCommand {
  action: 'pause' | 'resume' | 'stop';
  mode?: 'drain' | 'interrupt';
}
/** Storage limits and retention; `storage.configure` takes a part of it (SPEC-0009). */
export interface StoragePolicy {
  quotaBytes: number;
  minFreeBytes: number;
  emergencyBytes: number;
  maxRecords: number;
  settlementReserveRecords: number;
  maxSettlementPerTarget: number;
  eventDays: number;
  detailDays: number;
  usageDays: number;
}
/** The result of `storage.status` (SPEC-0027 T02). */
export interface StorageStatus {
  storeId: string;
  policy: StoragePolicy;
  bytes: number;
  availableBytes: number;
  records: number;
  reservedRecords: number;
  warning: boolean;
  backpressured: boolean;
  reasons: string[];
  retentionFloorCursor: string;
}
/** One page of `state.snapshot` (SPEC-0027 T02). */
export interface StateSnapshotPage {
  snapshotId: string;
  storeId: string;
  cursor: string;
  retentionFloorCursor: string;
  expiresAt: string;
  items: { kind: 'tasks' | 'sessions' | 'approvals'; value: Json }[];
  nextOffset: number;
  done: boolean;
}
/** A registered-price cost record; `amount` is null when the price or the usage is unknown. */
export interface CostRecord {
  id: string;
  usageRecordId: string | null;
  dispatchId: string | null;
  costOwnerTaskId: string | null;
  rootTaskId: string | null;
  category: 'task' | 'host_overhead';
  currency: string | null;
  amount: string | null;
  amountUnits: string | null;
  createdAt: string;
  [field: string]: Json;
}
/** A budget reservation held for a dispatch until its costs settle. */
export interface CostReservation {
  id: string;
  taskId: string;
  rootTaskId: string;
  currency: string;
  initialUnits: string;
  remainingUnits: string;
  status: 'held' | 'settled';
  remaining: string;
}
/**
 * The result of `costs.get`: money totals of registered-price estimates per currency, not token
 * counts and not a provider bill (SPEC-0027 T02).
 */
export interface CostSummary {
  scope: 'direct' | 'tree' | 'host_overhead';
  totals: Record<string, string>;
  unknownRecords: number;
  records: CostRecord[];
  recordsTruncated: boolean;
  recordCount: number;
  reservations: CostReservation[];
  reservationsTruncated: boolean;
  basis: string;
  settlementIncomplete: boolean;
}
export type TokenCounts = Pick<
  UsageRecord,
  'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens'
>;
/** The input of `context.estimate`; the engine adds the registered price (SPEC-0027 T02). */
export interface ContextEstimateInput {
  provider: string;
  model: string;
  keepHistoryTokens: number;
  compactHistoryTokens: number;
  /** Null when the number of future requests is unknown. */
  requests: number | null;
  growthTokens: number;
  outputTokens: number;
  retainedPrefixTokens: number;
  compaction: TokenCounts;
  intervalsMs: (number | null)[];
  ttlMs: number;
}
export interface ContextEstimateStrategy {
  amount: string | null;
  requests: number;
}
export interface ContextEstimateScenario {
  keep: ContextEstimateStrategy;
  compact: ContextEstimateStrategy;
  automaticSelection: false;
  reason: string;
  keepRequests: TokenCounts[];
  compactRequests: TokenCounts[];
}
/** The result of `context.estimate` (SPEC-0027 T02). */
export type ContextEstimateResult =
  | { status: 'unknown'; reason: 'unknown_future_request_count'; automaticSelection: false }
  | {
      scenarios: Record<
        'sustained_hit' | 'ttl_rebuild' | 'partial_prefix',
        ContextEstimateScenario
      >;
      range: Record<'keep' | 'compact', { min: string; max: string; currency: string } | null>;
      assumptions: Json;
      automaticSelection: false;
      cacheHitsGuaranteed: false;
    };
export type { RolloverPhase, RolloverRecord, StoreDirectories } from './control-plane.ts';
export type { ContextRefCheck } from './generated/wire.ts';
/** SPEC-0014 host workflow controls, advertised by `initialize`. */
export type WorkflowFeature =
  | 'dependencyResults'
  | 'revise'
  | 'delegationApproval'
  | 'handoffs'
  | 'writePath'
  | 'runtimeRules'
  | 'taskList'
  /** SPEC-0020 `context.checkRefs`. */
  | 'contextCheck'
  /** SPEC-0027 L01 `label` and `metadata` on tasks and sessions. */
  | 'labels'
  /** SPEC-0028 P: `tasks.list` status and order, `tasks.getMany` and `usage.summary`. */
  | 'taskQueries'
  /** SPEC-0028 B: `blockedBy` on waiting tasks. */
  | 'queueReasons'
  /** SPEC-0028 S: `close({ mode: 'pause' })`. */
  | 'pauseClose'
  /** SPEC-0028 U: `rules.retire` and `rules.list({ includeRetired })`. */
  | 'ruleRetirement'
  /** SPEC-0029 A: `usage.byTask`. */
  | 'usageByTask';
/** A model's request that the host hand work to a session outside its subtree (SPEC-0014 H). */
export interface HandoffRequest {
  handoffId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'invalidated';
  revision: number;
  fromTaskId: string;
  fromSessionId: string;
  fromDispatchId: string;
  fromGeneration: number;
  rootTaskId: string;
  targetSessionId: string;
  goal: string;
  contextRefs: { artifactRef: string; version: 1 }[];
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  /** The host-created task that took over the work, for `accepted`. */
  taskId?: string;
  comment?: string;
}
export interface SessionSnapshot {
  retryIdentity?: RetryIdentity;
  id: string;
  taskId: string | null;
  provider: string;
  model: string;
  providerSessionId: string | null;
  generation: number;
  revision: number;
  status: SessionStatus;
  activeDispatchId: string | null;
  /** Durable control provenance; absent old-store pauses are treated as client-owned. */
  pauseOrigin?: 'client' | 'runtime';
  /** From `sessions.open`, the task the engine opened it for, or a fork's source (SPEC-0027 L02). */
  label?: string;
  metadata?: { [key: string]: Json };
  taskIds?: string[];
  rootTaskId?: string;
  permissionProfile?: 'read-only' | 'workspace-write';
  writePaths?: string[];
  nativeCheckpoint?: string;
  forkSource?: {
    sessionId: string;
    generation: number;
    providerSessionId: string;
    nativeCheckpoint: string;
    snapshotRef: string;
  };
  generations?: {
    generation: number;
    providerSessionId: string | null;
    nativeCheckpoint?: string;
    artifactRef: string;
  }[];
  execution?: {
    dispatchId: string;
    lease: ExecutionLease;
    quarantined: boolean;
    lastEvidence: string;
    budget?: ExecutionBudgetSummary;
  };
}
export interface ExecutionLease {
  version: 1;
  status: 'held' | 'released';
  acquiredAt: string;
  releasedAt?: string;
  releaseReason?: string;
  releaseEvidenceRef?: string;
}
export interface ExecutionBudgetSummary {
  policyVersion: 2;
  enteredAt: string;
  acceptanceDeadlineAt: string;
  deadlineAt: string;
  effectiveAcceptanceMs: number;
  effectiveTurnMs: number;
  acceptanceSource: string;
  turnSource: string;
}
export interface ExecutionBudget extends ExecutionBudgetSummary {
  remainingAcceptanceMs(): number;
  remainingTurnMs(): number;
}
export type RuntimeTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'result' | 'interrupted' | 'error' }
>;
export interface ExecutionEvidence {
  version: 1;
  sequence: number;
  dispatchId: string;
  sessionId: string;
  generation: number;
  provider: string;
  providerSessionId: string | null;
  providerTurnId?: string | null;
  source: 'pre_submission' | 'runtime_terminal' | 'resource_observation';
  observedAt: string;
  localResources: 'stopped' | 'unknown' | 'active';
  remoteExecution: 'stopped' | 'unknown' | 'active';
  detail: string;
  terminal?: RuntimeTerminalEvent;
}
export interface ExecutionConflict {
  id: string;
  revision: number;
  dispatchId: string;
  sessionId: string;
  taskId: string;
  generation: number;
  status: 'open' | 'resolved';
  releaseEvidenceRef: string | null;
  conflictingEvidenceRef: string;
  createdAt: string;
  resolution?: { operationId: string; evidenceRef: string; occurredAt: string };
}
export interface SchedulerSnapshot {
  maxActiveSessions: number;
  maxQuarantinedDispatches: number;
  executionOccupied: number;
  quarantined: number;
  quarantineReserved: number;
  canDispatch: boolean;
  reasons: string[];
  occupants: Array<{
    taskId: string;
    sessionId: string;
    dispatchId: string;
    leaseStatus: 'held' | 'released';
    quarantined: boolean;
    lastEvidence: string;
    enteredAt: string;
  }>;
  truncated: boolean;
  openConflicts: number;
  conflicts: Array<{ conflictId: string; revision: number; dispatchId: string }>;
  conflictsTruncated: boolean;
}
export interface OperationSnapshot {
  retryIdentity?: RetryIdentity;
  id: string;
  method: string;
  scope: string;
  idempotencyKey: string;
  status: OperationStatus;
  targetId: string;
  result: Json;
  error: { code: string; message: string } | null;
  lifecycle?: OperationLifecycle;
  resolution?: { operationId: string; outcome: string; occurredAt: string };
}
export interface LifecycleTimeouts {
  acceptanceMs?: number;
  turnMs?: number;
  drainMs?: number;
  interruptMs?: number;
  reconcileMs?: number;
}
export interface OperationLifecycle {
  enteredAt: string;
  deadlineAt: string;
  policyVersion: 1;
  kind: 'drain' | 'interrupt' | 'reconcile' | 'shutdown';
  expectedGeneration: number | null;
  expectedDispatchId: string | null;
  mayHaveBeenSent: boolean;
  lastEvidence: string;
  expiredAt?: string;
}
export interface ReconcileEvidence {
  source: 'owner_attestation';
  summary: string;
  localResources: 'stopped' | 'unknown';
  remoteExecution: 'stopped' | 'unknown';
  sideEffects: 'resolved' | 'unknown';
  outcome: 'not_executed' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  result?: string;
}
// In-process test seam; not accepted from JSON config or the wire.
export interface EngineClock {
  wallNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}
export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  purpose: 'task_acceptance' | 'runtime_permission';
  revision: number;
  status: 'pending' | 'approved' | 'denied' | 'revised' | 'expired' | 'invalidated';
  /** The deciding client's comment; required for `revise`. */
  comment?: string;
  target: {
    taskId: string;
    taskRevision: number;
    artifactRefs: string[];
    sessionId?: string;
    generation?: number;
    dispatchId?: string;
    providerSessionId?: string | null;
    providerTurnId?: string;
    requestId?: string;
    toolName?: string;
    permission?: Json;
    requestDigest?: string;
  };
  summary: string;
  evidenceRefs: string[];
  expiresAt: string;
}
export interface MessageSpec {
  taskId: string;
  toSessionId: string;
  expectedGeneration: number;
  kind: 'assignment' | 'finding' | 'result' | 'question' | 'control';
  summary: string;
  artifactRefs?: string[];
  ttlMs?: number;
  replyToMessageId?: string;
}
export interface MessageSnapshot extends MessageSpec {
  retryIdentity?: RetryIdentity;
  id: string;
  fromSessionId: string;
  idempotencyKey: string;
  createdAt?: string;
  expiresAt?: string;
  hopCount?: number;
  status:
    | 'persisted'
    | 'dispatching'
    | 'runtime_accepted'
    | 'completed'
    | 'failed'
    | 'expired'
    | 'outcome_unknown';
}
export interface EventEnvelope {
  eventId: string;
  cursor: string;
  storeId: string;
  schemaVersion: 1;
  type: string;
  taskId: string | null;
  sessionId: string | null;
  operationId: string | null;
  occurredAt: string;
  data: Record<string, Json>;
}
export interface UsageRecord {
  id: string;
  taskId: string;
  dispatchId: string;
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  /**
   * The cache writes that live five minutes and one hour, which together are
   * `cacheWriteInputTokens`. Only a runtime that splits them reports them (SPEC-0030 A02).
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens: number | null;
  raw: Json;
  /** Written from SPEC-0028 E01 on; absent from earlier records. */
  sessionId?: string;
  /**
   * The model that served the calls: the one the runtime named for the observation, else the
   * dispatch's session's (SPEC-0028 E01, SPEC-0031 B01).
   */
  model?: string;
  rootTaskId?: string;
  recordedAt?: string;
}
/** Token counts over a set of usage records (SPEC-0028 P03). */
export interface UsageTotals {
  records: number;
  /** Each count is the sum over the records that report it. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /**
   * Sums over the records that split their cache writes by duration (SPEC-0030 A04);
   * `cacheWriteInputTokens` minus both is the cache writes of the records without a split.
   */
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  /** Records whose input or output count is null. */
  unknownRecords: number;
}
export interface UsageModelTotals extends UsageTotals {
  provider: string;
  /** Null when neither the record nor its dispatch's session names the model. */
  model: string | null;
}
/** One task's own usage, as `usage.byTask` reports it (SPEC-0029 A01). */
export interface UsageTaskTotals {
  taskId: string;
  byModel: UsageModelTotals[];
  totals: UsageTotals;
  completeness: 'reported' | 'unknown';
}
/** The result of `usage.byTask`, each list in the order requested (SPEC-0029 A01). */
export interface UsageByTaskResult {
  tasks: UsageTaskTotals[];
  missing: string[];
}
/** The result of `usage.summary`: a root task and every task under it (SPEC-0028 P03). */
export interface UsageSummary {
  rootTaskId: string;
  byModel: UsageModelTotals[];
  totals: UsageTotals;
  completeness: 'reported' | 'unknown';
}
export type RuntimeBudgetCapabilities = {
  version: 2;
  acceptanceCapMs: number | null;
  turnCapMs: number | null;
};
export type RuntimeEvidenceCapabilities = {
  version: 1;
  terminalCoversExecution: boolean;
};
export interface RuntimeCapabilities {
  provider: string;
  resume: boolean;
  interrupt: boolean;
  permissionProfiles: ('read-only' | 'workspace-write')[];
  executionBudget: RuntimeBudgetCapabilities;
  executionEvidence?: RuntimeEvidenceCapabilities;
  /** True only when a native fork can continue on another model with the source history. */
  forkModelChange?: boolean;
  /** True when Read/Glob/Grep are fenced to the workspace and configured read roots. */
  readFence?: boolean;
  [key: string]: Json | undefined;
}
export interface RuntimeInput {
  taskId: string;
  sessionId: string;
  dispatchId: string;
  providerSessionId: string | null;
  model: string;
  workspace: string;
  stateDir: string;
  prompt: string;
  permissionProfile: 'read-only' | 'workspace-write';
  signal: AbortSignal;
  generation?: number;
  executionBudget?: ExecutionBudget;
  reportExecutionEvidence?: (evidence: ExecutionEvidence) => void;
  /** Persists received usage even after the main iterator/deadline; never changes execution state. */
  reportUsage?: (event: RuntimeUsageEvent) => void;
  /** Canonical owner-registered write scope; adapters must narrow their sandbox to it. */
  writePaths?: string[];
  forkSource?: SessionSnapshot['forkSource'];
  nativeAction?: 'compact';
  orchestrationTools?: RuntimeTools;
  requestPermission?: (request: RuntimePermissionRequest) => Promise<boolean>;
  /** The task chain and the host's labels; the engine always sets them (SPEC-0027 L04). */
  parentTaskId?: string | null;
  rootTaskId?: string;
  label?: string | null;
  /** A deep-frozen copy: changing it cannot change what is stored. */
  metadata?: { readonly [key: string]: Json } | null;
  sessionLabel?: string | null;
  sessionMetadata?: { readonly [key: string]: Json } | null;
  /**
   * The native session totals that the dispatch before this one on the same native session
   * reported, or null when there is none to rely on (SPEC-0032 E01 to E03). The engine only
   * carries them; the adapter that reported them reads them.
   */
  usageBaseline?: { dispatchId: string; totals: Json } | null;
}
export interface RuntimePermissionRequest {
  requestId: string;
  toolName: string;
  permission: Json;
  providerSessionId?: string | null;
  providerTurnId?: string;
}
/** Required at the engine-to-host boundary; standalone provider calls retain RuntimeInput. */
export interface EngineRuntimeInput extends RuntimeInput {
  generation: number;
  executionBudget: ExecutionBudget;
  reportExecutionEvidence: (evidence: ExecutionEvidence) => void;
}
export type RuntimeEvent =
  | { type: 'accepted'; providerSessionId: string }
  | {
      type: 'result';
      text: string;
      providerSessionId?: string;
      nativeCheckpoint?: string;
      compacted?: { kind: 'boundary' | 'noop'; evidence: Json };
      /** Adapter asserts the received usage covers this entire dispatch; absent is unknown. */
      usageComplete?: boolean;
    }
  | {
      type: 'usage';
      usage: Omit<UsageRecord, 'id' | 'taskId' | 'dispatchId' | 'provider'>;
      usageId: string;
      /**
       * The native session's totals after this dispatch, kept with the dispatch and handed to the
       * next one as its `usageBaseline`; never part of the usage record (SPEC-0032 E01, E04).
       */
      sessionTotals?: Json;
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string; outcome: 'failed' | 'unknown' };
export type RuntimeUsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
export interface RuntimeResourceTarget {
  sessionId: string;
  dispatchId: string;
  generation: number;
}
export interface RuntimeStopContext {
  readonly target: Readonly<
    RuntimeResourceTarget & {
      taskId: string;
      provider: string;
      providerSessionId: string | null;
      providerTurnId?: string;
    }
  >;
  readonly terminal: Readonly<RuntimeTerminalEvent>;
  /**
   * SPEC-0023 P02: every operating-system process that the adapter started for this dispatch, each
   * the leader of its own process group, including those that already exited. Left out by adapters
   * that start no process, and on Windows. Never stored or sent on the wire.
   */
  readonly processes?: readonly Readonly<{ pid: number; processGroupId: number }>[];
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
}
/** True is a host observation of full execution stop, never merely receipt of a cancel request. */
export type RuntimeStopObserver = (context: RuntimeStopContext) => boolean | Promise<boolean>;
export interface RuntimeAdapter {
  provider: string;
  capabilities(): RuntimeCapabilities;
  execute(input: RuntimeInput): AsyncIterable<RuntimeEvent>;
  inspect?(input: RuntimeInspectionInput): Promise<RuntimeInspection>;
  close?(): Promise<void>;
  /** Required when execute can finish while local cleanup is still unconfirmed. */
  hasActiveResources?(sessionId: string): boolean;
  /**
   * Optional owner-attestation path for sealed records with no process observation at all.
   * Return null if any retained record is still executing, has an observed process, or belongs
   * to another dispatch/generation. Preparing must not mutate resources or report stop evidence.
   * The host invokes the synchronous, non-throwing, idempotent finalizer only after committing
   * its audit transaction. It retires only these records, without claiming an observed exit.
   * Contract failures leave a durable pending receipt; an explicit same-key owner retry resumes
   * the original finalizer. Abnormal Promise returns are observed without an unbounded wait.
   */
  prepareUnobservedCleanup?(target: RuntimeResourceTarget): (() => void) | null;
}
export interface RuntimeInspectionInput {
  sessionId: string;
  providerSessionId: string;
  generation: number;
  dispatchId: string | null;
  providerTurnId?: string;
  workspace: string;
  stateDir: string;
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
}
export interface RuntimeInspection {
  status: 'found' | 'not_found' | 'unavailable' | 'mismatch';
  providerSessionId: string;
  records: Json[];
  truncated: boolean;
  execution: 'unknown';
  detail: string;
}
/** The first internal failure that stopped an engine: its step, error code and time (SPEC-0025 F01). */
export interface EngineFailure {
  step: string;
  code: string;
  at: string;
}
export interface EngineConfig {
  storage?: Partial<StoragePolicy>;
  stores?: import('./control-plane.ts').StoreDirectories;
  storageFault?: (point: string) => void;
  /**
   * Called once, in a microtask, when an internal failure stopped the engine, with the failure
   * that `HOST_STOPPING` reports. In-process only; socket and stdio clients read the
   * `scheduler.failed` event (SPEC-0027 F01, F02).
   */
  onFatal?: (failure: EngineFailure) => void;
  workspace: string;
  stateDir: string;
  adapters: RuntimeAdapter[];
  limits?: {
    maxActiveSessions?: number;
    maxTurnsPerTask?: number;
    maxQuarantinedDispatches?: number;
    maxLogicalSessions?: number;
    maxQueuedTasks?: number;
    /** Queue wait of a task whose plan does not set one; 0..604800000, default 30000 (SPEC-0015 Q04). */
    defaultMaxQueueWaitMs?: number;
  };
  /** `model` is shorthand for a one-item `models` list; configure at most one of them. */
  providers?: Record<
    string,
    { model?: string; models?: string[]; permissionProfile?: 'read-only' | 'workspace-write' }
  >;
  approvalTtlMs?: number;
  runtimeApprovals?: { enabled?: boolean; ttlMs?: number };
  messages?: { ttlMs?: number; maxHops?: number; maxPerMinute?: number };
  pricing?: Pricing[];
  budget?: MoneyBudget;
  contextLimits?: Record<string, { windowTokens: number; safetyTokens: number }>;
  timeouts?: LifecycleTimeouts;
  clock?: EngineClock;
  verificationRules?: VerificationRule[];
  /** Named canonical in-workspace paths; task input can select but never register a scope. */
  writeScopes?: Record<string, string[]>;
  allowCrossRootReuse?: boolean;
  tools?: {
    enabled?: boolean;
    /** Admit children created by `work_delegate` paused until a client resumes them. */
    approveDelegation?: boolean;
    /** Turn out-of-subtree `work_delegate` reuse into host-resolved handoff requests. */
    handoffs?: boolean;
    handoffTtlMs?: number;
    maxDepth?: number;
    maxChildren?: number;
    maxCallsPerDispatch?: number;
    maxRepeatedCalls?: number;
  };
}
export interface SessionControlTarget {
  sessionId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedDispatchId: string | null;
  expectedState: SessionStatus;
}
export interface CloseOptions {
  /**
   * `pause` closes as `interrupt` does, and pauses the turns it interrupted with `owner_shutdown`
   * (SPEC-0028 S01).
   */
  mode?: 'drain' | 'interrupt' | 'pause';
  timeoutMs?: number;
  operationId?: string;
}
/** Engine-level close options; `host.shutdown` and the SDKs accept only CloseOptions. */
export interface EngineCloseOptions extends CloseOptions {
  /**
   * How long an interrupting close waits for running dispatches to end before it closes the
   * adapters. Defaults to the smaller of `timeouts.interruptMs` and half of `timeoutMs`
   * (SPEC-0022 C02); the stdio host passes 0 after its owner disconnects (C05).
   */
  interruptWaitMs?: number;
}
export interface CallContext {
  owner?: boolean;
  signal?: AbortSignal;
  /** Trusted in-process binding. Never accepted from public JSON requests. */
  runtimeActor?: { sessionId: string; taskId: string; dispatchId: string; generation: number };
  /** Internal: admit a model-delegated child paused for host approval (SPEC-0014 G01). */
  delegationGate?: boolean;
}
export interface EventPage {
  events: EventEnvelope[];
  cursor: string;
  storeId: string;
}
export interface Engine {
  readonly instanceId: string;
  readonly storeId: string;
  call(method: string, params?: Record<string, unknown>, context?: CallContext): Promise<unknown>;
  close(options?: EngineCloseOptions): Promise<{ status: 'closed'; operationId: string }>;
}
