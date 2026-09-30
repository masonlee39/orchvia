/**
 * The reference host's inspector (SPEC-0050 I): why a run stopped, how far it got, and who acts
 * next. It reads the journal and the engine's store read-only, whether or not a host runs, and
 * calls no method that changes anything.
 *
 *   node examples/reference-host/inspect.ts --root DIR [--run ID] [--json]
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openOrchestratorReadOnly } from '../../packages/sdk-typescript/src/index.ts';
import type { EventEnvelope } from '../../packages/engine/src/types.ts';
import { Journal } from './journal.ts';
import { NEXT_STEP, runState } from './recipe.ts';

/** The host's illustrative prices, in dollars per million tokens. */
const PRICE = { input: 1, output: 2 };

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    run: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (!values.root) {
  console.error('usage: inspect.ts --root DIR [--run ID] [--json]');
  process.exit(2);
}
const root = resolve(values.root);
const journal = new Journal(join(root, 'journal.sqlite'), { readOnly: true });
const orch = await openOrchestratorReadOnly({ stateDir: join(root, 'state') });
try {
  const storeId = orch.storeId;
  const events: EventEnvelope[] = [];
  for (let cursor = '0'; ; ) {
    const page = await orch.events.read({ afterCursor: cursor, storeId, limit: 256 });
    if (!page.events.length) break;
    events.push(...page.events);
    cursor = page.cursor;
  }
  const notices = journal.notices().filter((notice) => notice.storeId === storeId);
  const runs = [];
  for (const run of journal.runs()) {
    if (values.run && run.runId !== values.run) continue;
    const steps = journal.steps(run.runId);
    const ids = steps.map((step) => step.taskId).filter((id): id is string => !!id);
    // The engine's store is authoritative for task state; the journal for what was submitted.
    const tasks = ids.length ? (await orch.tasks.getMany(ids)).tasks : [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const state = notices.length
      ? 'attention'
      : runState(
          steps,
          Object.fromEntries(
            steps.map((step) => [step.stepId, step.taskId ? byId.get(step.taskId) : undefined]),
          ),
        );
    const review = steps.find((step) => step.stepId === 'review');
    const approval =
      review?.taskId && byId.get(review.taskId)?.status === 'waiting_approval'
        ? (journal.approvals(storeId, review.taskId).at(-1) ?? null)
        : null;
    // I04: a dispatch without a usage record, or a record without a count, makes the total unknown.
    const records = journal.usage(storeId, ids);
    const recorded = new Set(records.map((record) => record.dispatchId));
    const dispatches = events.filter(
      (event) => event.type === 'dispatch.started' && ids.includes(event.taskId ?? ''),
    );
    const unknownRecords =
      records.filter((record) => record.inputTokens === null || record.outputTokens === null)
        .length +
      dispatches.filter((event) => !recorded.has(String(event.data.dispatchId ?? ''))).length;
    const inputTokens = records.reduce((n, record) => n + (record.inputTokens ?? 0), 0);
    const outputTokens = records.reduce((n, record) => n + (record.outputTokens ?? 0), 0);
    const known = (inputTokens * PRICE.input + outputTokens * PRICE.output) / 1_000_000;
    runs.push({
      runId: run.runId,
      goal: run.goal,
      state,
      next: NEXT_STEP[state],
      steps: steps.map((step) => {
        const task = step.taskId ? byId.get(step.taskId) : undefined;
        const projected = step.taskId ? journal.projected(storeId, step.taskId) : undefined;
        const waiting = task && ['queued', 'waiting_dependency'].includes(task.status);
        return {
          stepId: step.stepId,
          state: step.state,
          taskId: step.taskId,
          status: task?.status ?? null,
          reason: task?.reason ?? null,
          attention: step.attention,
          // Only a running engine computes blockedBy: show the host's last reading, never a guess.
          blockedBy: !waiting
            ? null
            : projected?.blockedBy
              ? { ...JSON.parse(projected.blockedBy), at: projected.blockedByAt }
              : 'not known while the engine is stopped',
        };
      }),
      approval: approval && {
        approvalId: approval.approvalId,
        revision: approval.revision,
        summary: approval.criteria ? JSON.parse(approval.criteria) : null,
      },
      cost: {
        inputTokens,
        outputTokens,
        records: records.length,
        unknownRecords,
        knownUsd: known,
        total: unknownRecords ? null : known,
      },
      notices: notices.map((notice) => notice.detail),
    });
  }
  if (values.json) console.log(JSON.stringify({ storeId, runs }, null, 2));
  else
    for (const run of runs) {
      console.log(`Run ${run.runId}: ${run.goal}`);
      console.log(`  state     ${run.state}`);
      console.log(`  next      ${run.next}`);
      for (const step of run.steps)
        console.log(
          `  ${step.stepId.padEnd(9)} ${step.status ?? step.state}${step.reason ? ` (${step.reason})` : ''}` +
            `${step.attention ? `, attention: ${step.attention}` : ''}` +
            `${step.blockedBy ? `, waiting for ${typeof step.blockedBy === 'string' ? step.blockedBy : `${step.blockedBy.reason} as of ${step.blockedBy.at}`}` : ''}`,
        );
      if (run.approval) console.log(`  approval  ${run.approval.approvalId}`);
      console.log(
        `  cost      ${run.cost.total === null ? `at least $${run.cost.knownUsd.toFixed(6)}, ${run.cost.unknownRecords} unknown` : `$${run.cost.total.toFixed(6)}`}` +
          ` (in ${run.cost.inputTokens}, out ${run.cost.outputTokens} tokens)`,
      );
      for (const notice of run.notices) console.log(`  notice    ${notice}`);
    }
} finally {
  await orch.close();
  journal.close();
}
