import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createOrchestrator, type Orchestrator } from '../../packages/sdk-typescript/src/index.ts';
import {
  createJevJudge,
  createRouter,
  JudgeError,
  type Judge,
  type JudgeAnswer,
  type JudgeRequest,
  type RouteProposal,
} from '../../packages/sdk-typescript/src/routing.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { MessageSnapshot, TaskSnapshot } from '../../packages/engine/src/types.ts';

const acceptance = { mode: 'human' as const, criteria: ['Review the result'] };
const WRITE = { provider: 'fake-write', model: 'w-default' };
const READ = { provider: 'fake-read', model: 'r-default' };
const runtimes = {
  writable: { provider: 'fake-write', model: 'w-default', small: 'w-small', large: 'w-large' },
  readOnly: { provider: 'fake-read', model: 'r-default', small: 'r-small', large: 'r-large' },
};

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

/**
 * One group under a root task: an idle writable auth agent, a busy writable payments agent whose
 * task awaits approval, and an idle read-only reviewer. `other` belongs to another root task.
 */
async function setup(options: { allowCrossRootReuse?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-routing-')));
  await mkdir(join(dir, 'workspace', 'app'), { recursive: true });
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [
      createFakeAdapter({ provider: 'fake-read' }),
      createFakeAdapter({ provider: 'fake-write' }),
    ],
    providers: {
      'fake-read': { models: ['r-small', 'r-default', 'r-large'], permissionProfile: 'read-only' },
      'fake-write': {
        models: ['w-small', 'w-default', 'w-large'],
        permissionProfile: 'workspace-write',
      },
    },
    limits: { maxActiveSessions: 8 },
    writeScopes: { app: ['app'] },
    storage: { emergencyBytes: 4096 },
    ...(options.allowCrossRootReuse ? { allowCrossRootReuse: true } : {}),
  });
  const root = await orch.tasks.create({
    goal: 'Group root for the payments product',
    runtime: WRITE,
    acceptance,
  });
  await approve(orch, root.id);
  const child = (goal: string, runtime: { provider: string; model: string }) =>
    orch.tasks.create({
      goal,
      runtime,
      acceptance,
      parentTaskId: root.id,
      contextPlan: {
        requestedMode: 'fresh',
        independent: true,
        dependencyTaskIds: [],
        contextRefs: [],
        fallbackModes: [],
        maxQueueWaitMs: 30_000,
      },
    });
  const auth = await child('Refactor login to OAuth2 in src/auth', WRITE);
  await approve(orch, auth.id);
  const payments = await child('Fix refund rounding in src/payments', WRITE);
  await waitFor(orch, payments.id, 'waiting_approval');
  const review = await child('Security review: the refund endpoint lacks a rate limit', READ);
  await approve(orch, review.id);
  const other = await orch.tasks.create({
    goal: 'Unrelated marketing site copy',
    runtime: WRITE,
    acceptance,
  });
  await approve(orch, other.id);
  const session = async (id: string) => (await orch.tasks.get(id)).sessionId!;
  const ids = {
    root: root.id,
    auth: await session(auth.id),
    payments: await session(payments.id),
    review: await session(review.id),
    other: await session(other.id),
    authTask: auth.id,
    paymentsTask: payments.id,
    reviewTask: review.id,
  };
  return {
    orch,
    ids,
    members: [ids.auth, ids.payments, ids.review],
    async close() {
      await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

interface Script {
  /** Keyword in an agent's description, or `fresh`, to its probability. */
  best?: Record<string, number>;
  relevant?: Record<string, number>;
  writes?: number;
  size?: [number, number, number];
  depends?: Record<string, [number, number, number]>;
  clash?: Record<string, number>;
  affects?: Record<string, number>;
}
type Agents = Record<string, { description: string; status: string; access: string }>;

/** A judge that answers from keywords in the agent descriptions it is shown. */
function scripted(script: Script): Judge & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    async evaluate(request) {
      requests.push({ state: request.state, questions: request.questions });
      const agents = (request.state as { agents: Agents }).agents;
      const lookup = <T>(map: Record<string, T> | undefined, alias: string): T | undefined => {
        for (const [keyword, value] of Object.entries(map ?? {}))
          if (agents[alias]?.description.includes(keyword)) return value;
        return undefined;
      };
      const answers: Record<string, JudgeAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const [kind, alias] = id.split('.');
        if (question.type === 'choice') {
          const raw = Object.fromEntries(
            Object.keys(question.options).map((option) => [
              option,
              option === 'fresh' ? (script.best?.fresh ?? 0) : (lookup(script.best, option) ?? 0),
            ]),
          );
          const total = Object.values(raw).reduce((sum, p) => sum + p, 0) || 1;
          const probabilities = Object.fromEntries(
            Object.entries(raw).map(([option, p]) => [option, p / total]),
          );
          const [choice, top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
          answers[id] = { type: 'choice', choice, probabilities, confidence: top };
        } else if (question.type === 'yesno') {
          const probability =
            kind === 'relevant'
              ? (lookup(script.relevant, alias) ?? 0.1)
              : kind === 'clash'
                ? (lookup(script.clash, alias) ?? 0.1)
                : kind === 'affects'
                  ? (lookup(script.affects, alias) ?? 0.1)
                  : (script.writes ?? 0.9);
          answers[id] = { type: 'yesno', probability };
        } else {
          const probabilities =
            kind === 'depends'
              ? (lookup(script.depends, alias) ?? [0.9, 0.1, 0])
              : (script.size ?? [0.1, 0.8, 0.1]);
          answers[id] = {
            type: 'score',
            probabilities: [...probabilities],
            confidence: Math.max(...probabilities),
          };
        }
      }
      return { answers, model: 'scripted' };
    },
  };
}
const codes = (proposal: RouteProposal) => proposal.reasons.map((reason) => reason.code);

test('0018-R01 the router works with any judge, hides session ids and has no side effects', async () => {
  const g = await setup();
  try {
    const judge = scripted({ best: { OAuth2: 0.9, fresh: 0.1 }, relevant: { OAuth2: 0.9 } });
    const router = createRouter({
      orchestrator: g.orch,
      judge,
      runtimes,
      describe: (candidate) => `Agent working on ${candidate.task.spec.goal}`,
    });
    const before = await countTasks(g.orch);
    const proposal = await router.route({
      goal: 'Log every token refresh in the login flow',
      acceptance,
      members: g.members,
      rootTaskId: g.ids.root,
      needsWrites: true,
    });
    assert.equal(await countTasks(g.orch), before, 'route() creates nothing');
    assert.deepEqual(proposal.decision, { mode: 'reuse', sessionId: g.ids.auth });
    assert.equal(judge.requests.length, 1, 'one judge call per route');
    const [request] = judge.requests;
    const text = JSON.stringify(request.state);
    for (const id of [g.ids.auth, g.ids.payments, g.ids.review, g.ids.root])
      assert.ok(!text.includes(id), 'the judge never sees engine ids');
    assert.ok(text.includes('Agent working on Refactor login to OAuth2 in src/auth'));
    assert.equal(request.questions.best.type, 'choice');
    assert.ok(Object.keys(request.questions).some((id) => id.startsWith('relevant.')));
    assert.ok(!('writes' in request.questions), 'no writes question when the host decided');
  } finally {
    await g.close();
  }
});

test('0018-R02 root-scope proposals are accepted by the engine and never leave the root', async () => {
  const g = await setup();
  try {
    const route = (script: Script, extra: { members?: string[]; goal?: string } = {}) =>
      createRouter({ orchestrator: g.orch, judge: scripted(script), runtimes }).route({
        goal: extra.goal ?? 'Work item',
        acceptance,
        members: extra.members ?? g.members,
        rootTaskId: g.ids.root,
        needsWrites: true,
      });
    const router = createRouter({ orchestrator: g.orch, judge: scripted({}), runtimes });

    const reuse = await route({ best: { OAuth2: 0.95, fresh: 0.05 }, relevant: { OAuth2: 0.9 } });
    assert.equal(reuse.spec.parentTaskId, g.ids.root);
    const reused = await router.submit(reuse);
    assert.equal(reused.initial.sessionId, g.ids.auth);
    await waitFor(g.orch, reused.id, 'waiting_approval');

    const fresh = await route({ best: { fresh: 0.95 }, relevant: {} });
    const created = await router.submit(fresh);
    assert.ok(![g.ids.auth, g.ids.payments, g.ids.review].includes(created.initial.sessionId!));
    assert.equal(created.initial.spec.parentTaskId, g.ids.root);

    const busy = await route({
      best: { rounding: 0.95, fresh: 0.05 },
      relevant: { rounding: 0.9 },
      clash: { rounding: 0.9 },
    });
    const queued = await router.submit(busy);
    assert.equal(queued.initial.status, 'queued');
    assert.equal(queued.initial.sessionId, g.ids.payments);

    // A reused agent keeps its model and write scope, or the engine would refuse the declaration.
    const shell = await g.orch.tasks.create({
      goal: 'Build the app shell in app/',
      runtime: { provider: 'fake-write', model: 'w-small' },
      acceptance,
      parentTaskId: g.ids.root,
      writeScope: 'app',
      contextPlan: {
        requestedMode: 'fresh',
        independent: true,
        dependencyTaskIds: [],
        contextRefs: [],
        fallbackModes: [],
        maxQueueWaitMs: 30_000,
      },
    });
    await approve(g.orch, shell.id);
    const shellSession = (await g.orch.tasks.get(shell.id)).sessionId!;
    const kept = await route(
      { best: { 'app shell': 0.95, fresh: 0.05 }, relevant: { 'app shell': 0.9 } },
      { members: [shellSession] },
    );
    assert.deepEqual(kept.spec.runtime, { provider: 'fake-write', model: 'w-small' });
    assert.equal(kept.spec.writeScope, 'app');
    assert.equal((await router.submit(kept)).initial.sessionId, shellSession);

    const outside = await route(
      { best: { marketing: 0.99 }, relevant: { marketing: 0.99 } },
      { members: [...g.members, g.ids.other] },
    );
    assert.notEqual((outside.decision as { sessionId?: string }).sessionId, g.ids.other);
    assert.ok(!JSON.stringify(outside).includes(g.ids.other));
  } finally {
    await g.close();
  }
});

test('0018-R02 engine scope reuses any member when the engine allows cross-root reuse', async () => {
  const g = await setup({ allowCrossRootReuse: true });
  try {
    const router = createRouter({
      orchestrator: g.orch,
      judge: scripted({ best: { marketing: 0.95, fresh: 0.05 }, relevant: { marketing: 0.9 } }),
      runtimes,
      scope: 'engine',
    });
    const proposal = await router.route({
      goal: 'Tighten the landing page copy',
      acceptance,
      members: [...g.members, g.ids.other],
      needsWrites: true,
    });
    assert.deepEqual(proposal.decision, { mode: 'reuse', sessionId: g.ids.other });
    assert.equal(proposal.spec.parentTaskId, undefined);
    const task = await router.submit(proposal);
    assert.equal(task.initial.sessionId, g.ids.other);
  } finally {
    await g.close();
  }

  const h = await setup();
  try {
    const router = createRouter({
      orchestrator: h.orch,
      judge: scripted({ best: { marketing: 0.95, fresh: 0.05 }, relevant: { marketing: 0.9 } }),
      runtimes,
      scope: 'engine',
    });
    const proposal = await router.route({
      goal: 'Tighten the landing page copy',
      acceptance,
      members: [h.ids.other, h.ids.auth],
      needsWrites: true,
    });
    await assert.rejects(router.submit(proposal), { code: 'HISTORY_REUSE_FORBIDDEN' });
  } finally {
    await h.close();
  }
});

test('0018-R03 the policy table decides reuse, waiting, parallel work and fresh sessions', async () => {
  const g = await setup();
  try {
    /** `null` leaves the writes decision to the judge. */
    const route = (script: Script, needsWrites: boolean | null = true) =>
      createRouter({ orchestrator: g.orch, judge: scripted(script), runtimes }).route({
        goal: 'Work item',
        acceptance,
        members: g.members,
        rootTaskId: g.ids.root,
        ...(needsWrites === null ? {} : { needsWrites }),
      });

    const idle = await route({ best: { OAuth2: 0.9, fresh: 0.1 }, relevant: { OAuth2: 0.9 } });
    assert.deepEqual(idle.decision, { mode: 'reuse', sessionId: g.ids.auth });
    assert.deepEqual(idle.spec.runtime, WRITE);
    assert.equal(idle.spec.contextPlan?.requestedMode, 'reuse');
    assert.equal(idle.spec.contextPlan?.independent, true);

    const clash = await route({
      best: { rounding: 0.9, fresh: 0.1 },
      relevant: { rounding: 0.9 },
      clash: { rounding: 0.8 },
    });
    assert.deepEqual(clash.decision, { mode: 'reuse', sessionId: g.ids.payments });
    assert.equal(clash.spec.contextPlan?.maxQueueWaitMs, 20 * 60_000);
    assert.deepEqual(clash.spec.contextPlan?.fallbackModes, ['fresh']);
    assert.ok(codes(clash).includes('BUSY_WAIT'));

    const essential = await route({
      best: { rounding: 0.9, fresh: 0.1 },
      relevant: { rounding: 0.9 },
      depends: { rounding: [0, 0.2, 0.8] },
    });
    assert.deepEqual(essential.decision, { mode: 'reuse', sessionId: g.ids.payments });
    assert.deepEqual(essential.spec.contextPlan?.fallbackModes, []);

    const parallel = await route({
      best: { rounding: 0.9, fresh: 0.1 },
      relevant: { rounding: 0.9 },
      depends: { rounding: [0.8, 0.2, 0] },
      clash: { rounding: 0.1 },
    });
    assert.deepEqual(parallel.decision, { mode: 'fresh' });
    assert.ok(codes(parallel).includes('BUSY_PARALLEL'));
    const payments = await g.orch.tasks.get(g.ids.paymentsTask);
    assert.deepEqual(
      parallel.spec.contextPlan?.contextRefs.map((ref) => ref.artifactRef),
      [payments.artifactRefs[0]],
    );

    const unrelated = await route({ best: { OAuth2: 0.6, fresh: 0.4 }, relevant: {} });
    assert.deepEqual(unrelated.decision, { mode: 'fresh' });
    assert.ok(codes(unrelated).includes('NO_RELEVANT_AGENT'));

    const writes = await route({
      best: { 'rate limit': 0.7, OAuth2: 0.2, fresh: 0.1 },
      relevant: { 'rate limit': 0.9, OAuth2: 0.8 },
    });
    assert.deepEqual(writes.decision, { mode: 'reuse', sessionId: g.ids.auth });
    assert.ok(!JSON.stringify(writes.alternatives).includes(g.ids.review));

    const small = await route({ best: { fresh: 0.9 }, writes: 0.05, size: [0.9, 0.1, 0] }, null);
    assert.deepEqual(small.spec.runtime, { provider: 'fake-read', model: 'r-small' });
    const large = await route({ best: { fresh: 0.9 }, writes: 0.95, size: [0, 0.2, 0.8] }, null);
    assert.deepEqual(large.spec.runtime, { provider: 'fake-write', model: 'w-large' });
    const middle = await route({ best: { fresh: 0.9 }, writes: 0.95, size: [0.3, 0.5, 0.2] }, null);
    assert.deepEqual(middle.spec.runtime, WRITE);
  } finally {
    await g.close();
  }
});

test('0018-R04 fresh work carries the relevant agents results, most relevant first', async () => {
  const g = await setup();
  try {
    const route = (maxContextRefs?: number) =>
      createRouter({
        orchestrator: g.orch,
        judge: scripted({
          best: { fresh: 0.9, OAuth2: 0.1 },
          relevant: { OAuth2: 0.75, 'rate limit': 0.95, rounding: 0.4 },
        }),
        runtimes,
        ...(maxContextRefs ? { policy: { maxContextRefs } } : {}),
      }).route({
        goal: 'Summarize the security posture of login and refunds',
        acceptance,
        members: g.members,
        rootTaskId: g.ids.root,
        needsWrites: false,
      });
    const auth = await g.orch.tasks.get(g.ids.authTask);
    const review = await g.orch.tasks.get(g.ids.reviewTask);
    const proposal = await route();
    assert.deepEqual(
      proposal.spec.contextPlan?.contextRefs,
      [review.artifactRefs[0], auth.artifactRefs[0]].map((artifactRef) => ({
        artifactRef,
        version: 1,
      })),
    );
    const capped = await route(1);
    assert.deepEqual(
      capped.spec.contextPlan?.contextRefs.map((ref) => ref.artifactRef),
      [review.artifactRefs[0]],
    );
  } finally {
    await g.close();
  }
});

test('0018-R05 uncertain judgments ask for confirmation and list the alternatives', async () => {
  const g = await setup();
  try {
    const route = (script: Script, needsWrites?: boolean) =>
      createRouter({ orchestrator: g.orch, judge: scripted(script), runtimes }).route({
        goal: 'Work item',
        acceptance,
        members: g.members,
        rootTaskId: g.ids.root,
        ...(needsWrites === undefined ? {} : { needsWrites }),
      });
    const confident = await route(
      { best: { OAuth2: 0.95, fresh: 0.05 }, relevant: { OAuth2: 0.9 } },
      true,
    );
    assert.equal(confident.needsConfirmation, false);

    const low = await route({ best: { OAuth2: 0.6, fresh: 0.4 }, relevant: { OAuth2: 0.9 } }, true);
    assert.equal(low.needsConfirmation, true);
    assert.ok(codes(low).includes('LOW_CONFIDENCE'));
    assert.deepEqual(
      low.alternatives.map((alternative) => alternative.option),
      [g.ids.auth, 'fresh', g.ids.payments],
    );

    const narrow = await route(
      { best: { OAuth2: 0.5, rounding: 0.45, fresh: 0.05 }, relevant: { OAuth2: 0.9 } },
      true,
    );
    assert.ok(codes(narrow).includes('NARROW_MARGIN'));

    const unsure = await route({
      best: { OAuth2: 0.95, fresh: 0.05 },
      relevant: { OAuth2: 0.9 },
      writes: 0.5,
    });
    assert.equal(unsure.needsConfirmation, true);
    assert.ok(codes(unsure).includes('WRITES_UNCERTAIN'));
  } finally {
    await g.close();
  }
});

test('0018-R06 a failing judge yields the deterministic fallback proposal', async () => {
  const g = await setup();
  try {
    const failing: Judge = {
      async evaluate() {
        throw new JudgeError('JUDGE_UNAVAILABLE', 'down');
      },
    };
    const request = {
      goal: 'Work item',
      acceptance,
      members: g.members,
      rootTaskId: g.ids.root,
      needsWrites: true,
    };
    const proposal = await createRouter({ orchestrator: g.orch, judge: failing, runtimes }).route(
      request,
    );
    assert.deepEqual(proposal.decision, { mode: 'fresh' });
    assert.deepEqual(proposal.spec.contextPlan?.contextRefs, []);
    assert.deepEqual(proposal.spec.runtime, WRITE);
    assert.equal(proposal.needsConfirmation, true);
    assert.ok(codes(proposal).includes('JUDGE_UNAVAILABLE'));
    assert.deepEqual(proposal.judge, { unavailable: 'JUDGE_UNAVAILABLE' });

    const partial: Judge = { evaluate: async () => ({ answers: {} }) };
    const broken = await createRouter({
      orchestrator: g.orch,
      judge: partial,
      runtimes,
      policy: { onJudgeFailure: 'fresh' },
    }).route(request);
    assert.deepEqual(broken.judge, { unavailable: 'JUDGE_PROTOCOL' });
    assert.equal(broken.needsConfirmation, false);
  } finally {
    await g.close();
  }
});

test('0018-R07 findings reach only the agents they affect in the group', async () => {
  const g = await setup();
  try {
    const judge = scripted({ affects: { rounding: 0.85, 'rate limit': 0.6, marketing: 0.99 } });
    const router = createRouter({ orchestrator: g.orch, judge, runtimes });
    const plan = await router.notifications({
      text: 'The auth API now returns 401 instead of 403 for expired tokens.',
      fromSessionId: g.ids.auth,
      members: [...g.members, g.ids.other],
      rootTaskId: g.ids.root,
    });
    assert.deepEqual(
      plan.notify.map((target) => target.sessionId),
      [g.ids.payments],
    );
    assert.deepEqual(plan.confirm, []);
    assert.deepEqual(
      plan.followUp.map((target) => target.sessionId),
      [g.ids.review],
      'an agent whose task ended cannot receive messages',
    );
    const text = JSON.stringify(judge.requests[0]);
    assert.ok(!text.includes('Refactor login'), 'the source agent is not asked about');
    assert.ok(!text.includes('marketing'), 'agents outside the root are not asked about');
    const sent = await router.notify(plan);
    assert.equal(sent.length, 1);
    const message = (await g.orch.messages.get(sent[0].id)) as MessageSnapshot;
    assert.deepEqual(
      [message.toSessionId, message.kind, message.status],
      [g.ids.payments, 'finding', 'persisted'],
    );
  } finally {
    await g.close();
  }
});

/** A local stand-in for TypeSafe's API that records requests and replays scripted responses. */
async function fakeJev(
  respond: (
    body: Record<string, unknown>,
    attempt: number,
  ) => { status: number; body?: unknown; delayMs?: number },
) {
  const requests: { method: string; url: string; auth: string; body: Record<string, unknown> }[] =
    [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: String(req.headers.authorization ?? ''),
      body,
    });
    const reply = respond(body, requests.length);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const questions = {
  best: {
    type: 'choice' as const,
    instructions: 'Pick one',
    options: { A1: 'first', fresh: null },
  },
  w: { type: 'yesno' as const, instructions: 'Writes?' },
  s: { type: 'score' as const, instructions: 'Size?', levels: ['small', 'medium', 'large'] },
};
const jevAnswers = {
  best: { type: 'choice', choice: 'A1', probabilities: { A1: 0.8, fresh: 0.2 }, confidence: 0.7 },
  w: { type: 'noul', noul: 0.25 },
  s: {
    type: 'score',
    score: 1.1,
    legend: { '0': 'small', '1': 'medium', '2': 'large' },
    probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
    confidence: 0.6,
  },
};

test('0018-R08 the Jev judge sends the documented request and maps the answers', async () => {
  const server = await fakeJev(() => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: jevAnswers,
      usage: { input_tokens: 42, output_tokens: 7 },
    },
  }));
  try {
    const judge = createJevJudge({ apiKey: 'test-key', baseUrl: server.baseUrl });
    const result = await judge.evaluate({ state: { request: 'x' }, questions });
    const [sent] = server.requests;
    assert.deepEqual(
      [sent.method, sent.url, sent.auth],
      ['POST', '/v1/systemone', 'Bearer test-key'],
    );
    assert.deepEqual(sent.body, {
      state: { request: 'x' },
      model: 'jev-1.13.0',
      questions: {
        best: { type: 'choice', instructions: 'Pick one', criteria: { A1: 'first', fresh: null } },
        w: { type: 'noul', instructions: 'Writes?' },
        s: { type: 'score', instructions: 'Size?', criteria: ['small', 'medium', 'large'] },
      },
    });
    assert.deepEqual(result.answers, {
      best: {
        type: 'choice',
        choice: 'A1',
        probabilities: { A1: 0.8, fresh: 0.2 },
        confidence: 0.7,
      },
      w: { type: 'yesno', probability: 0.25 },
      s: { type: 'score', probabilities: [0.1, 0.7, 0.2], confidence: 0.6 },
    });
    assert.equal(result.model, 'jev-1.13.0');
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 7 });
  } finally {
    await server.close();
  }
});

test('0018-R08 the Jev judge retries once on overload and never on client errors', async () => {
  const cases: [number[], string | null, number][] = [
    [[401], 'JUDGE_AUTH', 1],
    [[422], 'JUDGE_INVALID_REQUEST', 1],
    [[503, 200], null, 2],
    [[529, 529], 'JUDGE_UNAVAILABLE', 2],
    [[429, 429], 'JUDGE_RATE_LIMITED', 2],
  ];
  for (const [statuses, code, calls] of cases) {
    const server = await fakeJev((_body, attempt) => ({
      status: statuses[attempt - 1],
      body:
        statuses[attempt - 1] === 200
          ? { model: 'jev-1.13.0', answers: jevAnswers }
          : { error: 'x' },
    }));
    try {
      const run = createJevJudge({ apiKey: 'k', baseUrl: server.baseUrl }).evaluate({
        state: {},
        questions,
      });
      if (code) await assert.rejects(run, (error: unknown) => (error as JudgeError).code === code);
      else await run;
      assert.equal(server.requests.length, calls, String(statuses));
    } finally {
      await server.close();
    }
  }
});

test('0018-R08 the Jev judge enforces its deadline and rejects incomplete answers', async () => {
  const slow = await fakeJev(() => ({ status: 200, body: { answers: jevAnswers }, delayMs: 500 }));
  try {
    await assert.rejects(
      createJevJudge({ apiKey: 'k', baseUrl: slow.baseUrl, timeoutMs: 100 }).evaluate({
        state: {},
        questions,
      }),
      (error: unknown) => (error as JudgeError).code === 'JUDGE_TIMEOUT',
    );
  } finally {
    await slow.close();
  }
  const partial = await fakeJev(() => ({
    status: 200,
    body: { answers: { best: jevAnswers.best } },
  }));
  try {
    await assert.rejects(
      createJevJudge({ apiKey: 'k', baseUrl: partial.baseUrl }).evaluate({ state: {}, questions }),
      (error: unknown) => (error as JudgeError).code === 'JUDGE_PROTOCOL',
    );
  } finally {
    await partial.close();
  }
});

test('0018-R08 a router backed by the Jev judge routes end to end', async () => {
  const g = await setup();
  const server = await fakeJev((body) => {
    const state = body.state as { agents: Agents };
    const asked = body.questions as Record<string, { type: string }>;
    const auth = Object.keys(state.agents).find((alias) =>
      state.agents[alias].description.includes('OAuth2'),
    )!;
    const answers = Object.fromEntries(
      Object.entries(asked).map(([id, question]) => [
        id,
        question.type === 'choice'
          ? { type: 'choice', choice: auth, probabilities: { [auth]: 0.95 }, confidence: 0.95 }
          : question.type === 'noul'
            ? { type: 'noul', noul: id === `relevant.${auth}` ? 0.9 : 0.1 }
            : {
                type: 'score',
                score: 1,
                legend: {},
                probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
                confidence: 0.8,
              },
      ]),
    );
    return { status: 200, body: { model: 'jev-1.13.0', answers } };
  });
  try {
    const router = createRouter({
      orchestrator: g.orch,
      judge: createJevJudge({ apiKey: 'k', baseUrl: server.baseUrl }),
      runtimes,
    });
    const proposal = await router.route({
      goal: 'Add PKCE to the OAuth2 login',
      acceptance,
      members: g.members,
      rootTaskId: g.ids.root,
    });
    assert.deepEqual(proposal.decision, { mode: 'reuse', sessionId: g.ids.auth });
    assert.equal((proposal.judge as { model?: string }).model, 'jev-1.13.0');
    const task = await router.submit(proposal);
    assert.equal(task.initial.sessionId, g.ids.auth);
  } finally {
    await server.close();
    await g.close();
  }
});
