import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator, type Orchestrator } from '../../packages/sdk-typescript/src/index.ts';
import {
  createRouter,
  type Judge,
  type JudgeAnswer,
  type RouteProposal,
} from '../../packages/sdk-typescript/src/routing.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { EngineClock, TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0020: context.checkRefs, and the router that uses it, against a real engine and fake runtimes.

const acceptance = { mode: 'human' as const, criteria: ['Review the result'] };
const WRITE = { provider: 'fake-write', model: 'w-default' };
const READ = { provider: 'fake-read', model: 'r-default' };
const runtimes = { writable: WRITE, readOnly: READ };
const DAY = 86_400_000;
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
const UNKNOWN = `sha256:${'0'.repeat(64)}`;

/** An engine whose wall clock the test can move forward. */
async function engine() {
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now() + offset,
    monotonicNow: () => performance.now(),
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-context-check-')));
  await mkdir(join(dir, 'workspace'));
  const stateDir = join(dir, 'state');
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir,
    adapters: [
      createFakeAdapter({ provider: 'fake-read' }),
      createFakeAdapter({ provider: 'fake-write' }),
    ],
    providers: {
      'fake-read': { models: ['r-default'], permissionProfile: 'read-only' },
      'fake-write': { models: ['w-default'], permissionProfile: 'workspace-write' },
    },
    limits: { maxActiveSessions: 8 },
    storage: { emergencyBytes: 4096 },
    clock,
  });
  return {
    orch,
    /** Moves past the 90-day detail retention and collects until nothing more is collected. */
    async collectAfterRetention() {
      offset += 91 * DAY;
      for (let idle = 0, pass = 0; idle < 2 && pass < 100; pass++) {
        const operation = await orch.storage.collect();
        const records = (operation.initial.result as { records?: number } | null)?.records;
        idle = records === 0 ? idle + 1 : 0;
      }
    },
    /** Deletes a result's file while its record stays. */
    async remove(artifactRef: string) {
      await rm(join(stateDir, 'artifacts', `${artifactRef.slice('sha256:'.length)}.txt`));
    },
    /** Rewrites a result on disk, as damage would. */
    async damage(artifactRef: string) {
      const file = join(stateDir, 'artifacts', `${artifactRef.slice('sha256:'.length)}.txt`);
      await chmod(file, 0o600);
      await writeFile(file, 'damaged on disk');
    },
    async close() {
      await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function waitFor(orch: Orchestrator, id: string, status: string): Promise<TaskSnapshot> {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await orch.tasks.get(id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
async function approve(orch: Orchestrator, id: string): Promise<TaskSnapshot> {
  const task = await waitFor(orch, id, 'waiting_approval');
  const approval = await orch.approvals.get(task.approvalId!);
  await orch.approvals.decide(task.approvalId!, {
    choice: 'approve',
    expectedRevision: approval.revision,
  });
  return waitFor(orch, id, 'completed');
}
const fresh = (contextRefs: string[] = []) => ({
  requestedMode: 'fresh' as const,
  independent: true,
  dependencyTaskIds: [],
  contextRefs: contextRefs.map((artifactRef) => ({ artifactRef, version: 1 as const })),
  fallbackModes: [],
  maxQueueWaitMs: 30_000,
});
async function root(orch: Orchestrator): Promise<TaskSnapshot> {
  return approve(
    orch,
    (await orch.tasks.create({ goal: 'Group root', runtime: WRITE, acceptance })).id,
  );
}
async function child(orch: Orchestrator, rootId: string, goal: string): Promise<TaskSnapshot> {
  const task = await orch.tasks.create({
    goal,
    runtime: READ,
    acceptance,
    parentTaskId: rootId,
    contextPlan: fresh(),
  });
  return approve(orch, task.id);
}
/** A goal whose fake result ("Fake result: " + goal) has exactly `bytes` UTF-8 bytes. */
function goalFor(tag: string, bytes: number, filler: string): string {
  const head = `${tag} `;
  const room = bytes - utf8('Fake result: ') - utf8(head);
  const count = Math.floor(room / utf8(filler));
  return head + filler.repeat(count) + 'x'.repeat(room - count * utf8(filler));
}
async function lastCursor(orch: Orchestrator): Promise<string> {
  let cursor = '0';
  let storeId: string | undefined;
  for (;;) {
    const page = await orch.events.read({
      afterCursor: cursor,
      limit: 256,
      ...(storeId ? { storeId } : {}),
    });
    storeId = page.storeId;
    if (!page.events.length) return cursor;
    cursor = page.cursor;
  }
}
const refsOf = (proposal: RouteProposal) =>
  proposal.spec.contextPlan.contextRefs.map((ref) => ref.artifactRef);
const omitted = (proposal: RouteProposal) =>
  proposal.reasons.filter((reason) => reason.code === 'CONTEXT_OMITTED').map((r) => r.detail);

/** Always starts a fresh session and finds the tagged agents relevant in the given order. */
function judge(relevant: Record<string, number>): Judge {
  return {
    async evaluate(request) {
      const agents =
        (request.state as { agents?: Record<string, { description: string }> }).agents ?? {};
      const answers: Record<string, JudgeAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const alias = id.split('.')[1];
        if (question.type === 'choice') {
          const probabilities = Object.fromEntries(
            Object.keys(question.options).map((option) => [option, option === 'fresh' ? 0.95 : 0]),
          );
          answers[id] = { type: 'choice', choice: 'fresh', probabilities, confidence: 0.95 };
        } else if (question.type === 'yesno') {
          const hit = Object.entries(relevant).find(([tag]) =>
            agents[alias]?.description.includes(tag),
          );
          answers[id] = { type: 'yesno', probability: hit ? hit[1] : 0.1 };
        } else answers[id] = { type: 'score', probabilities: [0.1, 0.8, 0.1], confidence: 0.8 };
      }
      return { answers };
    },
  };
}
const describe = (candidate: { task: TaskSnapshot }) => candidate.task.spec.goal.slice(0, 16);

test('0020-K01 the check agrees with task admission for each kind of reference', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch);
    const old = await child(e.orch, r.id, 'TAG-OLD notes');
    await e.collectAfterRetention();
    const exact = await child(e.orch, r.id, goalFor('TAG-EXACT', 32768, 'e'));
    const over = await child(e.orch, r.id, goalFor('TAG-OVER', 32769, 'o'));
    const wide = await child(e.orch, r.id, goalFor('TAG-WIDE', 32769, '€'));
    const damaged = await child(e.orch, r.id, 'TAG-DAMAGED notes');
    await e.damage(damaged.artifactRefs[0]);
    const cases: [string, Record<string, unknown>][] = [
      [exact.artifactRefs[0], { admissible: true, bytes: 32768 }],
      [over.artifactRefs[0], { admissible: false, code: 'ARTIFACT_TOO_LARGE', bytes: 32769 }],
      [wide.artifactRefs[0], { admissible: false, code: 'ARTIFACT_TOO_LARGE', bytes: 32769 }],
      [
        damaged.artifactRefs[0],
        { admissible: false, code: 'ARTIFACT_CORRUPT', bytes: utf8(damaged.result!) },
      ],
      [
        old.artifactRefs[0],
        { admissible: false, code: 'ARTIFACT_HISTORY_EXPIRED', bytes: utf8(old.result!) },
      ],
      [UNKNOWN, { admissible: false, code: 'NOT_FOUND' }],
    ];
    const checked = await e.orch.context.checkRefs(
      cases.map(([artifactRef]) => ({ artifactRef, version: 1 })),
    );
    assert.deepEqual(
      checked.contextRefs,
      cases.map(([artifactRef, verdict]) => ({ artifactRef, ...verdict })),
    );
    for (const [artifactRef, verdict] of cases) {
      const submit = e.orch.tasks.create({
        goal: 'Use one reference',
        runtime: READ,
        acceptance,
        parentTaskId: r.id,
        contextPlan: fresh([artifactRef]),
      });
      if (verdict.admissible) assert.ok((await submit).id, 'admission accepts it too');
      else await assert.rejects(submit, { code: verdict.code as string });
    }
  } finally {
    await e.close();
  }
});

test('0020-K01 admission and the check report a reference whose file is gone as ARTIFACT_UNREADABLE', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch);
    const gone = await child(e.orch, r.id, 'TAG-GONE notes');
    const ref = gone.artifactRefs[0];
    await e.remove(ref);
    // Before SPEC-0020 admission leaked the raw ENOENT, with the state directory in its message.
    await assert.rejects(
      e.orch.tasks.create({
        goal: 'Use the missing result',
        runtime: READ,
        acceptance,
        parentTaskId: r.id,
        contextPlan: fresh([ref]),
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'ARTIFACT_UNREADABLE' &&
        !String((error as Error).message).includes('state'),
    );
    assert.deepEqual(
      (await e.orch.context.checkRefs([{ artifactRef: ref, version: 1 }])).contextRefs,
      [
        {
          artifactRef: ref,
          admissible: false,
          code: 'ARTIFACT_UNREADABLE',
          bytes: utf8(gone.result!),
        },
      ],
    );
  } finally {
    await e.close();
  }
});

test('0020-K02 the parameters are validated like contextPlan.contextRefs', async () => {
  const e = await engine();
  try {
    const ok = { artifactRef: UNKNOWN, version: 1 as const };
    const cases: [unknown[], string][] = [
      [[], 'VALIDATION_ERROR'],
      [Array.from({ length: 21 }, () => ok), 'VALIDATION_ERROR'],
      [[{ artifactRef: UNKNOWN, version: 2 }], 'UNSUPPORTED_CAPABILITY'],
      [[{ ...ok, extra: true }], 'VALIDATION_ERROR'],
    ];
    for (const [contextRefs, code] of cases)
      await assert.rejects(e.orch.context.checkRefs(contextRefs as never), { code });
    const twenty = await e.orch.context.checkRefs(Array.from({ length: 20 }, () => ok));
    assert.equal(twenty.contextRefs.length, 20);
  } finally {
    await e.close();
  }
});

test('0020-K03 the check records no event and no operation', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch);
    const notes = await child(e.orch, r.id, 'TAG-NOTES notes');
    const cursor = await lastCursor(e.orch);
    const records = (await e.orch.storage.status()).records;
    await e.orch.context.checkRefs([
      { artifactRef: notes.artifactRefs[0], version: 1 },
      { artifactRef: UNKNOWN, version: 1 },
    ]);
    assert.equal(await lastCursor(e.orch), cursor);
    assert.equal((await e.orch.storage.status()).records, records);
    const workflow = e.orch.info.capabilities.workflow as { contextCheck?: boolean } | undefined;
    assert.equal(workflow?.contextCheck, true);
  } finally {
    await e.close();
  }
});

test('0020-K05 the router leaves out collected and damaged results, and the proposal submits', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch);
    const old = await child(e.orch, r.id, 'TAG-OLD notes');
    await e.collectAfterRetention();
    const damaged = await child(e.orch, r.id, 'TAG-DAMAGED notes');
    const kept = await child(e.orch, r.id, 'TAG-KEPT notes');
    await e.damage(damaged.artifactRefs[0]);
    const router = createRouter({
      orchestrator: e.orch,
      judge: judge({ 'TAG-OLD': 0.99, 'TAG-DAMAGED': 0.98, 'TAG-KEPT': 0.97 }),
      runtimes,
      describe,
    });
    const proposal = await router.route({
      goal: 'Summarize the notes',
      acceptance,
      members: [old, damaged, kept].map((task) => task.sessionId!),
      rootTaskId: r.id,
      needsWrites: false,
    });
    assert.deepEqual(refsOf(proposal), [kept.artifactRefs[0]]);
    assert.deepEqual(omitted(proposal), [
      {
        sessionId: old.sessionId,
        artifactRef: old.artifactRefs[0],
        reason: 'expired',
        code: 'ARTIFACT_HISTORY_EXPIRED',
        bytes: utf8(old.result!),
      },
      {
        sessionId: damaged.sessionId,
        artifactRef: damaged.artifactRefs[0],
        reason: 'corrupt',
        code: 'ARTIFACT_CORRUPT',
        bytes: utf8(damaged.result!),
      },
    ]);
    assert.equal(proposal.needsConfirmation, false);
    assert.ok(!proposal.reasons.some((reason) => reason.code === 'CONTEXT_UNCHECKED'));
    const created = await router.submit(proposal);
    const admitted = await waitFor(e.orch, created.id, 'waiting_approval');
    assert.deepEqual(
      admitted.spec.contextPlan?.contextRefs.map((ref) => ref.artifactRef),
      [kept.artifactRefs[0]],
    );
  } finally {
    await e.close();
  }
});

test('0020-K06 without the capability the router keeps checking sizes only and says so', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch);
    const kept = await child(e.orch, r.id, 'TAG-KEPT notes');
    const request = {
      goal: 'Summarize the notes',
      acceptance,
      members: [kept.sessionId!],
      rootTaskId: r.id,
      needsWrites: false,
    };
    const capabilities = e.orch.info.capabilities;
    const legacy = Object.create(e.orch, {
      info: {
        value: { ...e.orch.info, capabilities: { ...capabilities, workflow: { version: 1 } } },
      },
      context: {
        value: {
          checkRefs: () => assert.fail('an engine without the capability is never asked'),
        },
      },
    }) as Orchestrator;
    const proposal = await createRouter({
      orchestrator: legacy,
      judge: judge({ 'TAG-KEPT': 0.9 }),
      runtimes,
      describe,
    }).route(request);
    assert.deepEqual(refsOf(proposal), [kept.artifactRefs[0]]);
    assert.deepEqual(
      proposal.reasons.find((reason) => reason.code === 'CONTEXT_UNCHECKED')?.detail,
      { count: 1 },
    );
    assert.equal(proposal.needsConfirmation, false);

    // With the capability, a failed check fails the route instead of guessing.
    const failing = Object.create(e.orch, {
      context: {
        value: {
          checkRefs: async () => {
            throw Object.assign(new Error('host went away'), { code: 'TRANSPORT_CLOSED' });
          },
        },
      },
    }) as Orchestrator;
    await assert.rejects(
      createRouter({
        orchestrator: failing,
        judge: judge({ 'TAG-KEPT': 0.9 }),
        runtimes,
        describe,
      }).route(request),
      { code: 'TRANSPORT_CLOSED' },
    );
  } finally {
    await e.close();
  }
});
