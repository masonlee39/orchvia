// Runnable offline host integration. No real application, model, credentials, or tool calls.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createOfflineHostFixture } from '../../packages/engine/src/testing-host.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-host-example-')));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const host = createOfflineHostFixture();
const client = await createOrchestrator({
  workspace,
  stateDir: join(root, 'state'),
  adapters: [host.adapter],
});
try {
  const task = await client.tasks.create(
    {
      goal: 'Exercise the existing-host adapter boundary with a deterministic fixture',
      runtime: { provider: host.adapter.provider, model: 'offline-host-model' },
      acceptance: { mode: 'human', criteria: ['Simulated fixture review; no production approval'] },
    },
    { idempotencyKey: 'offline-example' },
  );
  const deadline = performance.now() + 2000;
  while (!host.submissions().length) {
    if (performance.now() >= deadline) throw new Error('Offline host did not receive the dispatch');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const input = host.submissions()[0];
  const beforeNativeAcceptance = await client.sessions.get(task.initial.sessionId!);
  host.act(input.dispatchId, 'accept');
  host.act(input.dispatchId, 'finish');
  let beforeApproval: string | undefined;
  for await (const event of client.events({ taskId: task.id, signal: AbortSignal.timeout(2000) })) {
    if (event.type !== 'approval.requested') continue;
    const snapshot = await task.get();
    beforeApproval = snapshot.status;
    const approval = await client.approvals.get(snapshot.approvalId!);
    // Deliberately simulated for this offline fixture. A real host must ask its authorized reviewer.
    await client.approvals.decide(
      approval.approvalId,
      {
        choice: 'approve',
        expectedRevision: approval.revision,
      },
      { idempotencyKey: 'simulated-fixture-review' },
    );
    break;
  }
  const completed = await task.wait({ timeoutMs: 2000 });
  console.log(
    JSON.stringify({
      runtime: host.adapter.provider,
      nativeIdWhileQueued: beforeNativeAcceptance.providerSessionId,
      beforeApproval,
      approval: 'simulated-fixture-review',
      status: completed.status,
      dispatches: host.submissions().length,
      executionOccupied: (await client.scheduler.get()).executionOccupied,
    }),
  );
} finally {
  await host.dispose();
  await client.close({ mode: 'interrupt', timeoutMs: 2000 });
  await rm(root, { recursive: true, force: true });
}
