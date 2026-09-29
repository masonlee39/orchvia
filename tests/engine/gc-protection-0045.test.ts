import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
import type { EngineClock } from '../../packages/engine/src/types.ts';

// SPEC-0045 G01: a reused session no longer keeps its earlier tasks from being collected.

const DAY = 86_400_000;
const runtime = { provider: 'fake', model: 'fake-model' };
const acceptance = { mode: 'human' as const, criteria: ['Review'] };

async function setup(t: any) {
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now() + offset,
    monotonicNow: () => performance.now(),
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-gc-protection-')));
  await mkdir(join(dir, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { model: 'fake-model' } },
    allowCrossRootReuse: true,
    storage: { emergencyBytes: 4096 },
    clock,
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return {
    orch,
    later: (days: number) => (offset += days * DAY),
    async collect() {
      let floor = '0';
      for (let idle = 0, pass = 0; idle < 2 && pass < 100; pass++) {
        const operation = await orch.storage.collect();
        const result = operation.initial.result as {
          records?: number;
          retentionFloorCursor?: string;
        } | null;
        floor = result?.retentionFloorCursor ?? floor;
        idle = result?.records === 0 ? idle + 1 : 0;
      }
      return Number(floor);
    },
  };
}

/** The first task ends; 91 days later a second one runs, reusing its session or not. */
async function scenario(t: any, reuse: boolean) {
  const g = await setup(t);
  const first = await g.orch.tasks.create({ goal: 'first', runtime, acceptance });
  const done = (await first.settle({ onApproval: () => 'approve', timeoutMs: 5000 })).task;
  let lastCursor = 0;
  for await (const event of g.orch.events({ taskId: done.id, signal: AbortSignal.timeout(500) })) {
    lastCursor = Number(event.cursor);
    if (event.type === 'task.completed') break;
  }
  g.later(91);
  const second = await g.orch.tasks.create({
    goal: 'second',
    runtime,
    acceptance,
    ...(reuse
      ? {
          contextPlan: {
            requestedMode: 'reuse' as const,
            independent: true,
            candidateSessionId: done.sessionId,
          },
        }
      : {}),
  });
  // The second task waits for its acceptance, so it stays active.
  assert.equal((await second.settle({ timeoutMs: 5000 })).reason, 'waiting_approval');
  if (reuse) assert.equal((await second.get()).sessionId, done.sessionId);
  const floor = await g.collect();
  const {
    contextRefs: [ref],
  } = await g.orch.context.checkRefs([{ artifactRef: done.artifactRefs[0]!, version: 1 }]);
  return { floor, lastCursor, artifact: ref!.code ?? 'admissible' };
}

test('AC-0045-G01 with a fresh second session the first task is collected', async (t) => {
  const r = await scenario(t, false);
  assert.ok(r.floor >= r.lastCursor, `floor ${r.floor} covers the first task's ${r.lastCursor}`);
  assert.equal(r.artifact, 'ARTIFACT_HISTORY_EXPIRED');
});

test("AC-0045-G01 a second task on the first task's session no longer keeps it from collection", async (t) => {
  const r = await scenario(t, true);
  assert.ok(r.floor >= r.lastCursor, `floor ${r.floor} covers the first task's ${r.lastCursor}`);
  assert.equal(r.artifact, 'ARTIFACT_HISTORY_EXPIRED');
});

test('AC-0045-G01 a session still protects what it references besides its tasks', () => {
  const base = mkdtempSync(join(tmpdir(), 'orch-gc-session-'));
  const workspace = join(base, 'workspace'),
    stateDir = join(base, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const store = new Store(workspace, stateDir, {});
  const governance = new StorageGovernance(store, { emergencyBytes: 4096 });
  try {
    const result = store.artifact("the first task's result");
    const checkpoint = store.artifact("the session's checkpoint");
    store.transaction(() => {
      store.put('tasks', 'first', {
        id: 'first',
        status: 'completed',
        sessionId: 'shared',
        artifactRefs: [result],
      });
      store.put('sessions', 'shared', {
        id: 'shared',
        status: 'idle',
        taskId: 'second',
        taskIds: ['first', 'second'],
        snapshotRef: checkpoint,
      });
      store.put('tasks', 'second', { id: 'second', status: 'running', sessionId: 'shared' });
      // The first task and both files are past every retention period.
      store.db
        .prepare(
          "UPDATE retention_records SET terminal_at=0 WHERE id IN (?,?,?) AND table_name IN ('tasks','artifacts')",
        )
        .run('first', result, checkpoint);
    });
    for (let pass = 0; pass < 10; pass++) governance.collect();
    const expired = (ref: string) =>
      !!store.get<{ historyExpired?: boolean }>('artifacts', ref)?.historyExpired;
    assert.equal(expired(result), true, 'the first task no longer inherits protection');
    assert.equal(expired(checkpoint), false, "the session's checkpoint stays protected");
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});
