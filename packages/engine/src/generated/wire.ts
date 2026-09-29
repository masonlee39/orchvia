// Generated from schemas/protocol.schema.json; SHA-256 db1f741f3de141a8ec6b6e71d652499c85b328b8de875652a095d32ad9c42b02. Do not edit.
// Structural types; validateWire enforces numeric and conditional constraints.
export type RuntimeSpec = { provider: string; model: string };
export type TaskSpec = {
  goal: string;
  runtime: RuntimeSpec;
  acceptance:
    | { mode: 'human'; criteria: Array<string> }
    | { mode: 'checks'; ruleRefs: Array<{ id: string; version: string }>; maxRepairs?: number };
  dependencyTaskIds?: Array<string>;
  parentTaskId?: string;
  writeScope?: string;
  contextPlan?: ContextPlan;
  budget?: MoneyBudget;
  contextEstimate?: ContextEstimate;
  writePath?: string;
  label?: string;
  metadata?: {
    [key: string]: unknown;
  };
};
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_dependency'
  | 'verifying';
export type TaskSnapshot = {
  id: string;
  status: TaskStatus;
  revision: number;
  sessionId: string;
  spec: TaskSpec;
  artifactRefs: Array<string>;
  result: string | null;
  reason: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  retryIdentity?: RetryIdentity;
  rootTaskId?: string;
  writePaths?: Array<string>;
  verificationRules?: Array<FrozenVerificationRule>;
  verificationAttempts?: number;
  routing?: RoutingDecision;
  kind?: 'work' | 'compaction';
  maintenanceOperationId?: string;
  revisionRequest?: { approvalId: string; comment: string };
  dependencyResultsDelivered?: boolean;
  blockedBy?: TaskBlocker;
  deliveredAt?: string;
  pausedByClose?: { operationId: string; wasRunning: boolean };
  [key: string]: unknown;
};
export type TaskBlocker = {
  reason:
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
  taskIds?: Array<string>;
  sessionId?: string;
};
export type ApprovalRequest = {
  approvalId: string;
  taskId: string;
  purpose: 'task_acceptance' | 'runtime_permission';
  revision: number;
  status: 'pending' | 'approved' | 'denied' | 'revised' | 'expired' | 'invalidated';
  target: {
    taskId: string;
    taskRevision: number;
    artifactRefs: Array<string>;
    sessionId?: string;
    generation?: number;
    dispatchId?: string;
    providerSessionId?: string | null;
    providerTurnId?: string;
    requestId?: string;
    toolName?: string;
    permission?: unknown;
    requestDigest?: string;
    [key: string]: unknown;
  };
  summary: string;
  evidenceRefs: Array<string>;
  expiresAt: string;
  comment?: string;
  [key: string]: unknown;
};
export type UsageRecordedData = {
  usageRecordId: string;
  dispatchId: string;
  provider: string;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens?: number | null;
  model?: string;
  rootTaskId?: string;
  [key: string]: unknown;
};
export type UsageRecord = {
  id: string;
  taskId: string;
  dispatchId: string;
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens: number | null;
  raw: unknown;
  sessionId?: string;
  model?: string;
  rootTaskId?: string;
  recordedAt?: string;
  [key: string]: unknown;
};
export type UsageSummaryParams = { rootTaskId: string };
export type UsageTotals = {
  records: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  unknownRecords: number;
};
export type UsageModelTotals = {
  provider: string;
  model: string | null;
  records: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  unknownRecords: number;
};
export type UsageSummary = {
  rootTaskId: string;
  byModel: Array<UsageModelTotals>;
  totals: UsageTotals;
  completeness: 'reported' | 'unknown';
};
export type UsageByTaskParams = { taskIds: Array<string> };
export type UsageTaskTotals = {
  taskId: string;
  byModel: Array<UsageModelTotals>;
  totals: UsageTotals;
  completeness: 'reported' | 'unknown';
  reasoningEfforts: Array<string>;
};
export type UsageByTaskResult = { tasks: Array<UsageTaskTotals>; missing: Array<string> };
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'closed'
  | 'outcome_unknown';
export type SessionSnapshot = {
  id: string;
  taskId: string | null;
  provider: string;
  model: string;
  providerSessionId: string | null;
  generation: number;
  revision: number;
  status: SessionStatus;
  activeDispatchId: string | null;
  pauseOrigin?: 'client' | 'runtime';
  execution?: SessionExecution;
  retryIdentity?: RetryIdentity;
  taskIds?: Array<string>;
  rootTaskId?: string;
  permissionProfile?: 'read-only' | 'workspace-write';
  writePaths?: Array<string>;
  nativeCheckpoint?: string;
  forkSource?: {
    sessionId: string;
    generation: number;
    providerSessionId: string;
    nativeCheckpoint: string;
    snapshotRef: string;
  };
  generations?: Array<{
    generation: number;
    providerSessionId: string | null;
    nativeCheckpoint?: string;
    artifactRef: string;
  }>;
  label?: string;
  metadata?: {
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type OperationStatus =
  | 'persisted'
  | 'completed'
  | 'noop'
  | 'rejected'
  | 'failed'
  | 'outcome_unknown';
export type EngineLimits = unknown &
  unknown &
  unknown &
  unknown &
  unknown &
  unknown &
  unknown & {
    maxActiveSessions?: number;
    maxQuarantinedDispatches?: number;
    maxTurnsPerTask?: number;
    maxLogicalSessions?: number;
    maxQueuedTasks?: number;
    defaultMaxQueueWaitMs?: number;
  };
export type LifecycleTimeouts = {
  acceptanceMs?: number;
  turnMs?: number;
  drainMs?: number;
  interruptMs?: number;
  reconcileMs?: number;
};
export type LifecycleCapability = {
  version: 1;
  reconcile: 'owner-attestation';
  durableDeadlines: true;
  [key: string]: unknown;
};
export type ExecutionIsolationCapability = {
  version: 1;
  resourceRelease: true;
  schedulerStatus: true;
  ownerConflictResolution: true;
  budgetVersion: 2;
  [key: string]: unknown;
};
export type ExecutionLease = {
  version: 1;
  status: 'held' | 'released';
  acquiredAt: string;
  releasedAt?: string;
  releaseReason?: string;
  releaseEvidenceRef?: string;
  [key: string]: unknown;
};
export type DispatchBudget = {
  policyVersion: 2;
  enteredAt: string;
  acceptanceDeadlineAt: string;
  deadlineAt: string;
  effectiveAcceptanceMs: number;
  effectiveTurnMs: number;
  acceptanceSource: string;
  turnSource: string;
  [key: string]: unknown;
};
export type SessionExecution = {
  dispatchId: string;
  lease: ExecutionLease;
  quarantined: boolean;
  lastEvidence: string;
  budget?: DispatchBudget;
  [key: string]: unknown;
};
export type SchedulerSnapshot = {
  maxActiveSessions: number;
  maxQuarantinedDispatches: number;
  executionOccupied: number;
  quarantined: number;
  quarantineReserved: number;
  canDispatch: boolean;
  reasons: Array<string>;
  occupants: Array<{
    taskId: string;
    sessionId: string;
    dispatchId: string;
    leaseStatus: 'held' | 'released';
    quarantined: boolean;
    lastEvidence: string;
    enteredAt: string;
    [key: string]: unknown;
  }>;
  truncated: boolean;
  openConflicts: number;
  conflicts: Array<{
    conflictId: string;
    revision: number;
    dispatchId: string;
    [key: string]: unknown;
  }>;
  conflictsTruncated: boolean;
  [key: string]: unknown;
};
export type ExecutionConflict = {
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
  resolution?: {
    operationId: string;
    evidenceRef: string;
    occurredAt: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type SchedulerGetParams = {};
export type SchedulerGetConflictParams = { conflictId: string };
export type SchedulerResolveConflictParams = {
  conflictId: string;
  expectedRevision: number;
  evidence: ReconcileEvidence & {
    localResources?: 'stopped';
    remoteExecution?: 'stopped';
    outcome?: 'not_executed' | 'completed' | 'failed' | 'interrupted' | 'unknown';
    [key: string]: unknown;
  };
  idempotencyKey: string;
  expectedStoreId: string;
  requestDigest?: string;
};
export type OperationLifecycle = {
  enteredAt: string;
  deadlineAt: string;
  policyVersion: 1;
  kind: 'drain' | 'interrupt' | 'reconcile' | 'shutdown';
  expectedGeneration: number | null;
  expectedDispatchId: string | null;
  mayHaveBeenSent: boolean;
  lastEvidence: string;
  expiredAt?: string;
  [key: string]: unknown;
};
export type OperationSnapshot = {
  id: string;
  method: string;
  scope: string;
  idempotencyKey: string;
  status: OperationStatus;
  targetId: string;
  result: unknown;
  error: null | { code: string; message: string; [key: string]: unknown };
  lifecycle?: OperationLifecycle;
  resolution?: { operationId: string; outcome: string; occurredAt: string; [key: string]: unknown };
  retryIdentity?: RetryIdentity;
  [key: string]: unknown;
};
export type ReconcileEvidence = unknown & {
  source: 'owner_attestation';
  summary: string;
  localResources: 'stopped' | 'unknown';
  remoteExecution: 'stopped' | 'unknown';
  sideEffects: 'resolved' | 'unknown';
  outcome: 'not_executed' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'recorded';
  result?: string;
};
export type ReconcileParams = {
  target: ControlTarget;
  evidence: ReconcileEvidence;
  idempotencyKey: string;
  expectedStoreId: string;
  requestDigest?: string;
};
export type ControlTarget = {
  sessionId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedDispatchId: string | null;
  expectedState: SessionStatus;
};
export type MessageSpec = {
  taskId: string;
  toSessionId: string;
  expectedGeneration: number;
  kind: 'assignment' | 'finding' | 'result' | 'question';
  summary: string;
  artifactRefs?: Array<string>;
  ttlMs?: number;
  replyToMessageId?: string;
};
export type MessageSnapshot = {
  id: string;
  fromSessionId: string;
  idempotencyKey: string;
  status:
    | 'persisted'
    | 'dispatching'
    | 'runtime_accepted'
    | 'completed'
    | 'failed'
    | 'outcome_unknown'
    | 'expired';
  taskId: string;
  toSessionId: string;
  expectedGeneration: number;
  kind: 'assignment' | 'finding' | 'result' | 'question';
  summary: string;
  artifactRefs?: Array<string>;
  ttlMs?: number;
  replyToMessageId?: string;
  retryIdentity?: RetryIdentity;
  createdAt?: string;
  expiresAt?: string;
  hopCount?: number;
  [key: string]: unknown;
};
export type Request = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: {
    [key: string]: unknown;
  };
};
export type EventEnvelope = {
  eventId: string;
  cursor: string;
  storeId: string;
  schemaVersion: 1;
  type: string;
  taskId: string | null;
  sessionId: string | null;
  operationId: string | null;
  occurredAt: string;
  data: {
    [key: string]: unknown;
  };
};
export type RetryIdentity = {
  storeId: string;
  method: string;
  scope: string;
  idempotencyKey: string;
  digestVersion: 1;
  requestDigest: string;
};
export type MoneyBudget = { currency: string; maxCost: string; reservePerDispatch: string };
export type ContextRefCheck = {
  contextRefs: Array<{
    artifactRef: string;
    admissible: boolean;
    code?:
      | 'ARTIFACT_TOO_LARGE'
      | 'ARTIFACT_HISTORY_EXPIRED'
      | 'ARTIFACT_CORRUPT'
      | 'NOT_FOUND'
      | 'ARTIFACT_UNREADABLE';
    bytes?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};
export type ContextEstimate = {
  inputTokens: number;
  outputReserveTokens: number;
  toolReserveTokens: number;
};
export type RoutingMode = 'continue' | 'parallel_tools' | 'reuse' | 'fork' | 'fresh';
export type ContextPlan = {
  requestedMode: RoutingMode;
  independent: boolean;
  dependencyTaskIds?: Array<string>;
  contextRefs?: Array<{ artifactRef: string; version: 1 }>;
  candidateSessionId?: string;
  snapshotRef?: string;
  fallbackModes?: Array<RoutingMode>;
  maxQueueWaitMs?: number;
};
export type RoutingDecision = {
  policyVersion: 1;
  mode: RoutingMode;
  candidateSessionId: string;
  expectedGeneration: number;
  enqueuedAt: string;
  deadlineAt: string;
  maxQueueWaitMs: number;
  fallbackModes: Array<RoutingMode>;
  reasonCode: string;
  submittedAt?: string;
  expiredAt?: string;
};
export type RuleReference = { id: string; version: string };
export type VerificationRule = {
  id: string;
  version: string;
  argv: Array<string>;
  cwdRelative: string;
  timeoutMs: number;
  permissionProfile: 'read-only' | 'workspace-write';
  success: { exitCode: number };
  maxOutputBytes?: number;
  baselinePaths?: Array<string>;
};
export type FrozenVerificationRule = {
  id: string;
  version: string;
  argv: Array<string>;
  cwdRelative: string;
  timeoutMs: number;
  permissionProfile: 'read-only' | 'workspace-write';
  success: { exitCode: number };
  maxOutputBytes?: number;
  baselinePaths?: Array<string>;
  digest: string;
};
export type SessionOpenSpec = {
  runtime: RuntimeSpec;
  writeScope?: string;
  writePath?: string;
  label?: string;
  metadata?: {
    [key: string]: unknown;
  };
};
export type InitializeParams = { protocolVersion: '2.0'; sdkVersion: string };
export type InitializeResult = {
  protocolVersion: '2.0';
  engineVersion: string;
  schemaVersion: 3;
  instanceId: string;
  storeId: string;
  capabilities: {
    storeNamespaces: {
      version: 1;
      expectedStoreId?: true;
      digestVersion?: 1;
      [key: string]: unknown;
    };
    workflow?: WorkflowCapability;
    readOnly?: { version: 1; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type Pricing = {
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputTokenMode: 'total' | 'uncached';
  perMillion: {
    input: string;
    output: string;
    cacheRead?: string;
    cacheWrite?: string;
    cacheWrite5m?: string;
    cacheWrite1h?: string;
  };
};
export type RuntimeInspection = {
  status: 'found' | 'not_found' | 'unavailable' | 'mismatch';
  execution: 'unknown';
  providerSessionId: string | null;
  records: Array<unknown>;
  detail: string;
  target?: unknown;
  truncated: boolean;
  [key: string]: unknown;
};
export type StoragePolicy = {
  quotaBytes?: number;
  minFreeBytes?: number;
  emergencyBytes?: number;
  maxRecords?: number;
  settlementReserveRecords?: number;
  maxSettlementPerTarget?: number;
  eventDays?: number;
  detailDays?: number;
  usageDays?: number;
};
export type SnapshotPage = {
  snapshotId: string;
  storeId: string;
  cursor: string;
  retentionFloorCursor: string;
  expiresAt: string;
  items: Array<{
    kind: 'tasks' | 'sessions' | 'approvals';
    value: {
      [key: string]: unknown;
    };
  }>;
  nextOffset: number;
  done: boolean;
};
export type TaskCreateParams = {
  spec: TaskSpec;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type MessageSendParams = {
  spec: MessageSpec;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type SessionOpenParams = {
  spec: SessionOpenSpec;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type TaskMutationParams = {
  taskId: string;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type SessionControlParams = {
  target: ControlTarget;
  command: { action: 'pause' | 'resume' | 'stop'; mode?: 'drain' | 'interrupt' };
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type SessionForkParams = {
  target: ControlTarget;
  snapshotRef: string;
  model?: string;
  acknowledgeCacheLoss?: boolean;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type SessionMutationParams = {
  target: ControlTarget;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type StoreRolloverParams = {
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type StoreImportParams = {
  backupId: string;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type HostShutdownParams = {
  mode?: 'drain' | 'interrupt' | 'pause';
  timeoutMs?: number;
  operationId?: string;
  expectedStoreId: string;
  idempotencyKey?: string;
  requestDigest?: string;
};
export type ApprovalDecisionParams = {
  approvalId: string;
  decision: unknown & {
    choice: 'approve' | 'deny' | 'revise';
    expectedRevision: number;
    comment?: string;
  };
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type TaskListParams = unknown &
  unknown &
  unknown & {
    parentTaskId?: string;
    sessionId?: string;
    label?: string;
    limit?: number;
    afterCursor?: string;
    status?: Array<TaskStatus>;
    order?: 'asc' | 'desc';
  };
export type TaskListResult = { tasks: Array<TaskSnapshot>; nextCursor: string | null };
export type TaskGetManyParams = { taskIds: Array<string> };
export type TaskGetManyResult = { tasks: Array<TaskSnapshot>; missing: Array<string> };
export type HandoffRequest = {
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
  contextRefs: Array<{ artifactRef: string; version: 1 }>;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  taskId?: string;
  comment?: string;
};
export type HandoffGetParams = { handoffId: string };
export type HandoffListParams = {
  status?: 'pending' | 'accepted' | 'rejected' | 'expired' | 'invalidated';
  targetSessionId?: string;
  limit?: number;
  afterCursor?: string;
};
export type HandoffListResult = { handoffs: Array<HandoffRequest>; nextCursor: string | null };
export type HandoffResolveParams = unknown &
  unknown & {
    handoffId: string;
    expectedRevision: number;
    outcome: 'accepted' | 'rejected';
    taskId?: string;
    comment?: string;
    expectedStoreId: string;
    idempotencyKey: string;
    requestDigest?: string;
  };
export type RuleRegisterParams = {
  rule: VerificationRule;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type RuleRetireParams = {
  id: string;
  version: string;
  expectedStoreId: string;
  idempotencyKey: string;
  requestDigest?: string;
};
export type RegisteredVerificationRule = {
  id: string;
  version: string;
  argv: Array<string>;
  cwdRelative: string;
  timeoutMs: number;
  permissionProfile: 'read-only' | 'workspace-write';
  success: { exitCode: number };
  maxOutputBytes?: number;
  baselinePaths?: Array<string>;
  digest: string;
  source: 'config' | 'runtime';
  retiredAt?: string;
};
export type RuleListParams = { includeRetired?: boolean };
export type RuleListResult = { rules: Array<RegisteredVerificationRule> };
export type WorkflowCapability = {
  version: 1;
  dependencyResults?: true;
  revise?: true;
  delegationApproval?: true;
  handoffs?: true;
  writePath?: true;
  runtimeRules?: true;
  taskList?: true;
  contextCheck?: true;
  labels?: true;
  taskQueries?: true;
  queueReasons?: true;
  pauseClose?: true;
  ruleRetirement?: true;
  usageByTask?: true;
  reasoningEfforts?: true;
  reconcileRecordedResult?: true;
  [key: string]: unknown;
};
