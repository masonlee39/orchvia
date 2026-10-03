// Offline team: a lead agent delegates to a helper, leaves it a message, and asks to hand work to
// another agent. The host approves the delegation and accepts the handoff.
// Uses a scripted fake runtime that calls the orchestration tools a real model would call.
// node examples/typescript/team-mailbox.ts
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator, TaskHandle } from '../../packages/sdk-typescript/src/index.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';
import { createTeamAdapter, leadGoal, teamTools } from './team-runtime.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-team-')));
await mkdir(join(root, 'workspace'));
await mkdir(join(root, 'state'), { mode: 0o700 });
const orch = await createOrchestrator({
  workspace: join(root, 'workspace'),
  stateDir: join(root, 'state'),
  adapters: [createTeamAdapter()],
  providers: { fake: { model: 'fake-model' } },
  tools: teamTools,
});
type Spec = Parameters<typeof orch.tasks.create>[0];
const runtime = { provider: 'fake', model: 'fake-model' };
const acceptance = { mode: 'human' as const, criteria: ['A reviewer read the result'] };

/** Runs one task to its end. A real host shows each result to a person; this demo approves it. */
async function run(task: Spec | TaskSnapshot) {
  // A task that a model created has no handle yet; one can be made from its snapshot.
  const handle = 'id' in task ? new TaskHandle(orch, task) : await orch.tasks.create(task);
  const settled = await handle.settle({ onApproval: () => 'approve', timeoutMs: 10_000 });
  if (settled.reason !== 'terminal') throw new Error(`${settled.task.id} ${settled.reason}`);
  return settled.task;
}

try {
  const editor = await run({ goal: 'Keep a consistent tone', runtime, acceptance });
  const lead = await run({ goal: leadGoal(editor.sessionId!), runtime, acceptance });

  const [helper] = (await orch.tasks.list({ parentTaskId: lead.id })).tasks;
  console.log(`1. The lead delegated "${helper!.spec.goal}": ${helper!.status} for the host`);
  await orch.tasks.resume(helper!.id);
  const checked = await run(helper!);
  const message = /\[Message .*\]\n(.*)/.exec(checked.result ?? '')?.[1];
  console.log(`2. The helper's prompt held the lead's message: ${message}`);

  const [request] = (await orch.handoffs.list({ status: 'pending' })).handoffs;
  // To accept, the host creates the task itself, in the editor's team and session.
  const takeover = await orch.tasks.create({
    goal: request!.goal,
    runtime,
    acceptance,
    parentTaskId: editor.id,
    contextPlan: {
      requestedMode: 'reuse',
      independent: true,
      candidateSessionId: editor.sessionId!,
    },
  });
  await orch.handoffs.resolve(request!.handoffId, {
    expectedRevision: request!.revision,
    outcome: 'accepted',
    taskId: takeover.id,
  });
  const reviewed = await run(await takeover.get());
  const same = reviewed.sessionId === editor.sessionId;
  console.log(
    `3. The host handed "${request!.goal}" to the editor: ${reviewed.status}, same session: ${same}`,
  );
} finally {
  await orch.close();
  await rm(root, { recursive: true, force: true });
}
