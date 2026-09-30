/**
 * The reference host's workflow (SPEC-0050 W01): change the code until the registered tests pass,
 * then an independent review that a person accepts. The Python host builds the same requests.
 */
import type { TaskSpec, VerificationRule } from '../../packages/engine/src/types.ts';

export const RECIPE_VERSION = '1';
/** The test the change must pass: here, a marker file in the workspace stands for a test suite. */
export function testRule(node: string): VerificationRule {
  return {
    id: 'tests',
    version: '1',
    argv: [node, '-e', "process.exit(require('node:fs').existsSync('tests-pass') ? 0 : 1)"],
    cwdRelative: '.',
    timeoutMs: 10_000,
    permissionProfile: 'read-only',
    success: { exitCode: 0 },
  };
}
/** Every step's idempotency key: one per step, for every send of it (invariant 2). */
export const stepKey = (runId: string, stepId: string) => `refhost/${runId}/${stepId}`;
export const decisionKey = (runId: string, approvalId: string) =>
  `refhost/${runId}/${approvalId}/decide`;

export function changeSpec(runId: string, goal: string): TaskSpec {
  return {
    goal: `Change the code: ${goal}`,
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'checks', ruleRefs: [{ id: 'tests', version: '1' }], maxRepairs: 1 },
    label: `refhost:${runId}`,
    metadata: { runId, stepId: 'change', recipeVersion: RECIPE_VERSION },
  };
}
/** The review runs on `provider`: a read-only one where the host has it. */
export function reviewSpec(runId: string, changeTaskId: string, provider: string): TaskSpec {
  return {
    goal: `Review the change of task ${changeTaskId}: name each problem with its evidence`,
    runtime: { provider, model: 'fixture' },
    acceptance: {
      mode: 'human',
      criteria: ['Each problem the review names comes with its evidence'],
    },
    dependencyTaskIds: [changeTaskId],
    contextPlan: {
      requestedMode: 'fresh',
      independent: true,
      dependencyTaskIds: [changeTaskId],
      contextRefs: [],
      fallbackModes: [],
      maxQueueWaitMs: 600_000,
    },
    label: `refhost:${runId}`,
    metadata: { runId, stepId: 'review', recipeVersion: RECIPE_VERSION },
  };
}

/** A run's state, from its steps' tasks, and what it waits for. */
export type RunState =
  | 'running'
  | 'attention'
  | 'tests_failed'
  | 'needs_reconcile'
  | 'awaiting_review'
  | 'done'
  | 'rejected'
  | 'abandoned'
  | 'ended';
export function runState(
  steps: { stepId: string; state: string }[],
  tasks: Record<string, { status: string; reason: string | null } | undefined>,
): RunState {
  if (steps.some((step) => step.state === 'attention')) return 'attention';
  const change = tasks.change,
    review = tasks.review;
  for (const task of [change, review])
    if (task?.status === 'blocked' && task.reason?.startsWith('outcome_unknown'))
      return 'needs_reconcile';
  if (change?.status === 'blocked' && change.reason === 'verification_failed')
    return 'tests_failed';
  if (change?.status === 'cancelled' && (!review || review.status === 'cancelled'))
    return 'abandoned';
  if (change && ['failed', 'cancelled'].includes(change.status)) {
    if (!review || review.status === 'blocked' || review.status === 'cancelled') return 'ended';
  }
  if (!review) return 'running';
  if (review.status === 'waiting_approval') return 'awaiting_review';
  if (review.status === 'completed') return 'done';
  if (review.status === 'failed') return 'rejected';
  if (review.status === 'cancelled') return 'abandoned';
  if (review.status === 'blocked') return 'ended';
  return 'running';
}
/** The next step for a person, for each state (SPEC-0050 I03). */
export const NEXT_STEP: Record<RunState, string> = {
  running: 'none: the engine is working',
  attention: 'a person: see the attention reason',
  tests_failed: 'a person: the tests failed after the repairs; abandon the run or start a new one',
  needs_reconcile: 'the owner: check what ran, then reconcile; never resend',
  awaiting_review: 'the reviewer: approve, deny or revise',
  done: 'none: accepted',
  rejected: 'none: the reviewer denied the result',
  abandoned: 'none: abandoned',
  ended: 'a person: the run ended without a result; start a new one',
};
