import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { RuntimeAdapter, RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0044 T: settling a task without waiting forever.

const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
});

async function orchestrator(
  t: any,
  adapters: RuntimeAdapter[],
  extra: Record<string, unknown> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-settle-')));
  await mkdir(join(root, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters,
    storage: { emergencyBytes: 4096 },
    ...extra,
  } as never);
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return orch;
}

/** A runtime that is accepted and then ends with an unknown outcome, which blocks its task. */
function unknownOutcome(): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(): AsyncGenerator<RuntimeEvent> {
      yield { type: 'accepted', providerSessionId: 'native' };
      yield { type: 'error', message: 'the runtime stopped answering', outcome: 'unknown' };
    },
  };
}

test('AC-0044-T01 AC-0044-T02 without a handler, settle returns the pending approval and decides nothing', async (t) => {
  const orch = await orchestrator(t, [createFakeAdapter()]);
  const task = await orch.tasks.create(spec('review me'));
  const settled = await task.settle();
  assert.equal(settled.reason, 'waiting_approval');
  assert.equal(settled.task.status, 'waiting_approval');
  assert.equal(settled.approval?.status, 'pending');
  assert.equal(settled.approval?.approvalId, settled.task.approvalId);
  // Nothing was decided on the caller's behalf.
  assert.equal((await orch.approvals.get(settled.approval!.approvalId)).status, 'pending');
});

test('AC-0044-T02 a handler decides each approval once, and settling goes on', async (t) => {
  const orch = await orchestrator(t, [createFakeAdapter()]);
  const task = await orch.tasks.create(spec('approve me'));
  const seen: string[] = [];
  const settled = await task.settle({
    onApproval: (approval, current) => {
      seen.push(`${approval.approvalId}:${approval.revision}:${current.status}`);
      return 'approve';
    },
  });
  assert.equal(settled.reason, 'terminal');
  assert.equal(settled.task.status, 'completed');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /:waiting_approval$/);
  // A handler with nothing to say ends settling at the approval.
  const second = await orch.tasks.create(spec('undecided'));
  let asked = 0;
  const undecided = await second.settle({ onApproval: () => (asked++, undefined) });
  assert.equal(undecided.reason, 'waiting_approval');
  assert.equal(asked, 1);
});

test('AC-0044-T01 an expired approval pauses the task, and settle returns paused', async (t) => {
  // The approval's lifetime passes on an injected clock: no runner's speed decides whether the
  // first read finds it pending.
  let later = 0;
  const orch = await orchestrator(t, [createFakeAdapter()], {
    approvalTtlMs: 60_000,
    clock: {
      wallNow: () => Date.now() + later,
      monotonicNow: () => performance.now(),
      setTimer(callback: () => void, delayMs: number) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
  });
  const task = await orch.tasks.create(spec('left alone'));
  assert.equal((await task.settle()).reason, 'waiting_approval');
  later = 61_000;
  const settled = await task.settle({ timeoutMs: 5000 });
  assert.equal(settled.reason, 'paused');
  assert.equal(settled.task.status, 'paused');
});

test('AC-0044-T01 a blocked task comes with its session, whose outcome is unknown', async (t) => {
  const orch = await orchestrator(t, [unknownOutcome()]);
  const task = await orch.tasks.create(spec('lost'));
  const settled = await task.settle({ timeoutMs: 5000 });
  assert.equal(settled.reason, 'blocked');
  assert.equal(settled.task.status, 'blocked');
  assert.equal(settled.session?.id, settled.task.sessionId);
  assert.equal(settled.session?.status, 'outcome_unknown');
});

test('AC-0044-T03 a timeout raises TIMEOUT and leaves the task running', async (t) => {
  const orch = await orchestrator(t, [createFakeAdapter({ delayMs: 60_000 })]);
  const task = await orch.tasks.create(spec('slow'));
  await assert.rejects(task.settle({ timeoutMs: 100 }), { code: 'TIMEOUT' });
  assert.notEqual((await task.get()).status, 'cancelled');
});
