import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import {
  createRouter,
  createRuleJudge,
  type JudgeAnswer,
  type JudgeQuestion,
} from '../../packages/sdk-typescript/src/routing.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';

// SPEC-0044 E04: a judge without a model, for trying the routing layer.

const agents = {
  a1: { description: 'Refactor login to OAuth2 in src/auth', status: 'idle', access: 'writable' },
  a2: { description: 'Release notes for 0.1.21', status: 'busy', access: 'read-only' },
};
const yesno: JudgeQuestion = { type: 'yesno', instructions: 'yes or no' };
const levels = (n: number): JudgeQuestion => ({
  type: 'score',
  instructions: 'how much',
  levels: Array.from({ length: n }, (_, i) => `level ${i}`),
});
const best: JudgeQuestion = {
  type: 'choice',
  instructions: 'which agent',
  options: { a1: null, a2: null, fresh: 'start a new one' },
};
const ask = (goal: string, questions: Record<string, JudgeQuestion>, options = {}) =>
  createRuleJudge(options).evaluate({ state: { request: { goal }, agents }, questions });
const probability = (answer: JudgeAnswer | undefined) =>
  (answer as Extract<JudgeAnswer, { type: 'yesno' }>).probability;

test('AC-0044-E04 relevance and the best agent come from the words a goal shares with an agent', async () => {
  const { answers } = await ask('Fix the login redirect after OAuth2 sign-in', {
    best,
    'relevant.a1': yesno,
    'relevant.a2': yesno,
  });
  assert.ok(probability(answers['relevant.a1']) >= 0.5, 'shares login and oauth2');
  assert.ok(probability(answers['relevant.a2']) < 0.5, 'shares nothing');
  const choice = answers.best as Extract<JudgeAnswer, { type: 'choice' }>;
  assert.equal(choice.choice, 'a1');
  assert.ok(choice.confidence <= 0.6);
  // A goal that shares no word with any agent picks a fresh one.
  const none = (await ask('Translate the landing page', { best })).answers.best as Extract<
    JudgeAnswer,
    { type: 'choice' }
  >;
  assert.equal(none.choice, 'fresh');
  assert.ok(none.confidence <= 0.6);
  // Verbs such as fix do not make two goals related.
  const verbs = await ask('Fix the release script', { 'relevant.a1': yesno });
  assert.ok(probability(verbs.answers['relevant.a1']) < 0.5);
});

test('AC-0044-E04 writes follows the verbs, and size the length of the goal', async () => {
  const fix = await ask('Fix the login redirect', { writes: yesno, size: levels(3) });
  assert.ok(probability(fix.answers.writes) >= 0.7);
  const explain = await ask('Explain how the login redirect works', { writes: yesno });
  assert.ok(probability(explain.answers.writes) <= 0.3);
  const short = fix.answers.size as Extract<JudgeAnswer, { type: 'score' }>;
  const long = (
    await ask(
      'Migrate every service from the old configuration loader to the new one, update each ' +
        'caller, move the defaults into one file, remove the environment fallbacks, and rewrite ' +
        'the tests that depended on them so that the suite still covers each case',
      { size: levels(3) },
    )
  ).answers.size as Extract<JudgeAnswer, { type: 'score' }>;
  assert.equal(short.probabilities.indexOf(Math.max(...short.probabilities)), 0);
  assert.equal(long.probabilities.indexOf(Math.max(...long.probabilities)), 2);
  for (const answer of [short, long]) assert.ok(answer.confidence <= 0.6);
});

test('AC-0044-E04 every question gets a valid answer, and answer() overrides any of them', async () => {
  const questions: Record<string, JudgeQuestion> = {
    best,
    'depends.a2': levels(3),
    'clash.a2': yesno,
    'affects.a1': yesno,
    other: yesno,
    scale: levels(5),
  };
  const { answers } = await ask('Fix the login redirect', questions);
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id]!;
    assert.equal(answer.type, question.type, id);
    if (answer.type === 'yesno') assert.ok(answer.probability >= 0 && answer.probability <= 1);
    else if (answer.type === 'score') {
      assert.equal(answer.probabilities.length, (question as { levels: unknown[] }).levels.length);
      assert.ok(answer.confidence <= 0.6);
    }
  }
  const seen: string[] = [];
  const overridden = await ask(
    'Fix the login redirect',
    { writes: yesno, other: yesno },
    {
      answer: (id: string, question: JudgeQuestion, state: unknown) => {
        seen.push(
          `${id}:${question.type}:${(state as { request: { goal: string } }).request.goal}`,
        );
        return id === 'other' ? { type: 'yesno', probability: 1 } : undefined;
      },
    },
  );
  assert.deepEqual(seen, [
    'writes:yesno:Fix the login redirect',
    'other:yesno:Fix the login redirect',
  ]);
  assert.equal(probability(overridden.answers.other), 1);
  assert.ok(probability(overridden.answers.writes) >= 0.7);
});

test('AC-0044-E04 with the default policy, a route by the rule judge asks for confirmation', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-rule-judge-')));
  await mkdir(join(dir, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { model: 'fake-model', permissionProfile: 'workspace-write' } },
    allowCrossRootReuse: true,
    storage: { emergencyBytes: 4096 },
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const acceptance = { mode: 'human' as const, criteria: ['Review'] };
  const runtime = { provider: 'fake', model: 'fake-model' };
  const auth = await orch.tasks.create({ goal: 'Refactor login to OAuth2', runtime, acceptance });
  const done = await auth.settle({ onApproval: () => 'approve', timeoutMs: 5000 });
  const router = createRouter({
    orchestrator: orch,
    judge: createRuleJudge(),
    runtimes: { writable: runtime },
    scope: 'engine',
  });
  const proposal = await router.route({
    goal: 'Fix the login redirect after OAuth2 sign-in',
    acceptance,
    members: [done.task.sessionId!],
  });
  assert.deepEqual(proposal.decision, { mode: 'reuse', sessionId: done.task.sessionId });
  assert.ok(proposal.judgeConfidence! <= 0.6);
  assert.equal(proposal.needsConfirmation, true);
  assert.ok(proposal.reasons.some((reason) => reason.code === 'LOW_CONFIDENCE'));
});
