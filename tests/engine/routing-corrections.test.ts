import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator, type Orchestrator } from '../../packages/sdk-typescript/src/index.ts';
import {
  createJevJudge,
  createRouter,
  type Judge,
  type JudgeAnswer,
  type JudgeError,
  type JudgeQuestion,
  type JudgeRequest,
  type RouteProposal,
} from '../../packages/sdk-typescript/src/routing.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { EngineClock, TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0019 corrections to the SPEC-0018 routing layer, against a real engine and fake runtimes.

const acceptance = { mode: 'human' as const, criteria: ['Review the result'] };
const WRITE = { provider: 'fake-write', model: 'w-default' };
const READ = { provider: 'fake-read', model: 'r-default' };
const runtimes = { writable: WRITE, readOnly: READ };
const DAY = 86_400_000;
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

async function engine(options: { allowCrossRootReuse?: boolean; clock?: EngineClock } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-routing-fix-')));
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
    ...(options.allowCrossRootReuse ? { allowCrossRootReuse: true } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return {
    orch,
    stateDir,
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
/** A root task; `done: false` leaves it awaiting approval, so its session can receive messages. */
async function root(orch: Orchestrator, goal: string, done = true): Promise<TaskSnapshot> {
  const task = await orch.tasks.create({ goal, runtime: WRITE, acceptance });
  return done ? approve(orch, task.id) : waitFor(orch, task.id, 'waiting_approval');
}
async function child(
  orch: Orchestrator,
  rootId: string,
  goal: string,
  runtime = WRITE,
  done = true,
): Promise<TaskSnapshot> {
  const task = await orch.tasks.create({
    goal,
    runtime,
    acceptance,
    parentTaskId: rootId,
    contextPlan: {
      requestedMode: 'fresh',
      independent: true,
      dependencyTaskIds: [],
      contextRefs: [],
      fallbackModes: [],
      maxQueueWaitMs: 30_000,
    },
  });
  return done ? approve(orch, task.id) : waitFor(orch, task.id, 'waiting_approval');
}
async function countTasks(orch: Orchestrator): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await orch.tasks.list({ limit: 100, ...(cursor ? { afterCursor: cursor } : {}) });
    count += page.tasks.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return count;
}
async function messageEvents(orch: Orchestrator, taskId: string): Promise<string[]> {
  const page = await orch.events.read({ taskId, limit: 256 });
  return page.events.filter((event) => event.type.startsWith('message.')).map((e) => e.type);
}
const codes = (proposal: RouteProposal) => proposal.reasons.map((reason) => reason.code);
const refs = (proposal: RouteProposal) =>
  proposal.spec.contextPlan.contextRefs.map((ref) => ref.artifactRef);

/**
 * Group A under one root: an idle writable auth agent, a busy writable payments agent awaiting
 * approval and an idle read-only reviewer. Root B is another group whose root task awaits
 * approval, so its session could receive a message.
 */
async function groups(options: { allowCrossRootReuse?: boolean } = {}) {
  const e = await engine(options);
  const rootA = await root(e.orch, 'Group A root for the payments product');
  const auth = await child(e.orch, rootA.id, 'Refactor login to OAuth2 in src/auth');
  const payments = await child(
    e.orch,
    rootA.id,
    'Fix refund rounding in src/payments',
    WRITE,
    false,
  );
  const review = await child(
    e.orch,
    rootA.id,
    'Security review: the refund endpoint lacks a rate limit',
    READ,
  );
  const rootB = await root(e.orch, 'Group B root for the marketing site', false);
  return {
    ...e,
    rootA,
    rootB,
    auth,
    payments,
    review,
    members: [auth.sessionId, payments.sessionId, review.sessionId],
  };
}

interface Script {
  /** Keyword in an agent's description, or `fresh`, to the judge's own probability. */
  best?: Record<string, number>;
  /** The judge's confidence in its choice; by default the chosen option's probability. */
  confidence?: number;
  relevant?: Record<string, number>;
  clash?: Record<string, number>;
  depends?: Record<string, [number, number, number]>;
  affects?: Record<string, number>;
  writes?: number;
}
/** A judge that answers from keywords in the descriptions it is shown, without normalizing. */
function judged(script: Script): Judge & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    async evaluate(request) {
      requests.push(request);
      const agents =
        (request.state as { agents?: Record<string, { description: string }> }).agents ?? {};
      const lookup = <T>(map: Record<string, T> | undefined, alias: string): T | undefined => {
        for (const [keyword, value] of Object.entries(map ?? {}))
          if (agents[alias]?.description.includes(keyword)) return value;
        return undefined;
      };
      const answers: Record<string, JudgeAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const [kind, alias] = id.split('.');
        if (question.type === 'choice') {
          const probabilities = Object.fromEntries(
            Object.keys(question.options).map((option) => [
              option,
              option === 'fresh' ? (script.best?.fresh ?? 0) : (lookup(script.best, option) ?? 0),
            ]),
          );
          const [choice, top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
          answers[id] = {
            type: 'choice',
            choice,
            probabilities,
            confidence: script.confidence ?? top,
          };
        } else if (question.type === 'yesno') {
          const map =
            kind === 'relevant'
              ? script.relevant
              : kind === 'clash'
                ? script.clash
                : script.affects;
          answers[id] = {
            type: 'yesno',
            probability: kind === 'writes' ? (script.writes ?? 0.9) : (lookup(map, alias) ?? 0.1),
          };
        } else {
          const levels = kind === 'depends' ? (lookup(script.depends, alias) ?? [0.9, 0.1, 0]) : [];
          const probabilities = levels.length ? [...levels] : [0.1, 0.8, 0.1];
          answers[id] = {
            type: 'score',
            probabilities,
            confidence: Math.max(...probabilities),
          };
        }
      }
      return { answers, model: 'scripted' };
    },
  };
}

test('0019-C01 a low judge confidence requires confirmation although its choice is probable', async () => {
  const g = await groups();
  try {
    const router = createRouter({
      orchestrator: g.orch,
      judge: judged({
        best: { OAuth2: 0.95, fresh: 0.05 },
        confidence: 0.2,
        relevant: { OAuth2: 0.9 },
      }),
      runtimes,
    });
    const proposal = await router.route({
      goal: 'Log every token refresh in the login flow',
      acceptance,
      members: g.members,
      rootTaskId: g.rootA.id,
      needsWrites: true,
    });
    assert.deepEqual(proposal.decision, { mode: 'reuse', sessionId: g.auth.sessionId });
    assert.equal(proposal.needsConfirmation, true, 'the judge reported that it is unsure');
    assert.ok(codes(proposal).includes('LOW_CONFIDENCE'));
    assert.equal(proposal.confidence, 0.2);
    assert.equal(proposal.judgeConfidence, 0.2);
    assert.equal(proposal.alternatives[0].option, g.auth.sessionId);
    assert.equal(proposal.alternatives[0].judgeProbability, 0.95);
    // Confirmation stays the host's decision: submit does not refuse the proposal.
    const task = await router.submit(proposal);
    assert.equal(task.initial.sessionId, g.auth.sessionId);
  } finally {
    await g.close();
  }
});

test('0019-C01 dropping read-only candidates never raises the confidence of what remains', async () => {
  const g = await groups();
  try {
    const route = (script: Script) =>
      createRouter({ orchestrator: g.orch, judge: judged(script), runtimes }).route({
        goal: 'Add a rate limit to the refund endpoint',
        acceptance,
        members: g.members,
        rootTaskId: g.rootA.id,
        needsWrites: true,
      });
    // The judge prefers the read-only reviewer, which cannot take work that writes.
    const filtered = await route({
      best: { 'rate limit': 0.5, OAuth2: 0.45, fresh: 0.05 },
      confidence: 0.9,
      relevant: { 'rate limit': 0.9, OAuth2: 0.8 },
    });
    assert.deepEqual(filtered.decision, { mode: 'reuse', sessionId: g.auth.sessionId });
    assert.equal(filtered.needsConfirmation, true, 'the judge gave the proposed agent 0.45');
    assert.ok(codes(filtered).includes('LOW_CONFIDENCE'));
    assert.equal(filtered.confidence, 0.45);
    const [top] = filtered.alternatives;
    assert.equal(top.option, g.auth.sessionId);
    assert.equal(top.judgeProbability, 0.45);
    assert.ok(Math.abs(top.probability - 0.45 / 0.5) < 1e-9, 'the share among eligible options');
    assert.ok(!filtered.alternatives.some((entry) => entry.option === g.review.sessionId));

    // Renormalizing 0.8 over the eligible options gives 0.94; the judge still said 0.8.
    const lifted = await route({
      best: { OAuth2: 0.8, 'rate limit': 0.15, fresh: 0.05 },
      confidence: 0.9,
      relevant: { OAuth2: 0.9 },
    });
    assert.deepEqual(lifted.decision, { mode: 'reuse', sessionId: g.auth.sessionId });
    assert.equal(lifted.needsConfirmation, true);
    assert.equal(lifted.confidence, 0.8);
    assert.ok(lifted.alternatives[0].probability > 0.85);
  } finally {
    await g.close();
  }
});

test('0019-C01 the confirmation threshold applies to every branch that asked for a best agent', async () => {
  const g = await groups();
  try {
    const route = (script: Script, members = g.members) =>
      createRouter({ orchestrator: g.orch, judge: judged(script), runtimes }).route({
        goal: 'Work item',
        acceptance,
        members,
        rootTaskId: g.rootA.id,
        needsWrites: true,
      });
    const at = await route({
      best: { OAuth2: 0.85, fresh: 0.15 },
      confidence: 0.85,
      relevant: { OAuth2: 0.9 },
    });
    assert.equal(at.needsConfirmation, false, 'exactly at the threshold is confident');
    assert.equal(at.confidence, 0.85);
    const unsure = await route({
      best: { OAuth2: 0.85, fresh: 0.15 },
      confidence: 0.849,
      relevant: { OAuth2: 0.9 },
    });
    assert.equal(unsure.needsConfirmation, true, 'a judge confidence just below the threshold');
    const improbable = await route({
      best: { OAuth2: 0.849, fresh: 0.151 },
      confidence: 0.9,
      relevant: { OAuth2: 0.9 },
    });
    assert.equal(improbable.needsConfirmation, true, 'a probability just below the threshold');

    const fresh = await route({ best: { fresh: 0.9, OAuth2: 0.1 }, confidence: 0.5 });
    assert.deepEqual(fresh.decision, { mode: 'fresh' });
    assert.ok(codes(fresh).includes('FRESH_CHOSEN'));
    assert.equal(fresh.needsConfirmation, true, 'fresh chosen with low judge confidence');

    const unrelated = await route({ best: { OAuth2: 0.9, fresh: 0.1 }, confidence: 0.4 });
    assert.ok(codes(unrelated).includes('NO_RELEVANT_AGENT'));
    assert.equal(unrelated.needsConfirmation, true, 'no relevant agent, but the judge was unsure');

    const empty = await route({}, []);
    assert.deepEqual(empty.decision, { mode: 'fresh' });
    assert.equal(empty.confidence, 1);
    assert.equal(empty.judgeConfidence, null);
    assert.equal(empty.needsConfirmation, false, 'no candidates: nothing to be unsure about');
  } finally {
    await g.close();
  }
});

test('0019-C02 notifications stay in the source root and refuse another group before the judge', async () => {
  const g = await groups();
  try {
    const judge = judged({ affects: { rounding: 0.9, marketing: 0.99 } });
    const router = createRouter({ orchestrator: g.orch, judge, runtimes });
    await assert.rejects(
      router.notifications({
        text: 'Refunds are now rounded half-even.',
        fromSessionId: g.auth.sessionId,
        members: [g.auth.sessionId, g.rootB.sessionId],
        rootTaskId: g.rootB.id,
      }),
      { code: 'ROUTING_ROOT_MISMATCH' },
    );
    await assert.rejects(
      router.notifications({
        text: 'Refunds are now rounded half-even.',
        fromSessionId: g.auth.sessionId,
        members: [g.payments.sessionId, g.review.sessionId],
        rootTaskId: g.rootA.id,
      }),
      { code: 'ROUTING_SOURCE_NOT_MEMBER' },
    );
    assert.equal(judge.requests.length, 0, 'a refused finding is never shown to the judge');
    assert.deepEqual(await messageEvents(g.orch, g.rootB.id), []);

    // Without a declared root the source's own root is the group, and root B's member is ignored.
    for (const rootTaskId of [undefined, g.rootA.id]) {
      const plan = await router.notifications({
        text: 'Refunds are now rounded half-even.',
        fromSessionId: g.auth.sessionId,
        members: [g.auth.sessionId, g.payments.sessionId, g.rootB.sessionId],
        ...(rootTaskId ? { rootTaskId } : {}),
      });
      assert.deepEqual(
        plan.notify.map((target) => target.sessionId),
        [g.payments.sessionId],
      );
    }
    assert.ok(!JSON.stringify(judge.requests).includes('marketing'));
    const plan = await router.notifications({
      text: 'Refunds are now rounded half-even.',
      fromSessionId: g.auth.sessionId,
      members: g.members,
    });
    const sent = await router.notify(plan);
    assert.deepEqual(
      sent.map((message) => [message.toSessionId, message.taskId, message.status]),
      [[g.payments.sessionId, g.payments.id, 'persisted']],
    );
    assert.deepEqual(await messageEvents(g.orch, g.rootB.id), []);
  } finally {
    await g.close();
  }
});

test('0019-C02 engine scope still notifies members of other roots and needs a member source', async () => {
  const g = await groups({ allowCrossRootReuse: true });
  try {
    const judge = judged({ affects: { marketing: 0.9 } });
    const router = createRouter({ orchestrator: g.orch, judge, runtimes, scope: 'engine' });
    const plan = await router.notifications({
      text: 'The login page now links to the marketing site.',
      fromSessionId: g.auth.sessionId,
      members: [g.auth.sessionId, g.rootB.sessionId],
    });
    assert.deepEqual(
      plan.notify.map((target) => target.sessionId),
      [g.rootB.sessionId],
    );
    const [message] = await router.notify(plan);
    assert.deepEqual(
      [message.toSessionId, message.taskId, message.kind, message.status],
      [g.rootB.sessionId, g.rootB.id, 'finding', 'persisted'],
    );
    const asked = judge.requests.length;
    await assert.rejects(
      router.notifications({
        text: 'The login page now links to the marketing site.',
        fromSessionId: g.auth.sessionId,
        members: [g.rootB.sessionId],
      }),
      { code: 'ROUTING_SOURCE_NOT_MEMBER' },
    );
    assert.equal(judge.requests.length, asked);
  } finally {
    await g.close();
  }
});

/** A goal whose fake result ("Fake result: " + goal) has exactly `bytes` UTF-8 bytes. */
function goalFor(tag: string, bytes: number, filler: string): string {
  const head = `${tag} `;
  const room = bytes - utf8('Fake result: ') - utf8(head);
  const count = Math.floor(room / utf8(filler));
  return head + filler.repeat(count) + 'x'.repeat(room - count * utf8(filler));
}
const describe = (candidate: { task: TaskSnapshot }) => candidate.task.spec.goal.slice(0, 16);

test('0019-C03 results over the 32 KiB inline limit are left out with a reason and the rest submit', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch, 'Group root for context references');
    const make = (tag: string, bytes: number, filler: string) =>
      child(e.orch, r.id, goalFor(tag, bytes, filler), READ);
    const small = await make('TAG-SMALL', 200, 's');
    const exact = await make('TAG-EXACT', 32768, 'e');
    const over = await make('TAG-OVER', 32769, 'o');
    const wideExact = await make('TAG-WEXACT', 32768, '€');
    const wideOver = await make('TAG-WOVER', 32769, '€');
    for (const [task, bytes] of [
      [small, 200],
      [exact, 32768],
      [over, 32769],
      [wideExact, 32768],
      [wideOver, 32769],
    ] as const)
      assert.equal(
        utf8(task.result!),
        bytes,
        'precondition: the fake result has the intended size',
      );
    assert.ok(wideOver.result!.length < 32768, 'precondition: fewer characters than bytes');
    const members = [over, small, wideOver, exact, wideExact].map((task) => task.sessionId);
    const route = (maxContextRefs?: number) =>
      createRouter({
        orchestrator: e.orch,
        judge: judged({
          best: { fresh: 0.95 },
          relevant: {
            'TAG-OVER': 0.99,
            'TAG-SMALL': 0.98,
            'TAG-WOVER': 0.97,
            'TAG-EXACT': 0.96,
            'TAG-WEXACT': 0.95,
          },
        }),
        runtimes,
        describe,
        ...(maxContextRefs ? { policy: { maxContextRefs } } : {}),
      }).route({
        goal: 'Summarize every report',
        acceptance,
        members,
        rootTaskId: r.id,
        needsWrites: false,
      });

    const proposal = await route();
    assert.deepEqual(proposal.decision, { mode: 'fresh' });
    assert.deepEqual(refs(proposal), [
      small.artifactRefs[0],
      exact.artifactRefs[0],
      wideExact.artifactRefs[0],
    ]);
    assert.deepEqual(
      proposal.reasons.filter((reason) => reason.code === 'CONTEXT_OMITTED').map((r) => r.detail),
      [over, wideOver].map((task) => ({
        sessionId: task.sessionId,
        artifactRef: task.artifactRefs[0],
        reason: 'too_large',
        bytes: 32769,
        maxBytes: 32768,
      })),
    );
    assert.equal(proposal.needsConfirmation, false);
    const created = await createRouter({
      orchestrator: e.orch,
      judge: judged({}),
      runtimes,
    }).submit(proposal);
    const admitted = await waitFor(e.orch, created.id, 'waiting_approval');
    assert.deepEqual(
      admitted.spec.contextPlan?.contextRefs.map((ref) => ref.artifactRef),
      refs(proposal),
    );

    // A result left out does not take one of the capped places.
    const capped = await route(2);
    assert.deepEqual(refs(capped), [small.artifactRefs[0], exact.artifactRefs[0]]);
    assert.equal(codes(capped).filter((code) => code === 'CONTEXT_OMITTED').length, 2);
  } finally {
    await e.close();
  }
});

test('0019-C03 a busy agent whose own result is too large still yields a submittable fresh plan', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch, 'Group root for context references');
    const notes = await child(e.orch, r.id, 'TAG-NOTES short notes', READ);
    const busy = await child(e.orch, r.id, goalFor('TAG-BUSY', 40000, 'b'), WRITE, false);
    const router = createRouter({
      orchestrator: e.orch,
      judge: judged({
        best: { 'TAG-BUSY': 0.95, fresh: 0.05 },
        relevant: { 'TAG-BUSY': 0.9, 'TAG-NOTES': 0.9 },
        clash: { 'TAG-BUSY': 0.1 },
        depends: { 'TAG-BUSY': [0.9, 0.1, 0] },
      }),
      runtimes,
      describe,
    });
    const proposal = await router.route({
      goal: 'Add a CSV export',
      acceptance,
      members: [busy.sessionId, notes.sessionId],
      rootTaskId: r.id,
      needsWrites: true,
    });
    assert.ok(codes(proposal).includes('BUSY_PARALLEL'));
    assert.deepEqual(refs(proposal), [notes.artifactRefs[0]]);
    assert.deepEqual(proposal.reasons.find((reason) => reason.code === 'CONTEXT_OMITTED')?.detail, {
      sessionId: busy.sessionId,
      artifactRef: busy.artifactRefs[0],
      reason: 'too_large',
      bytes: 40000,
      maxBytes: 32768,
    });
    const created = await router.submit(proposal);
    assert.equal(
      (await waitFor(e.orch, created.id, 'waiting_approval')).status,
      'waiting_approval',
    );
  } finally {
    await e.close();
  }
});

test('0019-C03 a result that becomes unreadable after routing fails the submission explicitly', async () => {
  const e = await engine();
  try {
    const r = await root(e.orch, 'Group root for context references');
    const kept = await child(e.orch, r.id, 'TAG-KEPT notes', READ);
    const broken = await child(e.orch, r.id, 'TAG-BROKEN notes', READ);
    const router = createRouter({
      orchestrator: e.orch,
      judge: judged({ best: { fresh: 0.95 }, relevant: { 'TAG-KEPT': 0.9, 'TAG-BROKEN': 0.8 } }),
      runtimes,
    });
    const proposal = await router.route({
      goal: 'Summarize the notes',
      acceptance,
      members: [kept.sessionId, broken.sessionId],
      rootTaskId: r.id,
      needsWrites: false,
    });
    assert.deepEqual(refs(proposal), [kept.artifactRefs[0], broken.artifactRefs[0]]);
    const file = join(
      e.stateDir,
      'artifacts',
      `${broken.artifactRefs[0].slice('sha256:'.length)}.txt`,
    );
    await chmod(file, 0o600);
    await writeFile(file, 'damaged on disk after the proposal');
    const before = await countTasks(e.orch);
    await assert.rejects(router.submit(proposal), { code: 'ARTIFACT_CORRUPT' });
    assert.equal(await countTasks(e.orch), before, 'nothing was created');
  } finally {
    await e.close();
  }
});

test('0019-C03 a result collected after routing fails the submission explicitly', async () => {
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now() + offset,
    monotonicNow: () => performance.now(),
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const e = await engine({ clock });
  try {
    const r = await root(e.orch, 'Group root for context references');
    const notes = await child(e.orch, r.id, 'TAG-NOTES short notes', READ);
    const router = createRouter({
      orchestrator: e.orch,
      judge: judged({ best: { fresh: 0.95 }, relevant: { 'TAG-NOTES': 0.9 } }),
      runtimes,
    });
    const proposal = await router.route({
      goal: 'Summarize the notes',
      acceptance,
      members: [notes.sessionId],
      rootTaskId: r.id,
      needsWrites: false,
    });
    assert.deepEqual(refs(proposal), [notes.artifactRefs[0]]);
    // The minimum detail retention is 90 days after the task ended; then the owner collects.
    // Collection runs in time-bounded batches, so it repeats until two passes find nothing.
    offset = 91 * DAY;
    for (let idle = 0, pass = 0; idle < 2 && pass < 100; pass++) {
      const records = ((await e.orch.storage.collect()).initial.result as { records?: number })
        ?.records;
      idle = records === 0 ? idle + 1 : 0;
    }
    const before = await countTasks(e.orch);
    await assert.rejects(router.submit(proposal), { code: 'ARTIFACT_HISTORY_EXPIRED' });
    assert.equal(await countTasks(e.orch), before, 'nothing was created');
  } finally {
    await e.close();
  }
});

const questions: Record<string, JudgeQuestion> = {
  w: { type: 'yesno', instructions: 'Writes?' },
};
const answer = JSON.stringify({ model: 'jev-1.13.0', answers: { w: { type: 'noul', noul: 0.9 } } });

/**
 * Plain HTTP server; `slowBody` sends the body five bytes at a time. A request counts once its body
 * has been read. `delayMs` holds each request back before that, as a slow machine does; a client that
 * gives up meanwhile is never counted.
 */
async function jevServer(reply: { status: number; slowBody?: boolean; delayMs?: number }) {
  const requests: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    try {
      for await (const _chunk of req);
    } catch {
      return; // The client went away before its request was read.
    }
    requests.push(req.url ?? '');
    const body = reply.status === 200 ? answer : '{}';
    res.writeHead(reply.status, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    if (!reply.slowBody) return res.end(body);
    res.flushHeaders();
    for (let i = 0; i < body.length && !res.destroyed; i += 5) {
      res.write(body.slice(i, i + 5));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
/** Raw TCP server that sends the status line and headers one byte every 20 ms. */
async function slowHeaders() {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', async () => {
      const head = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${answer.length}\r\n\r\n`;
      for (const byte of head) {
        if (socket.destroyed) return;
        socket.write(byte);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      socket.end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
const timedOut = (error: unknown) => (error as JudgeError).code === 'JUDGE_TIMEOUT';
/**
 * Waits past the moment the single retry would have been sent after a 503 (the 200 ms pause), then
 * checks that it was not. The first request may count or not: on a slow machine the 50 ms deadline
 * can pass before the server reads it, and the elapsed bound alone shows the pause was not awaited.
 */
/**
 * Whether a 200 ms timer, the Jev judge's retry pause, ran to its end while `evaluate` ran. It
 * replaces a bound on elapsed time, which a loaded runner overshot (docs/ci-flakes.md, SPEC-0046).
 */
async function retryPauseFired(evaluate: () => Promise<unknown>): Promise<boolean> {
  const real = globalThis.setTimeout;
  let fired = false;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) =>
    real(
      (...args: unknown[]) => {
        if (ms === 200) fired = true;
        callback(...args);
      },
      ms,
      ...rest,
    )) as typeof setTimeout;
  try {
    await evaluate();
  } finally {
    globalThis.setTimeout = real;
  }
  return fired;
}
async function noRetry(server: { requests: string[] }, started: number) {
  const settle = started + 400 - performance.now();
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
  assert.ok(server.requests.length <= 1, `the judge retried: ${server.requests.length} requests`);
}

test('0019-C04 the Jev judge waits for its retry only while its deadline lasts', async () => {
  const server = await jevServer({ status: 503 });
  try {
    const started = performance.now();
    const fired = await retryPauseFired(() =>
      assert.rejects(
        createJevJudge({ apiKey: 'synthetic', baseUrl: server.baseUrl, timeoutMs: 50 }).evaluate({
          state: {},
          questions,
        }),
        timedOut,
      ),
    );
    assert.equal(fired, false, 'the 200 ms retry pause outlived a 50 ms deadline');
    await noRetry(server, started);
  } finally {
    await server.close();
  }
});

test('0019-C04 the Jev judge keeps its deadline when the server is slower than the deadline', async () => {
  // A slow machine delays the local server past the 50 ms deadline (CI run 35866873671).
  const server = await jevServer({ status: 503, delayMs: 100 });
  try {
    const started = performance.now();
    const fired = await retryPauseFired(() =>
      assert.rejects(
        createJevJudge({ apiKey: 'synthetic', baseUrl: server.baseUrl, timeoutMs: 50 }).evaluate({
          state: {},
          questions,
        }),
        timedOut,
      ),
    );
    assert.equal(fired, false, 'the 200 ms retry pause outlived a 50 ms deadline');
    await noRetry(server, started);
  } finally {
    await server.close();
  }
});

test('0019-C04 a caller abort while the Jev body arrives surfaces as that abort', async () => {
  const server = await jevServer({ status: 200, slowBody: true });
  try {
    const controller = new AbortController();
    const reason = new Error('the caller stopped routing');
    setTimeout(() => controller.abort(reason), 60);
    await assert.rejects(
      createJevJudge({ apiKey: 'synthetic', baseUrl: server.baseUrl, timeoutMs: 5000 }).evaluate({
        state: {},
        questions,
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  } finally {
    await server.close();
  }
});

test('0019-C04 the Jev deadline covers slow headers and a slow body', async () => {
  const headers = await slowHeaders();
  try {
    const started = performance.now();
    await assert.rejects(
      createJevJudge({ apiKey: 'synthetic', baseUrl: headers.baseUrl, timeoutMs: 100 }).evaluate({
        state: {},
        questions,
      }),
      timedOut,
    );
    assert.ok(performance.now() - started < 600);
  } finally {
    await headers.close();
  }
  const body = await jevServer({ status: 200, slowBody: true });
  try {
    const started = performance.now();
    await assert.rejects(
      createJevJudge({ apiKey: 'synthetic', baseUrl: body.baseUrl, timeoutMs: 100 }).evaluate({
        state: {},
        questions,
      }),
      timedOut,
    );
    assert.ok(performance.now() - started < 600);
    const result = await createJevJudge({
      apiKey: 'synthetic',
      baseUrl: body.baseUrl,
      timeoutMs: 5000,
    }).evaluate({ state: {}, questions });
    assert.deepEqual(result.answers, { w: { type: 'yesno', probability: 0.9 } });
  } finally {
    await body.close();
  }
});
