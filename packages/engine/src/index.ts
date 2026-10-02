import { ControlPlane } from './control-plane.ts';
import { StorageGovernance } from './storage.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MUTATIONS, requestDigest, requestScope, type RetryIdentity } from './identity.ts';
const requestIdentity = new AsyncLocalStorage<RetryIdentity>();
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { canonicalPath } from './paths.ts';
import { Store } from './store.ts';
import { VERSION } from './version.ts';
import { MASKED_CHARACTERS, maskSecrets } from './masking.ts';
import {
  closedSessionsWithMessages,
  pendingRuntimeApprovals,
  pendingSteers,
  recoveryAction,
  unfinishedOperations,
} from './recovery.ts';
import { OrchestrationError, fail } from './errors.ts';
import { SHARED_READS, contextRefText, readCall, sessionSnapshot } from './reads.ts';
import {
  object,
  fields,
  string,
  integer,
  taskSpec,
  messageSpec,
  digest,
  contextPlan as validateContextPlan,
  contextRefs as validateContextRefs,
  MAX_QUEUE_WAIT_MS,
} from './validation.ts';
import { readRuntimeCapabilities } from './runtime.ts';
import { reportedUsage, usageRecord, usageTotals } from './usage.ts';
import {
  contains,
  checkRulePaths,
  effectiveRules,
  normalizeRules,
  ruleKey,
  verificationEnvironment,
  verifyRule,
  workspacePath,
} from './verification.ts';
import type { RetiredVerificationRule, VerificationEvidence } from './verification.ts';
import { completedRules, verificationFeedback } from './verification-feedback.ts';
import { ORCHESTRATION_TOOLS, TOOL_NAMES } from './tools.ts';
import { CostLedger } from './cost-ledger.ts';
import { estimateContext, moneyUnits, moneyString } from './accounting.ts';
import type {
  Engine,
  EngineConfig,
  EngineFailure,
  CallContext,
  CloseOptions,
  EngineCloseOptions,
  TaskSnapshot,
  SessionSnapshot,
  OperationSnapshot,
  ApprovalRequest,
  MessageSnapshot,
  RuntimeAdapter,
  RuntimeCapabilities,
  EngineRuntimeInput,
  RuntimeEvent,
  RuntimeSteerAnswer,
  RuntimeProgress,
  RuntimeUsageEvent,
  UsageRecord,
  Json,
  SessionControlTarget,
  EngineClock,
  LifecycleTimeouts,
  OperationLifecycle,
  ExecutionLease,
  ExecutionBudget,
  ExecutionBudgetSummary,
  ExecutionEvidence,
  ExecutionConflict,
  SchedulerSnapshot,
  TaskBlocker,
  FrozenVerificationRule,
  HandoffRequest,
  VerificationRule,
  TaskSpec,
  RuntimeSpec,
  RoutingDecision,
  RuntimeTools,
  RuntimePermissionRequest,
} from './types.ts';
export * from './types.ts';
export { OrchestrationError } from './errors.ts';
export { createFakeAdapter } from './fake.ts';
export { readRuntimeCapabilities, requireEngineRuntimeInput } from './runtime.ts';
export { priceUsage, estimateStrategies, estimateContext } from './accounting.ts';
export { validateWire } from './wire.ts';
export type { WireTypes } from './wire.ts';
export { openReadOnlyEngine, type ReadOnlyEngine, type ReadOnlyStoreInfo } from './read-only.ts';

const terminalTasks = new Set(['completed', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultTimeouts: Required<LifecycleTimeouts> = {
  acceptanceMs: 30_000,
  turnMs: 1_800_000,
  drainMs: 300_000,
  interruptMs: 30_000,
  reconcileMs: 60_000,
};
const realClock: EngineClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

function resultText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 524288)
    fail(
      'VALIDATION_ERROR',
      'result must be a string (max 524288); empty output is preserved for human review',
    );
  return value;
}
function resultPreview(text: string, artifactRef: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 64 * 1024) return text;
  let end = 64 * 1024;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return (
    bytes.subarray(0, end).toString('utf8') +
    `\n[Preview truncated; the full result is in artifact ${artifactRef}]`
  );
}
interface Dispatch extends Record<string, unknown> {
  id: string;
  taskId: string;
  sessionId: string;
  generation: number;
  status: string;
  executionLease: ExecutionLease;
  quarantined: boolean;
  quarantinedAt?: string;
  budget?: ExecutionBudgetSummary;
  lastEvidence: string;
  provider?: string;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  executionEvidence?: ExecutionEvidence;
  executionEvidenceRef?: string;
  evidenceSequence?: number;
  terminalCertificate?: ExecutionEvidence;
  terminalCertificateRef?: string;
  preSubmissionEvidenceRef?: string;
  executionState?: {
    localResources: 'stopped' | 'unknown' | 'active';
    remoteExecution: 'stopped' | 'unknown' | 'active';
    localEvidenceRef?: string;
    remoteEvidenceRef?: string;
  };
  terminalCoversExecution?: boolean;
}
interface Flight {
  /** Steers accepted with `outcomePending` that nothing has settled yet (SPEC-0058 D03). */
  pendingSteers?: Set<string>;
  /** The turn's runtime has finished: a steer answered from here on is unknown at once. */
  steersSettled?: true;
  taskId: string;
  sessionId: string;
  dispatchId: string;
  generation: number;
  messageIds: string[];
  controller: AbortController;
  promise: Promise<void>;
  intent: 'cancel' | 'pause' | 'stop' | 'shutdown' | null;
  /** Set by a pausing close before it aborts the flight; its terminal then reads it (SPEC-0028 S02). */
  pausedByClose?: true;
  controlIds: string[];
  expired: boolean;
  cancelTimers: (() => void)[];
  deadlineChecks: (() => void)[];
  cancelAcceptance?: () => void;
  budget: ExecutionBudget;
  /** SPEC-0057 W03: the evidence reported so far, applied in order. */
  evidence?: Promise<void>;
  /** Set once the terminal handling has waited for `evidence`: later evidence applies at once. */
  evidenceSettled?: true;
  /** True while the terminal handling only waits for its files; a close does not time it out. */
  writingFiles?: boolean;
  /** The time spent so, which no deadline of the flight counts (SPEC-0057 invariant 6). */
  fileWaitMs?: number;
  /** SPEC-0053 E02: this flight's progress limits, in memory only (invariant 3). */
  progress?: {
    count: number;
    dropped: number;
    textAt: number;
    text: string;
    thinkingAt: number;
    limited: boolean;
  };
}
const PROGRESS_LIMIT = 1000;
const PROGRESS_TEXT_MS = 5000;
const PROGRESS_THINKING_MS = 30_000;

/** A progress's bounded data, or null when it is malformed (SPEC-0053 E01). */
function progressData(value: unknown, workspace: string): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v ? v.slice(0, max) : undefined;
  const count = (v: unknown) =>
    v === null || v === undefined
      ? null
      : Number.isSafeInteger(v) && (v as number) >= 0
        ? v
        : undefined;
  if (p.kind === 'tool_started') {
    const tool = text(p.tool, 128);
    if (!tool) return null;
    // SPEC-0060 M03: 200 characters are kept; a bounded part of the command is examined.
    const command =
      p.command === undefined
        ? undefined
        : text(maskSecrets(String(p.command).slice(0, MASKED_CHARACTERS)), 200);
    const paths = Array.isArray(p.paths)
      ? p.paths
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
          .slice(0, 20)
          .map((path) => {
            const inside = isAbsolute(path) ? relative(workspace, path) : path;
            return (
              inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path
            ).slice(0, 512);
          })
      : [];
    const server = text(p.server, 128);
    return {
      kind: 'tool_started',
      tool,
      ...(command ? { command } : {}),
      ...(paths.length ? { paths } : {}),
      ...(server ? { server } : {}),
    };
  }
  if (p.kind === 'tool_finished') {
    const tool = text(p.tool, 128);
    const durationMs = count(p.durationMs);
    const exitCode =
      p.exitCode === null || p.exitCode === undefined
        ? null
        : Number.isSafeInteger(p.exitCode)
          ? p.exitCode
          : undefined;
    if (!tool || typeof p.ok !== 'boolean' || durationMs === undefined || exitCode === undefined)
      return null;
    return { kind: 'tool_finished', tool, ok: p.ok, durationMs, exitCode };
  }
  if (p.kind === 'thinking') return { kind: 'thinking' };
  if (p.kind === 'assistant_text') {
    if (typeof p.text !== 'string' || !p.text) return null;
    // SPEC-0060 M03: 280 characters are kept; a bounded part of the text is examined.
    return { kind: 'assistant_text', text: maskSecrets(p.text.slice(-MASKED_CHARACTERS)) };
  }
  if (p.kind === 'api_retry') {
    const fields = {
      attempt: count(p.attempt),
      maxRetries: count(p.maxRetries),
      delayMs: count(p.delayMs),
      status: count(p.status),
    };
    if (Object.values(fields).some((v) => v === undefined)) return null;
    // SPEC-0060 M04: an error's text can hold the credential it refused.
    const message =
      p.message === null || p.message === undefined
        ? null
        : typeof p.message === 'string'
          ? text(maskSecrets(p.message.slice(0, MASKED_CHARACTERS)), 300)
          : undefined;
    if (message === undefined) return null;
    return { kind: 'api_retry', ...fields, message };
  }
  return null;
}

class LocalEngine implements Engine {
  readonly instanceId = randomUUID();
  get storeId(): string {
    return this.store.storeId;
  }
  private controlPlane?: ControlPlane;
  private store: Store;
  private config: EngineConfig;
  private storage: StorageGovernance;
  private storageTimer?: ReturnType<typeof setInterval>;
  private adapters: Map<string, RuntimeAdapter>;
  private flights = new Map<string, Flight>();
  private closing = false;
  /** The first internal failure that stopped this engine, if any (SPEC-0025 F01). */
  private failure?: EngineFailure;
  private closed = false;
  private scheduled = false;
  private shutdownId: string | undefined;
  private closeAdaptersPromise: Promise<void> | undefined;
  private pendingResourceCleanups = new Map<
    string,
    { commit: () => void; applied: boolean; settling?: boolean }
  >();
  private clock: EngineClock;
  private timeouts: Required<LifecycleTimeouts>;
  private verificationRules: FrozenVerificationRule[] = [];
  /** `ruleKey` of rules registered through `rules.register` (SPEC-0014 W03/W05). */
  private runtimeRuleKeys = new Set<string>();
  /** Retired registered rules by `ruleKey`; none of them is effective (SPEC-0028 U01). */
  private retiredRules = new Map<string, RetiredVerificationRule>();
  private queueTimers = new Map<string, { cancel: () => void; deadline: number }>();
  private handoffTimer?: () => void;
  private permissionWaits = new Map<
    string,
    { promise: Promise<boolean>; settle: (allow: boolean) => void }
  >();
  private accounting: CostLedger;

  constructor(config: EngineConfig) {
    string(config.workspace, 'workspace');
    string(config.stateDir, 'stateDir');
    if (!Array.isArray(config.adapters) || !config.adapters.length)
      fail('VALIDATION_ERROR', 'At least one explicit adapter is required');
    this.adapters = new Map();
    for (const adapter of config.adapters) {
      string(adapter.provider, 'provider', 128);
      if (this.adapters.has(adapter.provider)) fail('VALIDATION_ERROR', 'Duplicate provider');
      this.adapters.set(adapter.provider, adapter);
    }
    integer(config.limits?.maxActiveSessions ?? 2, 'maxActiveSessions', 1, 8);
    integer(
      config.limits?.maxQuarantinedDispatches ?? 32,
      'maxQuarantinedDispatches',
      config.limits?.maxActiveSessions ?? 2,
      1024,
    );
    integer(config.limits?.maxTurnsPerTask ?? 20, 'maxTurnsPerTask', 1, 1000);
    integer(config.limits?.maxLogicalSessions ?? 10000, 'maxLogicalSessions', 1, 100000);
    integer(config.limits?.maxQueuedTasks ?? 1000, 'maxQueuedTasks', 1, 10000);
    integer(
      config.limits?.defaultMaxQueueWaitMs ?? 30000,
      'defaultMaxQueueWaitMs',
      0,
      MAX_QUEUE_WAIT_MS,
    );
    for (const [key, fallback, max] of [
      ['maxDepth', 4, 16],
      ['maxChildren', 32, 1000],
      ['maxCallsPerDispatch', 100, 10000],
      ['maxRepeatedCalls', 6, 100],
    ] as const)
      integer(config.tools?.[key] ?? fallback, `tools.${key}`, 1, max);
    integer(config.tools?.handoffTtlMs ?? 86400000, 'tools.handoffTtlMs', 60000, 604800000);
    for (const key of ['enabled', 'approveDelegation', 'handoffs'] as const)
      if (config.tools?.[key] !== undefined && typeof config.tools[key] !== 'boolean')
        fail('VALIDATION_ERROR', `tools.${key} must be boolean`);
    integer(config.approvalTtlMs ?? 86400000, 'approvalTtlMs', 1, 604800000);
    integer(config.runtimeApprovals?.ttlMs ?? 300000, 'runtimeApprovals.ttlMs', 1, 86400000);
    integer(config.messages?.ttlMs ?? 86400000, 'messages.ttlMs', 1, 604800000);
    integer(config.messages?.maxHops ?? 16, 'messages.maxHops', 1, 128);
    integer(config.messages?.maxPerMinute ?? 120, 'messages.maxPerMinute', 1, 10000);
    if (
      config.runtimeApprovals?.enabled !== undefined &&
      typeof config.runtimeApprovals.enabled !== 'boolean'
    )
      fail('VALIDATION_ERROR', 'runtimeApprovals.enabled must be boolean');
    const timeouts = object(config.timeouts ?? {}, 'timeouts');
    fields(timeouts, Object.keys(defaultTimeouts));
    this.timeouts = { ...defaultTimeouts };
    for (const key of Object.keys(defaultTimeouts) as (keyof LifecycleTimeouts)[])
      this.timeouts[key] = integer(
        timeouts[key] ?? defaultTimeouts[key],
        `timeouts.${key}`,
        1,
        86400000,
      );
    this.clock = config.clock ?? realClock;
    for (const [provider, options] of Object.entries(config.providers ?? {})) {
      const adapter = this.adapters.get(provider);
      if (!adapter) fail('VALIDATION_ERROR', `No adapter for ${provider}`);
      if (options.model !== undefined) string(options.model, 'model', 256);
      if (options.models !== undefined) {
        if (options.model !== undefined)
          fail('VALIDATION_ERROR', `Provider ${provider} configures both model and models`);
        if (!Array.isArray(options.models) || options.models.length === 0)
          fail('VALIDATION_ERROR', `Provider ${provider} models must be a non-empty list`);
        for (const model of options.models) string(model, 'models[]', 256);
        if (new Set(options.models).size !== options.models.length)
          fail('VALIDATION_ERROR', `Provider ${provider} models must be unique`);
      }
      const profile = options.permissionProfile ?? 'read-only';
      if (!readRuntimeCapabilities(adapter).permissionProfiles.includes(profile))
        fail('UNSUPPORTED_CAPABILITY', `Provider ${provider} cannot enforce ${profile}`);
    }
    this.config = config;
    // SPEC-0061 V01, V02: refused at start, not at the first verification.
    verificationEnvironment(config.verificationEnvironment, config.verificationInheritEnv);
    if (config.stores)
      this.controlPlane = new ControlPlane(
        config.workspace,
        config.stateDir,
        config.stores,
        config.storageFault,
        // A store switch must not activate registered rules this configuration rejects (W04).
        (stored) => void effectiveRules(config.workspace, config.verificationRules, stored),
      );
    const stateDir = this.controlPlane?.activeStateDir ?? config.stateDir;
    try {
      this.store = new Store(config.workspace, stateDir, {
        now: () => this.clock.wallNow(),
        fault: config.storageFault,
        fence: this.controlPlane?.fence(stateDir),
      });
      this.controlPlane?.bind(this.store);
    } catch (error) {
      this.controlPlane?.close();
      throw error;
    }
    try {
      this.storage = new StorageGovernance(this.store, config.storage, () =>
        this.clock.monotonicNow(),
      );
      this.accounting = new CostLedger(this.store, config);
      this.loadRules();
      for (const paths of Object.values(config.writeScopes ?? {})) {
        if (!Array.isArray(paths) || !paths.length || paths.length > 100)
          fail('VALIDATION_ERROR', 'Write scopes must contain 1..100 workspace paths');
        for (const path of paths)
          workspacePath(this.store.workspace, string(path, 'writeScope.path'));
      }
      this.recover();
      this.tryExpireHandoffs();
      this.storageTimer = setInterval(() => {
        if (this.closing || this.closed) return;
        try {
          this.storage.collect();
        } catch (error) {
          this.store.storageFailure(error);
          this.stopAfterFailure('storage collection', error);
          process.emitWarning(`Storage collection failed; scheduler stopped: ${String(error)}`);
        }
      }, 3600000);
      this.storageTimer.unref();
    } catch (error) {
      this.store.close();
      this.controlPlane?.close();
      throw error;
    }
  }

  /** Stops new work after an internal failure and keeps the first one for clients (SPEC-0025 F01). */
  private stopAfterFailure(step: string, error: unknown): void {
    this.closing = true;
    if (this.failure) return;
    const failure: EngineFailure = {
      step,
      code: error instanceof OrchestrationError ? error.code : 'INTERNAL_ERROR',
      at: this.time(),
    };
    this.failure = failure;
    // Outside the failing call's stack: the event first, where the store can still be written,
    // then the host's callback (SPEC-0027 F01, F02).
    queueMicrotask(() => this.announceFailure(failure));
  }
  private announceFailure(failure: EngineFailure): void {
    if (
      !this.closed &&
      !this.store.isClosed &&
      !this.store.degraded &&
      !this.store.db.isTransaction
    )
      try {
        this.store.event('scheduler.failed', { ...failure });
      } catch {
        // The failure that stopped the engine stays authoritative; the host still hears of it.
      }
    try {
      this.config.onFatal?.({ ...failure });
    } catch (error) {
      process.emitWarning(`onFatal callback failed: ${String(error)}`);
    }
  }
  /**
   * The last step of createEngine: the emergency reserve, written without blocking the event loop
   * (SPEC-0028 W01, W02). Recovery ran in the constructor, and no scheduler pass starts before a
   * call. A failure closes what the constructor opened.
   */
  async writeReserve(): Promise<void> {
    try {
      await this.storage.reserve();
    } catch (error) {
      if (this.storageTimer) clearInterval(this.storageTimer);
      this.handoffTimer?.();
      this.store.close();
      this.controlPlane?.close();
      this.closed = true;
      throw error;
    }
  }
  private ensureOpen(): void {
    if (this.closed) fail('CLIENT_CLOSED', 'Engine is closed');
  }
  /**
   * The engine's wall time: inside a transaction the reading it began with, so that every time
   * written in one transaction is one (SPEC-0030 B01), and a new reading outside one.
   */
  private wall(): number {
    return this.store.wallTime();
  }
  private time(): string {
    return new Date(this.wall()).toISOString();
  }
  /** The queue wait of a task whose plan does not set one (SPEC-0015 Q04). */
  private get defaultQueueWaitMs(): number {
    return this.config.limits?.defaultMaxQueueWaitMs ?? 30000;
  }
  private deadline(session: SessionSnapshot, kind: OperationLifecycle['kind']): OperationLifecycle {
    const duration = kind === 'shutdown' ? 30000 : this.timeouts[`${kind}Ms`];
    const enteredAt = this.wall();
    return {
      enteredAt: new Date(enteredAt).toISOString(),
      deadlineAt: new Date(enteredAt + duration).toISOString(),
      policyVersion: 1,
      kind,
      expectedGeneration: session.generation,
      expectedDispatchId: session.activeDispatchId,
      mayHaveBeenSent: kind === 'interrupt' && session.activeDispatchId !== null,
      lastEvidence: session.providerSessionId ? 'runtime_accepted' : 'dispatch_persisted',
    };
  }
  private arm(flight: Flight, duration: number, reason: string, operationId?: string): () => void {
    const end = this.clock.monotonicNow() + duration;
    let stopped = false;
    let cancel: () => void = () => {};
    // SPEC-0057 invariant 6: the time a turn's end spends writing its files does not count, and no
    // deadline expires during it. Those writes used to block the event loop, where no timer fires.
    const left = () => end + (flight.fileWaitMs ?? 0) - this.clock.monotonicNow();
    const check = () => {
      if (stopped || this.closed || !this.live(flight) || flight.writingFiles) return;
      if (operationId && this.store.operation(operationId).status !== 'persisted') return;
      const remaining = left();
      if (remaining > 0) return;
      try {
        this.expire(flight, reason);
      } catch (error) {
        this.stopAfterFailure('deadline persistence', error);
        process.emitWarning(`Deadline persistence failed; scheduler stopped: ${String(error)}`);
      }
    };
    const tick = () => {
      check();
      const remaining = left();
      if (!stopped && !this.closed && (remaining > 0 || flight.writingFiles))
        cancel = this.clock.setTimer(tick, Math.max(remaining, 10));
    };
    cancel = this.clock.setTimer(tick, duration);
    const stop = () => {
      stopped = true;
      cancel();
    };
    flight.cancelTimers.push(stop);
    flight.deadlineChecks.push(check);
    return stop;
  }
  private expire(flight: Flight, reason: string): void {
    if (!this.live(flight) || flight.expired) return;
    this.store.transaction(() => {
      const session = this.session(flight.sessionId),
        task = this.task(flight.taskId);
      this.saveSession(session, 'outcome_unknown');
      this.saveTask(task, 'blocked', `outcome_unknown: ${reason}`);
      const dispatch = this.store.require<Record<string, unknown>>('dispatches', flight.dispatchId);
      this.store.put('dispatches', flight.dispatchId, {
        ...dispatch,
        status: 'outcome_unknown',
        quarantined: true,
        quarantinedAt: dispatch.quarantinedAt ?? this.time(),
        expiredAt: this.time(),
        timeoutReason: reason,
      });
      this.messagesStatus(flight, 'outcome_unknown');
      for (const id of flight.controlIds) {
        const op = this.store.operation(id);
        if (op.status !== 'persisted') continue;
        op.status = 'outcome_unknown';
        op.error = { code: 'OUTCOME_UNKNOWN', message: reason };
        if (op.lifecycle) op.lifecycle.expiredAt = this.time();
        this.store.saveOperation(op);
        this.store.event(
          'operation.updated',
          { status: op.status, reason },
          { operationId: id, taskId: task.id, sessionId: session.id },
        );
      }
      this.store.event(
        'dispatch.deadline_exceeded',
        { dispatchId: flight.dispatchId, reason },
        { taskId: task.id, sessionId: session.id },
      );
      this.taskEvent(task);
      this.admissionEvent();
    });
    flight.expired = true;
    for (const cancel of flight.cancelTimers) cancel();
  }
  private ensureMutable(): void {
    this.ensureOpen();
    this.store.assertWritable();
    if (this.closing)
      fail(
        'HOST_STOPPING',
        this.failure
          ? `Engine stopped after its ${this.failure.step} failed (${this.failure.code})`
          : 'Engine is stopping',
        this.failure ? { failure: { ...this.failure } } : {},
      );
  }
  private task(id: string): TaskSnapshot {
    return this.store.require('tasks', id);
  }
  private dependencyState(spec: TaskSpec): 'queued' | 'waiting_dependency' | 'blocked' {
    const visiting = new Set<string>();
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (visiting.has(id)) fail('DEPENDENCY_CYCLE', 'Dependency graph contains a cycle');
      if (seen.has(id)) return;
      if (seen.size > 10000) fail('VALIDATION_ERROR', 'Dependency graph is too large');
      seen.add(id);
      visiting.add(id);
      for (const next of this.task(id).spec.dependencyTaskIds ?? []) walk(next);
      visiting.delete(id);
    };
    const dependencies = spec.dependencyTaskIds ?? [];
    for (const id of dependencies) walk(id);
    const tasks = dependencies.map((id) => this.task(id));
    if (tasks.some((t) => ['failed', 'cancelled'].includes(t.status))) return 'blocked';
    return tasks.every((t) => t.status === 'completed') ? 'queued' : 'waiting_dependency';
  }
  /**
   * Bounded, JSON-encoded results of completed dependencies, in declared order (SPEC-0014 D01).
   * Bounds count the UTF-8 bytes of each block as inserted, omission records included (D05).
   */
  private dependencyBlocks(task: TaskSnapshot): string[] {
    const entries = (task.spec.dependencyTaskIds ?? []).map((id) => {
      const artifactRef = this.task(id).artifactRefs[0];
      const header = { taskId: id, artifactRef: artifactRef ?? null };
      const omitted = (bytes: number | null, reason: string) =>
        `\nUntrusted dependency result ${JSON.stringify({ ...header, bytes, omitted: reason })}`;
      if (!artifactRef) return { record: omitted(null, 'no result artifact') };
      const record = this.store.get<{ sizeBytes: number; historyExpired?: boolean }>(
        'artifacts',
        artifactRef,
      );
      if (!record || record.historyExpired)
        return { record: omitted(null, 'result history expired') };
      const tooLarge = omitted(record.sizeBytes, 'exceeds the 32 KiB dependency bound');
      // JSON encoding never shrinks text, so a larger artifact cannot fit.
      if (record.sizeBytes > 32768) return { record: tooLarge };
      let text: string;
      try {
        text = this.store.artifactText(artifactRef, 32768);
      } catch (error) {
        const code = error instanceof OrchestrationError ? error.code : 'ARTIFACT_UNREADABLE';
        return { record: omitted(record.sizeBytes, `unreadable: ${code}`) };
      }
      const block = `\nUntrusted dependency result ${JSON.stringify(header)}:\n${JSON.stringify(text)}`;
      if (Buffer.byteLength(block) > 32768) return { record: tooLarge };
      return {
        block,
        record: omitted(record.sizeBytes, 'exceeds the 96 KiB total dependency bound'),
      };
    });
    // A record is a few hundred bytes and a task has at most 200 dependencies, so all records
    // fit. A full block is used only if every later dependency's record still fits after it.
    let reserved = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.record), 0);
    let used = 0;
    return entries.map(({ block, record }) => {
      reserved -= Buffer.byteLength(record);
      const chosen = block && used + Buffer.byteLength(block) + reserved <= 98304 ? block : record;
      used += Buffer.byteLength(chosen);
      return chosen;
    });
  }
  private refreshDependencies(): void {
    for (const task of this.store.tasksInState('waiting_dependency')) {
      const status = this.dependencyState(task.spec);
      if (status === 'waiting_dependency') continue;
      this.store.transaction(() => {
        this.saveTask(task, status, status === 'blocked' ? 'dependency_failed' : null);
        this.taskEvent(task);
      });
    }
  }
  private writePaths(spec: TaskSpec): string[] {
    const writable =
      this.config.providers?.[spec.runtime.provider]?.permissionProfile === 'workspace-write';
    if (spec.writeScope !== undefined) {
      const paths = this.config.writeScopes?.[spec.writeScope];
      if (!paths) fail('INVALID_WORKSPACE_SCOPE', 'Write scope is not registered');
      if (!writable)
        fail('INVALID_WORKSPACE_SCOPE', 'Read-only runtime cannot request a write scope');
      const roots = [...new Set(paths.map((path) => workspacePath(this.store.workspace, path)))];
      if (spec.writePath === undefined) return roots;
      let narrowed: string;
      try {
        narrowed = workspacePath(this.store.workspace, spec.writePath);
      } catch (error) {
        if (error instanceof OrchestrationError) throw error;
        fail('INVALID_WORKSPACE_SCOPE', 'writePath must be an existing workspace path');
      }
      if (!roots.some((root) => contains(root, narrowed)))
        fail('INVALID_WORKSPACE_SCOPE', 'writePath is outside the write scope');
      return [narrowed];
    }
    return writable ? [this.store.workspace] : [];
  }
  /**
   * The tasks whose held lease or pending verification overlaps `task`'s write paths. The scheduler
   * does not start `task` while there is one (SPEC-0028 B02 shares this with `blockedBy`).
   */
  private writeConflictHolders(
    task: TaskSnapshot,
    active = this.store.activeDispatches() as Dispatch[],
  ): string[] {
    const paths = task.verificationRules?.length ? [this.store.workspace] : (task.writePaths ?? []);
    if (!paths.length) return [];
    // SPEC-0054: paths recorded in another spelling of the same directory are compared as the
    // volume names them.
    const seen = new Map<string, string>();
    const named = (path: string) => {
      let found = seen.get(path);
      if (found === undefined) {
        try {
          found = canonicalPath(path);
        } catch {
          found = path;
        }
        seen.set(path, found);
      }
      return found;
    };
    const holders = active.filter((d) => {
      if (d.executionLease?.status !== 'held' && !d.verificationPending) return false;
      const occupied = d.writePaths as string[] | undefined;
      return (
        occupied?.some((a) =>
          paths.some((b) => {
            const [x, y] = [named(a), named(b)];
            return contains(x, y) || contains(y, x);
          }),
        ) ?? false
      );
    });
    return [...new Set(holders.map((d) => d.taskId))];
  }
  /** Storage keeps the scheduler from starting a task: backpressure, or an unsettled rollover. */
  private storageBlocked(): boolean {
    return !!this.controlPlane?.hasPendingRollover || this.storage.status().backpressured;
  }
  /**
   * Adds `blockedBy` to each waiting task that a read returns (SPEC-0028 B01). It asks the
   * predicates that the scheduler asks (B02), and reads the scheduler snapshot, the storage status
   * and the active dispatches at most once per read.
   */
  private addBlockers(tasks: TaskSnapshot[]): void {
    let scheduler: SchedulerSnapshot | undefined;
    let storage: boolean | undefined;
    let active: Dispatch[] | undefined;
    for (const task of tasks) {
      if (task.status === 'waiting_dependency')
        task.blockedBy = {
          reason: 'dependency',
          taskIds: (task.spec.dependencyTaskIds ?? []).filter(
            (id) => this.store.get<TaskSnapshot>('tasks', id)?.status !== 'completed',
          ),
        };
      else if (task.status === 'queued')
        task.blockedBy = this.queueBlocker(
          task,
          (scheduler ??= this.scheduler()),
          () => (storage ??= this.storageBlocked()),
          () => (active ??= this.store.activeDispatches() as Dispatch[]),
        );
    }
  }
  /** The first condition, in the order of SPEC-0028 B01, that keeps a queued task waiting. */
  private queueBlocker(
    task: TaskSnapshot,
    scheduler: SchedulerSnapshot,
    storageBlocked: () => boolean,
    active: () => Dispatch[],
  ): TaskBlocker {
    const reasons = scheduler.reasons;
    if (reasons.includes('SCHEDULER_FAILED')) return { reason: 'scheduler_failed' };
    if (reasons.includes('HOST_STOPPING')) return { reason: 'host_stopping' };
    if (reasons.includes('EXECUTION_CAPACITY_EXHAUSTED'))
      return {
        reason: 'capacity',
        taskIds: [
          ...new Set(
            active()
              .filter((d) => d.executionLease?.status === 'held')
              .map((d) => d.taskId),
          ),
        ],
      };
    if (reasons.includes('QUARANTINE_CAPACITY_EXCEEDED')) return { reason: 'quarantine_capacity' };
    if (reasons.includes('RESOURCE_CLEANUP_PENDING')) return { reason: 'resource_cleanup' };
    if (reasons.includes('EXECUTION_EVIDENCE_CONFLICT')) return { reason: 'execution_conflict' };
    if (storageBlocked()) return { reason: 'storage' };
    const session = this.session(task.sessionId);
    if (!this.sessionReady(task, session)) {
      const holders = new Set(
        (this.store.activeDispatches(session.id) as Dispatch[]).map((d) => d.taskId),
      );
      const flight = this.flights.get(session.id);
      if (flight) holders.add(flight.taskId);
      if (
        session.taskId &&
        session.taskId !== task.id &&
        !terminalTasks.has(this.task(session.taskId).status)
      )
        holders.add(session.taskId);
      return { reason: 'session_busy', sessionId: session.id, taskIds: [...holders] };
    }
    const writers = this.writeConflictHolders(task, active());
    if (writers.length) return { reason: 'write_conflict', taskIds: writers };
    return { reason: 'scheduling' };
  }
  private session(id: string): SessionSnapshot {
    return this.store.require('sessions', id);
  }
  private associatedTask(session: SessionSnapshot): TaskSnapshot {
    if (!session.taskId) fail('NO_SESSION_TASK', 'The logical session has no associated task');
    return this.task(session.taskId);
  }
  private checkedTarget(value: unknown): SessionSnapshot {
    const target = object(value, 'target');
    fields(target, [
      'sessionId',
      'expectedGeneration',
      'expectedRevision',
      'expectedDispatchId',
      'expectedState',
    ]);
    const session = this.session(string(target.sessionId, 'sessionId', 128));
    if (
      session.generation !== target.expectedGeneration ||
      session.revision !== target.expectedRevision ||
      session.activeDispatchId !== target.expectedDispatchId ||
      session.status !== target.expectedState
    )
      fail('STALE_TARGET', 'Session target changed');
    return session;
  }
  private requireQuietSession(session: SessionSnapshot): void {
    if (
      this.flights.has(session.id) ||
      session.activeDispatchId ||
      this.store.activeDispatches(session.id).length ||
      this.adapters.get(session.provider)?.hasActiveResources?.(session.id)
    )
      fail('RUNTIME_STILL_ACTIVE', 'Session has unresolved execution or retained resources');
    if (session.taskId && !terminalTasks.has(this.task(session.taskId).status))
      fail('SESSION_BUSY', 'Finish or cancel the associated task before managing history');
  }
  /** A provider's allowed models, or undefined when the owner configured no list. */
  private allowedModels(provider: string): string[] | undefined {
    const configured = this.config.providers?.[provider];
    return configured?.models ?? (configured?.model ? [configured.model] : undefined);
  }
  private requireAllowedModel(runtime: RuntimeSpec): void {
    const allowed = this.allowedModels(runtime.provider);
    if (allowed && !allowed.includes(runtime.model))
      fail('VALIDATION_ERROR', 'Model does not match configured provider');
  }
  private forkCandidate(
    source: SessionSnapshot,
    snapshotRef: string,
    change: { model?: string; acknowledgeCacheLoss?: boolean } = {},
  ): SessionSnapshot {
    this.requireQuietSession(source);
    const task = this.associatedTask(source);
    if (task.status !== 'completed' || !task.artifactRefs.includes(snapshotRef))
      fail('INVALID_SNAPSHOT', 'Fork requires an accepted source artifact');
    this.store.artifactText(snapshotRef, 1024 * 1024);
    const adapter = this.adapters.get(source.provider)!;
    const capabilities = readRuntimeCapabilities(adapter);
    if (capabilities.fork !== true || !source.providerSessionId || !source.nativeCheckpoint)
      fail('UNSUPPORTED_CAPABILITY', 'Runtime lacks a completed native checkpoint for forking');
    const model = change.model ?? source.model;
    if (model !== source.model) {
      const allowed = this.allowedModels(source.provider);
      if (!allowed)
        fail(
          'VALIDATION_ERROR',
          `Provider ${source.provider} does not configure an allowed model list`,
        );
      if (!allowed.includes(model))
        fail('VALIDATION_ERROR', `Model is not an allowed model for provider ${source.provider}`);
      if (capabilities.forkModelChange !== true)
        fail('UNSUPPORTED_CAPABILITY', 'Runtime does not support model-changing forks');
      if (change.acknowledgeCacheLoss !== true)
        fail(
          'CACHE_LOSS_NOT_ACKNOWLEDGED',
          'The fork model cannot reuse the source prompt cache; pass acknowledgeCacheLoss: true',
        );
    }
    const session = this.newSession(
      { provider: source.provider, model },
      source.writePaths ?? [],
      null,
      source.rootTaskId ?? task.rootTaskId ?? task.id,
      // A fork takes its source's labels (SPEC-0027 L02).
      { label: source.label, metadata: source.metadata },
    );
    session.forkSource = {
      sessionId: source.id,
      generation: source.generation,
      providerSessionId: source.providerSessionId,
      nativeCheckpoint: source.nativeCheckpoint,
      snapshotRef,
    };
    return session;
  }
  private newSession(
    runtime: RuntimeSpec,
    writePaths: string[],
    taskId: string | null,
    rootTaskId?: string,
    labels: Pick<SessionSnapshot, 'label' | 'metadata'> = {},
  ): SessionSnapshot {
    const count = (
      this.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    if (count >= (this.config.limits?.maxLogicalSessions ?? 10000))
      fail(
        'SESSION_CAPACITY_EXHAUSTED',
        'Logical session capacity reached; settle and archive this store',
      );
    return {
      id: randomUUID(),
      taskId,
      provider: runtime.provider,
      model: runtime.model,
      providerSessionId: null,
      generation: 1,
      revision: 1,
      status: 'idle',
      activeDispatchId: null,
      taskIds: taskId ? [taskId] : [],
      ...(rootTaskId ? { rootTaskId } : {}),
      permissionProfile:
        this.config.providers?.[runtime.provider]?.permissionProfile ?? 'read-only',
      writePaths,
      ...(labels.label !== undefined ? { label: labels.label } : {}),
      ...(labels.metadata !== undefined ? { metadata: labels.metadata } : {}),
    };
  }
  /**
   * Why the latest verification failed, for the retry prompt (SPEC-0022 V01-V03). The engine writes
   * that verification's evidence last among the task's artifacts; its size is bounded by the task's
   * frozen rules, whose output escapes to at most six bytes per captured byte.
   */
  private verificationFeedback(task: TaskSnapshot): string {
    const evidenceRef = task.artifactRefs.at(-1);
    const limit = (task.verificationRules ?? []).reduce(
      (sum, rule) => sum + (rule.maxOutputBytes ?? 65536) * 6 + 65536,
      65536,
    );
    let evidence: string | null = null;
    try {
      if (evidenceRef) evidence = this.store.artifactText(evidenceRef, limit);
    } catch {
      evidence = null;
    }
    return verificationFeedback(task.id, evidence, task.artifactRefs);
  }
  /**
   * Reads one context reference as admission, the prompt and `context.checkRefs` do (SPEC-0020). A
   * read failure that is not already an engine error becomes ARTIFACT_UNREADABLE.
   */
  private contextRefText(artifactRef: string): string {
    return contextRefText(this.store, artifactRef);
  }
  private selectSession(
    spec: TaskSpec,
    taskId: string,
    rootTaskId: string,
    writePaths: string[],
  ): { session: SessionSnapshot; routing?: RoutingDecision; fresh: boolean } {
    const plan = spec.contextPlan;
    if (!plan) {
      // A session the engine opens for a task takes the task's labels (SPEC-0027 L02).
      const session = this.newSession(spec.runtime, writePaths, taskId, rootTaskId, {
        label: spec.label,
        metadata: spec.metadata,
      });
      return {
        session,
        fresh: true,
        routing: {
          policyVersion: 1,
          mode: 'fresh',
          candidateSessionId: session.id,
          expectedGeneration: 1,
          enqueuedAt: this.time(),
          deadlineAt: new Date(this.wall() + this.defaultQueueWaitMs).toISOString(),
          maxQueueWaitMs: this.defaultQueueWaitMs,
          fallbackModes: [],
          reasonCode: 'ROOT_SESSION',
        },
      };
    }
    for (const ref of plan.contextRefs) this.contextRefText(ref.artifactRef);
    if (
      (plan.requestedMode === 'reuse' ||
        plan.requestedMode === 'fork' ||
        (spec.parentTaskId && plan.requestedMode === 'fresh')) &&
      !plan.independent
    )
      fail('INVALID_ROUTING', 'This routing mode requires declared independence');
    const fresh = plan.requestedMode === 'fresh' || plan.requestedMode === 'fork';
    if (plan.requestedMode !== 'fresh' && !plan.candidateSessionId)
      fail('INVALID_ROUTING', 'This mode requires candidateSessionId');
    const session =
      plan.requestedMode === 'fork'
        ? this.forkCandidate(
            this.session(plan.candidateSessionId!),
            string(plan.snapshotRef, 'snapshotRef', 128),
          )
        : plan.requestedMode === 'fresh'
          ? this.newSession(spec.runtime, writePaths, taskId, rootTaskId, {
              label: spec.label,
              metadata: spec.metadata,
            })
          : this.session(plan.candidateSessionId!);
    if (
      session.provider !== spec.runtime.provider ||
      session.model !== spec.runtime.model ||
      (session.permissionProfile ?? 'read-only') !==
        (this.config.providers?.[spec.runtime.provider]?.permissionProfile ?? 'read-only') ||
      digest(session.writePaths ?? []) !== digest(writePaths)
    )
      fail(
        'SESSION_INCOMPATIBLE',
        'Candidate runtime, model, permission profile or write scope differs',
      );
    const previousRoot =
      session.rootTaskId ??
      (session.taskId ? (this.task(session.taskId).rootTaskId ?? session.taskId) : undefined);
    if (previousRoot && previousRoot !== rootTaskId && !this.config.allowCrossRootReuse)
      fail(
        'HISTORY_REUSE_FORBIDDEN',
        'Cross-root history reuse requires explicit owner configuration',
      );
    if (session.status === 'closed') fail('SESSION_CLOSED', 'Session is closed');
    return {
      session,
      fresh,
      routing: {
        policyVersion: 1,
        mode: plan.requestedMode,
        candidateSessionId: session.id,
        expectedGeneration: session.generation,
        enqueuedAt: this.time(),
        deadlineAt: new Date(this.wall() + plan.maxQueueWaitMs).toISOString(),
        maxQueueWaitMs: plan.maxQueueWaitMs,
        fallbackModes: [...plan.fallbackModes],
        reasonCode: 'DECLARED_ROUTING',
      },
    };
  }
  private sessionReady(task: TaskSnapshot, session: SessionSnapshot): boolean {
    if (session.status !== 'idle' || session.activeDispatchId || this.flights.has(session.id))
      return false;
    if (
      session.taskId &&
      session.taskId !== task.id &&
      !terminalTasks.has(this.task(session.taskId).status)
    )
      return false;
    return this.store.activeDispatches(session.id).length === 0;
  }
  private armQueue(task: TaskSnapshot): void {
    if (
      task.status !== 'queued' ||
      !task.routing ||
      task.routing.submittedAt ||
      task.routing.expiredAt ||
      this.queueTimers.has(task.id)
    )
      return;
    const remaining = Math.max(
      0,
      Math.min(task.routing.maxQueueWaitMs, Date.parse(task.routing.deadlineAt) - this.wall()),
    );
    const deadline = this.clock.monotonicNow() + remaining;
    const record = { cancel: () => {}, deadline };
    const fire = () => {
      const left = deadline - this.clock.monotonicNow();
      if (left > 0) record.cancel = this.clock.setTimer(fire, Math.ceil(left));
      else this.kick();
    };
    record.cancel = this.clock.setTimer(fire, Math.ceil(remaining));
    this.queueTimers.set(task.id, record);
  }
  private stopQueue(taskId: string): void {
    this.queueTimers.get(taskId)?.cancel();
    this.queueTimers.delete(taskId);
  }
  /** The out-of-subtree session a reuse delegation may ask the host to hand work to. */
  private handoffTarget(
    plan: Record<string, unknown>,
    flight: Flight,
  ): SessionSnapshot | undefined {
    if (
      this.config.tools?.handoffs !== true ||
      plan.requestedMode !== 'reuse' ||
      plan.candidateSessionId === undefined
    )
      return undefined;
    const target = this.session(string(plan.candidateSessionId, 'candidateSessionId', 128));
    if (
      target.status === 'closed' ||
      (target.taskId && this.inSubtree(target.taskId, flight.taskId))
    )
      return undefined;
    return target;
  }
  /** Records a pending request; it grants nothing until the host resolves it (SPEC-0014 H01). */
  private requestHandoff(
    flight: Flight,
    parent: TaskSnapshot,
    target: SessionSnapshot,
    goal: string,
    contextRefs: { artifactRef: string; version: 1 }[],
    callId: string,
  ): Json {
    // A retried tool call maps to the same request instead of creating another.
    const handoffId = digest(`handoff:${callId}`).slice(0, 32);
    const receipt = (value: HandoffRequest) => ({
      handoffId: value.handoffId,
      status: value.status,
      targetSessionId: value.targetSessionId,
    });
    const existing = this.store.get<HandoffRequest>('handoffs', handoffId);
    if (existing) return receipt(existing);
    this.tryExpireHandoffs();
    const rootTaskId = parent.rootTaskId ?? parent.id;
    let record!: HandoffRequest;
    this.store.transaction(() => {
      const pending = (
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM handoffs WHERE json_extract(data,'$.status')='pending' AND json_extract(data,'$.rootTaskId')=?",
          )
          .get(rootTaskId) as { n: number }
      ).n;
      if (pending >= 100)
        fail('HANDOFF_LIMIT', 'This root task already has 100 pending handoff requests');
      // Its times are the transaction's, as its event's is (SPEC-0030 B01).
      record = {
        handoffId,
        status: 'pending',
        revision: 1,
        fromTaskId: parent.id,
        fromSessionId: flight.sessionId,
        fromDispatchId: flight.dispatchId,
        fromGeneration: flight.generation,
        rootTaskId,
        targetSessionId: target.id,
        goal,
        contextRefs,
        createdAt: this.time(),
        expiresAt: new Date(
          this.wall() + (this.config.tools?.handoffTtlMs ?? 86400000),
        ).toISOString(),
      };
      this.store.put('handoffs', handoffId, record);
      this.store.event(
        'handoff.requested',
        { handoffId, targetSessionId: target.id, fromSessionId: flight.sessionId, revision: 1 },
        { taskId: parent.id, sessionId: target.id },
      );
    });
    this.tryExpireHandoffs();
    return receipt(record);
  }
  private expireHandoffs(due: HandoffRequest[]): void {
    this.store.transaction(() => {
      for (const handoff of due) {
        handoff.status = 'expired';
        handoff.revision++;
        handoff.resolvedAt = this.time();
        this.store.put('handoffs', handoff.handoffId, handoff);
        this.store.event(
          'handoff.expired',
          { handoffId: handoff.handoffId, revision: handoff.revision },
          { taskId: handoff.fromTaskId, sessionId: handoff.targetSessionId },
        );
      }
    });
  }
  /**
   * Reads apply expiry when the store accepts writes; a read-only store reports stored state. One
   * timer wakes the scheduler at the earliest remaining expiry, so an idle host expires requests on
   * time (SPEC-0017 A04).
   */
  private tryExpireHandoffs(): void {
    this.handoffTimer?.();
    this.handoffTimer = undefined;
    let next: number | undefined;
    try {
      const now = this.wall();
      const due: HandoffRequest[] = [];
      // Through handoffs_pending_expiry, in creation order (SPEC-0024 X01, X02).
      for (const row of (
        this.store.db
          .prepare(
            "SELECT rowid AS ordinal,data FROM handoffs WHERE json_extract(data,'$.status')='pending'",
          )
          .all() as { ordinal: number; data: string }[]
      ).sort((a, b) => a.ordinal - b.ordinal)) {
        const handoff = JSON.parse(row.data) as HandoffRequest;
        const at = Date.parse(handoff.expiresAt);
        if (at <= now) due.push(handoff);
        else if (next === undefined || at < next) next = at;
      }
      if (due.length) this.expireHandoffs(due);
    } catch {
      // Due requests are retried by the next scheduler pass, read or mutation.
    }
    if (next === undefined || this.closing || this.closed) return;
    this.handoffTimer = this.clock.setTimer(
      () => {
        this.handoffTimer = undefined;
        this.kick();
      },
      Math.min(Math.max(0, next - this.wall()), 2147483647),
    );
  }
  private inSubtree(taskId: string, rootId: string): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = taskId; id && !seen.has(id) && seen.size <= 32; ) {
      if (id === rootId) return true;
      seen.add(id);
      id = this.store.get<TaskSnapshot>('tasks', id)?.spec.parentTaskId;
    }
    return false;
  }
  private toolLimit(flight: Flight, code: string): never {
    this.store.transaction(() => {
      const task = this.task(flight.taskId);
      task.reason = code;
      this.store.put('tasks', task.id, task);
      this.store.event(
        'tool.limit_reached',
        { code, dispatchId: flight.dispatchId },
        { taskId: task.id, sessionId: flight.sessionId },
      );
    });
    flight.intent = 'pause';
    if (
      readRuntimeCapabilities(this.adapters.get(this.session(flight.sessionId).provider)!).interrupt
    )
      flight.controller.abort();
    fail(code, 'Runtime tool limit reached; work is being paused');
  }
  private boundTools(flight: Flight): RuntimeTools {
    const assertLive = () => {
      if (
        this.closed ||
        this.closing ||
        flight.expired ||
        flight.controller.signal.aborted ||
        this.flights.get(flight.sessionId) !== flight ||
        !this.live(flight)
      )
        fail('STALE_GRANT', 'Runtime binding is no longer active');
    };
    const authorize = (id: string) => {
      if (!this.inSubtree(id, flight.taskId))
        fail('UNAUTHORIZED', 'Target is outside the delegated subtree');
    };
    return {
      definitions: ORCHESTRATION_TOOLS,
      call: async (name, raw) => {
        assertLive();
        if (!TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]))
          fail('UNAUTHORIZED', 'Unknown orchestration tool');
        let encoded: string;
        try {
          encoded = JSON.stringify(raw);
        } catch {
          fail('VALIDATION_ERROR', 'Tool input must be JSON');
        }
        if (!encoded || Buffer.byteLength(encoded) > 65536)
          fail('VALIDATION_ERROR', 'Tool input exceeds 64 KiB');
        const request = object(JSON.parse(encoded), 'request');
        const allowed =
          name === 'work_delegate'
            ? [
                'goal',
                'contextPlan',
                'dependencyTaskIds',
                'writeScope',
                'writePath',
                'idempotencyKey',
              ]
            : name === 'work_send'
              ? [
                  'taskId',
                  'toSessionId',
                  'expectedGeneration',
                  'kind',
                  'summary',
                  'artifactRefs',
                  'ttlMs',
                  'replyToMessageId',
                  'idempotencyKey',
                ]
              : name === 'work_read'
                ? ['kind', 'id']
                : ['target', 'command', 'idempotencyKey'];
        fields(request, allowed);
        const { idempotencyKey: providedKey, ...args } = request;
        const key =
          name === 'work_read' ? randomUUID() : string(providedKey, 'idempotencyKey', 128);
        const callId = `${flight.dispatchId}:${key}`;
        const hash = digest({ name, args });
        const previous = this.store.get<{
          digest: string;
          status: string;
          result?: Json;
          error?: { code: string; message: string };
        }>('tool_calls', callId);
        if (previous) {
          if (previous.digest !== hash)
            fail('IDEMPOTENCY_CONFLICT', 'Tool key was used for different arguments');
          if (previous.status === 'completed') return previous.result!;
          if (previous.error) fail(previous.error.code, previous.error.message);
          fail('OUTCOME_UNKNOWN', 'Previous tool call has no durable completion receipt');
        }
        const parent = this.task(flight.taskId);
        const descendants = this.store.subtreeTasks(parent.id);
        /** Artifacts of the bound subtree and of its declared direct dependencies (D02). */
        const readable = (ref: string) =>
          descendants.some((task) => task.artifactRefs.includes(ref)) ||
          (parent.spec.dependencyTaskIds ?? []).some((id) =>
            this.task(id).artifactRefs.includes(ref),
          );
        const state = digest(
          descendants.map((task) => [task.id, task.status, task.revision, task.artifactRefs]),
        );
        const loopKey = `${parent.id}:${hash}`;
        const loop = this.store.get<{ state: string; count: number }>('tool_loops', loopKey);
        if (loop?.state === state && loop.count >= (this.config.tools?.maxRepeatedCalls ?? 6))
          this.toolLimit(flight, 'TOOL_LOOP_LIMIT');
        const count = (
          this.store.db
            .prepare(
              "SELECT count(*) AS count FROM tool_calls WHERE json_extract(data, '$.dispatchId')=?",
            )
            .get(flight.dispatchId) as { count: number }
        ).count;
        if (count >= (this.config.tools?.maxCallsPerDispatch ?? 100))
          this.toolLimit(flight, 'TOOL_CALL_LIMIT');
        const record = {
          id: callId,
          taskId: parent.id,
          sessionId: flight.sessionId,
          dispatchId: flight.dispatchId,
          generation: flight.generation,
          name,
          digest: hash,
          status: 'pending',
          createdAt: this.time(),
        };
        this.store.transaction(() => {
          this.store.put('tool_calls', callId, record);
          this.store.put('tool_loops', loopKey, {
            id: loopKey,
            taskId: parent.id,
            state,
            count: loop?.state === state ? loop.count + 1 : 1,
          });
        });
        try {
          let result: unknown;
          const mutationKey = `tool:${callId}`;
          if (name === 'work_delegate') {
            const goal = string(args.goal, 'goal', 16384);
            const plan =
              args.contextPlan === undefined ? undefined : object(args.contextPlan, 'contextPlan');
            if (!plan || ['continue', 'parallel_tools'].includes(plan.requestedMode as string)) {
              if (
                plan?.candidateSessionId !== undefined &&
                plan.candidateSessionId !== flight.sessionId
              )
                fail('UNAUTHORIZED', 'Inline continuation must use this session');
              result = {
                taskId: parent.id,
                sessionId: flight.sessionId,
                mode: plan?.requestedMode ?? 'continue',
                delegated: false,
                instruction: goal,
              };
            } else if (this.handoffTarget(plan, flight)) {
              if (['dependencyTaskIds', 'writeScope', 'writePath'].some((key) => key in args))
                fail(
                  'VALIDATION_ERROR',
                  'A handoff request carries only a goal and context references',
                );
              const refs = validateContextPlan(plan).contextRefs;
              // H05: the requester may cite what it may read (D02), and nothing more.
              for (const ref of refs)
                if (!readable(ref.artifactRef))
                  fail('UNAUTHORIZED', 'Context artifact is outside the delegated subtree');
              result = this.requestHandoff(
                flight,
                parent,
                this.handoffTarget(plan, flight)!,
                goal,
                refs,
                callId,
              );
            } else {
              let depth = 0;
              for (
                let current: TaskSnapshot | undefined = parent;
                current?.spec.parentTaskId;
                current = this.store.get<TaskSnapshot>('tasks', current.spec.parentTaskId)
              )
                if (++depth >= (this.config.tools?.maxDepth ?? 4))
                  this.toolLimit(flight, 'DELEGATION_DEPTH_LIMIT');
              if (
                descendants.filter((task) => task.spec.parentTaskId === parent.id).length >=
                (this.config.tools?.maxChildren ?? 32)
              )
                this.toolLimit(flight, 'DELEGATION_CHILD_LIMIT');
              const childSpec = taskSpec(
                {
                  goal,
                  runtime: parent.spec.runtime,
                  acceptance: parent.spec.acceptance,
                  parentTaskId: parent.id,
                  contextPlan: plan,
                  // A child the engine creates takes its parent's labels (SPEC-0027 L02).
                  ...(parent.spec.label !== undefined ? { label: parent.spec.label } : {}),
                  ...(parent.spec.metadata !== undefined ? { metadata: parent.spec.metadata } : {}),
                  ...(args.dependencyTaskIds !== undefined
                    ? { dependencyTaskIds: args.dependencyTaskIds }
                    : {}),
                  ...(parent.spec.budget ? { budget: parent.spec.budget } : {}),
                  ...(args.writeScope !== undefined
                    ? { writeScope: args.writeScope }
                    : parent.spec.writeScope
                      ? { writeScope: parent.spec.writeScope }
                      : {}),
                  // Children inherit a narrowed parent path unless they name their own scope.
                  ...(args.writePath !== undefined
                    ? { writePath: args.writePath }
                    : args.writeScope === undefined && parent.spec.writePath
                      ? { writePath: parent.spec.writePath }
                      : {}),
                },
                this.defaultQueueWaitMs,
              );
              for (const dependency of childSpec.dependencyTaskIds ?? []) authorize(dependency);
              for (const ref of childSpec.contextPlan!.contextRefs) {
                if (!descendants.some((task) => task.artifactRefs.includes(ref.artifactRef)))
                  fail('UNAUTHORIZED', 'Context artifact is outside the delegated subtree');
              }
              if (plan.candidateSessionId) {
                const candidate = this.session(
                  string(plan.candidateSessionId, 'candidateSessionId', 128),
                );
                if (!candidate.taskId)
                  fail('UNAUTHORIZED', 'Tools cannot claim an unassigned session');
                authorize(candidate.taskId);
              }
              const paths = this.writePaths(childSpec);
              if (
                paths.some(
                  (path) => !(parent.writePaths ?? []).some((root) => contains(root, path)),
                )
              )
                fail('UNAUTHORIZED', 'Child write scope exceeds its parent');
              result = await this.call(
                'tasks.create',
                { spec: childSpec, idempotencyKey: mutationKey, expectedStoreId: this.storeId },
                { delegationGate: this.config.tools?.approveDelegation === true },
              );
            }
          } else if (name === 'work_send') {
            const taskId = string(args.taskId, 'taskId', 128);
            if (parent.spec.parentTaskId !== taskId) authorize(taskId);
            result = await this.call(
              'messages.send',
              { spec: args, idempotencyKey: mutationKey, expectedStoreId: this.storeId },
              {
                runtimeActor: {
                  sessionId: flight.sessionId,
                  taskId: flight.taskId,
                  dispatchId: flight.dispatchId,
                  generation: flight.generation,
                },
              },
            );
          } else if (name === 'work_control') {
            const target = object(args.target, 'target');
            const session = this.session(string(target.sessionId, 'sessionId', 128));
            if (!session.taskId) fail('UNAUTHORIZED', 'Tools cannot control an unassigned session');
            authorize(session.taskId);
            const command = object(args.command, 'command');
            fields(command, ['action', 'mode']);
            const action = string(command.action, 'action', 32);
            if (!['pause', 'resume', 'stop', 'compact', 'rotate'].includes(action))
              fail('UNAUTHORIZED', 'Control action is not granted');
            if (
              action !== 'pause' &&
              ['paused', 'pausing'].includes(session.status) &&
              session.pauseOrigin !== 'runtime'
            )
              fail('UNAUTHORIZED', 'A runtime cannot override a client or unowned pause');
            result = await this.call(
              ['compact', 'rotate'].includes(action) ? `sessions.${action}` : 'sessions.control',
              {
                target,
                ...(['compact', 'rotate'].includes(action) ? {} : { command }),
                idempotencyKey: mutationKey,
                expectedStoreId: this.storeId,
              },
              {
                runtimeActor: {
                  sessionId: flight.sessionId,
                  taskId: flight.taskId,
                  dispatchId: flight.dispatchId,
                  generation: flight.generation,
                },
              },
            );
          } else {
            const kind = string(args.kind, 'kind', 32),
              id = string(args.id, 'id', 512);
            const dependencies = parent.spec.dependencyTaskIds ?? [];
            if (kind === 'task') {
              if (!dependencies.includes(id)) authorize(id);
              result = this.task(id);
            } else if (kind === 'session') {
              const session = this.session(id);
              if (!session.taskId) fail('UNAUTHORIZED', 'Session has no granted task');
              authorize(session.taskId);
              result = this.sessionSnapshot(id);
            } else if (kind === 'message') {
              const message = this.store.require<MessageSnapshot>('messages', id);
              authorize(message.taskId);
              result = message;
            } else if (kind === 'artifact') {
              if (!readable(id)) fail('UNAUTHORIZED', 'Artifact is outside the delegated subtree');
              result = { artifactRef: id, text: this.store.artifactText(id, 65536) };
            } else if (kind === 'handoff') {
              this.tryExpireHandoffs();
              const handoff = this.store.require<HandoffRequest>('handoffs', id);
              if (!descendants.some((task) => task.id === handoff.fromTaskId))
                fail('UNAUTHORIZED', 'Handoff is outside the delegated subtree');
              result = handoff as unknown as Json;
            } else if (kind === 'usage') {
              authorize(id);
              result = await this.call('usage.get', { taskId: id });
            } else if (kind === 'operation') {
              const op = this.store.operation(id);
              if (
                !descendants.some(
                  (task) => task.id === op.targetId || task.sessionId === op.targetId,
                )
              )
                fail('UNAUTHORIZED', 'Operation is outside the delegated subtree');
              result = op;
            } else fail('UNAUTHORIZED', 'Read kind is not granted');
          }
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded) > 262144)
            fail('TOOL_OUTPUT_LIMIT', 'Tool result exceeds 256 KiB; use bounded artifacts');
          const json = JSON.parse(encoded) as Json;
          this.store.put('tool_calls', callId, {
            ...record,
            status: 'completed',
            result: json,
            completedAt: this.time(),
          });
          return json;
        } catch (error) {
          const code = error instanceof OrchestrationError ? error.code : 'TOOL_FAILED';
          const message =
            error instanceof OrchestrationError ? error.message : 'Orchestration tool failed';
          if (!this.closed)
            this.store.put('tool_calls', callId, {
              ...record,
              status: 'failed',
              error: { code, message },
              completedAt: this.time(),
            });
          fail(code, message);
        }
      },
    };
  }
  private expireQueue(task: TaskSnapshot): void {
    const route = task.routing!;
    this.store.transaction(() => {
      const current = this.task(task.id);
      if (current.routing?.submittedAt || current.status !== 'queued') return;
      route.expiredAt = this.time();
      const fallback = route.fallbackModes.shift();
      if (fallback) {
        const replacement = this.selectSession(
          {
            ...task.spec,
            contextPlan: {
              ...task.spec.contextPlan!,
              requestedMode: fallback,
              fallbackModes: route.fallbackModes,
              maxQueueWaitMs: 0,
            },
          },
          task.id,
          task.rootTaskId ?? task.id,
          task.writePaths ?? [],
        );
        if (replacement.fresh)
          this.store.put('sessions', replacement.session.id, replacement.session);
        task.sessionId = replacement.session.id;
        task.routing = {
          ...replacement.routing!,
          enqueuedAt: route.enqueuedAt,
          deadlineAt: route.deadlineAt,
          reasonCode: 'DECLARED_FALLBACK',
        };
        this.store.put('tasks', task.id, task);
      } else {
        task.routing = route;
        task.routing.reasonCode = 'SCHEDULING_BLOCKED';
        this.saveTask(task, 'blocked', 'SCHEDULING_BLOCKED');
        const receipt = this.store
          .operations()
          .find((op) => op.method === 'tasks.create' && op.targetId === task.id);
        if (receipt) {
          receipt.status = 'failed';
          receipt.error = {
            code: 'SCHEDULING_BLOCKED',
            message: 'Unsubmitted routing candidate expired',
          };
          this.store.saveOperation(receipt);
        }
      }
      this.store.event(
        'routing.expired',
        { mode: route.mode, fallback: fallback ?? null },
        { taskId: task.id, sessionId: task.sessionId },
      );
      this.taskEvent(task);
    });
    this.stopQueue(task.id);
  }
  private sessionSnapshot(id: string): SessionSnapshot {
    return sessionSnapshot(this.store, id);
  }
  private scheduler(): SchedulerSnapshot {
    const records = this.store.activeDispatches() as Dispatch[];
    const held = records.filter((d) => d.executionLease?.status === 'held');
    const quarantined = records.filter((d) => d.quarantined);
    const reserved = held.filter((d) => !d.quarantined);
    const conflicts = (
      this.store.db
        .prepare("SELECT data FROM execution_conflicts WHERE json_extract(data,'$.status')='open'")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as ExecutionConflict);
    const maxActiveSessions = this.config.limits?.maxActiveSessions ?? 2;
    const maxQuarantinedDispatches = this.config.limits?.maxQuarantinedDispatches ?? 32;
    const reasons: string[] = [];
    if (held.length >= maxActiveSessions) reasons.push('EXECUTION_CAPACITY_EXHAUSTED');
    if (quarantined.length + reserved.length >= maxQuarantinedDispatches)
      reasons.push('QUARANTINE_CAPACITY_EXCEEDED');
    if (this.closing) reasons.push('HOST_STOPPING');
    if (this.failure) reasons.push('SCHEDULER_FAILED');
    if (this.pendingResourceCleanups.size) reasons.push('RESOURCE_CLEANUP_PENDING');
    if (conflicts.length) reasons.push('EXECUTION_EVIDENCE_CONFLICT');
    const occupants = records.filter((d) => d.executionLease?.status === 'held' || d.quarantined);
    return {
      maxActiveSessions,
      maxQuarantinedDispatches,
      executionOccupied: held.length,
      quarantined: quarantined.length,
      quarantineReserved: reserved.length,
      canDispatch: reasons.length === 0,
      reasons,
      occupants: occupants.slice(0, 16).map((d) => ({
        taskId: d.taskId,
        sessionId: d.sessionId,
        dispatchId: d.id,
        leaseStatus: d.executionLease.status,
        quarantined: d.quarantined,
        lastEvidence: d.lastEvidence,
        enteredAt: d.quarantinedAt ?? d.executionLease.acquiredAt,
      })),
      truncated: occupants.length > 16,
      openConflicts: conflicts.length,
      conflicts: conflicts
        .slice(0, 16)
        .map((c) => ({ conflictId: c.id, revision: c.revision, dispatchId: c.dispatchId })),
      conflictsTruncated: conflicts.length > 16,
    };
  }
  private admissionEvent(): void {
    const snapshot = this.scheduler();
    const value = JSON.stringify(snapshot.reasons);
    const prior = this.store.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get('admissionReasons') as { value: string } | undefined;
    if (prior?.value === value || (!prior && !snapshot.reasons.length)) return;
    this.store.db
      .prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('admissionReasons', value);
    this.store.event('scheduler.admission_changed', {
      reasons: snapshot.reasons,
      executionOccupied: snapshot.executionOccupied,
      quarantined: snapshot.quarantined,
      quarantineReserved: snapshot.quarantineReserved,
    });
  }
  private admitWork(): void {
    if (this.controlPlane?.hasPendingRollover)
      fail('STORAGE_BACKPRESSURE', 'Continue settlement of the original rollover');
    this.storage.admit(68);
    if (this.scheduler().reasons.includes('QUARANTINE_CAPACITY_EXCEEDED'))
      fail(
        'QUARANTINE_CAPACITY_EXCEEDED',
        'Quarantine capacity is reserved or occupied; reconcile existing results before adding work',
      );
  }
  private stopProof(d: Dispatch): boolean {
    const e = d.executionEvidence;
    const state = d.executionState ?? e;
    if (!state || state.localResources !== 'stopped' || state.remoteExecution !== 'stopped')
      return false;
    if (d.preSubmissionEvidenceRef || e?.source === 'pre_submission')
      return !d.runtimeAccepted && !d.terminalCertificate;
    const t = d.terminalCertificate?.terminal;
    return (
      d.terminalCoversExecution === true &&
      !!t &&
      (t.type === 'result' ||
        t.type === 'interrupted' ||
        (t.type === 'error' && t.outcome === 'failed'))
    );
  }
  /** Runs a wait for files at a turn's end: not timed out by a close, nor counted by a deadline. */
  private async whileWriting(flight: Flight, work: () => Promise<void>): Promise<void> {
    const started = this.clock.monotonicNow();
    flight.writingFiles = true;
    try {
      await work();
    } finally {
      flight.writingFiles = false;
      flight.fileWaitMs = (flight.fileWaitMs ?? 0) + (this.clock.monotonicNow() - started);
    }
  }
  /** The release evidence of a dispatch whose runtime stopped; also predicted ahead (SPEC-0057). */
  private releaseEvidenceText(d: Dispatch, evidenceRef: string, occurredAt: string): string {
    return JSON.stringify({
      instanceId: this.instanceId,
      dispatchId: d.id,
      taskId: d.taskId,
      sessionId: d.sessionId,
      generation: d.generation,
      provider: d.provider,
      providerSessionId: d.providerSessionId,
      providerTurnId: d.providerTurnId,
      terminalEvidenceRef: d.terminalCertificateRef ?? null,
      preSubmissionEvidenceRef: d.preSubmissionEvidenceRef ?? null,
      state: d.executionState ?? null,
      latestObservationRef: evidenceRef,
      occurredAt,
    });
  }
  /**
   * SPEC-0057 W02: writes the files a turn's end registers, its result and the evidence of its
   * lease's release, before the transaction that registers them and without blocking the event
   * loop. The release evidence is predicted from the dispatch as it is now and the time `at` that
   * the transaction will write; a prediction that misses, or a write that fails, leaves the
   * transaction to write as it did before.
   */
  private async prepareTerminalFiles(
    flight: Flight,
    terminal: RuntimeEvent,
    at: number,
  ): Promise<void> {
    try {
      const texts: string[] = [];
      if (
        terminal.type === 'result' &&
        typeof terminal.text === 'string' &&
        terminal.text.length <= 524288
      )
        texts.push(terminal.text);
      const d = this.store.get<Dispatch>('dispatches', flight.dispatchId);
      if (d?.executionEvidenceRef && d.executionLease.status !== 'released')
        texts.push(this.releaseEvidenceText(d, d.executionEvidenceRef, new Date(at).toISOString()));
      await Promise.all(texts.map((text) => this.store.prepareArtifact(text).catch(() => {})));
    } catch {
      // Preparing is an optimization: the transaction writes what was not prepared.
    }
  }
  private release(d: Dispatch, evidenceRef: string, reason: string): void {
    if (d.executionLease.status === 'released') return;
    if (reason === 'runtime_stop_and_cleanup' && d.verificationPending) return;
    if (reason === 'runtime_stop_and_cleanup')
      evidenceRef = this.store.artifact(this.releaseEvidenceText(d, evidenceRef, this.time()));
    d.executionLease = {
      ...d.executionLease,
      status: 'released',
      releasedAt: this.time(),
      releaseReason: reason,
      releaseEvidenceRef: evidenceRef,
    };
    this.store.put('dispatches', d.id, d);
    this.store.event(
      'execution.released',
      {
        dispatchId: d.id,
        generation: d.generation,
        evidenceRef,
        reason,
        quarantined: d.quarantined,
      },
      { taskId: d.taskId, sessionId: d.sessionId },
    );
  }
  private reevaluateRelease(dispatchId: string): void {
    if (this.closed) return;
    this.store.transaction(() => {
      const d = this.store.require<Dispatch>('dispatches', dispatchId);
      if (
        this.flights.has(d.sessionId) ||
        this.adapters
          .get(d.provider ?? this.session(d.sessionId).provider)
          ?.hasActiveResources?.(d.sessionId)
      )
        return;
      if (this.stopProof(d)) this.release(d, d.executionEvidenceRef!, 'runtime_stop_and_cleanup');
      this.admissionEvent();
    });
    this.kick();
  }
  /**
   * SPEC-0053: writes a running turn's progress as `dispatch.progress`, bounded and throttled, in a
   * transaction of its own (invariant 1), only while the flight's turn runs (invariant 2). It never
   * throws to the adapter.
   */
  private reportProgress(flight: Flight, progress: RuntimeProgress): void {
    try {
      if (this.closed || this.flights.get(flight.sessionId) !== flight || !this.live(flight))
        return;
      const dispatch = this.store.get<Dispatch>('dispatches', flight.dispatchId);
      if (!dispatch || dispatch.terminalEvidence) return;
      const state = (flight.progress ??= {
        count: 0,
        dropped: 0,
        textAt: -Infinity,
        text: '',
        thinkingAt: -Infinity,
        limited: false,
      });
      if (state.limited) return;
      const data = progressData(progress, this.config.workspace);
      if (!data) {
        state.dropped++;
        return;
      }
      if (data.kind === 'assistant_text') {
        state.text = (state.text + data.text).slice(-280);
        if (this.clock.monotonicNow() - state.textAt < PROGRESS_TEXT_MS) return;
        state.textAt = this.clock.monotonicNow();
        data.text = state.text;
        state.text = '';
      }
      if (data.kind === 'thinking') {
        if (this.clock.monotonicNow() - state.thinkingAt < PROGRESS_THINKING_MS) return;
        state.thinkingAt = this.clock.monotonicNow();
      }
      const write = (value: Record<string, unknown>) =>
        this.store.transaction(() =>
          this.store.event(
            'dispatch.progress',
            { dispatchId: flight.dispatchId, ...value },
            { taskId: flight.taskId, sessionId: flight.sessionId },
          ),
        );
      if (state.count >= PROGRESS_LIMIT) {
        state.limited = true;
        write({ kind: 'limit_reached', limit: PROGRESS_LIMIT });
        return;
      }
      write({ ...data, ...(state.dropped ? { dropped: state.dropped } : {}) });
      state.count++;
      state.dropped = 0;
    } catch {
      // Progress may be lost; it never changes the turn (SPEC-0053 A02).
    }
  }
  /**
   * SPEC-0057 W03: a dispatch's evidence takes effect in the order it was reported, each after its
   * artifact is on disk, written off the event loop. The turn's terminal handling waits for what
   * was reported before it (invariant 1).
   */
  private reportEvidence(flight: Flight, provider: string, evidence: ExecutionEvidence): void {
    if (this.closed) return;
    // Only while the turn runs and its terminal handling has not begun: that handling waits for the
    // queue. Evidence that arrives later, or for a flight that ended, takes effect at once, as it
    // always did, so that a close, a reconciliation or a rollover right after it sees it.
    if (flight.evidenceSettled || this.flights.get(flight.sessionId) !== flight)
      return this.applyEvidence(flight, provider, evidence);
    let text: string | undefined;
    try {
      text = JSON.stringify({ instanceId: this.instanceId, taskId: flight.taskId, evidence });
    } catch {
      // Evidence that cannot be written is rejected when it is applied.
    }
    flight.evidence = (flight.evidence ?? Promise.resolve()).then(async () => {
      if (text !== undefined && !this.closed)
        await this.store.prepareArtifact(text).catch(() => {});
      this.applyEvidence(flight, provider, evidence);
    });
  }
  /** Waits until every evidence report queued so far has been applied (SPEC-0057 W03, W04). */
  private evidenceApplied(flight: Flight): Promise<void> {
    return this.whileWriting(flight, async () => {
      for (let waited: Promise<void> | undefined; waited !== flight.evidence; ) {
        waited = flight.evidence;
        await waited;
      }
    });
  }
  private applyEvidence(flight: Flight, provider: string, evidence: ExecutionEvidence): void {
    if (this.closed) return;
    try {
      this.store.transaction(() => {
        const d = this.store.require<Dispatch>('dispatches', flight.dispatchId);
        const session = this.session(flight.sessionId);
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
          this.store.event(
            'execution.evidence_rejected',
            { dispatchId: d.id, reason: 'malformed_evidence' },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
          return;
        }
        const terminal = evidence.terminal;
        const validTerminal =
          terminal === undefined
            ? evidence.source !== 'runtime_terminal'
            : !terminal || typeof terminal !== 'object' || Array.isArray(terminal)
              ? false
              : terminal.type === 'result'
                ? typeof terminal.text === 'string' &&
                  terminal.text.length <= 524288 &&
                  (!terminal.providerSessionId ||
                    terminal.providerSessionId === evidence.providerSessionId)
                : terminal.type === 'interrupted' ||
                  (terminal.type === 'error' &&
                    typeof terminal.message === 'string' &&
                    ['failed', 'unknown'].includes(terminal.outcome));
        const valid =
          validTerminal &&
          typeof evidence.detail === 'string' &&
          evidence.detail.length > 0 &&
          evidence.detail.length <= 65536 &&
          (evidence.providerSessionId === null ||
            (typeof evidence.providerSessionId === 'string' &&
              evidence.providerSessionId.length > 0 &&
              evidence.providerSessionId.length <= 256)) &&
          (evidence.providerTurnId === undefined ||
            evidence.providerTurnId === null ||
            (typeof evidence.providerTurnId === 'string' &&
              evidence.providerTurnId.length > 0 &&
              evidence.providerTurnId.length <= 256)) &&
          evidence.version === 1 &&
          Number.isSafeInteger(evidence.sequence) &&
          evidence.sequence > 0 &&
          evidence.dispatchId === d.id &&
          evidence.sessionId === d.sessionId &&
          evidence.generation === d.generation &&
          session.generation === d.generation &&
          evidence.provider === provider &&
          (!d.providerSessionId || evidence.providerSessionId === d.providerSessionId) &&
          (!d.providerTurnId || evidence.providerTurnId === d.providerTurnId) &&
          ['pre_submission', 'runtime_terminal', 'resource_observation'].includes(
            evidence.source,
          ) &&
          Number.isFinite(Date.parse(evidence.observedAt)) &&
          ['stopped', 'unknown', 'active'].includes(evidence.localResources) &&
          ['stopped', 'unknown', 'active'].includes(evidence.remoteExecution);
        if (!valid) {
          this.store.event(
            'execution.evidence_rejected',
            { dispatchId: d.id, reason: 'identity_or_contract_mismatch' },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
          return;
        }
        if (evidence.sequence <= (d.evidenceSequence ?? 0)) return;
        const ref = this.store.artifact(
          JSON.stringify({ instanceId: this.instanceId, taskId: d.taskId, evidence }),
        );
        d.evidenceSequence = evidence.sequence;
        d.executionEvidence = evidence;
        d.executionEvidenceRef = ref;
        d.lastEvidence = evidence.source;
        d.providerSessionId ??= evidence.providerSessionId;
        d.providerTurnId ??= evidence.providerTurnId;
        const previousState = d.executionState ?? {
          localResources: 'unknown',
          remoteExecution: 'unknown',
        };
        d.executionState = {
          ...previousState,
          ...(evidence.localResources !== 'unknown'
            ? { localResources: evidence.localResources, localEvidenceRef: ref }
            : {}),
          ...(evidence.remoteExecution !== 'unknown'
            ? { remoteExecution: evidence.remoteExecution, remoteEvidenceRef: ref }
            : {}),
        };
        if (evidence.source === 'pre_submission') d.preSubmissionEvidenceRef = ref;
        if (evidence.source === 'runtime_terminal' && evidence.terminal) {
          d.terminalCertificate = evidence;
          d.terminalCertificateRef = ref;
        }
        if (
          d.executionLease.status === 'released' &&
          (evidence.localResources === 'active' || evidence.remoteExecution === 'active')
        ) {
          const conflict: ExecutionConflict = {
            id: randomUUID(),
            revision: 1,
            dispatchId: d.id,
            sessionId: d.sessionId,
            taskId: d.taskId,
            generation: d.generation,
            status: 'open',
            releaseEvidenceRef: d.executionLease.releaseEvidenceRef ?? null,
            conflictingEvidenceRef: ref,
            createdAt: this.time(),
          };
          this.store.put('execution_conflicts', conflict.id, conflict);
          this.store.event(
            'execution.evidence_conflict',
            {
              conflictId: conflict.id,
              dispatchId: d.id,
              generation: d.generation,
              evidenceRef: ref,
              reason: 'EXECUTION_EVIDENCE_CONFLICT',
            },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
        }
        this.store.put('dispatches', d.id, d);
        this.admissionEvent();
      });
      if (!this.flights.has(flight.sessionId)) this.reevaluateRelease(flight.dispatchId);
    } catch (error) {
      this.stopAfterFailure('execution evidence persistence', error);
      process.emitWarning(
        `Execution evidence persistence failed; scheduler stopped: ${String(error)}`,
      );
    }
  }

  private recordUsage(flight: Flight, provider: string, event: RuntimeUsageEvent): void {
    if (this.closed) fail('HOST_CLOSED', 'Usage observation arrived after the host closed');
    const value = usageRecord(event, {
      taskId: flight.taskId,
      dispatchId: flight.dispatchId,
      provider,
    });
    const totals = usageTotals(event);
    try {
      this.store.transaction(() => {
        const dispatch = this.store.require<Dispatch>('dispatches', flight.dispatchId);
        if (
          dispatch.taskId !== flight.taskId ||
          dispatch.sessionId !== flight.sessionId ||
          dispatch.generation !== flight.generation ||
          dispatch.provider !== provider
        )
          fail('INVALID_RUNTIME_CONTRACT', 'Usage observation has no matching durable dispatch');
        // SPEC-0032 E01: the native session totals stay with the dispatch, in the transaction of
        // its observation; a repeated observation must carry the same ones.
        if (totals !== undefined) {
          const kept = (dispatch as { usageTotals?: Json }).usageTotals;
          if (kept === undefined)
            this.store.put('dispatches', dispatch.id, { ...dispatch, usageTotals: totals });
          else if (digest(kept) !== digest(totals))
            fail('IDEMPOTENCY_CONFLICT', 'Dispatch already recorded different session totals');
        }
        const existing = this.store.get<UsageRecord>('usage', value.id);
        // SPEC-0031 B01, B02: the model the runtime names, else the session's.
        const model = value.model ?? this.session(flight.sessionId).model;
        if (existing) {
          const { model: _named, ...reported } = value;
          if (
            digest(reportedUsage(existing)) !== digest(reported) ||
            (existing.model !== undefined && existing.model !== model)
          )
            fail(
              'IDEMPOTENCY_CONFLICT',
              'Usage identity was already recorded with different content',
            );
          return;
        }
        // SPEC-0028 E01: the record says whose it is and when, so that a reader needs no join.
        const task = this.task(flight.taskId);
        const record: UsageRecord = {
          ...value,
          sessionId: flight.sessionId,
          model,
          rootTaskId: task.rootTaskId ?? task.id,
          recordedAt: this.time(),
        };
        this.store.put('usage', record.id, record);
        this.accounting.record(record, dispatch, this.time());
        // E02: the counts and the model travel with the event; raw stays in the record.
        this.store.event(
          'usage.recorded',
          {
            usageRecordId: record.id,
            dispatchId: record.dispatchId,
            provider,
            inputTokens: record.inputTokens,
            cachedInputTokens: record.cachedInputTokens,
            cacheWriteInputTokens: record.cacheWriteInputTokens,
            // SPEC-0030 A03: the split travels only when the runtime reported it.
            ...(record.cacheWrite5mInputTokens !== undefined
              ? {
                  cacheWrite5mInputTokens: record.cacheWrite5mInputTokens,
                  cacheWrite1hInputTokens: record.cacheWrite1hInputTokens!,
                }
              : {}),
            outputTokens: record.outputTokens,
            model: record.model!,
            rootTaskId: record.rootTaskId!,
          },
          { taskId: flight.taskId, sessionId: flight.sessionId },
        );
      });
    } catch (error) {
      if (!(error instanceof OrchestrationError)) {
        this.stopAfterFailure('usage persistence', error);
        process.emitWarning(`Usage persistence failed; scheduler stopped: ${String(error)}`);
      }
      throw error;
    }
  }

  /**
   * The totals of the dispatch just before this one on the same native session (SPEC-0032 E01 to
   * E03): the session's own previous dispatch once it has a native session, else, for a fork's
   * first dispatch, its source's latest. Nothing when that dispatch kept no totals, or while the
   * source still runs, since then which totals the fork continues from is unknown.
   */
  private usageBaseline(
    session: SessionSnapshot,
    dispatchId: string,
  ): { dispatchId: string; totals: Json } | null {
    const fork = !session.providerSessionId && session.forkSource;
    if (!session.providerSessionId && !fork) return null;
    const owner = fork ? this.session(fork.sessionId) : session;
    if (fork && (owner.status === 'running' || this.store.activeDispatches(owner.id).length))
      return null;
    const previous = this.store.latestDispatch(owner.id, dispatchId);
    const totals = (previous as { usageTotals?: Json } | undefined)?.usageTotals;
    return previous && totals !== undefined ? { dispatchId: previous.id, totals } : null;
  }

  /** `delivered` records the change as the task's latest delivery of a result (SPEC-0029 B01). */
  private saveTask(
    task: TaskSnapshot,
    status?: TaskSnapshot['status'],
    reason?: string | null,
    delivered = false,
  ): void {
    // SPEC-0015 Q01: only time spent queued counts, so each new stay in the queue restarts the wait.
    if (
      status === 'queued' &&
      task.status !== 'queued' &&
      task.routing &&
      !task.routing.submittedAt
    ) {
      const wall = this.wall();
      task.routing.enqueuedAt = new Date(wall).toISOString();
      task.routing.deadlineAt = new Date(wall + task.routing.maxQueueWaitMs).toISOString();
      delete task.routing.expiredAt;
      // A timer from an earlier stay would still carry the old deadline (Q02.3).
      this.stopQueue(task.id);
    }
    if (status) task.status = status;
    if (reason !== undefined) task.reason = reason;
    // A close's mark lasts while the pause it describes lasts (SPEC-0029 D03).
    if (status && status !== 'paused') delete task.pausedByClose;
    task.revision++;
    task.updatedAt = this.time();
    if (delivered) task.deliveredAt = task.updatedAt;
    this.store.put('tasks', task.id, task);
  }
  private saveSession(session: SessionSnapshot, status?: SessionSnapshot['status']): void {
    if (status) {
      session.status = status;
      if (status !== 'paused' && status !== 'pausing') delete session.pauseOrigin;
    }
    session.revision++;
    this.store.put('sessions', session.id, session);
    if (status === 'closed') this.expireStoppedMessages(session.id);
  }
  private taskEvent(task: TaskSnapshot, operationId?: string): void {
    this.store.event(
      `task.${task.status}`,
      {
        status: task.status,
        reason: task.reason,
        revision: task.revision,
        ...(task.spec.label !== undefined ? { label: task.spec.label } : {}),
      },
      { taskId: task.id, sessionId: task.sessionId, operationId },
    );
  }
  private operation(
    method: string,
    scope: string,
    key: string,
    payload: unknown,
    mutate: (op: OperationSnapshot) => void,
  ): OperationSnapshot {
    string(key, 'idempotencyKey', 256);
    const hash = digest(payload);
    const identity = requestIdentity.getStore();
    const existing = this.store.findOperation(method, scope, key);
    if (existing) {
      if (
        existing.digest !== hash ||
        (identity &&
          existing.operation.retryIdentity &&
          identity.requestDigest !== existing.operation.retryIdentity.requestDigest)
      )
        fail('IDEMPOTENCY_CONFLICT', 'Key was already used with different payload');
      this.store.assertDetails(existing.operation);
      return existing.operation;
    }
    // An owner must be able to attest unknown resources that prevented its shutdown.
    // Keep normal writes and storage-degraded instances outside this exception.
    if (method === 'sessions.reconcile' && this.shutdownId) this.ensureOpen();
    else this.ensureMutable();
    return this.store.transaction(() => {
      if (
        ![
          'tasks.create',
          'messages.send',
          'sessions.steer',
          'sessions.open',
          'sessions.fork',
          'sessions.compact',
          'storage.configure',
          'storage.gc',
        ].includes(method)
      )
        this.storage.settlement(method, scope);
      const op: OperationSnapshot = {
        id: randomUUID(),
        method,
        scope,
        idempotencyKey: key,
        ...(identity ? { retryIdentity: identity } : {}),
        status: 'completed',
        targetId: '',
        result: null,
        error: null,
      };
      mutate(op);
      this.store.saveOperation(op, hash);
      this.store.event(
        'operation.created',
        { status: op.status, targetId: op.targetId },
        { operationId: op.id },
      );
      return op;
    });
  }
  /** Effective rules come from configuration and the active store only (SPEC-0014 W03/W04). */
  private loadRules(): void {
    const loaded = effectiveRules(
      this.store.workspace,
      this.config.verificationRules,
      this.store.all('verification_rules'),
    );
    this.verificationRules = loaded.rules;
    this.runtimeRuleKeys = loaded.runtime;
    this.retiredRules = new Map(
      loaded.retired.map((rule) => [ruleKey(rule.id, rule.version), rule]),
    );
  }
  private recover(): void {
    this.store.transaction(() => {
      // Each step acts on the rows that recovery.ts selects (SPEC-0027 R05).
      // SPEC-0058 D04, O01: before anything rewrites a task.
      for (const message of pendingSteers(this.store))
        this.settleSteer(message, message.toSessionId, 'unknown');
      for (const approval of pendingRuntimeApprovals(this.store)) {
        approval.status = 'invalidated';
        approval.revision++;
        this.store.put('approvals', approval.approvalId, approval);
        const task = this.task(approval.taskId);
        if (task.approvalId === approval.approvalId) {
          task.approvalId = null;
          this.store.put('tasks', task.id, task);
        }
        this.store.event(
          'approval.invalidated',
          { approvalId: approval.approvalId, reason: 'owner_restart' },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
      for (const task of this.store.all<TaskSnapshot>('tasks')) {
        const session = this.session(task.sessionId);
        const action = recoveryAction(task, session);
        if (action === 'pause_task') {
          this.saveTask(task, 'paused', 'owner_restart');
          this.taskEvent(task);
        } else if (action === 'block') {
          const dispatchId = session.activeDispatchId;
          this.saveTask(
            task,
            'blocked',
            'outcome_unknown: previous owner exited during a dispatch',
          );
          this.saveSession(session, 'outcome_unknown'); // Keep dispatch ID for inspection, never replay it.
          if (dispatchId)
            this.store.put('dispatches', dispatchId, {
              ...this.store.get<Record<string, unknown>>('dispatches', dispatchId),
              status: 'outcome_unknown',
              quarantined: true,
              quarantinedAt:
                this.store.get<Dispatch>('dispatches', dispatchId)?.quarantinedAt ?? this.time(),
              executionLease: this.store.get<Dispatch>('dispatches', dispatchId)
                ?.executionLease ?? { version: 1, status: 'held', acquiredAt: this.time() },
            });
          for (const message of this.store.all<MessageSnapshot>('messages'))
            if (
              message.taskId === task.id &&
              ['dispatching', 'runtime_accepted'].includes(message.status)
            ) {
              message.status = 'outcome_unknown';
              this.store.put('messages', message.id, message);
              const outbox = this.store.get<Record<string, unknown>>('outbox', message.id);
              if (outbox)
                this.store.put('outbox', message.id, { ...outbox, status: 'outcome_unknown' });
            }
          this.taskEvent(task);
        } else if (action === 'pause') {
          this.saveTask(task, 'paused', 'owner_restart');
          this.saveSession(session, 'paused');
          this.taskEvent(task);
        }
      }
      for (const op of unfinishedOperations(this.store)) {
        if (op.method === 'storage.gc') {
          op.status = 'failed';
          op.error = {
            code: 'GC_INTERRUPTED',
            message: 'Recorded file actions recovered; batch completion was not recorded',
          };
          this.store.saveOperation(op);
          continue;
        }
        op.status = 'outcome_unknown';
        op.error = {
          code: 'OUTCOME_UNKNOWN',
          message: 'Previous owner exited before operation completion',
        };
        // SPEC-0048 S05: a steer the runtime never answered may or may not have reached it.
        if (op.method === 'sessions.steer') {
          op.error = {
            code: 'STEER_OUTCOME_UNKNOWN',
            message: 'The previous owner exited before the runtime answered the steer',
          };
          const messageId = (op.result as { messageId?: string } | null)?.messageId;
          const message = messageId && this.store.get<MessageSnapshot>('messages', messageId);
          if (message && message.status === 'dispatching')
            this.store.put('messages', message.id, { ...message, status: 'outcome_unknown' });
        }
        if (op.lifecycle && Date.parse(op.lifecycle.deadlineAt) <= this.wall())
          op.lifecycle.expiredAt ??= this.time();
        this.store.saveOperation(op);
        this.store.event(
          'operation.updated',
          { status: op.status, reason: 'owner_restart' },
          { operationId: op.id },
        );
      }
      // Stores from rc.10 and earlier can hold pending messages to sessions already stopped.
      for (const id of closedSessionsWithMessages(this.store)) this.expireStoppedMessages(id);
      this.admissionEvent();
    });
  }
  private expireApprovals(): void {
    // Through approvals_pending_expiry, so finished approvals cost nothing. An ORDER BY rowid would
    // make SQLite scan the table instead; the few due rows are put in creation order here
    // (SPEC-0024 X01, X02).
    const expired = (
      this.store.db
        .prepare(
          "SELECT rowid AS ordinal,data FROM approvals WHERE json_extract(data,'$.status')='pending' AND json_extract(data,'$.expiresAt')<=?",
        )
        .all(this.time()) as { ordinal: number; data: string }[]
    )
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => JSON.parse(row.data) as ApprovalRequest);
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const approval of expired) {
        approval.status = 'expired';
        approval.revision++;
        this.store.put('approvals', approval.approvalId, approval);
        const task = this.task(approval.taskId);
        if (approval.purpose === 'runtime_permission') {
          this.permissionWaits.get(approval.approvalId)?.settle(false);
          if (task.approvalId === approval.approvalId) {
            task.approvalId = null;
            if (task.status === 'waiting_approval') this.saveTask(task, 'running', null);
          }
          this.store.event(
            'approval.expired',
            { approvalId: approval.approvalId, revision: approval.revision },
            { taskId: task.id, sessionId: task.sessionId },
          );
          continue;
        }
        if (task.approvalId === approval.approvalId && task.status === 'waiting_approval') {
          this.saveTask(task, 'paused', 'approval_expired');
          this.saveSession(this.session(task.sessionId), 'paused');
          this.taskEvent(task);
        }
        this.store.event(
          'approval.expired',
          { approvalId: approval.approvalId, revision: approval.revision },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
  }
  private invalidateApproval(task: TaskSnapshot): void {
    if (!task.approvalId) return;
    const approval = this.store.get<ApprovalRequest>('approvals', task.approvalId);
    if (approval?.status === 'pending') {
      approval.status = 'invalidated';
      approval.revision++;
      this.store.put('approvals', approval.approvalId, approval);
      this.permissionWaits.get(approval.approvalId)?.settle(false);
    }
    task.approvalId = null;
  }
  private async requestRuntimePermission(
    flight: Flight,
    request: RuntimePermissionRequest,
  ): Promise<boolean> {
    if (
      this.closed ||
      this.closing ||
      flight.expired ||
      flight.controller.signal.aborted ||
      this.flights.get(flight.sessionId) !== flight ||
      !this.live(flight)
    )
      return false;
    string(request.requestId, 'permission.requestId', 256);
    string(request.toolName, 'permission.toolName', 256);
    const serialized = JSON.stringify(request.permission);
    if (!serialized || Buffer.byteLength(serialized) > 65536)
      fail('VALIDATION_ERROR', 'Permission object exceeds 64 KiB');
    const session = this.session(flight.sessionId);
    if (
      request.providerSessionId &&
      session.providerSessionId &&
      request.providerSessionId !== session.providerSessionId
    )
      return false;
    const id = `runtime-${digest({ dispatchId: flight.dispatchId, requestId: request.requestId })}`;
    const fingerprint = digest(request);
    const old = this.store.get<ApprovalRequest>('approvals', id);
    if (old) {
      if (old.target.requestDigest !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', 'Permission target changed');
      return this.permissionWaits.get(id)?.promise ?? old.status === 'approved';
    }
    const task = this.task(flight.taskId);
    if (task.approvalId) return false;
    const ttl = Math.min(
      this.config.runtimeApprovals?.ttlMs ?? 300000,
      flight.budget.remainingTurnMs(),
    );
    if (ttl <= 0) return false;
    let resolve!: (allow: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    let cancelled = false;
    let cancelTimer = () => {};
    const settle = (allow: boolean) => {
      if (cancelled) return;
      cancelled = true;
      cancelTimer();
      flight.controller.signal.removeEventListener('abort', abort);
      this.permissionWaits.delete(id);
      resolve(allow && !flight.expired && !flight.controller.signal.aborted && this.live(flight));
    };
    const invalidate = (status: 'expired' | 'invalidated') => {
      const approval = this.store.get<ApprovalRequest>('approvals', id);
      if (approval?.status === 'pending')
        this.store.transaction(() => {
          approval.status = status;
          approval.revision++;
          this.store.put('approvals', id, approval);
          const current = this.task(flight.taskId);
          if (current.approvalId === id) {
            current.approvalId = null;
            if (current.status === 'waiting_approval') this.saveTask(current, 'running', null);
          }
          this.store.event(
            `approval.${status}`,
            { approvalId: id, revision: approval.revision },
            { taskId: task.id, sessionId: session.id },
          );
        });
      settle(false);
    };
    const abort = () => invalidate('invalidated');
    this.permissionWaits.set(id, { promise, settle });
    try {
      this.store.transaction(() => {
        task.approvalId = id;
        this.saveTask(task, 'waiting_approval', 'runtime_permission');
        const approval: ApprovalRequest = {
          approvalId: id,
          taskId: task.id,
          purpose: 'runtime_permission',
          revision: 1,
          status: 'pending',
          target: {
            taskId: task.id,
            taskRevision: task.revision,
            artifactRefs: [],
            sessionId: session.id,
            generation: flight.generation,
            dispatchId: flight.dispatchId,
            providerSessionId: session.providerSessionId,
            ...(request.providerTurnId ? { providerTurnId: request.providerTurnId } : {}),
            requestId: request.requestId,
            toolName: request.toolName,
            permission: request.permission,
            requestDigest: fingerprint,
          },
          summary: `Permission requested for ${request.toolName}`,
          evidenceRefs: [],
          expiresAt: new Date(this.wall() + ttl).toISOString(),
        };
        this.store.put('approvals', id, approval);
        this.store.event('approval.requested', approval as unknown as Record<string, Json>, {
          taskId: task.id,
          sessionId: session.id,
        });
        this.taskEvent(task);
      });
      cancelTimer = this.clock.setTimer(() => invalidate('expired'), ttl);
      flight.controller.signal.addEventListener('abort', abort, { once: true });
      if (flight.controller.signal.aborted) abort();
      return await promise;
    } catch (error) {
      settle(false);
      throw error;
    }
  }
  private requestApproval(task: TaskSnapshot): void {
    this.invalidateApproval(task);
    const id = randomUUID();
    task.approvalId = id;
    // The review of a result is its delivery; a runtime permission's review is not (SPEC-0029 B01).
    this.saveTask(task, 'waiting_approval', null, true);
    const approval: ApprovalRequest = {
      approvalId: id,
      taskId: task.id,
      purpose: 'task_acceptance',
      revision: 1,
      status: 'pending',
      target: {
        taskId: task.id,
        taskRevision: task.revision,
        artifactRefs: [...task.artifactRefs],
      },
      summary: task.result ?? '',
      evidenceRefs: [...task.artifactRefs],
      expiresAt: new Date(this.wall() + (this.config.approvalTtlMs ?? 86400000)).toISOString(),
    };
    this.store.put('approvals', id, approval);
    this.taskEvent(task);
    this.store.event(
      'approval.requested',
      {
        approvalId: id,
        purpose: approval.purpose,
        revision: 1,
        target: approval.target,
        summary: approval.summary,
        evidenceRefs: approval.evidenceRefs,
        expiresAt: approval.expiresAt,
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }

  private resumePausedTask(
    task: TaskSnapshot,
    session: SessionSnapshot,
    operationId: string,
    approveDelegation = false,
  ): void {
    if (task.status === 'paused' && task.reason === 'DELEGATION_APPROVAL_REQUIRED') {
      if (session.taskId === task.id && session.status === 'paused')
        this.saveSession(session, 'idle');
      if (!approveDelegation) return;
      this.admitWork();
      const status = this.dependencyState(task.spec);
      // The routing wait starts when the approved task enters the queue (SPEC-0015 Q01).
      this.saveTask(task, status, status === 'blocked' ? 'dependency_failed' : null);
      this.taskEvent(task, operationId);
      this.armQueue(task);
      return;
    }
    if (
      task.status === 'paused' &&
      !(
        ['approval_expired', 'reconciled_result'].includes(task.reason ?? '') &&
        task.result !== null
      )
    ) {
      this.admitWork();
      const adapter = this.adapters.get(session.provider);
      if (!adapter)
        fail('UNSUPPORTED_CAPABILITY', 'The original runtime provider is not configured');
      readRuntimeCapabilities(adapter);
    }
    if (session.taskId === task.id) this.saveSession(session, 'idle');
    if (task.status !== 'paused') return;
    if (
      task.spec.acceptance.mode === 'human' &&
      ['approval_expired', 'reconciled_result'].includes(task.reason ?? '') &&
      task.result !== null
    ) {
      this.requestApproval(task);
    } else {
      this.saveTask(task, 'queued', null);
      this.taskEvent(task, operationId);
    }
  }

  async call(
    method: string,
    raw: Record<string, unknown> = {},
    context: CallContext = {},
  ): Promise<unknown> {
    this.ensureOpen();
    if (
      [
        'stores.rollover',
        'stores.import',
        'storage.backup',
        'rollovers.get',
        'archives.lookup',
        'archives.readArtifact',
      ].includes(method)
    ) {
      if (['stores.rollover', 'stores.import', 'storage.backup'].includes(method) && !context.owner)
        fail('UNAUTHORIZED', 'Only the owner may switch stores');
      if (!this.controlPlane)
        fail('ROLLOVER_UNSUPPORTED', 'Configure trusted controlDir, storesRoot and archiveRoot');
      if (method === 'rollovers.get') {
        fields(raw, ['rolloverId']);
        return this.controlPlane.rolloverRecord(string(raw.rolloverId, 'rolloverId'));
      }
      if (method === 'archives.lookup') return this.controlPlane.archiveLookup(raw);
      if (method === 'archives.readArtifact') return this.controlPlane.readArchiveArtifact(raw);
      if (raw.expectedStoreId === undefined)
        fail('STORE_NAMESPACE_REQUIRED', 'A fixed expectedStoreId is required');
      const runtimeBlockers = [...this.flights.values()].map((flight) => ({
        id: flight.dispatchId,
        reason: 'owned_runtime_handle',
      }));
      for (const [id] of this.pendingResourceCleanups)
        runtimeBlockers.push({ id, reason: 'cleanup_handle' });
      if (method === 'storage.backup')
        return this.controlPlane.backup(this.store, raw, runtimeBlockers);
      const record = this.controlPlane.rollover(this.store, raw, runtimeBlockers, method);
      if (record.status === 'completed' && this.store.storeId !== this.controlPlane.activeStoreId) {
        const policy = this.storage.policy;
        this.store.close();
        const stateDir = this.controlPlane.activeStateDir;
        this.store = new Store(this.config.workspace, stateDir, {
          now: () => this.clock.wallNow(),
          fault: this.config.storageFault,
          fence: this.controlPlane.fence(stateDir),
        });
        this.controlPlane.bind(this.store);
        this.storage = new StorageGovernance(this.store, policy, () => this.clock.monotonicNow());
        this.accounting = new CostLedger(this.store, this.config);
        this.loadRules();
        await this.storage.reserve();
      }
      return record;
    }
    if (this.controlPlane?.switching)
      fail('STORE_SWITCH_IN_PROGRESS', 'Continue the original rollover before using a store');
    if (method === 'initialize' && raw.protocolVersion !== '2.0')
      fail('PROTOCOL_MISMATCH', 'Expected protocolVersion 2.0');
    if (!MUTATIONS.has(method)) return this.dispatchCall(method, raw, context);
    if (raw.expectedStoreId === undefined)
      fail('STORE_NAMESPACE_REQUIRED', 'A fixed expectedStoreId is required');
    if (raw.expectedStoreId !== this.storeId)
      fail('STORE_NAMESPACE_MISMATCH', 'Request belongs to another store', {
        expectedStoreId: raw.expectedStoreId,
        currentStoreId: this.storeId,
        archiveId:
          typeof raw.expectedStoreId === 'string'
            ? (this.controlPlane?.archiveId(raw.expectedStoreId) ?? null)
            : null,
      });
    const hash = requestDigest(method, raw);
    if (raw.requestDigest !== undefined && raw.requestDigest !== hash)
      fail('IDEMPOTENCY_CONFLICT', 'Retry payload digest changed');
    const identity: RetryIdentity = {
      storeId: this.storeId,
      method,
      scope: requestScope(method, raw),
      idempotencyKey: typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : '',
      digestVersion: 1,
      requestDigest: hash,
    };
    const { expectedStoreId: _expected, requestDigest: _digest, ...params } = raw;
    return requestIdentity.run(identity, async () => {
      try {
        const result = await this.dispatchCall(method, params, context);
        return result && typeof result === 'object'
          ? { ...result, retryIdentity: identity }
          : result;
      } finally {
        // SPEC-0055 C01: what a mutation committed may free a session, end a dependency or lift
        // backpressure; the scheduler looks once more, after the commit. A pass with nothing to do
        // is cheap, and passes asked for together run once.
        this.kick();
      }
    });
  }
  private async dispatchCall(
    method: string,
    raw: Record<string, unknown>,
    context: CallContext,
  ): Promise<unknown> {
    const p = object(raw);
    if (!this.store.degraded) {
      if (!['scheduler.get', 'scheduler.getConflict'].includes(method)) this.expireApprovals();
      this.expireMessages();
    }
    // SPEC-0027 R03: the reads that a read-only view answers go through the same code.
    if (SHARED_READS.has(method))
      return readCall(this.store, method, p, {
        expireHandoffs: () => this.tryExpireHandoffs(),
        blockedBy: (tasks) => this.addBlockers(tasks),
      });
    switch (method) {
      case 'storage.status':
        fields(p, []);
        // SPEC-0033 S04: only the method computes what collection has left.
        return { ...this.storage.status(), retention: this.storage.retentionStatus() };
      case 'state.snapshot':
        fields(p, ['snapshotId', 'offset', 'limit']);
        return this.storage.snapshot(p);
      case 'state.releaseSnapshot':
        fields(p, ['snapshotId']);
        this.storage.releaseSnapshot(string(p.snapshotId, 'snapshotId', 128));
        return { released: true };
      case 'storage.configure':
      case 'storage.pin':
      case 'storage.unpin': {
        if (!context.owner) fail('UNAUTHORIZED', 'Storage policy is owner-only');
        fields(
          p,
          method === 'storage.configure'
            ? ['policy', 'idempotencyKey']
            : ['ref', 'reason', 'idempotencyKey'],
        );
        const { idempotencyKey, ...payload } = p;
        const operation = this.operation(
          method,
          'local',
          string(idempotencyKey, 'idempotencyKey'),
          payload,
          (op) => {
            if (method === 'storage.configure')
              op.result = this.storage.configure(object(p.policy)) as any;
            else {
              if (method === 'storage.pin')
                this.storage.pin(string(p.ref, 'ref'), string(p.reason, 'reason'));
              else this.storage.unpin(string(p.ref, 'ref'));
              op.result = { ref: p.ref as string };
            }
          },
        );
        if (method === 'storage.configure') {
          await this.storage.reload();
          // A new policy can end backpressure, which may free a queued task (SPEC-0028 B02).
          this.kick();
        }
        return operation;
      }
      case 'storage.gc': {
        if (!context.owner) fail('UNAUTHORIZED', 'Storage collection is owner-only');
        fields(p, ['idempotencyKey']);
        const key = string(p.idempotencyKey, 'idempotencyKey');
        const prior = this.store.findOperation(method, 'local', key);
        if (prior) {
          this.store.assertDetails(prior.operation);
          return prior.operation;
        }
        const operation = this.operation(method, 'local', key, {}, (op) => {
          op.status = 'persisted';
        });
        try {
          const result = this.storage.collect();
          this.store.transaction(() => {
            operation.status = 'completed';
            operation.result = result;
            this.store.saveOperation(operation);
          });
          return operation;
        } catch (error) {
          if (!this.store.degraded) {
            operation.status = 'failed';
            operation.error = {
              code: 'GC_INTERRUPTED',
              message: 'Collection interrupted; recover recorded file actions before a new batch',
            };
            this.store.saveOperation(operation);
          }
          throw error;
        }
      }
      case 'initialize': {
        fields(p, ['protocolVersion', 'sdkVersion']);
        if (p.protocolVersion !== '2.0') fail('PROTOCOL_MISMATCH', 'Expected protocolVersion 2.0');
        string(p.sdkVersion, 'sdkVersion', 128);
        return {
          protocolVersion: '2.0',
          engineVersion: VERSION,
          schemaVersion: 3,
          instanceId: this.instanceId,
          storeId: this.storeId,
          capabilities: {
            events: 'cursor-pull',
            storeNamespaces: { version: 1, digestVersion: 1 },
            storage: {
              version: 1,
              snapshots: true,
              retention: true,
              archives: !!this.controlPlane,
            },
            acceptance: ['human', 'checks'],
            sessionLifecycle: {
              version: 1,
              open: true,
              reuse: true,
              routing: true,
              fork: true,
              forkModel: true,
              compact: true,
              rotate: true,
              stop: true,
            },
            workflow: {
              version: 1,
              dependencyResults: true,
              revise: true,
              delegationApproval: true,
              handoffs: true,
              writePath: true,
              runtimeRules: true,
              taskList: true,
              contextCheck: true,
              labels: true,
              taskQueries: true,
              queueReasons: true,
              pauseClose: true,
              ruleRetirement: true,
              usageByTask: true,
              reasoningEfforts: true,
              reconcileRecordedResult: true,
              steer: true,
            },
            providers: [...this.adapters.keys()],
            lifecycle: { version: 1, reconcile: 'owner-attestation', durableDeadlines: true },
            executionIsolation: {
              version: 1,
              resourceRelease: true,
              schedulerStatus: true,
              ownerConflictResolution: true,
              budgetVersion: 2,
            },
          },
        };
      }
      case 'tasks.create': {
        fields(p, ['spec', 'idempotencyKey']);
        const spec = taskSpec(p.spec, this.defaultQueueWaitMs);
        const adapter = this.adapters.get(spec.runtime.provider);
        if (!adapter) fail('VALIDATION_ERROR', 'Provider is not configured');
        const capabilities = readRuntimeCapabilities(adapter);
        const configured = this.config.providers?.[spec.runtime.provider];
        this.requireAllowedModel(spec.runtime);
        if (!capabilities.permissionProfiles.includes(configured?.permissionProfile ?? 'read-only'))
          fail('UNSUPPORTED_CAPABILITY', 'Permission profile is unsupported');
        const op = this.operation(
          method,
          'local',
          string(p.idempotencyKey, 'idempotencyKey'),
          // The fixed fallback keeps a retry's digest independent of the host default (SPEC-0017 A02).
          taskSpec(p.spec),
          (op) => {
            this.admitWork();
            const queued = (
              this.store.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM tasks WHERE json_extract(data,'$.status') IN ('queued','waiting_dependency')",
                )
                .get() as { n: number }
            ).n;
            if (queued >= (this.config.limits?.maxQueuedTasks ?? 1000))
              fail('QUEUE_CAPACITY_EXHAUSTED', 'Queued task capacity reached');
            const dependencyStatus = this.dependencyState(spec);
            // A gated child is paused in its creating transaction, so no scheduler pass sees it queued.
            const status =
              context.delegationGate && dependencyStatus !== 'blocked'
                ? 'paused'
                : dependencyStatus;
            const parent = spec.parentTaskId ? this.task(spec.parentTaskId) : undefined;
            if (parent?.spec.budget && !spec.budget)
              spec.budget = structuredClone(parent.spec.budget);
            if (
              parent?.spec.budget &&
              spec.budget &&
              (parent.spec.budget.currency !== spec.budget.currency ||
                moneyUnits(spec.budget.maxCost) > moneyUnits(parent.spec.budget.maxCost))
            )
              fail('UNAUTHORIZED', 'Child budget exceeds its parent');
            const writePaths = this.writePaths(spec);
            const rules =
              spec.acceptance.mode === 'checks'
                ? spec.acceptance.ruleRefs.map((ref) => {
                    const rule = this.verificationRules.find(
                      (r) => r.id === ref.id && r.version === ref.version,
                    );
                    if (!rule && this.retiredRules.has(ruleKey(ref.id, ref.version)))
                      fail('RULE_RETIRED', 'Verification rule id/version was retired', {
                        id: ref.id,
                        version: ref.version,
                      });
                    if (!rule)
                      fail(
                        'UNKNOWN_VERIFICATION_RULE',
                        'Verification rule id/version is not registered',
                      );
                    checkRulePaths(this.store.workspace, rule);
                    return structuredClone(rule);
                  })
                : undefined;
            const id = randomUUID(),
              time = this.time();
            const rootTaskId = parent?.rootTaskId ?? parent?.id ?? id;
            const selected = this.selectSession(spec, id, rootTaskId, writePaths);
            const sessionId = selected.session.id;
            const task: TaskSnapshot = {
              retryIdentity: requestIdentity.getStore(),
              id,
              sessionId,
              spec,
              status,
              revision: 1,
              artifactRefs: [],
              result: null,
              reason:
                status === 'blocked'
                  ? 'dependency_failed'
                  : status === 'paused'
                    ? 'DELEGATION_APPROVAL_REQUIRED'
                    : null,
              approvalId: null,
              createdAt: time,
              updatedAt: time,
              rootTaskId,
              writePaths,
              ...(selected.routing ? { routing: selected.routing } : {}),
              ...(rules ? { verificationRules: rules, verificationAttempts: 0 } : {}),
            };
            this.store.put('tasks', id, task);
            if (selected.fresh) this.store.put('sessions', sessionId, selected.session);
            op.targetId = id;
            op.result = { taskId: id };
            this.store.event(
              'task.created',
              {
                status: task.status,
                parentTaskId: spec.parentTaskId ?? null,
                rootTaskId,
                ...(spec.label !== undefined ? { label: spec.label } : {}),
              },
              { taskId: id, sessionId, operationId: op.id },
            );
          },
        );
        this.armQueue(this.task(op.targetId));
        this.kick();
        return this.task(op.targetId);
      }
      case 'rules.register': {
        fields(p, ['rule', 'idempotencyKey']);
        if (!context.owner || context.runtimeActor)
          fail('UNAUTHORIZED', 'Only the host owner can register verification rules');
        const [rule] = normalizeRules(this.store.workspace, [p.rule as VerificationRule]);
        const key = ruleKey(rule.id, rule.version);
        let registered: FrozenVerificationRule | undefined;
        let reactivated = false;
        const op = this.operation(
          method,
          'local',
          string(p.idempotencyKey, 'idempotencyKey'),
          { rule },
          (op) => {
            const existing = this.verificationRules.find(
              (r) => r.id === rule.id && r.version === rule.version,
            );
            if (existing && existing.digest !== rule.digest)
              fail('CONFLICT', 'This rule id/version is registered with different content');
            // A retired version keeps its content: the same content reactivates it, other content
            // takes a new version (SPEC-0028 U03, SPEC-0029 C01).
            const retired = existing ? undefined : this.retiredRules.get(key);
            if (retired && retired.digest !== rule.digest)
              fail('RULE_RETIRED', 'This rule id/version was retired; register a new version', {
                id: rule.id,
                version: rule.version,
              });
            if (existing) op.status = 'noop';
            else {
              if (this.verificationRules.length >= 1000)
                fail('VALIDATION_ERROR', 'At most 1000 verification rules may be effective');
              if (retired) {
                // Rows written by rc.8 have other keys; the row is found by its content.
                const row = this.store.db
                  .prepare(
                    "SELECT id FROM verification_rules WHERE json_extract(data,'$.id')=? AND json_extract(data,'$.version')=?",
                  )
                  .get(rule.id, rule.version) as { id: string };
                this.store.put('verification_rules', row.id, rule);
                this.store.event(
                  'rule.reactivated',
                  { id: rule.id, version: rule.version },
                  { operationId: op.id },
                );
                reactivated = true;
              } else this.store.put('verification_rules', key, rule);
              registered = rule;
            }
            op.targetId = key;
            op.result = {
              id: rule.id,
              version: rule.version,
              digest: rule.digest,
              ...(reactivated ? { reactivated: true } : {}),
            };
          },
        );
        // Admission sees the rule only after its registration committed.
        if (registered) {
          this.verificationRules.push(registered);
          this.runtimeRuleKeys.add(key);
          this.retiredRules.delete(key);
        }
        return op;
      }
      case 'handoffs.resolve': {
        fields(p, [
          'handoffId',
          'expectedRevision',
          'outcome',
          'taskId',
          'comment',
          'idempotencyKey',
        ]);
        if (context.runtimeActor) fail('UNAUTHORIZED', 'Only a client can resolve handoffs');
        const id = string(p.handoffId, 'handoffId', 128);
        const expectedRevision = integer(p.expectedRevision, 'expectedRevision', 1);
        if (!['accepted', 'rejected'].includes(p.outcome as string))
          fail('VALIDATION_ERROR', 'outcome must be accepted or rejected');
        if (p.outcome === 'accepted' && p.taskId === undefined)
          fail('VALIDATION_ERROR', 'Accepting a handoff requires the task the host created');
        if (p.outcome === 'rejected' && p.taskId !== undefined)
          fail('VALIDATION_ERROR', 'A rejected handoff has no task');
        const taskId = p.taskId === undefined ? undefined : string(p.taskId, 'taskId', 128);
        if (
          p.comment !== undefined &&
          (typeof p.comment !== 'string' || !p.comment || Buffer.byteLength(p.comment) > 16384)
        )
          fail('VALIDATION_ERROR', 'comment must be 1 to 16384 UTF-8 bytes');
        const comment = p.comment as string | undefined;
        this.tryExpireHandoffs();
        return this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { handoffId: id, expectedRevision, outcome: p.outcome, taskId, comment },
          (op) => {
            const handoff = this.store.require<HandoffRequest>('handoffs', id);
            if (handoff.status !== 'pending' || handoff.revision !== expectedRevision)
              fail('STALE_TARGET', 'Handoff request is no longer pending at this revision');
            if (taskId !== undefined) this.task(taskId);
            handoff.status = p.outcome as 'accepted' | 'rejected';
            handoff.revision++;
            handoff.resolvedAt = this.time();
            if (taskId !== undefined) handoff.taskId = taskId;
            if (comment !== undefined) handoff.comment = comment;
            this.store.put('handoffs', id, handoff);
            op.targetId = id;
            op.result = { handoffId: id, status: handoff.status };
            this.store.event(
              `handoff.${handoff.status}`,
              {
                handoffId: id,
                revision: handoff.revision,
                ...(taskId !== undefined ? { taskId } : {}),
              },
              {
                taskId: handoff.fromTaskId,
                sessionId: handoff.targetSessionId,
                operationId: op.id,
              },
            );
          },
        );
      }
      case 'rules.retire': {
        fields(p, ['id', 'version', 'idempotencyKey']);
        if (!context.owner || context.runtimeActor)
          fail('UNAUTHORIZED', 'Only the host owner can retire verification rules');
        const id = string(p.id, 'id', 128);
        const version = string(p.version, 'version', 128);
        const key = ruleKey(id, version);
        let retired: RetiredVerificationRule | undefined;
        const op = this.operation(
          method,
          'local',
          string(p.idempotencyKey, 'idempotencyKey'),
          { id, version },
          (op) => {
            op.targetId = key;
            const rule = this.verificationRules.find((r) => r.id === id && r.version === version);
            if (rule && !this.runtimeRuleKeys.has(key))
              fail(
                'VALIDATION_ERROR',
                'A rule of the configuration cannot be retired; remove it from the configuration',
              );
            if (!rule) {
              const prior = this.retiredRules.get(key);
              if (!prior)
                fail('UNKNOWN_VERIFICATION_RULE', 'Verification rule id/version is not registered');
              op.status = 'noop';
              op.result = { id, version, retiredAt: prior.retiredAt };
              return;
            }
            // Rows written by rc.8 have other keys; the row is found by its content (SPEC-0014 W05).
            const row = this.store.db
              .prepare(
                "SELECT id FROM verification_rules WHERE json_extract(data,'$.id')=? AND json_extract(data,'$.version')=?",
              )
              .get(id, version) as { id: string };
            retired = { ...rule, retiredAt: this.time() };
            this.store.put('verification_rules', row.id, retired);
            op.result = { id, version, retiredAt: retired.retiredAt };
            this.store.event(
              'rule.retired',
              { id, version, retiredAt: retired.retiredAt },
              { operationId: op.id },
            );
          },
        );
        // Admission stops seeing the rule once its retirement committed (SPEC-0028 U01).
        if (retired) {
          this.verificationRules = this.verificationRules.filter(
            (r) => !(r.id === id && r.version === version),
          );
          this.runtimeRuleKeys.delete(key);
          this.retiredRules.set(key, retired);
        }
        return op;
      }
      case 'rules.list': {
        fields(p, ['includeRetired']);
        if (p.includeRetired !== undefined && typeof p.includeRetired !== 'boolean')
          fail('VALIDATION_ERROR', 'includeRetired must be a boolean');
        return {
          rules: [
            ...this.verificationRules.map((rule) => ({
              ...rule,
              source: this.runtimeRuleKeys.has(ruleKey(rule.id, rule.version))
                ? 'runtime'
                : 'config',
            })),
            // SPEC-0028 U04: retired rules only on request, after the effective ones.
            ...(p.includeRetired
              ? [...this.retiredRules.values()].map((rule) => ({ ...rule, source: 'runtime' }))
              : []),
          ],
        };
      }
      case 'sessions.inspect': {
        fields(p, ['sessionId', 'timeoutMs', 'limit']);
        const session = this.session(string(p.sessionId, 'sessionId', 128));
        const adapter = this.adapters.get(session.provider);
        if (!adapter?.inspect)
          fail('UNSUPPORTED_CAPABILITY', 'Runtime history inspection is unavailable');
        const timeoutMs = integer(p.timeoutMs ?? 5000, 'timeoutMs', 1, 60000);
        const limit = integer(p.limit ?? 16, 'limit', 1, 64);
        const target = {
          sessionId: session.id,
          generation: session.generation,
          dispatchId: session.activeDispatchId,
          providerSessionId: session.providerSessionId,
        };
        if (!session.providerSessionId)
          return {
            target,
            status: 'not_found',
            records: [],
            truncated: false,
            execution: 'unknown',
            detail: 'No native session identity was recorded; submission outcome is unchanged',
          };
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            adapter.inspect({
              ...target,
              providerSessionId: session.providerSessionId,
              workspace: this.store.workspace,
              stateDir: this.store.stateDir,
              limit,
              timeoutMs,
              signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Inspection timed out'));
              }, timeoutMs);
            }),
          ]);
          if (
            result.providerSessionId !== session.providerSessionId ||
            Buffer.byteLength(JSON.stringify(result)) > 131072
          )
            return {
              target,
              status: 'mismatch',
              records: [],
              truncated: false,
              execution: 'unknown',
              detail: 'Runtime inspection identity or bounds failed validation',
            };
          return { ...result, target, execution: 'unknown' };
        } catch {
          return {
            target,
            status: 'unavailable',
            records: [],
            truncated: false,
            execution: 'unknown',
            detail:
              'Bounded native inspection failed; prior outcome and resource ownership are unchanged',
          };
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
      }
      case 'scheduler.get':
        fields(p, []);
        return this.scheduler();
      case 'scheduler.getConflict':
        fields(p, ['conflictId']);
        return this.store.require<ExecutionConflict>(
          'execution_conflicts',
          string(p.conflictId, 'conflictId', 128),
        );
      case 'scheduler.resolveConflict':
        if (!context.owner)
          fail('UNAUTHORIZED', 'Only the host owner may resolve execution evidence conflicts');
        return this.resolveConflict(p);
      case 'tasks.resume': {
        fields(p, ['taskId', 'idempotencyKey']);
        const id = string(p.taskId, 'taskId', 128);
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { taskId: id },
          (op) => {
            const task = this.task(id),
              session = this.session(task.sessionId);
            op.targetId = id;
            if (session.status === 'closed')
              fail('SESSION_CLOSED', 'Stopped sessions cannot resume an old task');
            if (task.status === 'blocked' || session.status === 'outcome_unknown')
              fail('OUTCOME_UNKNOWN', 'Inspect the unresolved dispatch before resuming');
            if (terminalTasks.has(task.status)) fail('STALE_TARGET', 'Task is terminal');
            if (task.status !== 'paused') {
              op.status = 'noop';
              return;
            }
            this.resumePausedTask(task, session, op.id, true);
            op.result = { taskId: id };
          },
        );
        this.kick();
        return op;
      }
      case 'tasks.cancel': {
        fields(p, ['taskId', 'idempotencyKey']);
        const id = string(p.taskId, 'taskId', 128);
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { taskId: id },
          (op) => {
            const task = this.task(id);
            op.targetId = id;
            if (terminalTasks.has(task.status)) {
              op.status = 'noop';
              return;
            }
            const session = this.session(task.sessionId),
              activeFlight = this.flights.get(session.id),
              flight = activeFlight?.taskId === task.id ? activeFlight : undefined;
            if (session.taskId === task.id && session.status === 'outcome_unknown')
              fail('OUTCOME_UNKNOWN', 'Cannot confirm cancellation of an unknown dispatch');
            if (flight) {
              if (!readRuntimeCapabilities(this.adapters.get(session.provider)!).interrupt)
                fail('UNSUPPORTED_CAPABILITY', 'Runtime cannot interrupt');
              for (const id of flight.controlIds) {
                const previous = this.store.operation(id);
                if (previous.method === 'sessions.control' && previous.status === 'persisted') {
                  previous.status = 'rejected';
                  previous.error = {
                    code: 'STALE_TARGET',
                    message: 'Pause was superseded by task cancellation',
                  };
                  this.store.saveOperation(previous);
                  this.store.event(
                    'operation.updated',
                    { status: previous.status },
                    { operationId: id, taskId: task.id, sessionId: task.sessionId },
                  );
                }
              }
              op.status = 'persisted';
              op.lifecycle = this.deadline(session, 'interrupt');
            } else {
              this.invalidateApproval(task);
              this.saveTask(task, 'cancelled', 'cancelled_by_client');
              for (const message of this.persistedMessages('taskId', task.id)) {
                message.status = 'expired';
                this.store.put('messages', message.id, message);
                const outbox = this.store.get<Record<string, unknown>>('outbox', message.id);
                if (outbox)
                  this.store.put('outbox', message.id, {
                    ...outbox,
                    status: 'expired',
                    reason: 'task_cancelled_before_submission',
                  });
                this.store.event(
                  'message.expired',
                  { messageId: message.id, reason: 'task_cancelled_before_submission' },
                  { taskId: task.id, sessionId: message.toSessionId },
                );
              }
              if (session.taskId === task.id) this.saveSession(session, 'idle');
              this.taskEvent(task, op.id);
            }
          },
        );
        if (op.status === 'persisted') {
          const flight = this.flights.get(this.task(id).sessionId);
          if (flight?.taskId === id) {
            flight.intent = 'cancel';
            if (!flight.controlIds.includes(op.id)) {
              flight.controlIds.push(op.id);
              this.arm(flight, this.timeouts.interruptMs, 'interrupt deadline exceeded', op.id);
            }
            flight.controller.abort();
          }
        }
        return op;
      }
      case 'sessions.control':
        return this.control(p, context);
      case 'sessions.steer':
        return this.steer(p, context);
      case 'sessions.reconcile':
        if (!context.owner)
          fail('UNAUTHORIZED', 'Only the host owner may attest reconciliation evidence');
        return this.reconcile(p);
      case 'messages.send': {
        fields(p, ['spec', 'idempotencyKey']);
        const spec = messageSpec(p.spec);
        const key = string(p.idempotencyKey, 'idempotencyKey');
        const op = this.operation(method, spec.toSessionId, key, spec, (op) => {
          this.admitWork();
          const task = this.task(spec.taskId),
            session = this.session(spec.toSessionId);
          if (session.taskId !== task.id || task.sessionId !== session.id)
            fail('UNAUTHORIZED', 'Session is outside the target task');
          if (session.generation !== spec.expectedGeneration)
            fail('STALE_TARGET', 'Session generation changed');
          if (terminalTasks.has(task.status))
            fail('STALE_TARGET', 'Cannot send to a terminal task');
          if (session.status === 'closed')
            fail('SESSION_CLOSED', 'A stopped session cannot receive messages');
          const sender = context.runtimeActor?.sessionId ?? 'client:local';
          const recent = this.store.db
            .prepare(
              "SELECT count(*) AS count FROM messages WHERE json_extract(data,'$.fromSessionId')=? AND json_extract(data,'$.createdAt')>=?",
            )
            .get(sender, new Date(this.wall() - 60000).toISOString()) as { count: number };
          if (recent.count >= (this.config.messages?.maxPerMinute ?? 120))
            fail('MESSAGE_RATE_LIMIT', 'Message rate limit reached');
          const sourceIds = context.runtimeActor
            ? [...(this.flights.get(context.runtimeActor.sessionId)?.messageIds ?? [])]
            : [];
          if (spec.replyToMessageId) {
            const reply = this.store.require<MessageSnapshot>('messages', spec.replyToMessageId);
            if (
              context.runtimeActor &&
              reply.toSessionId !== sender &&
              reply.fromSessionId !== sender
            )
              fail('UNAUTHORIZED', 'Reply target is outside sender context');
            sourceIds.push(reply.id);
          }
          const hops =
            1 +
            Math.max(
              0,
              ...sourceIds.map(
                (id) => this.store.get<MessageSnapshot>('messages', id)?.hopCount ?? 0,
              ),
            );
          if (hops > (this.config.messages?.maxHops ?? 16))
            fail('MESSAGE_HOP_LIMIT', 'Message hop limit reached');
          const id = randomUUID();
          const message: MessageSnapshot = {
            retryIdentity: requestIdentity.getStore(),
            ...spec,
            id,
            fromSessionId: sender,
            idempotencyKey: key,
            status: 'persisted',
            createdAt: this.time(),
            expiresAt: new Date(
              this.wall() +
                Math.min(
                  spec.ttlMs ?? this.config.messages?.ttlMs ?? 86400000,
                  this.config.messages?.ttlMs ?? 86400000,
                ),
            ).toISOString(),
            hopCount: hops,
          };
          this.store.put('messages', id, message);
          this.store.put('outbox', id, { id, sessionId: session.id, status: 'persisted' });
          op.targetId = id;
          op.result = { messageId: id };
          this.store.event(
            'message.persisted',
            { messageId: id, status: 'persisted' },
            { taskId: task.id, sessionId: session.id, operationId: op.id },
          );
        });
        this.kick();
        return this.store.require<MessageSnapshot>('messages', op.targetId);
      }
      case 'approvals.decide': {
        fields(p, ['approvalId', 'decision', 'idempotencyKey']);
        const id = string(p.approvalId, 'approvalId', 128),
          decision = object(p.decision, 'decision');
        fields(decision, ['choice', 'expectedRevision', 'comment']);
        if (!['approve', 'deny', 'revise'].includes(decision.choice as string))
          fail('VALIDATION_ERROR', 'choice must be approve, deny or revise');
        integer(decision.expectedRevision, 'expectedRevision', 1);
        if (
          decision.comment !== undefined &&
          (typeof decision.comment !== 'string' ||
            !decision.comment ||
            Buffer.byteLength(decision.comment) > 16384)
        )
          fail('VALIDATION_ERROR', 'comment must be 1 to 16384 UTF-8 bytes');
        if (decision.choice === 'revise' && decision.comment === undefined)
          fail('VALIDATION_ERROR', 'revise requires a comment for the next dispatch');
        const comment = decision.comment as string | undefined;
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { approvalId: id, decision },
          (op) => {
            const approval = this.store.require<ApprovalRequest>('approvals', id);
            const task = this.task(approval.taskId);
            if (approval.purpose === 'runtime_permission') {
              if (decision.choice === 'revise')
                fail('VALIDATION_ERROR', 'revise applies only to task acceptance');
              const target = approval.target;
              const session = this.session(task.sessionId);
              if (
                approval.status !== 'pending' ||
                approval.revision !== decision.expectedRevision ||
                task.approvalId !== id ||
                task.revision !== target.taskRevision ||
                session.id !== target.sessionId ||
                session.generation !== target.generation ||
                session.activeDispatchId !== target.dispatchId ||
                Date.parse(approval.expiresAt) <= this.wall() ||
                !this.permissionWaits.has(id)
              )
                fail('STALE_TARGET', 'Runtime permission request is no longer current');
              approval.status = decision.choice === 'approve' ? 'approved' : 'denied';
              if (comment !== undefined) approval.comment = comment;
              approval.revision++;
              this.store.put('approvals', id, approval);
              task.approvalId = null;
              this.saveTask(task, 'running', null);
              op.targetId = id;
              op.result = {
                taskId: task.id,
                purpose: approval.purpose,
                choice: decision.choice as string,
              };
              this.store.event(
                `approval.${approval.status}`,
                { approvalId: id, revision: approval.revision },
                { taskId: task.id, sessionId: session.id, operationId: op.id },
              );
              this.taskEvent(task, op.id);
              return;
            }
            if (
              approval.status !== 'pending' ||
              approval.revision !== decision.expectedRevision ||
              task.approvalId !== id ||
              task.status !== 'waiting_approval' ||
              approval.target.taskRevision !== task.revision
            )
              fail('STALE_TARGET', 'Approval is no longer current');
            // A revision needs a session that can run it (SPEC-0017 A03).
            if (decision.choice === 'revise' && this.session(task.sessionId).status === 'closed')
              fail('SESSION_CLOSED', 'The task session is closed; approve or deny the result');
            approval.status =
              decision.choice === 'approve'
                ? 'approved'
                : decision.choice === 'revise'
                  ? 'revised'
                  : 'denied';
            if (comment !== undefined) approval.comment = comment;
            approval.revision++;
            this.store.put('approvals', id, approval);
            op.targetId = id;
            op.result = { taskId: task.id, choice: decision.choice as string };
            // The request rides on the task until a dispatch that carried it returns a result.
            if (decision.choice === 'revise')
              task.revisionRequest = { approvalId: id, comment: comment! };
            const pending = this.pendingMessages(task.sessionId);
            const session = this.session(task.sessionId);
            const nextStatus =
              decision.choice === 'deny'
                ? 'failed'
                : pending.length || decision.choice === 'revise'
                  ? ['paused', 'closed'].includes(session.status)
                    ? 'paused'
                    : 'queued'
                  : 'completed';
            this.saveTask(
              task,
              nextStatus,
              decision.choice === 'deny'
                ? 'acceptance_denied'
                : nextStatus === 'paused'
                  ? 'paused_by_client'
                  : decision.choice === 'revise'
                    ? 'revision_requested'
                    : null,
            );
            if (nextStatus === 'queued') this.saveSession(session, 'idle');
            this.store.event(
              `approval.${approval.status}`,
              { approvalId: id, revision: approval.revision },
              { taskId: task.id, sessionId: task.sessionId, operationId: op.id },
            );
            this.taskEvent(task, op.id);
          },
        );
        const permission = this.store.get<ApprovalRequest>('approvals', id);
        if (permission?.purpose === 'runtime_permission' && permission.status !== 'pending')
          this.permissionWaits.get(id)?.settle(permission.status === 'approved');
        this.kick();
        return op;
      }
      case 'context.estimate': {
        fields(p, [
          'provider',
          'model',
          'keepHistoryTokens',
          'compactHistoryTokens',
          'requests',
          'growthTokens',
          'outputTokens',
          'retainedPrefixTokens',
          'compaction',
          'intervalsMs',
          'ttlMs',
        ]);
        const pricing = this.accounting.pricing.find(
          (price) => price.provider === p.provider && price.model === p.model,
        );
        if (!pricing) fail('UNKNOWN_PRICING', 'No registered price for this provider and model');
        return estimateContext({ ...p, pricing } as unknown as Parameters<
          typeof estimateContext
        >[0]);
      }
      case 'costs.recordOverhead': {
        if (!context.owner) fail('UNAUTHORIZED', 'Only the host owner can record overhead');
        fields(p, [
          'billingId',
          'currency',
          'amount',
          'pricingVersion',
          'summary',
          'idempotencyKey',
        ]);
        const billingId = string(p.billingId, 'billingId', 256),
          currency = string(p.currency, 'currency', 3);
        if (!/^[A-Z]{3}$/.test(currency)) fail('VALIDATION_ERROR', 'Invalid currency');
        const amount =
          p.amount === null ? null : moneyString(moneyUnits(string(p.amount, 'amount', 64)));
        const payload = {
          billingId,
          currency,
          amount,
          pricingVersion: string(p.pricingVersion, 'pricingVersion', 128),
          summary: string(p.summary, 'summary', 2048),
        };
        return this.operation(
          method,
          'host',
          string(p.idempotencyKey, 'idempotencyKey'),
          payload,
          (op) => {
            const id = `overhead:${billingId}`;
            const previous = this.store.get<Record<string, unknown>>('costs', id);
            if (previous && previous.requestDigest !== digest(payload))
              fail('IDEMPOTENCY_CONFLICT', 'Billing identity has a different overhead record');
            if (!previous)
              this.store.put('costs', id, {
                id,
                usageRecordId: null,
                dispatchId: null,
                costOwnerTaskId: null,
                rootTaskId: null,
                category: 'host_overhead',
                ...payload,
                amountUnits: amount === null ? null : moneyUnits(amount).toString(),
                requestDigest: digest(payload),
                createdAt: this.time(),
              });
            op.targetId = id;
            op.result = { costRecordId: id };
            this.store.event(
              'cost.overhead_recorded',
              { costRecordId: id, amount, currency, actor: 'host_owner' },
              { operationId: op.id },
            );
          },
        );
      }
      case 'capabilities.get': {
        fields(p, ['provider']);
        if (p.provider !== undefined) {
          const adapter = this.adapters.get(string(p.provider, 'provider', 128));
          if (!adapter) fail('NOT_FOUND', 'Provider is not configured');
          return readRuntimeCapabilities(adapter);
        }
        return Object.fromEntries(
          [...this.adapters].map(([key, adapter]) => [key, readRuntimeCapabilities(adapter)]),
        );
      }
      case 'host.shutdown':
      case 'host.shutdown.continue': {
        if (!context.owner) fail('UNAUTHORIZED', 'Only the host owner can close the engine');
        fields(p, ['mode', 'timeoutMs', 'operationId', 'idempotencyKey']);
        if (method === 'host.shutdown.continue' && !p.operationId)
          fail('VALIDATION_ERROR', 'operationId is required');
        return this.close(p as CloseOptions);
      }
      case 'sessions.open': {
        fields(p, ['spec', 'idempotencyKey']);
        const raw = object(p.spec, 'spec');
        fields(raw, ['runtime', 'writeScope', 'writePath', 'label', 'metadata']);
        const spec = taskSpec({
          ...raw,
          goal: 'Open a logical session',
          acceptance: { mode: 'human', criteria: ['Logical session only'] },
        });
        const adapter = this.adapters.get(spec.runtime.provider);
        if (!adapter) fail('VALIDATION_ERROR', 'Provider is not configured');
        readRuntimeCapabilities(adapter);
        this.requireAllowedModel(spec.runtime);
        const op = this.operation(
          method,
          'local',
          string(p.idempotencyKey, 'idempotencyKey'),
          raw,
          (op) => {
            this.admitWork();
            const session = this.newSession(spec.runtime, this.writePaths(spec), null, undefined, {
              label: spec.label,
              metadata: spec.metadata,
            });
            this.store.put('sessions', session.id, session);
            op.targetId = session.id;
            op.result = { sessionId: session.id };
            this.store.event(
              'session.opened',
              { generation: 1 },
              { sessionId: session.id, operationId: op.id },
            );
          },
        );
        return this.sessionSnapshot(op.targetId);
      }
      case 'sessions.fork': {
        fields(p, ['target', 'snapshotRef', 'model', 'acknowledgeCacheLoss', 'idempotencyKey']);
        const target = object(p.target, 'target');
        const model = p.model === undefined ? undefined : string(p.model, 'model', 256);
        if (p.acknowledgeCacheLoss !== undefined && typeof p.acknowledgeCacheLoss !== 'boolean')
          fail('VALIDATION_ERROR', 'acknowledgeCacheLoss must be a boolean');
        const acknowledgeCacheLoss = p.acknowledgeCacheLoss as boolean | undefined;
        const op = this.operation(
          method,
          string(target.sessionId, 'sessionId', 128),
          string(p.idempotencyKey, 'idempotencyKey'),
          { target, snapshotRef: p.snapshotRef, model, acknowledgeCacheLoss },
          (op) => {
            this.admitWork();
            const source = this.checkedTarget(target);
            const fork = this.forkCandidate(source, string(p.snapshotRef, 'snapshotRef', 128), {
              model,
              acknowledgeCacheLoss,
            });
            this.store.put('sessions', fork.id, fork);
            // Hosts use this to tell end users that the first response reprocesses the history.
            const modelChange =
              fork.model === source.model
                ? undefined
                : { fromModel: source.model, toModel: fork.model, promptCacheReuse: false };
            op.targetId = fork.id;
            op.result = {
              sessionId: fork.id,
              nativeForkPending: true,
              ...(modelChange ? { modelChange } : {}),
            };
            this.store.event(
              'session.fork_prepared',
              {
                sourceSessionId: source.id,
                snapshotRef: p.snapshotRef as string,
                nativeCheckpoint: source.nativeCheckpoint!,
                ...(modelChange ? { modelChange } : {}),
              },
              { sessionId: fork.id, operationId: op.id },
            );
          },
        );
        return this.sessionSnapshot(op.targetId);
      }
      case 'sessions.rotate': {
        fields(p, ['target', 'idempotencyKey']);
        const target = object(p.target, 'target');
        return this.operation(
          method,
          string(target.sessionId, 'sessionId', 128),
          string(p.idempotencyKey, 'idempotencyKey'),
          { target },
          (op) => {
            const session = this.checkedTarget(target);
            this.requireQuietSession(session);
            const artifactRef = this.store.artifact(JSON.stringify(session));
            session.generations = [
              ...(session.generations ?? []),
              {
                generation: session.generation,
                providerSessionId: session.providerSessionId,
                ...(session.nativeCheckpoint ? { nativeCheckpoint: session.nativeCheckpoint } : {}),
                artifactRef,
              },
            ];
            session.generation++;
            session.providerSessionId = null;
            delete session.nativeCheckpoint;
            delete session.forkSource;
            session.taskId = null;
            this.saveSession(session, 'idle');
            op.targetId = session.id;
            op.result = { generation: session.generation, artifactRef };
            this.store.event(
              'session.rotated',
              { generation: session.generation, artifactRef },
              { sessionId: session.id, operationId: op.id },
            );
          },
        );
      }
      case 'sessions.compact': {
        fields(p, ['target', 'idempotencyKey']);
        const target = object(p.target, 'target');
        const op = this.operation(
          method,
          string(target.sessionId, 'sessionId', 128),
          string(p.idempotencyKey, 'idempotencyKey'),
          { target },
          (op) => {
            this.admitWork();
            const session = this.checkedTarget(target);
            this.requireQuietSession(session);
            op.targetId = session.id;
            if (!session.providerSessionId) {
              op.status = 'noop';
              op.result = { reason: 'NO_NATIVE_HISTORY' };
              return;
            }
            if (readRuntimeCapabilities(this.adapters.get(session.provider)!).compact !== true)
              fail('UNSUPPORTED_CAPABILITY', 'Runtime cannot manually compact');
            const source = this.associatedTask(session);
            const id = randomUUID();
            const task: TaskSnapshot = {
              id,
              sessionId: session.id,
              status: 'queued',
              revision: 1,
              spec: {
                goal: 'Compact the existing native history',
                runtime: { provider: session.provider, model: session.model },
                acceptance: { mode: 'human', criteria: ['Native compaction boundary observed'] },
                parentTaskId: source.id,
              },
              artifactRefs: [],
              result: null,
              reason: null,
              approvalId: null,
              createdAt: this.time(),
              updatedAt: this.time(),
              kind: 'compaction',
              maintenanceOperationId: op.id,
              rootTaskId: source.rootTaskId ?? source.id,
              writePaths: session.writePaths ?? [],
            };
            this.store.put('tasks', id, task);
            op.status = 'persisted';
            op.result = { taskId: id };
            this.taskEvent(task, op.id);
          },
        );
        this.kick();
        return op;
      }
      default:
        fail('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }

  /** SPEC-0048: what a steer's dispatch and task are now, for STEER_TURN_ENDED's data. */
  private turnState(dispatchId: string, task: TaskSnapshot) {
    const dispatch = this.store.get<Dispatch & { taskId?: string }>('dispatches', dispatchId);
    const terminal = dispatch?.terminalEvidence as RuntimeEvent | undefined;
    const turnOutcome =
      terminal?.type === 'result'
        ? 'completed'
        : terminal?.type === 'interrupted'
          ? 'interrupted'
          : terminal?.type === 'error' && terminal.outcome === 'failed'
            ? 'failed'
            : !terminal && dispatch?.status === 'completed'
              ? 'completed'
              : 'unknown';
    const owner =
      (dispatch?.taskId && this.store.get<TaskSnapshot>('tasks', dispatch.taskId)) || task;
    return { dispatchId, turnOutcome, taskStatus: owner.status };
  }
  /** Whether `dispatchId` is the session's running turn, not yet ended (SPEC-0048 S02). */
  private turnRunning(sessionId: string, dispatchId: string): boolean {
    const flight = this.flights.get(sessionId);
    if (flight?.dispatchId !== dispatchId) return false;
    const dispatch = this.store.get<Dispatch>('dispatches', dispatchId);
    if (dispatch?.terminalEvidence) return false;
    const task = this.task(flight.taskId);
    if (task.status === 'running') return true;
    // SPEC-0048 invariant 3: a turn that waits for its runtime's permission is still running.
    if (task.status !== 'waiting_approval' || !task.approvalId) return false;
    const approval = this.store.get<ApprovalRequest>('approvals', task.approvalId);
    return (
      approval?.purpose === 'runtime_permission' &&
      approval.status === 'pending' &&
      approval.target.dispatchId === dispatchId
    );
  }
  private steer(p: Record<string, unknown>, context: CallContext): OperationSnapshot {
    if (context.runtimeActor) fail('UNAUTHORIZED', 'Only a client may steer a turn');
    fields(p, ['target', 'text', 'idempotencyKey']);
    const target = object(p.target, 'target');
    fields(target, ['sessionId', 'expectedGeneration', 'expectedDispatchId', 'expectedRevision']);
    const sessionId = string(target.sessionId, 'sessionId', 128);
    integer(target.expectedGeneration, 'expectedGeneration', 1);
    const dispatchId = string(target.expectedDispatchId, 'expectedDispatchId', 128);
    if (target.expectedRevision !== undefined)
      integer(target.expectedRevision, 'expectedRevision', 1);
    const text = p.text;
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 16_384)
      fail('VALIDATION_ERROR', 'text must be 1 to 16384 UTF-8 bytes');
    let created: { session: SessionSnapshot; messageId: string } | undefined;
    const op = this.operation(
      'sessions.steer',
      sessionId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { target, text },
      (op) => {
        this.admitWork();
        const session = this.session(sessionId);
        op.targetId = sessionId;
        const adapter = this.adapters.get(session.provider);
        if (!adapter?.steer || readRuntimeCapabilities(adapter).steer !== true)
          fail('UNSUPPORTED_CAPABILITY', 'This runtime cannot be steered');
        if (
          session.generation !== target.expectedGeneration ||
          (target.expectedRevision !== undefined && session.revision !== target.expectedRevision)
        )
          fail('STALE_TARGET', 'Steer target changed');
        if (session.status === 'closed') fail('SESSION_CLOSED', 'The session is stopped');
        const task = this.associatedTask(session);
        if (!this.turnRunning(sessionId, dispatchId))
          fail('STEER_TURN_ENDED', 'The turn is not running', this.turnState(dispatchId, task));
        // Invariant 1: recorded, never to be delivered in a prompt, before the runtime is asked.
        const messageId = randomUUID();
        this.store.put('messages', messageId, {
          id: messageId,
          fromSessionId: 'client:local',
          idempotencyKey: op.idempotencyKey,
          status: 'dispatching',
          taskId: task.id,
          toSessionId: sessionId,
          expectedGeneration: session.generation,
          kind: 'steer',
          summary: text,
          dispatchId,
          createdAt: this.time(),
        } as MessageSnapshot);
        op.status = 'persisted';
        op.result = { messageId, dispatchId };
        created = { session, messageId };
      },
    );
    if (created)
      void this.deliverSteer(op.id, created.session, dispatchId, created.messageId, text);
    return op;
  }
  /** SPEC-0048 S04, C02: asks the runtime once, then records its answer. */
  private async deliverSteer(
    operationId: string,
    session: SessionSnapshot,
    dispatchId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    let answer: RuntimeSteerAnswer | undefined;
    try {
      answer = await this.adapters.get(session.provider)!.steer!(
        { sessionId: session.id, dispatchId, generation: session.generation },
        text,
        messageId,
      );
    } catch {
      answer = undefined;
    }
    // Codex may answer before its notification that the turn ended arrives.
    if (answer?.status === 'rejected' && !answer.turnEnded && !answer.notSteerable) {
      const deadline = this.clock.monotonicNow() + 2000;
      while (this.clock.monotonicNow() < deadline && this.turnRunning(session.id, dispatchId))
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!this.turnRunning(session.id, dispatchId)) answer = { ...answer, turnEnded: true };
    }
    try {
      this.store.transaction(() => {
        const op = this.store.operation(operationId);
        const message = this.store.get<MessageSnapshot>('messages', messageId);
        if (op.status !== 'persisted' || !message) return;
        const task = this.task(message.taskId);
        if (answer?.status === 'accepted') {
          message.status = 'completed';
          op.status = 'completed';
          this.store.event(
            'session.steered',
            { dispatchId, taskId: task.id, messageId, text },
            { taskId: task.id, sessionId: session.id, operationId },
          );
          const early = this.earlySteerOutcomes.get(messageId);
          this.earlySteerOutcomes.delete(messageId);
          if (answer.outcomePending) {
            message.steerDelivery = 'pending';
            const flight = this.flights.get(session.id);
            // SPEC-0056 invariant 3: the runtime said, before this answer was recorded, whether
            // the steer reached its turn.
            if (early !== undefined)
              this.settleSteer(message, session.id, early ? 'delivered' : 'not_taken');
            // SPEC-0058 D03: a turn that has ended reports nothing more.
            else if (flight?.dispatchId !== dispatchId || flight.steersSettled)
              this.settleSteer(message, session.id, 'unknown');
            else (flight.pendingSteers ??= new Set()).add(messageId);
          } else if (early === false) this.settleSteer(message, session.id, 'not_taken');
        } else if (answer) {
          message.status = 'failed';
          op.status = 'failed';
          op.error = answer.turnEnded
            ? {
                code: 'STEER_TURN_ENDED',
                message: 'The turn ended before the steer reached it',
                data: this.turnState(dispatchId, task),
              }
            : answer.notSteerable
              ? { code: 'STEER_NOT_STEERABLE', message: answer.message }
              : { code: 'STEER_REJECTED', message: answer.message };
        } else {
          message.status = 'outcome_unknown';
          op.status = 'outcome_unknown';
          op.error = {
            code: 'STEER_OUTCOME_UNKNOWN',
            message: 'The runtime gave no answer; the steer may or may not have reached the turn',
          };
        }
        this.store.put('messages', messageId, message);
        this.store.saveOperation(op);
        this.store.event('operation.updated', { status: op.status }, { operationId });
      });
    } catch {
      // A host that closed meanwhile leaves the steer persisted; its next start records it unknown.
    }
  }
  /** Outcomes a runtime reported before the steer's own answer was recorded (SPEC-0056). */
  private earlySteerOutcomes = new Map<string, boolean>();
  /**
   * Inside a transaction: the steer's outcome, once (SPEC-0056 S04, SPEC-0058 D02). The caller puts
   * the message when it writes it anyway; this writes it too, so that either order holds.
   */
  private settleSteer(
    message: MessageSnapshot,
    sessionId: string,
    outcome: 'delivered' | 'not_taken' | 'unknown',
  ): void {
    const data = { dispatchId: message.dispatchId!, taskId: message.taskId, messageId: message.id };
    const context = { taskId: message.taskId, sessionId };
    if (message.steerDelivery) message.steerDelivery = outcome;
    this.flights.get(sessionId)?.pendingSteers?.delete(message.id);
    if (outcome === 'delivered') {
      this.store.put('messages', message.id, message);
      this.store.event('session.steer_delivered', data, context);
      return;
    }
    message.status = 'expired';
    this.store.put('messages', message.id, message);
    this.store.event('session.steer_undelivered', { ...data, reason: outcome }, context);
  }
  /**
   * SPEC-0058 D03, O01: once a turn's runtime has finished, the steers it never settled are
   * unknown. In a transaction of its own, before the turn's end writes anything.
   */
  private settlePendingSteers(flight: Flight): void {
    flight.steersSettled = true;
    if (!flight.pendingSteers?.size) return;
    try {
      this.store.transaction(() => {
        for (const id of [...flight.pendingSteers!]) {
          const message = this.store.get<MessageSnapshot>('messages', id);
          if (message?.steerDelivery === 'pending')
            this.settleSteer(message, flight.sessionId, 'unknown');
        }
      });
    } catch {
      // A store that cannot be written leaves them pending; the next start settles them (D04).
    }
  }
  /**
   * SPEC-0056 S04: a runtime that accepts a steer before it knows whether the turn takes it says so
   * later. A steer that was not delivered expires, with its event, once; a delivered one whose
   * answer said `outcomePending` is marked so, with its event (SPEC-0058 D02). It never throws to
   * the adapter.
   */
  private steerOutcome(flight: Flight, outcome: { steerId: string; delivered: boolean }): void {
    try {
      if (this.closed || !outcome || typeof outcome.delivered !== 'boolean') return;
      if (typeof outcome.steerId !== 'string') return;
      const message = this.store.get<MessageSnapshot>('messages', outcome.steerId);
      if (!message || message.kind !== 'steer' || message.dispatchId !== flight.dispatchId) return;
      const delivered = outcome.delivered;
      if (message.status === 'dispatching') {
        if (!this.earlySteerOutcomes.has(message.id))
          this.earlySteerOutcomes.set(message.id, delivered);
      } else if (
        message.status === 'completed' &&
        // A steer accepted without `outcomePending` only ever says that it was not delivered.
        (message.steerDelivery === 'pending' || (!message.steerDelivery && !delivered))
      )
        this.store.transaction(() =>
          this.settleSteer(message, flight.sessionId, delivered ? 'delivered' : 'not_taken'),
        );
    } catch {
      // The outcome is an observation; it never changes the turn.
    }
  }
  private control(p: Record<string, unknown>, context: CallContext): OperationSnapshot {
    fields(p, ['target', 'command', 'idempotencyKey']);
    const target = object(p.target, 'target');
    fields(target, [
      'sessionId',
      'expectedGeneration',
      'expectedRevision',
      'expectedDispatchId',
      'expectedState',
    ]);
    const sessionId = string(target.sessionId, 'sessionId', 128);
    integer(target.expectedGeneration, 'expectedGeneration', 1);
    integer(target.expectedRevision, 'expectedRevision', 1);
    string(target.expectedState, 'expectedState', 128);
    if (target.expectedDispatchId !== null)
      string(target.expectedDispatchId, 'expectedDispatchId', 128);
    const command = object(p.command, 'command');
    fields(command, ['action', 'mode']);
    if (!['pause', 'resume', 'stop'].includes(command.action as string))
      fail('UNSUPPORTED_CAPABILITY', 'Unknown session control action');
    const mode = command.mode ?? 'drain';
    if (!['drain', 'interrupt'].includes(mode as string))
      fail('VALIDATION_ERROR', 'Invalid pause mode');
    const op = this.operation(
      'sessions.control',
      sessionId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { target, command },
      (op) => {
        const session = this.session(sessionId);
        op.targetId = sessionId;
        if (
          session.generation !== target.expectedGeneration ||
          session.revision !== target.expectedRevision ||
          session.activeDispatchId !== target.expectedDispatchId ||
          session.status !== target.expectedState
        )
          fail('STALE_TARGET', 'Control target changed');
        if (command.action === 'stop' && !this.flights.has(sessionId)) {
          if (
            session.activeDispatchId ||
            this.store.activeDispatches(sessionId).length ||
            this.adapters.get(session.provider)?.hasActiveResources?.(sessionId)
          )
            fail('RUNTIME_STILL_ACTIVE', 'Stop requires confirmed execution and resource release');
          if (session.status === 'closed') {
            op.status = 'noop';
            return;
          }
          this.saveSession(session, 'closed');
          if (session.taskId) {
            const task = this.task(session.taskId);
            if (!terminalTasks.has(task.status) && task.status !== 'waiting_approval') {
              this.saveTask(task, 'paused', 'session_stopped');
              this.taskEvent(task, op.id);
            }
          }
          this.store.event(
            'session.closed',
            { generation: session.generation },
            { sessionId, operationId: op.id },
          );
          return;
        }
        if (session.status === 'closed')
          fail('SESSION_CLOSED', 'Open or rotate a session before new work');
        const task = this.associatedTask(session);
        if (session.status === 'outcome_unknown' || task.status === 'blocked')
          fail('OUTCOME_UNKNOWN', 'Session requires reconciliation');
        const ended = terminalTasks.has(task.status);
        if (ended && command.action !== 'resume') fail('STALE_TARGET', 'Task is terminal');
        const flight = this.flights.get(sessionId);
        if (flight?.intent === 'cancel')
          fail('STALE_TARGET', 'Task cancellation is already pending');
        if (command.action === 'resume') {
          if (flight) fail('STALE_TARGET', 'Cannot resume an active dispatch');
          if (session.status !== 'paused') {
            op.status = 'noop';
            return;
          }
          if (context.runtimeActor && session.pauseOrigin !== 'runtime')
            fail('UNAUTHORIZED', 'A runtime cannot resume a client or unowned pause');
          if (ended) {
            // SPEC-0016 S01: with its task ended the session only returns to idle; nothing reruns.
            if (
              session.activeDispatchId ||
              this.store.activeDispatches(sessionId).length ||
              this.adapters.get(session.provider)?.hasActiveResources?.(sessionId)
            )
              fail(
                'RUNTIME_STILL_ACTIVE',
                'Resume requires confirmed execution and resource release',
              );
            this.saveSession(session, 'idle');
          } else this.resumePausedTask(task, session, op.id);
        } else if (flight) {
          if (
            mode === 'interrupt' &&
            !readRuntimeCapabilities(this.adapters.get(session.provider)!).interrupt
          )
            fail('UNSUPPORTED_CAPABILITY', 'Runtime cannot interrupt');
          op.status = 'persisted';
          op.lifecycle = this.deadline(session, mode as 'drain' | 'interrupt');
          if (command.action === 'pause')
            session.pauseOrigin =
              context.runtimeActor && session.pauseOrigin !== 'client' ? 'runtime' : 'client';
          this.saveSession(session, 'pausing');
        } else {
          if (session.status === 'paused') {
            if (
              command.action === 'pause' &&
              !context.runtimeActor &&
              session.pauseOrigin !== 'client'
            ) {
              session.pauseOrigin = 'client';
              this.saveSession(session);
              this.store.event(
                'session.pause_origin_changed',
                { pauseOrigin: 'client', revision: session.revision },
                { taskId: task.id, sessionId, operationId: op.id },
              );
            } else op.status = 'noop';
            return;
          }
          if (command.action === 'pause')
            session.pauseOrigin =
              context.runtimeActor && session.pauseOrigin !== 'client' ? 'runtime' : 'client';
          this.saveSession(session, 'paused');
          // A delegation gate outlives session pauses; only tasks.resume releases it.
          if (
            task.status !== 'waiting_approval' &&
            !(task.status === 'paused' && task.reason === 'DELEGATION_APPROVAL_REQUIRED')
          ) {
            this.saveTask(task, 'paused', 'paused_by_client');
            this.taskEvent(task, op.id);
          }
        }
        this.store.event(
          `session.${session.status}`,
          { status: session.status, revision: session.revision },
          { taskId: task.id, sessionId, operationId: op.id },
        );
      },
    );
    if (op.status === 'persisted') {
      const flight = this.flights.get(sessionId);
      if (flight) {
        flight.intent = command.action === 'stop' ? 'stop' : 'pause';
        if (!flight.controlIds.includes(op.id)) {
          flight.controlIds.push(op.id);
          this.arm(
            flight,
            mode === 'interrupt' ? this.timeouts.interruptMs : this.timeouts.drainMs,
            `${mode} deadline exceeded`,
            op.id,
          );
        }
        if (mode === 'interrupt') flight.controller.abort();
      }
    }
    this.kick();
    return op;
  }
  /**
   * Persisted messages of a session or task, in creation order, through messages_persisted_expiry
   * (SPEC-0024 X01).
   */
  private persistedMessages(field: 'toSessionId' | 'taskId', id: string): MessageSnapshot[] {
    return (
      this.store.db
        .prepare(
          `SELECT rowid AS ordinal,data FROM messages WHERE json_extract(data,'$.status')='persisted' AND json_extract(data,'$.${field}')=?`,
        )
        .all(id) as { ordinal: number; data: string }[]
    )
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => JSON.parse(row.data) as MessageSnapshot);
  }
  private pendingMessages(sessionId: string): MessageSnapshot[] {
    return this.persistedMessages('toSessionId', sessionId).filter(
      (m) => !m.expiresAt || Date.parse(m.expiresAt) > this.wall(),
    );
  }
  /** A closed session never runs again, so no message to it stays pending (SPEC-0017 A05). */
  private expireStoppedMessages(sessionId: string): void {
    for (const message of this.persistedMessages('toSessionId', sessionId)) {
      message.status = 'expired';
      this.store.put('messages', message.id, message);
      const outbox = this.store.get<Record<string, unknown>>('outbox', message.id);
      if (outbox)
        this.store.put('outbox', message.id, {
          ...outbox,
          status: 'expired',
          reason: 'session_stopped',
        });
      this.store.event(
        'message.expired',
        { messageId: message.id, reason: 'session_stopped' },
        { taskId: message.taskId, sessionId },
      );
    }
  }
  private expireMessages(): void {
    // Through messages_persisted_expiry, in creation order (SPEC-0024 X01, X02).
    const expired = (
      this.store.db
        .prepare(
          "SELECT rowid AS ordinal,data FROM messages WHERE json_extract(data,'$.status')='persisted' AND json_extract(data,'$.expiresAt')<=?",
        )
        .all(this.time()) as { ordinal: number; data: string }[]
    ).sort((a, b) => a.ordinal - b.ordinal);
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const row of expired) {
        const message = JSON.parse(row.data) as MessageSnapshot;
        message.status = 'expired';
        this.store.put('messages', message.id, message);
        const outbox = this.store.get<Record<string, unknown>>('outbox', message.id);
        if (outbox) this.store.put('outbox', message.id, { ...outbox, status: 'expired' });
        this.store.event(
          'message.expired',
          { messageId: message.id },
          { taskId: message.taskId, sessionId: message.toSessionId },
        );
      }
    });
  }

  private reconcile(p: Record<string, unknown>): OperationSnapshot {
    fields(p, ['target', 'evidence', 'idempotencyKey']);
    const target = object(p.target, 'target');
    fields(target, [
      'sessionId',
      'expectedGeneration',
      'expectedRevision',
      'expectedDispatchId',
      'expectedState',
    ]);
    const sessionId = string(target.sessionId, 'sessionId', 128);
    integer(target.expectedGeneration, 'expectedGeneration', 1);
    integer(target.expectedRevision, 'expectedRevision', 1);
    string(target.expectedDispatchId, 'expectedDispatchId', 128);
    string(target.expectedState, 'expectedState', 128);
    const evidence = object(p.evidence, 'evidence');
    fields(evidence, [
      'source',
      'summary',
      'localResources',
      'remoteExecution',
      'sideEffects',
      'outcome',
      'result',
    ]);
    if (evidence.source !== 'owner_attestation')
      fail('VALIDATION_ERROR', 'An explicit owner attestation is required');
    string(evidence.summary, 'summary', 65536);
    for (const key of ['localResources', 'remoteExecution'])
      if (!['stopped', 'unknown'].includes(evidence[key] as string))
        fail('VALIDATION_ERROR', `Invalid ${key}`);
    if (!['resolved', 'unknown'].includes(evidence.sideEffects as string))
      fail('VALIDATION_ERROR', 'Invalid sideEffects');
    if (
      !['not_executed', 'completed', 'failed', 'interrupted', 'unknown', 'recorded'].includes(
        evidence.outcome as string,
      )
    )
      fail('VALIDATION_ERROR', 'Invalid reconciliation outcome');
    // SPEC-0045 R01: a completed attestation may leave its result to the recorded terminal.
    if (evidence.outcome === 'completed' && evidence.result !== undefined)
      resultText(evidence.result);
    else if (evidence.result !== undefined)
      fail('VALIDATION_ERROR', 'Only a completed attestation may include a result');
    const resolved =
      evidence.localResources === 'stopped' &&
      evidence.remoteExecution === 'stopped' &&
      evidence.sideEffects === 'resolved' &&
      evidence.outcome !== 'unknown';
    const started = this.clock.monotonicNow();
    const resourceDisposition: { commit?: () => void } = {};
    const op = this.operation(
      'sessions.reconcile',
      sessionId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { target, evidence },
      (op) => {
        const session = this.session(sessionId),
          task = this.associatedTask(session);
        if (
          session.generation !== target.expectedGeneration ||
          session.revision !== target.expectedRevision ||
          session.activeDispatchId !== target.expectedDispatchId ||
          session.status !== target.expectedState
        )
          fail('STALE_TARGET', 'Reconciliation target changed');
        if (session.status !== 'outcome_unknown' || task.status !== 'blocked')
          fail('STALE_TARGET', 'Session is not awaiting reconciliation');
        if (evidence.localResources === 'stopped') {
          if (this.flights.has(sessionId))
            fail('RUNTIME_STILL_ACTIVE', 'This owner still holds an active execution observer');
          const adapter = this.adapters.get(session.provider);
          if (adapter?.hasActiveResources?.(sessionId)) {
            let commit: unknown;
            try {
              commit = adapter.prepareUnobservedCleanup?.({
                sessionId,
                dispatchId: session.activeDispatchId!,
                generation: session.generation,
              });
            } catch {
              fail('INVALID_RUNTIME_CONTRACT', 'Runtime cleanup preparation threw before commit');
            }
            if (commit == null)
              fail('RUNTIME_STILL_ACTIVE', 'This owner still holds an active cleanup handle');
            if (typeof commit !== 'function')
              fail(
                'INVALID_RUNTIME_CONTRACT',
                'Runtime cleanup preparation must return a function or null',
              );
            resourceDisposition.commit = commit as () => void;
          }
        }
        const dispatchId = session.activeDispatchId!;
        const dispatch = this.store.require<Record<string, unknown>>('dispatches', dispatchId);
        if (
          this.store
            .all<ExecutionConflict>('execution_conflicts')
            .some((c) => c.dispatchId === dispatchId && c.status === 'open')
        )
          fail(
            'EXECUTION_EVIDENCE_CONFLICT',
            'Resolve the resource evidence conflict before reconciliation',
          );
        const terminalEvidence = [
          dispatch.terminalEvidence as RuntimeEvent | undefined,
          (dispatch as Dispatch).terminalCertificate?.terminal,
        ];
        const recorded = terminalEvidence.find((late) => late?.type === 'result') as
          | Extract<RuntimeEvent, { type: 'result' }>
          | undefined;
        // SPEC-0045 R03: `recorded` takes the outcome of the terminal the dispatch recorded.
        let outcome = evidence.outcome as string;
        if (outcome === 'recorded') {
          const first = terminalEvidence.find(Boolean);
          const mapped =
            first?.type === 'result'
              ? 'completed'
              : first?.type === 'interrupted'
                ? 'interrupted'
                : first?.type === 'error' && first.outcome === 'failed'
                  ? 'failed'
                  : undefined;
          if (!mapped)
            fail(
              'VALIDATION_ERROR',
              'The dispatch recorded no result, interruption or failure; give the outcome',
            );
          outcome = mapped;
        }
        const attestedResult =
          outcome === 'completed'
            ? ((evidence.result as string | undefined) ?? recorded?.text)
            : undefined;
        if (outcome === 'completed' && attestedResult === undefined)
          fail(
            'VALIDATION_ERROR',
            'A completed attestation needs result when the dispatch recorded none',
          );
        if (
          outcome !== 'unknown' &&
          terminalEvidence.some(
            (late) =>
              late &&
              ((late.type === 'result' &&
                (outcome !== 'completed' || attestedResult !== late.text)) ||
                (late.type === 'interrupted' && outcome !== 'interrupted') ||
                (late.type === 'error' &&
                  late.outcome === 'failed' &&
                  !['failed', 'not_executed'].includes(outcome))),
          )
        )
          fail(
            'EVIDENCE_CONFLICT',
            'Owner attestation conflicts with recorded runtime terminal evidence',
          );
        op.targetId = sessionId;
        op.lifecycle = this.deadline(session, 'reconcile');
        op.lifecycle.lastEvidence = 'owner_attestation';
        const audit = {
          actor: 'host_owner',
          instanceId: this.instanceId,
          occurredAt: this.time(),
          dispatchId,
          target,
          evidence,
          ...(evidence.outcome === 'recorded' ? { recordedOutcome: outcome } : {}),
          ...(resourceDisposition.commit
            ? { resourceReconciliation: 'owner_attested_unobserved' }
            : {}),
        };
        const evidenceRef = this.store.artifact(JSON.stringify(audit));
        const executionReleased =
          evidence.localResources === 'stopped' && evidence.remoteExecution === 'stopped';
        if (executionReleased) {
          dispatch.verificationPending = false;
          this.release(dispatch as Dispatch, evidenceRef, 'owner_attestation');
        }
        op.result = {
          sessionId,
          dispatchId,
          resolved,
          executionReleased,
          evidenceRef,
          actor: 'host_owner',
          outcome: outcome,
          unobservedResourcesReconciled: false,
          ...(resourceDisposition.commit
            ? { resourceCleanup: { status: 'pending', ownerInstanceId: this.instanceId } }
            : {}),
        };
        if (resourceDisposition.commit) op.status = 'persisted';
        this.store.put('dispatches', dispatchId, {
          ...dispatch,
          reconciliations: [...((dispatch.reconciliations as string[] | undefined) ?? []), op.id],
          ...(resolved
            ? {
                status: 'reconciled',
                quarantined: false,
                resolution: { outcome: outcome, operationId: op.id, evidenceRef },
              }
            : {}),
        });
        this.admissionEvent();
        if (resolved) {
          const replaySafe = outcome === 'not_executed';
          for (const id of (dispatch.messageIds as string[] | undefined) ?? []) {
            const message = this.store.require<MessageSnapshot>('messages', id);
            message.status = replaySafe
              ? 'persisted'
              : outcome === 'completed'
                ? 'completed'
                : 'failed';
            this.store.put('messages', id, message);
            this.store.put('outbox', id, {
              id,
              sessionId,
              dispatchId: replaySafe ? null : dispatchId,
              status: message.status,
            });
            this.store.event(
              `message.${message.status}`,
              { messageId: id, status: message.status, dispatchId, reconciliationId: op.id },
              { taskId: task.id, sessionId, operationId: op.id },
            );
          }
          session.activeDispatchId = null;
          this.saveSession(session, 'paused');
          if (outcome === 'completed') {
            const full = resultText(attestedResult);
            task.artifactRefs = [this.store.artifact(full)];
            task.result = resultPreview(full, task.artifactRefs[0]);
            this.saveTask(task, 'paused', 'reconciled_result');
          } else if (replaySafe) {
            this.saveTask(task, 'paused', 'reconciled_not_executed');
          } else this.saveTask(task, 'failed', `reconciled_${outcome}`);
          for (const prior of this.store.operations()) {
            if (
              prior.status !== 'outcome_unknown' ||
              prior.lifecycle?.expectedDispatchId !== dispatchId
            )
              continue;
            prior.resolution = {
              operationId: op.id,
              outcome: outcome,
              occurredAt: this.time(),
            };
            this.store.saveOperation(prior);
            this.store.event(
              'operation.resolved',
              { resolution: prior.resolution },
              { operationId: prior.id, taskId: task.id, sessionId },
            );
          }
          this.taskEvent(task, op.id);
        }
        this.store.event(
          'session.reconciled',
          {
            resolved,
            evidenceRef,
            dispatchId,
            actor: 'host_owner',
            outcome: outcome,
          },
          { taskId: task.id, sessionId, operationId: op.id },
        );
        if (resourceDisposition.commit)
          this.store.event(
            'session.resource_cleanup_prepared',
            { dispatchId, generation: session.generation, evidenceRef, actor: 'host_owner' },
            { taskId: task.id, sessionId, operationId: op.id },
          );
        if (this.clock.monotonicNow() - started >= this.timeouts.reconcileMs)
          fail(
            'TIMEOUT',
            'Reconciliation deadline exceeded before commit; no resolution was committed',
          );
      },
    );
    if (resourceDisposition.commit)
      this.pendingResourceCleanups.set(op.id, {
        commit: resourceDisposition.commit,
        applied: false,
      });
    const completed = this.finishResourceCleanup(op);
    this.kick();
    return completed;
  }
  private finishResourceCleanup(op: OperationSnapshot): OperationSnapshot {
    const result = op.result as Record<string, Json> | null;
    const cleanup = result?.resourceCleanup as Record<string, Json> | undefined;
    if (!cleanup || cleanup.status !== 'pending') return op;
    const pending = this.pendingResourceCleanups.get(op.id);
    const incomplete = (message: string): never =>
      fail('RESOURCE_CLEANUP_INCOMPLETE', message, { operationId: op.id, auditCommitted: true });
    if (!pending)
      return incomplete(
        'Owner attestation is committed, but its original in-memory finalizer is unavailable',
      );
    try {
      if (pending.settling) throw new Error('Runtime finalizer is still settling');
      if (!pending.applied) {
        const work: unknown = pending.commit();
        if (
          work !== null &&
          (typeof work === 'object' || typeof work === 'function') &&
          typeof (work as { then?: unknown }).then === 'function'
        ) {
          // A misbehaving async finalizer cannot block the RPC or run twice concurrently.
          // Observe both settlements, but only an explicit owner retry acknowledges completion.
          pending.settling = true;
          void Promise.resolve(work).then(
            () => {
              pending.applied = true;
              pending.settling = false;
            },
            () => {
              pending.settling = false;
            },
          );
          throw new Error('Runtime finalizer must finish synchronously');
        }
        pending.applied = true;
      }
      if (this.adapters.get(this.session(op.scope).provider)?.hasActiveResources?.(op.scope)) {
        pending.applied = false;
        throw new Error('Runtime finalizer retained its resources');
      }
      return this.store.transaction(() => {
        const completed = this.store.operation(op.id);
        completed.status = 'completed';
        completed.error = null;
        completed.result = {
          ...result,
          unobservedResourcesReconciled: true,
          resourceCleanup: { ...cleanup, status: 'completed' },
        };
        this.store.saveOperation(completed);
        this.store.event(
          'session.resources_reconciled',
          {
            dispatchId: result!.dispatchId,
            generation: op.lifecycle!.expectedGeneration,
            evidenceRef: result!.evidenceRef,
            actor: 'host_owner',
          },
          {
            sessionId: op.scope,
            taskId: this.session(op.scope).taskId ?? undefined,
            operationId: op.id,
          },
        );
        this.store.event('operation.updated', { status: 'completed' }, { operationId: op.id });
        this.pendingResourceCleanups.delete(op.id);
        this.admissionEvent();
        return completed;
      });
    } catch {
      // Keep the exact prepared closure; replaying the durable operation must not re-prepare
      // against a now-paused session or a different generation. A completed disposition only
      // retries its durable acknowledgement if that later write failed.
      this.pendingResourceCleanups.set(op.id, pending);
      return incomplete(
        'Owner attestation is committed; retry the same reconciliation key to finish resource cleanup',
      );
    }
  }
  private resolveConflict(p: Record<string, unknown>): OperationSnapshot {
    fields(p, ['conflictId', 'expectedRevision', 'evidence', 'idempotencyKey']);
    const conflictId = string(p.conflictId, 'conflictId', 128);
    const revision = integer(p.expectedRevision, 'expectedRevision', 1);
    const evidence = object(p.evidence, 'evidence');
    fields(evidence, [
      'source',
      'summary',
      'localResources',
      'remoteExecution',
      'sideEffects',
      'outcome',
      'result',
    ]);
    if (
      evidence.source !== 'owner_attestation' ||
      evidence.localResources !== 'stopped' ||
      evidence.remoteExecution !== 'stopped'
    )
      fail(
        'INSUFFICIENT_EVIDENCE',
        'Conflict resolution requires owner-confirmed local and remote stop evidence',
      );
    string(evidence.summary, 'summary', 65536);
    if (
      !['resolved', 'unknown'].includes(evidence.sideEffects as string) ||
      !['not_executed', 'completed', 'failed', 'interrupted', 'unknown'].includes(
        evidence.outcome as string,
      )
    )
      fail('VALIDATION_ERROR', 'Invalid business evidence');
    if (evidence.outcome === 'completed') resultText(evidence.result);
    if (evidence.result !== undefined) {
      if (evidence.outcome !== 'completed')
        fail('VALIDATION_ERROR', 'Only completed evidence may contain a result');
      resultText(evidence.result);
    }
    const op = this.operation(
      'scheduler.resolveConflict',
      conflictId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { conflictId, expectedRevision: revision, evidence },
      (op) => {
        const c = this.store.require<ExecutionConflict>('execution_conflicts', conflictId);
        if (c.revision !== revision || c.status !== 'open')
          fail('STALE_TARGET', 'Execution conflict changed');
        const d = this.store.require<Dispatch>('dispatches', c.dispatchId);
        const provider = d.provider ?? this.session(d.sessionId).provider;
        if (
          this.flights.has(d.sessionId) ||
          this.adapters.get(provider)?.hasActiveResources?.(d.sessionId)
        )
          fail('RUNTIME_STILL_ACTIVE', 'An observation or resource handle is still retained');
        const evidenceRef = this.store.artifact(
          JSON.stringify({
            actor: 'host_owner',
            instanceId: this.instanceId,
            conflictId,
            dispatchId: d.id,
            generation: d.generation,
            evidence,
            occurredAt: this.time(),
          }),
        );
        c.status = 'resolved';
        c.revision++;
        c.resolution = { operationId: op.id, evidenceRef, occurredAt: this.time() };
        this.store.put('execution_conflicts', c.id, c);
        op.targetId = c.id;
        op.result = { conflictId: c.id, resolved: true, evidenceRef, revision: c.revision };
        this.store.event(
          'execution.conflict_resolved',
          {
            conflictId: c.id,
            dispatchId: d.id,
            generation: d.generation,
            evidenceRef,
            revision: c.revision,
          },
          { taskId: d.taskId, sessionId: d.sessionId, operationId: op.id },
        );
        this.admissionEvent();
      },
    );
    this.kick();
    return op;
  }
  private kick(): void {
    if (this.scheduled || this.closing || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closing || this.closed) return;
      try {
        this.expireMessages();
        this.tryExpireHandoffs();
        this.refreshDependencies();
        const queued = this.store.queuedTasks();
        if (!queued.length) return;
        let canDispatch = this.scheduler().canDispatch && !this.storage.status().backpressured;
        for (const task of queued) {
          this.armQueue(task);
          let session = this.session(task.sessionId);
          for (
            let attempts = 0;
            attempts < 5 && task.routing && !task.routing.submittedAt;
            attempts++
          ) {
            const remaining = Math.min(
              Date.parse(task.routing.deadlineAt) - this.wall(),
              (this.queueTimers.get(task.id)?.deadline ?? this.clock.monotonicNow()) -
                this.clock.monotonicNow(),
            );
            const ready =
              canDispatch &&
              this.sessionReady(task, session) &&
              !this.writeConflictHolders(task).length;
            if (remaining > 0 || (task.routing.maxQueueWaitMs === 0 && ready)) break;
            this.expireQueue(task);
            if (task.status === 'blocked') break;
            session = this.session(task.sessionId);
          }
          if (task.status !== 'queued' || !canDispatch || !this.sessionReady(task, session))
            continue;
          if (task.routing && task.routing.expectedGeneration !== session.generation) {
            this.store.transaction(() => {
              this.saveTask(task, 'blocked', 'STALE_TARGET');
              this.taskEvent(task);
            });
            this.stopQueue(task.id);
            continue;
          }
          if (this.start(task, session))
            canDispatch = this.scheduler().canDispatch && !this.storage.status().backpressured;
        }
      } catch (error) {
        // A scheduler/storage failure must not become an unhandled promise or silently retry a dispatch.
        this.stopAfterFailure('scheduler pass', error);
        process.emitWarning(
          `Orchestrator scheduler stopped: ${error instanceof OrchestrationError ? error.code : 'INTERNAL_ERROR'}`,
        );
      }
    });
  }
  private start(task: TaskSnapshot, session: SessionSnapshot): boolean {
    this.store.assertWritable();
    if (this.storageBlocked()) return false;
    const dependencyStatus = this.dependencyState(task.spec);
    if (dependencyStatus !== 'queued') {
      this.store.transaction(() => {
        this.saveTask(
          task,
          dependencyStatus,
          dependencyStatus === 'blocked' ? 'dependency_failed' : null,
        );
        this.taskEvent(task);
      });
      return false;
    }
    try {
      const currentPaths = this.writePaths(task.spec);
      for (const path of task.writePaths ?? []) workspacePath(this.store.workspace, path);
      if (digest(currentPaths) !== digest(task.writePaths ?? []))
        fail('INVALID_WORKSPACE_SCOPE', 'Registered write scope changed after admission');
    } catch (error) {
      this.store.transaction(() => {
        this.saveTask(task, 'blocked', 'INVALID_WORKSPACE_SCOPE');
        this.taskEvent(task);
      });
      return false;
    }
    if (this.writeConflictHolders(task).length) return false;
    const moneyPolicy = this.accounting.policy(task);
    if (moneyPolicy.reason) {
      this.store.transaction(() => {
        this.saveTask(task, 'paused', moneyPolicy.reason);
        this.taskEvent(task);
      });
      return false;
    }
    const adapter = this.adapters.get(session.provider);
    let capabilities: RuntimeCapabilities;
    try {
      if (!adapter)
        fail('UNSUPPORTED_CAPABILITY', 'The original runtime provider is not configured');
      capabilities = readRuntimeCapabilities(adapter);
      const profile = this.config.providers?.[session.provider]?.permissionProfile ?? 'read-only';
      if (!capabilities.permissionProfiles.includes(profile))
        fail('UNSUPPORTED_CAPABILITY', `Provider ${session.provider} cannot enforce ${profile}`);
    } catch (error) {
      if (
        !(error instanceof OrchestrationError) ||
        !['UNSUPPORTED_CAPABILITY', 'INVALID_RUNTIME_CONTRACT'].includes(error.code)
      )
        throw error;
      this.store.transaction(() => {
        this.saveTask(task, 'paused', `${error.code}: ${error.message}`);
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    const turns = this.store.dispatchCount(task.id);
    if (turns >= (this.config.limits?.maxTurnsPerTask ?? 20)) {
      this.store.transaction(() => {
        this.saveTask(task, 'paused', 'max_turns_reached');
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    if (session.providerSessionId && !capabilities.resume) {
      this.store.transaction(() => {
        this.saveTask(task, 'blocked', 'runtime_resume_unsupported');
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    const cap = capabilities.executionBudget;
    const enteredMono = this.clock.monotonicNow(),
      enteredWall = this.wall();
    const effectiveTurnMs = Math.min(
      this.timeouts.turnMs,
      cap.turnCapMs ?? Infinity,
      task.kind === 'compaction' ? 300000 : Infinity,
    );
    const effectiveAcceptanceMs = Math.min(
      this.timeouts.acceptanceMs,
      cap.acceptanceCapMs ?? Infinity,
      effectiveTurnMs,
    );
    const budget: ExecutionBudget = {
      policyVersion: 2,
      enteredAt: new Date(enteredWall).toISOString(),
      acceptanceDeadlineAt: new Date(enteredWall + effectiveAcceptanceMs).toISOString(),
      deadlineAt: new Date(enteredWall + effectiveTurnMs).toISOString(),
      effectiveAcceptanceMs,
      effectiveTurnMs,
      acceptanceSource:
        effectiveTurnMs < Math.min(this.timeouts.acceptanceMs, cap.acceptanceCapMs ?? Infinity)
          ? 'total_budget'
          : cap.acceptanceCapMs !== null && cap.acceptanceCapMs < this.timeouts.acceptanceMs
            ? 'adapter_explicit'
            : this.config.timeouts?.acceptanceMs === undefined
              ? 'host_default'
              : 'host_explicit',
      turnSource:
        cap.turnCapMs !== null && cap.turnCapMs < this.timeouts.turnMs
          ? 'adapter_explicit'
          : this.config.timeouts?.turnMs === undefined
            ? 'host_default'
            : 'host_explicit',
      remainingAcceptanceMs: () =>
        Math.max(0, effectiveAcceptanceMs - (this.clock.monotonicNow() - enteredMono)),
      remainingTurnMs: () =>
        Math.max(0, effectiveTurnMs - (this.clock.monotonicNow() - enteredMono)),
    };
    const { remainingAcceptanceMs, remainingTurnMs, ...budgetSummary } = budget;
    const messages = this.pendingMessages(session.id);
    const dependencyBlocks = task.dependencyResultsDelivered ? [] : this.dependencyBlocks(task);
    const dispatchId = randomUUID();
    const controller = new AbortController();
    const flight: Flight = {
      taskId: task.id,
      sessionId: session.id,
      dispatchId,
      generation: session.generation,
      messageIds: messages.map((m) => m.id),
      controller,
      promise: Promise.resolve(),
      intent: null,
      controlIds: task.maintenanceOperationId ? [task.maintenanceOperationId] : [],
      expired: false,
      cancelTimers: [],
      deadlineChecks: [],
      budget,
    };
    this.store.transaction(() => {
      if (!this.scheduler().canDispatch)
        fail('DISPATCH_CAPACITY_CHANGED', 'Dispatch capacity changed before reservation');
      const costIdentity = this.accounting.reserve(task, dispatchId);
      this.invalidateApproval(task);
      if (task.routing) {
        task.routing.submittedAt = this.time();
        this.store.event(
          'routing.submitted',
          {
            mode: task.routing.mode,
            reasonCode: task.routing.reasonCode,
            candidateSessionId: session.id,
          },
          { taskId: task.id, sessionId: session.id },
        );
      }
      this.saveTask(task, 'running', null);
      session.taskId = task.id;
      session.rootTaskId ??= task.rootTaskId ?? task.id;
      session.taskIds = [...new Set([...(session.taskIds ?? []), task.id])];
      session.activeDispatchId = dispatchId;
      this.saveSession(session, 'running');
      this.store.put('dispatches', dispatchId, {
        id: dispatchId,
        taskId: task.id,
        sessionId: session.id,
        generation: session.generation,
        status: 'dispatching',
        messageIds: flight.messageIds,
        createdAt: this.time(),
        ...budgetSummary,
        budget: budgetSummary,
        provider: adapter.provider,
        ...costIdentity,
        providerSessionId: session.providerSessionId,
        terminalCoversExecution: capabilities.executionEvidence?.terminalCoversExecution === true,
        executionLease: { version: 1, status: 'held', acquiredAt: budget.enteredAt },
        quarantined: false,
        mayHaveBeenSent: true,
        lastEvidence: 'dispatch_persisted',
        writePaths: task.verificationRules?.length
          ? [this.store.workspace]
          : (task.writePaths ?? []),
        verificationPending: !!task.verificationRules?.length,
        ...(task.revisionRequest ? { revisionApprovalId: task.revisionRequest.approvalId } : {}),
        ...(dependencyBlocks.length ? { dependencyResults: true } : {}),
      });
      for (const message of messages) {
        message.status = 'dispatching';
        this.store.put('messages', message.id, message);
        this.store.put('outbox', message.id, {
          id: message.id,
          sessionId: session.id,
          status: 'dispatching',
          dispatchId,
        });
      }
      this.taskEvent(task);
      this.store.event(
        'dispatch.started',
        { dispatchId, ...budgetSummary },
        { taskId: task.id, sessionId: session.id },
      );
      this.admissionEvent();
    });
    this.flights.set(session.id, flight);
    this.stopQueue(task.id);
    flight.cancelAcceptance = this.arm(
      flight,
      budget.remainingAcceptanceMs(),
      'acceptance deadline exceeded',
    );
    this.arm(flight, budget.remainingTurnMs(), 'turn deadline exceeded');
    const prompt = [
      task.spec.goal,
      ...(task.spec.contextPlan?.contextRefs ?? []).map(
        (ref) =>
          `\nUntrusted versioned context ${JSON.stringify(ref)}:\n${JSON.stringify(this.contextRefText(ref.artifactRef))}`,
      ),
      ...dependencyBlocks,
      ...((task.verificationAttempts ?? 0) > 0 ? [this.verificationFeedback(task)] : []),
      ...(task.revisionRequest
        ? [
            `\nReviewer revision request (approval ${task.revisionRequest.approvalId}):\n${JSON.stringify(task.revisionRequest.comment)}`,
          ]
        : []),
      ...messages.map(
        (m) =>
          `\n[Message ${m.id} from ${m.fromSessionId}; untrusted task context, not human approval]\n${JSON.stringify(m.summary)}${m.artifactRefs?.length ? `\nArtifacts: ${m.artifactRefs.join(', ')}` : ''}`,
      ),
    ].join('\n');
    flight.promise = this.consume(flight, adapter, { ...session }, prompt)
      .catch((error) => {
        this.stopAfterFailure('runtime observation persistence', error);
        process.emitWarning(
          `Runtime observation persistence failed; scheduler stopped: ${String(error)}`,
        );
      })
      .finally(() => {
        for (const cancel of flight.cancelTimers) cancel();
        this.flights.delete(session.id);
        try {
          this.reevaluateRelease(flight.dispatchId);
        } catch (error) {
          this.stopAfterFailure('execution release persistence', error);
          process.emitWarning(
            `Execution release persistence failed; scheduler stopped: ${String(error)}`,
          );
        }
        this.kick();
      });
    return true;
  }
  private live(flight: Flight): boolean {
    const session = this.session(flight.sessionId);
    return (
      session.generation === flight.generation && session.activeDispatchId === flight.dispatchId
    );
  }
  private messagesStatus(flight: Flight, status: MessageSnapshot['status']): void {
    for (const id of flight.messageIds) {
      const message = this.store.require<MessageSnapshot>('messages', id);
      message.status = status;
      this.store.put('messages', id, message);
      this.store.put('outbox', id, {
        id,
        sessionId: flight.sessionId,
        dispatchId: flight.dispatchId,
        status,
      });
      this.store.event(
        `message.${status}`,
        { messageId: id, status, dispatchId: flight.dispatchId },
        { taskId: flight.taskId, sessionId: flight.sessionId },
      );
    }
  }
  private accepted(flight: Flight, providerSessionId: string): void {
    string(providerSessionId, 'providerSessionId', 256);
    const session = this.session(flight.sessionId);
    if (!session.providerSessionId && session.forkSource?.providerSessionId === providerSessionId)
      fail('OUTCOME_UNKNOWN', 'Runtime returned the source identity instead of a distinct fork');
    if (session.providerSessionId && session.providerSessionId !== providerSessionId)
      fail('OUTCOME_UNKNOWN', 'Runtime resumed a different native session');
    const dispatch = this.store.require<Record<string, unknown>>('dispatches', flight.dispatchId);
    if (dispatch.status === 'runtime_accepted') return;
    flight.cancelAcceptance?.();
    session.providerSessionId = providerSessionId;
    this.saveSession(session);
    this.store.put('dispatches', flight.dispatchId, {
      ...dispatch,
      status: flight.expired ? 'outcome_unknown' : 'runtime_accepted',
      providerSessionId,
      runtimeAccepted: true,
      lastEvidence: 'runtime_accepted',
    });
    if (!flight.expired) this.messagesStatus(flight, 'runtime_accepted');
    this.store.event(
      flight.expired ? 'dispatch.late_accepted' : 'dispatch.runtime_accepted',
      { dispatchId: flight.dispatchId, providerSessionId },
      { taskId: flight.taskId, sessionId: flight.sessionId },
    );
  }
  private async consume(
    flight: Flight,
    adapter: RuntimeAdapter,
    session: SessionSnapshot,
    prompt: string,
  ): Promise<void> {
    let terminal: Extract<RuntimeEvent, { type: 'result' | 'interrupted' | 'error' }> | undefined;
    try {
      const task = this.task(flight.taskId);
      const input: EngineRuntimeInput = {
        taskId: flight.taskId,
        sessionId: flight.sessionId,
        // The task chain and the host's labels, as detached frozen copies (SPEC-0027 L04).
        parentTaskId: task.spec.parentTaskId ?? null,
        rootTaskId: task.rootTaskId ?? task.id,
        label: task.spec.label ?? null,
        metadata: frozenCopy(task.spec.metadata),
        sessionLabel: session.label ?? null,
        sessionMetadata: frozenCopy(session.metadata),
        dispatchId: flight.dispatchId,
        providerSessionId: session.providerSessionId,
        model: session.model,
        workspace: this.store.workspace,
        stateDir: this.store.stateDir,
        prompt,
        permissionProfile:
          this.config.providers?.[session.provider]?.permissionProfile ?? ('read-only' as const),
        signal: flight.controller.signal,
        generation: flight.generation,
        executionBudget: flight.budget,
        reportExecutionEvidence: (evidence: ExecutionEvidence) =>
          this.reportEvidence(flight, adapter.provider, evidence),
        reportUsage: (event: RuntimeUsageEvent) =>
          this.recordUsage(flight, adapter.provider, event),
        reportProgress: (progress: RuntimeProgress) => this.reportProgress(flight, progress),
        reportSteerOutcome: (outcome) => this.steerOutcome(flight, outcome),
        ...(this.config.runtimeApprovals?.enabled
          ? {
              requestPermission: (request: RuntimePermissionRequest) =>
                this.requestRuntimePermission(flight, request),
            }
          : {}),
        writePaths: this.task(flight.taskId).writePaths,
        ...(session.forkSource && !session.providerSessionId
          ? { forkSource: session.forkSource }
          : {}),
        usageBaseline: this.usageBaseline(session, flight.dispatchId),
        ...(this.task(flight.taskId).kind === 'compaction'
          ? { nativeAction: 'compact' as const }
          : {}),
        ...(this.config.tools?.enabled && this.task(flight.taskId).kind !== 'compaction'
          ? { orchestrationTools: this.boundTools(flight) }
          : {}),
      };
      for await (const event of adapter.execute(input)) {
        if (event.type === 'usage') {
          this.recordUsage(flight, adapter.provider, event);
        }
        for (const check of flight.deadlineChecks) check();
        if (!this.live(flight)) break;
        if (event.type === 'usage') continue;
        if (event.type === 'accepted')
          this.store.transaction(() => this.accepted(flight, event.providerSessionId));
        else {
          terminal = event;
          // SPEC-0058 E01: what the runtime reported before its terminal takes effect before the
          // terminal is recorded, in the order it happened.
          await this.evidenceApplied(flight);
          this.store.transaction(() => {
            if (event.type === 'result') {
              resultText(event.text);
              if (this.task(flight.taskId).kind === 'compaction' && !event.compacted)
                fail(
                  'OUTCOME_UNKNOWN',
                  'Compaction ended without a native boundary or explicit no-op',
                );
              const current = this.session(flight.sessionId);
              if (
                event.providerSessionId &&
                current.providerSessionId &&
                event.providerSessionId !== current.providerSessionId
              )
                fail('OUTCOME_UNKNOWN', 'Terminal evidence belongs to a different native session');
            }
            const dispatch = this.store.require<Record<string, unknown>>(
              'dispatches',
              flight.dispatchId,
            );
            this.store.put('dispatches', flight.dispatchId, {
              ...dispatch,
              terminalEvidence: event,
              lastEvidence: `terminal_${event.type}`,
            });
          });
          break;
        }
      }
      if (!terminal)
        terminal = {
          type: 'error',
          message: 'outcome_unknown: runtime stream ended without a terminal result',
          outcome: 'unknown',
        };
    } catch (error) {
      terminal = {
        type: 'error',
        message: error instanceof Error ? error.message : 'Runtime threw an unknown error',
        outcome: 'unknown',
      };
    }
    // SPEC-0057 invariant 1: the evidence reported before the terminal has taken effect before the
    // stop proof is read.
    await this.evidenceApplied(flight);
    flight.evidenceSettled = true;
    this.settlePendingSteers(flight);
    let verification: VerificationEvidence[] | undefined;
    const activeApproval = this.task(flight.taskId).approvalId;
    if (
      activeApproval &&
      this.store.get<ApprovalRequest>('approvals', activeApproval)?.purpose === 'runtime_permission'
    )
      this.store.transaction(() => this.invalidateApproval(this.task(flight.taskId)));
    const candidate = this.task(flight.taskId);
    if (
      terminal.type === 'result' &&
      !flight.expired &&
      flight.intent !== 'cancel' &&
      this.live(flight) &&
      candidate.verificationRules?.length &&
      this.stopProof(this.store.require<Dispatch>('dispatches', flight.dispatchId)) &&
      !adapter.hasActiveResources?.(flight.sessionId)
    ) {
      this.store.transaction(() => {
        this.saveTask(candidate, 'verifying', null);
        this.taskEvent(candidate);
      });
      verification = [];
      for (const rule of candidate.verificationRules) {
        verification.push(
          await verifyRule(
            this.store.workspace,
            rule,
            flight.controller.signal,
            // SPEC-0061 V01: read when the command starts, from the host's environment then.
            verificationEnvironment(
              this.config.verificationEnvironment,
              this.config.verificationInheritEnv,
            ),
          ),
        );
        if (!verification.at(-1)!.passed) break;
      }
    }
    const verificationStopped =
      verification?.every((evidence) => evidence.resourcesStopped) ?? true;
    if (!verificationStopped)
      terminal = {
        type: 'error',
        outcome: 'unknown',
        message: 'Verification cleanup is unconfirmed',
      };
    // SPEC-0057 W02: the files of the turn's end, written off the event loop. Invariant 2: the
    // deadlines and the flight are checked again after the wait, as after verification.
    const settledAt = this.clock.wallNow();
    await this.whileWriting(flight, () => this.prepareTerminalFiles(flight, terminal!, settledAt));
    try {
      for (const check of flight.deadlineChecks) check();
      if (!this.live(flight)) return;
      this.store.transaction(() => {
        const task = this.task(flight.taskId),
          current = this.session(flight.sessionId);
        const dispatch = this.store.require<Record<string, unknown>>(
          'dispatches',
          flight.dispatchId,
        );
        if (
          !flight.expired &&
          (!this.stopProof(dispatch as Dispatch) || adapter.hasActiveResources?.(flight.sessionId))
        ) {
          terminal = {
            type: 'error',
            outcome: 'unknown',
            message: 'Execution stop or local cleanup is unconfirmed',
          };
        }
        if (flight.expired) {
          if (terminal!.type === 'result' && terminal!.providerSessionId)
            this.accepted(flight, terminal!.providerSessionId);
          const observed = this.store.require<Record<string, unknown>>(
            'dispatches',
            flight.dispatchId,
          );
          this.store.put('dispatches', flight.dispatchId, {
            ...observed,
            status: 'outcome_unknown',
            quarantined: true,
            quarantinedAt: observed.quarantinedAt ?? this.time(),
            terminalEvidence: observed.terminalEvidence ?? terminal,
            observationEndedAt: this.time(),
            verificationPending: !verificationStopped,
          });
          this.store.event(
            'dispatch.late_evidence',
            { dispatchId: flight.dispatchId, type: terminal!.type },
            { taskId: task.id, sessionId: current.id },
          );
          return;
        }
        if (terminal!.type === 'result') {
          if (terminal!.providerSessionId) {
            this.accepted(flight, terminal!.providerSessionId);
            current.providerSessionId = terminal!.providerSessionId;
            current.revision = this.session(current.id).revision;
          }
          // A final result is terminal runtime evidence even when the provider has no earlier acceptance event.
          this.messagesStatus(flight, 'completed');
          if (
            dispatch.revisionApprovalId &&
            task.revisionRequest?.approvalId === dispatch.revisionApprovalId
          )
            delete task.revisionRequest;
          if (dispatch.dependencyResults) task.dependencyResultsDelivered = true;
          this.store.put('dispatches', flight.dispatchId, { ...dispatch, status: 'completed' });
          const fullResult = resultText(terminal!.text);
          task.artifactRefs = [this.store.artifact(fullResult)];
          task.result = resultPreview(fullResult, task.artifactRefs[0]);
          current.activeDispatchId = null;
          if (terminal!.nativeCheckpoint) current.nativeCheckpoint = terminal!.nativeCheckpoint;
          this.saveSession(
            current,
            flight.intent === 'stop' ? 'closed' : flight.intent === 'pause' ? 'paused' : 'idle',
          );
          if (flight.intent === 'cancel') {
            this.saveTask(task, 'cancelled', 'cancelled_by_client');
            this.taskEvent(task);
          } else if (task.kind === 'compaction') {
            const ref = this.store.artifact(JSON.stringify(terminal!.compacted));
            task.artifactRefs.push(ref);
            this.saveTask(task, 'completed', null);
            this.store.event(
              'session.compacted',
              { evidenceRef: ref, kind: terminal!.compacted!.kind },
              { sessionId: current.id, taskId: task.id },
            );
            this.taskEvent(task);
          } else if (task.spec.acceptance.mode === 'checks') {
            const passed =
              verification?.length === task.verificationRules?.length &&
              verification?.every((r) => r.passed);
            const evidenceRef = this.store.artifact(
              JSON.stringify({
                taskId: task.id,
                dispatchId: flight.dispatchId,
                resultArtifactRefs: [...task.artifactRefs],
                rules: verification ?? [],
                passed: !!passed,
              }),
            );
            task.artifactRefs.push(evidenceRef);
            task.verificationAttempts = (task.verificationAttempts ?? 0) + 1;
            const repair =
              !passed &&
              task.verificationAttempts <= (task.spec.acceptance.maxRepairs ?? 0) &&
              flight.intent !== 'pause';
            this.saveTask(
              task,
              passed ? 'completed' : repair ? 'queued' : 'blocked',
              passed ? null : 'verification_failed',
              !!passed,
            );
            this.store.event(
              'verification.completed',
              { passed: !!passed, evidenceRef, rules: completedRules(verification ?? []) },
              { taskId: task.id, sessionId: current.id },
            );
            this.taskEvent(task);
          } else this.requestApproval(task);
        } else if (terminal!.type === 'interrupted') {
          this.messagesStatus(flight, 'failed');
          this.store.put('dispatches', flight.dispatchId, { ...dispatch, status: 'interrupted' });
          current.activeDispatchId = null;
          this.saveSession(
            current,
            flight.intent === 'stop' ? 'closed' : flight.intent === 'cancel' ? 'idle' : 'paused',
          );
          // Only a turn whose intent the close set is the close's (SPEC-0029 D01, D02).
          if (flight.intent === 'shutdown' && this.shutdownId)
            task.pausedByClose = { operationId: this.shutdownId, wasRunning: true };
          this.saveTask(
            task,
            flight.intent === 'cancel' ? 'cancelled' : 'paused',
            flight.pausedByClose ? 'owner_shutdown' : 'runtime_interrupted',
          );
          this.taskEvent(task);
        } else {
          const unknown = terminal!.outcome === 'unknown';
          this.messagesStatus(flight, unknown ? 'outcome_unknown' : 'failed');
          this.store.put('dispatches', flight.dispatchId, {
            ...dispatch,
            status: unknown ? 'outcome_unknown' : 'failed',
            quarantined: unknown,
            ...(unknown ? { quarantinedAt: dispatch.quarantinedAt ?? this.time() } : {}),
          });
          if (!unknown) current.activeDispatchId = null;
          this.saveSession(current, unknown ? 'outcome_unknown' : 'idle');
          this.saveTask(
            task,
            unknown ? 'blocked' : 'failed',
            unknown ? `outcome_unknown: ${terminal!.message}` : terminal!.message,
          );
          this.taskEvent(task);
        }
        const finalDispatch = this.store.require<Dispatch>('dispatches', flight.dispatchId);
        this.accounting.settle(flight.dispatchId);
        finalDispatch.verificationPending = !verificationStopped;
        if (verification && !verificationStopped)
          finalDispatch.verificationEvidenceRef = this.store.artifact(JSON.stringify(verification));
        this.store.put('dispatches', finalDispatch.id, finalDispatch);
        if (this.stopProof(finalDispatch) && !adapter.hasActiveResources?.(flight.sessionId))
          this.release(
            finalDispatch,
            finalDispatch.executionEvidenceRef!,
            'runtime_stop_and_cleanup',
          );
        this.admissionEvent();
        for (const id of flight.controlIds) {
          const op = this.store.operation(id);
          if (op.status !== 'persisted') continue;
          if (terminal!.type === 'error') {
            op.status = terminal!.outcome === 'unknown' ? 'outcome_unknown' : 'failed';
            op.error = {
              code: terminal!.outcome === 'unknown' ? 'OUTCOME_UNKNOWN' : 'RUNTIME_FAILED',
              message: task.reason ?? 'Runtime failed',
            };
          } else if (
            (op.method === 'tasks.cancel' && task.status === 'cancelled') ||
            (op.method === 'sessions.control' && ['paused', 'closed'].includes(current.status)) ||
            (op.method === 'sessions.compact' && task.status === 'completed')
          )
            op.status = 'completed';
          else {
            op.status = 'rejected';
            op.error = {
              code: 'STALE_TARGET',
              message: 'A later operation superseded this control',
            };
          }
          this.store.saveOperation(op);
          this.store.event(
            'operation.updated',
            { status: op.status },
            { operationId: id, taskId: task.id, sessionId: task.sessionId },
          );
        }
        this.config.storageFault?.('terminal.before_commit');
      }, settledAt);
    } catch (error) {
      // Preserve uncertainty if result persistence or native identity checks fail.
      this.store.transaction(() => {
        const task = this.task(flight.taskId);
        this.saveTask(
          task,
          'blocked',
          `outcome_unknown: ${error instanceof Error ? error.message : 'result persistence failed'}`,
        );
        this.saveSession(this.session(flight.sessionId), 'outcome_unknown');
        const dispatch = this.store.require<Record<string, unknown>>(
          'dispatches',
          flight.dispatchId,
        );
        this.store.put('dispatches', flight.dispatchId, {
          ...dispatch,
          status: 'outcome_unknown',
          quarantined: true,
          quarantinedAt: dispatch.quarantinedAt ?? this.time(),
        });
        this.admissionEvent();
        this.messagesStatus(flight, 'outcome_unknown');
        for (const id of flight.controlIds) {
          const operation = this.store.operation(id);
          if (operation.status !== 'persisted') continue;
          operation.status = 'outcome_unknown';
          operation.error = { code: 'OUTCOME_UNKNOWN', message: task.reason! };
          this.store.saveOperation(operation);
          this.store.event(
            'operation.updated',
            { status: operation.status },
            { operationId: id, taskId: task.id, sessionId: task.sessionId },
          );
        }
        this.taskEvent(task);
      });
    }
  }

  async close(
    options: EngineCloseOptions = {},
  ): Promise<{ status: 'closed'; operationId: string }> {
    if (this.store.isClosed && this.controlPlane?.switching) {
      if (this.storageTimer) clearInterval(this.storageTimer);
      this.controlPlane.close();
      this.closed = true;
      this.shutdownId ??= randomUUID();
      return { status: 'closed', operationId: this.shutdownId };
    }
    const mode = options.mode ?? 'drain';
    if (!['drain', 'interrupt', 'pause'].includes(mode))
      fail('VALIDATION_ERROR', 'Unknown close mode');
    const timeout = integer(options.timeoutMs ?? 30000, 'timeoutMs', 0, 3600000);
    const interruptWait =
      options.interruptWaitMs === undefined
        ? Math.min(this.timeouts.interruptMs, timeout / 2)
        : Math.min(integer(options.interruptWaitMs, 'interruptWaitMs', 0, 3600000), timeout);
    if (options.operationId !== undefined && options.operationId !== this.shutdownId)
      fail('STALE_TARGET', 'Unknown shutdown operation');
    if (this.closed) return { status: 'closed', operationId: this.shutdownId! };
    if (this.store.degraded) return this.closeDegraded(timeout);
    if (!this.shutdownId) {
      this.shutdownId = randomUUID();
      this.closing = true;
      this.store.transaction(() => {
        const op: OperationSnapshot = {
          id: this.shutdownId!,
          method: 'host.shutdown',
          scope: this.instanceId,
          idempotencyKey: this.shutdownId!,
          status: 'persisted',
          targetId: this.instanceId,
          result: null,
          error: null,
        };
        this.store.saveOperation(op, digest({ instanceId: this.instanceId }));
        for (const task of this.store.all<TaskSnapshot>('tasks'))
          if (task.status === 'queued') {
            task.pausedByClose = { operationId: this.shutdownId!, wasRunning: false };
            this.saveTask(task, 'paused', 'owner_shutdown');
            const session = this.session(task.sessionId);
            if (session.taskId === task.id) this.saveSession(session, 'paused');
            this.taskEvent(task);
          }
        this.admissionEvent();
      });
    }
    this.store.transaction(() => {
      const op = this.store.operation(this.shutdownId!);
      op.lifecycle = {
        enteredAt: op.lifecycle?.enteredAt ?? this.time(),
        deadlineAt: new Date(this.wall() + timeout).toISOString(),
        policyVersion: 1,
        kind: 'shutdown',
        expectedGeneration: null,
        expectedDispatchId: null,
        mayHaveBeenSent: mode !== 'drain',
        lastEvidence: `waiting_${mode}`,
      };
      this.store.saveOperation(op);
      this.store.event(
        'shutdown.wait_started',
        { mode, timeoutMs: timeout, deadlineAt: op.lifecycle.deadlineAt },
        { operationId: op.id },
      );
    });
    const deadline = performance.now() + timeout;
    if (mode === 'interrupt' || mode === 'pause') {
      for (const flight of this.flights.values()) {
        if (!flight.intent) {
          flight.intent = 'shutdown';
          // Marked before the abort, so the terminal chooses its reason once (SPEC-0028 S02).
          // A flight that another request already interrupts keeps that request's reason.
          if (mode === 'pause') flight.pausedByClose = true;
        }
        flight.controller.abort();
      }
      // Each runtime may still report its interrupted terminal and stop proof (SPEC-0022 C01, C02):
      // wait for the flights, by default at most interruptMs and half of the budget, before
      // closing the adapters.
      const settled = performance.now() + interruptWait;
      while (this.flights.size && performance.now() < settled)
        await sleep(Math.min(10, Math.max(1, settled - performance.now())));
      // The owner requested resource shutdown. Adapter cleanup may unblock a stalled iterator;
      // it is not evidence that a remote business action was cancelled (SPEC-0022 C03).
      this.beginAdapterClose();
    }
    while (this.flights.size) {
      // A flight whose runtime has ended and that only writes its files is finishing, however
      // slow the disk: before SPEC-0057 those writes blocked this loop and could not time out.
      if (
        performance.now() >= deadline &&
        [...this.flights.values()].some((flight) => !flight.writingFiles)
      )
        throw this.shutdownIncomplete();
      await sleep(Math.min(10, Math.max(1, deadline - performance.now())));
    }
    if (this.closed) return { status: 'closed', operationId: this.shutdownId };
    this.beginAdapterClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closeAdaptersPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(this.shutdownIncomplete()),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } catch (cause) {
      const error = this.shutdownIncomplete();
      error.cause = cause;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A reserve that storage.configure or a store switch is writing finishes first (W02), and so
    // does an artifact file that a turn's end is writing (SPEC-0057).
    await this.storage.settled();
    await this.store.writesSettled();
    if (!this.closed) {
      const op = this.store.operation(this.shutdownId);
      op.status = 'completed';
      op.result = { status: 'closed' };
      this.store.saveOperation(op);
      for (const { cancel } of this.queueTimers.values()) cancel();
      this.queueTimers.clear();
      this.handoffTimer?.();
      if (this.storageTimer) clearInterval(this.storageTimer);
      this.store.close();
      this.controlPlane?.close();
      this.closed = true;
    }
    return { status: 'closed', operationId: this.shutdownId };
  }
  private async closeDegraded(timeoutMs: number): Promise<never> {
    this.closing = true;
    this.shutdownId ??= randomUUID();
    for (const flight of this.flights.values()) {
      flight.intent ??= 'shutdown';
      flight.controller.abort();
    }
    this.beginAdapterClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          this.closeAdaptersPromise,
          ...[...this.flights.values()].map((f) => f.promise),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(this.shutdownIncomplete()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    for (const { cancel } of this.queueTimers.values()) cancel();
    this.queueTimers.clear();
    this.handoffTimer?.();
    if (this.storageTimer) clearInterval(this.storageTimer);
    await this.storage.settled();
    await this.store.writesSettled();
    this.store.close();
    this.controlPlane?.close();
    this.closed = true;
    throw new OrchestrationError(
      'STORAGE_DEGRADED_CLOSED',
      'Local resources closed; shutdown receipt could not be persisted. Restart must recover unresolved work.',
      { status: 'closed', operationId: this.shutdownId, durableReceipt: false },
    );
  }
  private beginAdapterClose(): void {
    if (this.closeAdaptersPromise) return;
    const attempt = Promise.all(
      [...this.adapters.values()].map((a) => Promise.resolve().then(() => a.close?.())),
    ).then(() => {});
    this.closeAdaptersPromise = attempt;
    void attempt.catch(() => {
      if (this.closeAdaptersPromise === attempt) this.closeAdaptersPromise = undefined;
    });
  }
  private shutdownIncomplete(): OrchestrationError {
    if (!this.closed && !this.store.degraded && this.shutdownId) {
      this.store.transaction(() => {
        const op = this.store.operation(this.shutdownId!);
        if (op.lifecycle && !op.lifecycle.expiredAt) {
          op.lifecycle.expiredAt = this.time();
          op.lifecycle.lastEvidence = 'shutdown_incomplete';
          this.store.saveOperation(op);
          this.store.event('shutdown.incomplete', { status: 'stopping' }, { operationId: op.id });
        }
      });
    }
    const error = new OrchestrationError(
      'SHUTDOWN_INCOMPLETE',
      'Owned runtime work or cleanup is still running',
      { operationId: this.shutdownId },
    );
    Object.assign(error, { client: this, operationId: this.shutdownId });
    return error;
  }
}
/** A deep-frozen copy of host metadata, or null (SPEC-0027 L04). */
function frozenCopy(value: { [key: string]: Json } | undefined): { [key: string]: Json } | null {
  if (value === undefined) return null;
  const freeze = (item: Json): Json => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(structuredClone(value)) as { [key: string]: Json };
}
export async function createEngine(config: EngineConfig): Promise<Engine> {
  const engine = new LocalEngine(config);
  await engine.writeReserve();
  return engine;
}
