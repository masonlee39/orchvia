/**
 * The TypeScript reference host (SPEC-0050): runs "change the code until the tests pass, then an
 * independent review that a person decides" on an embedded engine, and survives a crash at any
 * point without creating, running or counting anything twice. See README.md for how to run it.
 *
 *   node examples/reference-host/host.ts start --root DIR --run ID --goal TEXT
 *   node examples/reference-host/host.ts advance|abandon --root DIR --run ID
 *   node examples/reference-host/host.ts decide --root DIR --run ID --choice approve|deny|revise [--comment TEXT]
 *   node examples/reference-host/host.ts reconcile --root DIR --run ID --outcome interrupted|not_executed|failed --summary TEXT
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createOrchestrator, type Orchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { requestScope } from '../../packages/engine/src/identity.ts';
import type { EventEnvelope, TaskSnapshot } from '../../packages/engine/src/types.ts';
import { Journal, type Step } from './journal.ts';
import {
  NEXT_STEP,
  RECIPE_VERSION,
  changeSpec,
  decisionKey,
  reviewSpec,
  runState,
  stepKey,
  testRule,
  type RunState,
} from './recipe.ts';

/** Engine answers after which the same request can never succeed: a person must act. */
const NEVER_RESEND = new Set([
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_HISTORY_EXPIRED',
  'STORE_NAMESPACE_MISMATCH',
  'OUTCOME_UNKNOWN',
  'VALIDATION_ERROR',
  'UNSUPPORTED_CAPABILITY',
  'UNAUTHORIZED',
  'STALE_TARGET',
]);
const code = (error: unknown) => (error as { code?: string })?.code ?? '';

/** The part of the SDK that recovery needs; tests pass a stand-in. */
export interface RecoveryClient {
  info: { storeId: string };
  operations: {
    lookup(query: { method: string; scope: string; idempotencyKey: string }): Promise<{
      status: string;
      targetId: string;
    }>;
  };
  tasks: {
    create(spec: any, options: { idempotencyKey: string }): Promise<{ id: string }>;
  };
}

/**
 * Invariant 4: an intended step is looked up in the store it was recorded in. Found: its receipt is
 * recorded and nothing is sent. Not found: the create did not commit (the engine commits the
 * operation and the task together), so the frozen request goes again under the same key. Any other
 * answer needs a person, and the step is never sent again.
 */
export async function resolveStep(journal: Journal, client: RecoveryClient, step: Step) {
  if (step.storeId !== client.info.storeId) {
    journal.stepAttention(
      step.runId,
      step.stepId,
      `store_changed: recorded in store ${step.storeId}, the host now has ${client.info.storeId}; never resend it`,
    );
    return;
  }
  let found: { status: string; targetId: string } | undefined;
  try {
    found = await client.operations.lookup({
      method: 'tasks.create',
      scope: 'local',
      idempotencyKey: step.idempotencyKey,
    });
  } catch (error) {
    if (code(error) === 'NOT_FOUND') found = undefined;
    else if (NEVER_RESEND.has(code(error))) {
      journal.stepAttention(step.runId, step.stepId, `${code(error)}: ${(error as Error).message}`);
      return;
    } else throw error;
  }
  if (found) {
    if (found.status === 'completed') journal.submitStep(step.runId, step.stepId, found.targetId);
    else
      journal.stepAttention(
        step.runId,
        step.stepId,
        `OUTCOME_UNKNOWN: the create's operation is ${found.status}`,
      );
    return;
  }
  await sendStep(journal, client, step);
}
async function sendStep(
  journal: Journal,
  client: RecoveryClient,
  step: Step,
  afterSend: (taskId: string) => Promise<void> | void = () => {},
) {
  let task: { id: string };
  try {
    task = await client.tasks.create(JSON.parse(step.request), {
      idempotencyKey: step.idempotencyKey,
    });
  } catch (error) {
    if (!NEVER_RESEND.has(code(error))) throw error;
    journal.stepAttention(step.runId, step.stepId, `${code(error)}: ${(error as Error).message}`);
    return;
  }
  await afterSend(task.id);
  journal.submitStep(step.runId, step.stepId, task.id);
}

export interface HostOptions {
  root: string;
  node: string;
  emergencyBytes?: number;
  fault?: string;
}

export class ReferenceHost {
  readonly options: HostOptions;
  readonly journal: Journal;
  private orch!: Orchestrator;
  private storeId = '';
  constructor(options: HostOptions) {
    this.options = options;
    mkdirSync(join(options.root, 'workspace'), { recursive: true });
    mkdirSync(join(options.root, 'state'), { recursive: true, mode: 0o700 });
    this.journal = new Journal(join(options.root, 'journal.sqlite'));
  }
  /** Ends the process at once at a named point, as a crash would (SPEC-0050 F). */
  private fault(point: string) {
    if (this.options.fault === point) process.kill(process.pid, 'SIGKILL');
  }
  async open() {
    const usage = { inputTokens: 100, outputTokens: 20 };
    this.orch = await createOrchestrator(
      {
        workspace: join(this.options.root, 'workspace'),
        stateDir: join(this.options.root, 'state'),
        adapters: [
          // F02 and F04 hold the change's dispatch so that the host is killed during it.
          createFakeAdapter({
            usage,
            delayMs: ['during-dispatch', 'after-send'].includes(this.options.fault ?? '')
              ? 3_600_000
              : 0,
          }),
          createFakeAdapter({ provider: 'reviewer', usage }),
        ],
        providers: {
          fake: { model: 'fixture', permissionProfile: 'workspace-write' },
          reviewer: { model: 'fixture', permissionProfile: 'read-only' },
        },
        verificationRules: [testRule(this.options.node)],
        approvalTtlMs: 604_800_000,
        ...(this.options.emergencyBytes !== undefined
          ? { storage: { emergencyBytes: this.options.emergencyBytes } }
          : {}),
      },
      { pollIntervalMs: 20 },
    );
    this.storeId = this.orch.info.storeId;
  }
  async close() {
    await this.orch.close({ mode: 'interrupt', timeoutMs: 3000 });
    this.journal.close();
  }

  /** Invariant 4: every intent without a receipt is resolved before anything new is sent. */
  async recover() {
    for (const step of this.journal.steps())
      if (step.state === 'intended') await resolveStep(this.journal, this.orch, step);
    for (const decision of this.journal.decisions())
      if (decision.state === 'intended')
        await this.resolveDecision(decision.runId, decision.approvalId);
    for (const command of this.journal.commands())
      if (command.state === 'intended') await this.resolveCommand(command.idempotencyKey);
    await this.project();
  }

  /** Invariant 5: a page of events and the checkpoint after it commit together. */
  async project() {
    let cursor = this.journal.checkpoint(this.storeId) ?? '0';
    for (;;) {
      let page;
      try {
        page = await this.orch.events.read({
          afterCursor: cursor,
          storeId: this.storeId,
          limit: 256,
        });
      } catch (error) {
        if (code(error) !== 'CURSOR_EXPIRED') throw error;
        const reason = (error as { data?: { reason?: string } }).data?.reason ?? 'unknown';
        this.journal.notice(
          this.storeId,
          'CURSOR_EXPIRED',
          `CURSOR_EXPIRED: ${reason} at ${cursor}`,
        );
        return;
      }
      if (!page.events.length) return;
      // F03 fires on the page that asks for the review's decision, when nothing runs.
      if (page.events.some((event) => event.type === 'approval.requested'))
        this.fault('before-projection-commit');
      let accepted = false;
      const next = page.cursor;
      this.journal.transaction(() => {
        for (const event of page.events) accepted = this.apply(event) || accepted;
        this.journal.setCheckpoint(this.storeId, next);
      });
      if (accepted) this.fault('during-dispatch');
      cursor = next;
    }
  }
  /** Applies one event; returns true for the change's runtime acceptance (used by F04). */
  private apply(event: EventEnvelope): boolean {
    const data = event.data as Record<string, any>;
    if (event.type.startsWith('task.') && event.taskId)
      this.journal.projectTask(
        this.storeId,
        event.taskId,
        String(data.status),
        (data.reason as string | null) ?? null,
        event.cursor,
      );
    else if (event.type === 'approval.requested' && event.taskId && data.approvalId)
      this.journal.projectApproval(
        this.storeId,
        String(data.approvalId),
        event.taskId,
        Number(data.revision),
        JSON.stringify(data.summary ?? null),
        event.cursor,
      );
    else if (event.type === 'usage.recorded' && event.taskId)
      this.journal.projectUsage(
        this.storeId,
        String(data.usageRecordId),
        event.taskId,
        String(data.dispatchId),
        (data.inputTokens as number | null) ?? null,
        (data.outputTokens as number | null) ?? null,
        event.cursor,
      );
    return (
      event.type === 'dispatch.runtime_accepted' &&
      this.journal.steps().some((s) => s.stepId === 'change' && s.taskId === event.taskId)
    );
  }
  private tasks(runId: string) {
    const tasks: Record<string, { status: string; reason: string | null } | undefined> = {};
    for (const step of this.journal.steps(runId))
      if (step.taskId) tasks[step.stepId] = this.journal.projected(this.storeId, step.taskId);
    return tasks;
  }
  state(runId: string): RunState {
    if (this.journal.notices().some((n) => n.storeId === this.storeId)) return 'attention';
    return runState(this.journal.steps(runId), this.tasks(runId));
  }
  private async intendAndSend(runId: string, stepId: string, request: object) {
    const key = stepKey(runId, stepId);
    // Invariant 1: the intent is on disk before the engine hears of it.
    this.journal.intendStep({
      runId,
      stepId,
      storeId: this.storeId,
      idempotencyKey: key,
      request: JSON.stringify(request),
    });
    this.fault('after-intent');
    await sendStep(this.journal, this.orch, this.journal.step(runId, stepId)!, async (id) => {
      if (this.options.fault !== 'after-send') return;
      // F02: the engine committed and started the task; the receipt is not yet on disk.
      while ((await this.orch.tasks.get(id)).status !== 'running')
        await new Promise((r) => setTimeout(r, 10));
      this.fault('after-send');
    });
  }

  /** Drives a run until a person must act or it ended, then records `blockedBy`. */
  async advance(runId: string, timeoutMs = 60_000): Promise<RunState> {
    const run = this.journal.run(runId);
    if (!run) throw new Error(`No run ${runId}`);
    const deadline = Date.now() + timeoutMs;
    let state: RunState = 'running';
    while (Date.now() < deadline) {
      await this.project();
      const change = this.journal.step(runId, 'change'),
        review = this.journal.step(runId, 'review');
      if (!change) await this.intendAndSend(runId, 'change', changeSpec(runId, run.goal));
      // Invariant 3: the review names the change's task, so it waits for the change's receipt; the
      // engine holds it until the change completes (W02).
      else if (change.state === 'submitted' && !review)
        await this.intendAndSend(runId, 'review', reviewSpec(runId, change.taskId!, 'reviewer'));
      state = this.state(runId);
      if (state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await this.recordBlockedBy(runId);
    return state;
  }
  /** `blockedBy` is computed by a running engine only; the inspector shows it with this time. */
  private async recordBlockedBy(runId: string) {
    const ids = this.journal
      .steps(runId)
      .map((step) => step.taskId)
      .filter((id): id is string => !!id);
    if (!ids.length) return;
    // The events of a step sent in the last pass are projected first, so that each has its row.
    await this.project();
    const { tasks } = await this.orch.tasks.getMany(ids);
    const at = new Date().toISOString();
    this.journal.transaction(() => {
      for (const task of tasks as (TaskSnapshot & { blockedBy?: unknown })[])
        this.journal.setBlockedBy(
          this.storeId,
          task.id,
          task.blockedBy ? JSON.stringify(task.blockedBy) : null,
          at,
        );
    });
  }

  async start(runId: string, goal: string) {
    this.journal.addRun({
      runId,
      recipeVersion: RECIPE_VERSION,
      goal,
      createdAt: new Date().toISOString(),
    });
    return this.advance(runId);
  }

  /** A person's decision on the review waiting for one; one decision per approval. */
  async decide(runId: string, choice: 'approve' | 'deny' | 'revise', comment?: string) {
    const review = this.journal.step(runId, 'review');
    if (
      !review?.taskId ||
      this.journal.projected(this.storeId, review.taskId)?.status !== 'waiting_approval'
    )
      throw new Error(`Run ${runId} has no review waiting for a decision`);
    const approval = this.journal.approvals(this.storeId, review.taskId).at(-1)!;
    if (!this.journal.decision(runId, approval.approvalId)) {
      const decision = {
        choice,
        expectedRevision: approval.revision,
        ...(comment !== undefined ? { comment } : {}),
      };
      this.journal.intendDecision({
        runId,
        approvalId: approval.approvalId,
        storeId: this.storeId,
        idempotencyKey: decisionKey(runId, approval.approvalId),
        request: JSON.stringify(decision),
      });
      await this.sendDecision(runId, approval.approvalId);
    }
    return this.advance(runId);
  }
  private async sendDecision(runId: string, approvalId: string) {
    const decision = this.journal.decision(runId, approvalId)!;
    try {
      const operation = await this.orch.approvals.decide(approvalId, JSON.parse(decision.request), {
        idempotencyKey: decision.idempotencyKey,
      });
      this.fault('after-decide-send');
      this.journal.submitDecision(runId, approvalId, operation.id);
    } catch (error) {
      if (!NEVER_RESEND.has(code(error))) throw error;
      this.journal.decisionAttention(
        runId,
        approvalId,
        `${code(error)}: ${(error as Error).message}`,
      );
    }
  }
  private async resolveDecision(runId: string, approvalId: string) {
    const decision = this.journal.decision(runId, approvalId)!;
    if (decision.storeId !== this.storeId)
      return this.journal.decisionAttention(runId, approvalId, 'store_changed: never resend it');
    try {
      const found = await this.orch.operations.lookup({
        method: 'approvals.decide',
        scope: requestScope('approvals.decide', { approvalId }),
        idempotencyKey: decision.idempotencyKey,
      });
      this.journal.submitDecision(runId, approvalId, found.id);
    } catch (error) {
      if (code(error) === 'NOT_FOUND') return this.sendDecision(runId, approvalId);
      if (!NEVER_RESEND.has(code(error))) throw error;
      this.journal.decisionAttention(
        runId,
        approvalId,
        `${code(error)}: ${(error as Error).message}`,
      );
    }
  }

  /** An owner command (cancel, reconcile) with the same intent-first rule as a step. */
  private async command(
    runId: string,
    key: string,
    method: string,
    request: Record<string, unknown>,
  ) {
    if (!this.journal.command(key))
      this.journal.intendCommand({
        idempotencyKey: key,
        runId,
        storeId: this.storeId,
        method,
        request: JSON.stringify(request),
      });
    if (this.journal.command(key)!.state === 'intended') await this.resolveCommand(key);
  }
  private async resolveCommand(key: string) {
    const command = this.journal.command(key)!;
    if (command.storeId !== this.storeId)
      return this.journal.settleCommand(key, 'attention', 'store_changed: never resend it');
    const request = JSON.parse(command.request) as Record<string, any>;
    try {
      await this.orch.operations.lookup({
        method: command.method,
        scope: requestScope(command.method, request),
        idempotencyKey: key,
      });
      return this.journal.settleCommand(key, 'submitted');
    } catch (error) {
      if (code(error) !== 'NOT_FOUND') {
        if (!NEVER_RESEND.has(code(error))) throw error;
        return this.journal.settleCommand(
          key,
          'attention',
          `${code(error)}: ${(error as Error).message}`,
        );
      }
    }
    try {
      const operation =
        command.method === 'tasks.cancel'
          ? await this.orch.tasks.cancel(request.taskId, { idempotencyKey: key })
          : await this.orch.sessions.reconcile(request.target, request.evidence, {
              idempotencyKey: key,
            });
      await operation.wait({ timeoutMs: 10_000 });
      this.journal.settleCommand(key, 'submitted');
    } catch (error) {
      if (!NEVER_RESEND.has(code(error))) throw error;
      this.journal.settleCommand(key, 'attention', `${code(error)}: ${(error as Error).message}`);
    }
  }
  /** Cancels the change, then the review, which the change's cancellation blocks first. */
  async abandon(runId: string) {
    for (const stepId of ['change', 'review']) {
      const step = this.journal.step(runId, stepId);
      if (step?.taskId)
        await this.command(runId, `refhost/${runId}/cancel-${stepId}`, 'tasks.cancel', {
          taskId: step.taskId,
        });
    }
    return this.advance(runId);
  }
  /** Invariant 6: only the owner, with the attestation a person gives, resolves an unknown task. */
  async reconcile(runId: string, outcome: string, summary: string) {
    for (const step of this.journal.steps(runId)) {
      if (!step.taskId) continue;
      const task = await this.orch.tasks.get(step.taskId);
      if (task.status !== 'blocked' || !task.reason?.startsWith('outcome_unknown')) continue;
      const session = await this.orch.sessions.get(task.sessionId!);
      await this.command(
        runId,
        `refhost/${runId}/reconcile-${step.stepId}-${session.activeDispatchId}`,
        'sessions.reconcile',
        {
          target: {
            sessionId: session.id,
            expectedGeneration: session.generation,
            expectedRevision: session.revision,
            expectedDispatchId: session.activeDispatchId,
            expectedState: session.status,
          },
          evidence: {
            source: 'owner_attestation',
            summary,
            localResources: 'stopped',
            remoteExecution: 'stopped',
            sideEffects: 'resolved',
            outcome,
          },
        },
      );
    }
    return this.advance(runId);
  }
  report(runId: string, state: RunState) {
    return {
      run: runId,
      state,
      next: NEXT_STEP[state],
      steps: this.journal.steps(runId).map((step) => ({
        step: step.stepId,
        state: step.state,
        taskId: step.taskId,
        ...(step.taskId ? this.journal.projected(this.storeId, step.taskId) : {}),
        attention: step.attention,
      })),
      notices: this.journal.notices(),
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      run: { type: 'string' },
      goal: { type: 'string' },
      choice: { type: 'string' },
      comment: { type: 'string' },
      outcome: { type: 'string' },
      summary: { type: 'string' },
      fault: { type: 'string' },
      node: { type: 'string' },
      'emergency-bytes': { type: 'string' },
    },
  });
  const [command] = positionals;
  if (!values.root || !values.run || !command) {
    console.error('usage: host.ts start|advance|decide|abandon|reconcile --root DIR --run ID ...');
    process.exit(2);
  }
  const host = new ReferenceHost({
    root: resolve(values.root),
    node: values.node ?? process.execPath,
    fault: values.fault,
    emergencyBytes: values['emergency-bytes'] ? Number(values['emergency-bytes']) : undefined,
  });
  await host.open();
  try {
    await host.recover();
    const runId = values.run;
    const state =
      command === 'start'
        ? await host.start(runId, values.goal ?? 'the requested change')
        : command === 'decide'
          ? await host.decide(runId, values.choice as 'approve', values.comment)
          : command === 'abandon'
            ? await host.abandon(runId)
            : command === 'reconcile'
              ? await host.reconcile(runId, values.outcome ?? 'interrupted', values.summary ?? '')
              : await host.advance(runId);
    console.log(JSON.stringify(host.report(runId, state)));
  } finally {
    await host.close();
  }
}
