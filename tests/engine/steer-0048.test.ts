import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EventPage,
  MessageSnapshot,
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0048 S, C02: steering a running turn.

type Answer =
  | { status: 'accepted' }
  | { status: 'rejected'; turnEnded: boolean; notSteerable?: boolean; message: string };
type Steer = (text: string, id: string) => Promise<Answer>;
const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
});

/** A runtime that works until released, and answers steers as `answer` says. */
async function setup(t: any, answer?: Steer) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-steer-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  const prompts: string[] = [];
  const inputs: RuntimeInput[] = [];
  const steered: { text: string; id: string; dispatchId: string }[] = [];
  let release!: () => void;
  const hold = () => new Promise<void>((resolve) => (release = resolve));
  let held = hold();
  const adapter: RuntimeAdapter = {
    ...fake,
    capabilities: () => ({ ...fake.capabilities(), ...(answer ? { steer: true } : {}) }),
    async *execute(input: RuntimeInput) {
      prompts.push(input.prompt);
      inputs.push(input);
      yield { type: 'accepted', providerSessionId: `fake-${input.sessionId}` };
      await held;
      held = hold();
      for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
    },
    ...(answer
      ? {
          steer: (target: { dispatchId: string }, text: string, id: string) => {
            steered.push({ text, id, dispatchId: target.dispatchId });
            return answer(text, id);
          },
        }
      : {}),
  } as RuntimeAdapter;
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    allowCrossRootReuse: true,
  };
  let engine: Engine = await createEngine(config);
  t.after(async () => {
    release?.();
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
    let value = await read();
    for (let i = 0; i < 2000 && !done(value); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      value = await read();
    }
    assert.ok(done(value), JSON.stringify(value));
    return value;
  };
  const session = (id: string) =>
    engine.call('sessions.get', { sessionId: id }) as Promise<SessionSnapshot>;
  const operation = (id: string) =>
    engine.call('operations.get', { operationId: id }) as Promise<OperationSnapshot>;
  return {
    get engine() {
      return engine;
    },
    prompts,
    inputs,
    steered,
    release: () => release(),
    async restart() {
      // The dispatch ends; the steer stays unanswered.
      release();
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      engine = await createEngine(config);
    },
    /** A task whose dispatch the runtime accepted and still works on. */
    async running(goal = 'work') {
      const task = (await engine.call('tasks.create', {
        spec: spec(goal),
        idempotencyKey: goal,
      })) as TaskSnapshot;
      const current = await until(
        () => session(task.sessionId),
        (s) => !!s.activeDispatchId && !!s.providerSessionId,
      );
      return { task, session: current };
    },
    target: (s: SessionSnapshot, extra: Record<string, unknown> = {}) => ({
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedDispatchId: s.activeDispatchId,
      ...extra,
    }),
    steer: (target: Record<string, unknown>, text: string, key = 'steer', context = {}) =>
      engine.call(
        'sessions.steer',
        { target, text, idempotencyKey: key },
        context,
      ) as Promise<OperationSnapshot>,
    settled: (id: string) =>
      until(
        () => operation(id),
        (op) => op.status !== 'persisted',
      ),
    message: (id: string) =>
      engine.call('messages.get', { messageId: id }) as Promise<MessageSnapshot>,
    events: async (type: string) =>
      ((await engine.call('events.read', { limit: 200 })) as EventPage).events.filter(
        (event) => event.type === type,
      ),
    until,
    session,
  };
}

test('AC-0048-S01 AC-0048-S04 an accepted steer is recorded, with its event', async (t) => {
  const f = await setup(t, async () => ({ status: 'accepted' }));
  const { task, session } = await f.running();
  const op = await f.steer(f.target(session), "Don't touch config.json");
  assert.equal(op.status, 'persisted');
  const done = await f.settled(op.id);
  assert.equal(done.status, 'completed');
  const { messageId, dispatchId } = done.result as { messageId: string; dispatchId: string };
  assert.equal(dispatchId, session.activeDispatchId);
  assert.deepEqual(f.steered, [{ text: "Don't touch config.json", id: messageId, dispatchId }]);
  const message = await f.message(messageId);
  assert.equal(message.kind, 'steer');
  assert.equal(message.status, 'completed');
  assert.equal(message.summary, "Don't touch config.json");
  assert.equal((message as { dispatchId?: string }).dispatchId, dispatchId);
  const [event] = await f.events('session.steered');
  assert.deepEqual(
    { ...event!.data },
    { dispatchId, taskId: task.id, messageId, text: "Don't touch config.json" },
  );
  // A retry under the same key returns the first operation and asks nothing again.
  assert.equal((await f.steer(f.target(session), "Don't touch config.json")).id, op.id);
  assert.equal(f.steered.length, 1);
});

test('AC-0048-S01 limits, the flag, and no steer from a runtime', async (t) => {
  const f = await setup(t, async () => ({ status: 'accepted' }));
  const { session } = await f.running();
  for (const text of ['', 'x'.repeat(16_385), 'é'.repeat(8_193)])
    await assert.rejects(f.steer(f.target(session), text, `bad-${text.length}`), {
      code: 'VALIDATION_ERROR',
    });
  await assert.rejects(
    f.steer(f.target(session), 'from a model', 'runtime', {
      runtimeActor: { sessionId: session.id, taskId: 'x', dispatchId: 'x' },
    }),
    { code: 'UNAUTHORIZED' },
  );
  const info = (await f.engine.call('initialize', { protocolVersion: '2.0', sdkVersion: 't' })) as {
    capabilities: { workflow: Record<string, unknown> };
  };
  assert.equal(info.capabilities.workflow.steer, true);
});

test('AC-0048-S02 refusals before anything is recorded', async (t) => {
  const plain = await setup(t);
  const { session: s0 } = await plain.running('plain');
  await assert.rejects(plain.steer(plain.target(s0), 'x'), { code: 'UNSUPPORTED_CAPABILITY' });

  const f = await setup(t, async () => ({ status: 'accepted' }));
  const { task, session } = await f.running();
  await assert.rejects(f.steer(f.target(session, { expectedGeneration: 99 }), 'x', 'g'), {
    code: 'STALE_TARGET',
  });
  await assert.rejects(f.steer(f.target(session, { expectedRevision: 999 }), 'x', 'r'), {
    code: 'STALE_TARGET',
  });
  await assert.rejects(f.steer(f.target(session, { expectedDispatchId: 'other' }), 'x', 'd'), {
    code: 'STEER_TURN_ENDED',
    details: { dispatchId: 'other', turnOutcome: 'unknown', taskStatus: 'running' },
  });
  // The turn ends: its dispatch is no longer the running one.
  f.release();
  await f.until(
    () => f.engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>,
    (current) => current.status === 'waiting_approval',
  );
  await assert.rejects(f.steer(f.target(session), 'too late', 'late'), {
    code: 'STEER_TURN_ENDED',
    details: {
      dispatchId: session.activeDispatchId,
      turnOutcome: 'completed',
      taskStatus: 'waiting_approval',
    },
  });
  assert.equal(f.steered.length, 0, 'the runtime was never asked');
  assert.equal((await f.events('session.steered')).length, 0);
});

test('AC-0048-S03 recorded before the runtime is asked, and never delivered in a prompt', async (t) => {
  let answer!: (value: Answer) => void;
  const f = await setup(t, () => new Promise<Answer>((resolve) => (answer = resolve)));
  const { task, session } = await f.running();
  const op = await f.steer(f.target(session), 'STEER-TEXT');
  await f.until(
    async () => f.steered.length,
    (n) => n === 1,
  );
  const pending = await f.message(f.steered[0]!.id);
  assert.equal(pending.status, 'dispatching', 'recorded while the runtime is asked');
  answer({ status: 'accepted' });
  await f.settled(op.id);
  // The turn ends and is accepted; the next task on the session gets no steer in its prompt.
  f.release();
  const waiting = await f.until(
    () => f.engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>,
    (current) => current.status === 'waiting_approval',
  );
  const approval = (await f.engine.call('approvals.get', { approvalId: waiting.approvalId })) as {
    revision: number;
  };
  await f.engine.call('approvals.decide', {
    approvalId: waiting.approvalId,
    decision: { choice: 'approve', expectedRevision: approval.revision },
    idempotencyKey: 'ok',
  });
  await f.engine.call('tasks.create', {
    spec: {
      ...spec('follow-up'),
      contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: session.id },
    },
    idempotencyKey: 'follow-up',
  });
  await f.until(
    async () => f.prompts.length,
    (n) => n === 2,
  );
  assert.doesNotMatch(f.prompts[1]!, /STEER-TEXT/);
});

test('AC-0048-S04 each refusal, and no answer, end the operation', async (t) => {
  const answers: Record<string, () => Promise<Answer>> = {
    'not steerable': async () => ({
      status: 'rejected',
      turnEnded: false,
      notSteerable: true,
      message: 'compaction',
    }),
    rejected: async () => ({
      status: 'rejected',
      turnEnded: false,
      message: 'input must not be empty',
    }),
    ended: async () => ({
      status: 'rejected',
      turnEnded: true,
      message: 'no active turn to steer',
    }),
    unknown: async () => {
      throw new Error('the connection ended');
    },
  };
  const expected: Record<string, [string, string]> = {
    'not steerable': ['STEER_NOT_STEERABLE', 'failed'],
    rejected: ['STEER_REJECTED', 'failed'],
    ended: ['STEER_TURN_ENDED', 'failed'],
    unknown: ['STEER_OUTCOME_UNKNOWN', 'outcome_unknown'],
  };
  for (const [name, answer] of Object.entries(answers)) {
    const f = await setup(t, answer);
    const { session } = await f.running(name.replace(' ', '-'));
    const op = await f.settled((await f.steer(f.target(session), 'x', name)).id);
    const [code, messageStatus] = expected[name]!;
    assert.equal(op.error?.code, code, name);
    assert.equal(op.status, code === 'STEER_OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'failed', name);
    if (name === 'rejected') assert.match(op.error!.message, /input must not be empty/);
    assert.equal((await f.message(f.steered[0]!.id)).status, messageStatus, name);
    assert.equal((await f.events('session.steered')).length, 0, name);
    // Never sent again, even under the same key.
    await f.steer(f.target(session), 'x', name);
    assert.equal(f.steered.length, 1, name);
  }
});

test("AC-0048-C02 a refusal followed by the turn's end is STEER_TURN_ENDED", async (t) => {
  let f!: Awaited<ReturnType<typeof setup>>;
  f = await setup(t, async () => {
    // Codex answers before its notification that the turn ended.
    setTimeout(() => f.release(), 100);
    return { status: 'rejected', turnEnded: false, message: 'no active turn to steer' };
  });
  const { session } = await f.running();
  const op = await f.settled((await f.steer(f.target(session), 'x')).id);
  assert.equal(op.error?.code, 'STEER_TURN_ENDED');
  assert.equal((op.error as { data?: { turnOutcome?: string } }).data?.turnOutcome, 'completed');
});

test('AC-0048-S05 a restart leaves an unanswered steer unknown', async (t) => {
  const f = await setup(t, () => new Promise<Answer>(() => {}));
  const { session } = await f.running();
  const op = await f.steer(f.target(session), 'x');
  await f.until(
    async () => f.steered.length,
    (n) => n === 1,
  );
  const messageId = f.steered[0]!.id;
  await f.restart();
  const after = (await f.engine.call('operations.get', {
    operationId: op.id,
  })) as OperationSnapshot;
  assert.equal(after.status, 'outcome_unknown');
  assert.equal(after.error?.code, 'STEER_OUTCOME_UNKNOWN');
  assert.equal((await f.message(messageId)).status, 'outcome_unknown');
});

test('AC-0048-S02 a turn that waits for a runtime approval can be steered, and the approval still waits', async (t) => {
  // Reported with 0.1.23: the runtime's permission request put the task in waiting_approval, and
  // the steer was refused as if the turn had ended.
  const dir = await mkdtemp(join(tmpdir(), 'orch-steer-approval-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  const steered: string[] = [];
  const adapter: RuntimeAdapter = {
    ...fake,
    capabilities: () => ({ ...fake.capabilities(), steer: true }),
    async *execute(input: RuntimeInput) {
      const native = `fake-${input.sessionId}`;
      yield { type: 'accepted', providerSessionId: native };
      await input.requestPermission!({
        requestId: 'command-1',
        toolName: 'Bash',
        permission: { command: 'make' },
        providerSessionId: native,
      });
      for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
    },
    steer: async (_target: unknown, text: string) => {
      steered.push(text);
      return { status: 'accepted' };
    },
  } as RuntimeAdapter;
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    runtimeApprovals: { enabled: true },
  });
  t.after(async () => {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const created = (await engine.call('tasks.create', {
    spec: spec('ask first'),
    idempotencyKey: 'ask',
  })) as TaskSnapshot;
  let task = created;
  for (let i = 0; i < 2000 && task.status !== 'waiting_approval'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    task = (await engine.call('tasks.get', { taskId: created.id })) as TaskSnapshot;
  }
  assert.equal(task.status, 'waiting_approval');
  const session = (await engine.call('sessions.get', {
    sessionId: task.sessionId,
  })) as SessionSnapshot;
  const op = (await engine.call(
    'sessions.steer',
    {
      target: {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedDispatchId: session.activeDispatchId,
      },
      text: 'use the staging config',
      idempotencyKey: 'while-asking',
    },
    {},
  )) as OperationSnapshot;
  let done = op;
  for (let i = 0; i < 2000 && done.status === 'persisted'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done = (await engine.call('operations.get', { operationId: op.id })) as OperationSnapshot;
  }
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.deepEqual(steered, ['use the staging config']);
  const approval = (await engine.call('approvals.get', { approvalId: task.approvalId })) as {
    status: string;
  };
  assert.equal(approval.status, 'pending', "the approval is still the person's to give");
});

// SPEC-0056 S04: a runtime that accepts a steer before it knows whether the turn takes it, as
// Claude does, reports the outcome later.
test('AC-0056-S04 a steer that did not reach its turn expires, with one event', async (t) => {
  const f = await setup(t, async () => ({ status: 'accepted' }));
  const { task, session } = await f.running();
  const report = (steerId: string, delivered: boolean) =>
    f.inputs.at(-1)!.reportSteerOutcome!({ steerId, delivered });
  assert.equal(typeof f.inputs.at(-1)!.reportSteerOutcome, 'function');
  const first = await f.settled((await f.steer(f.target(session), 'kept', 'kept')).id);
  assert.equal(first.status, 'completed');
  const kept = f.steered[0]!.id;
  report(kept, true);
  assert.equal((await f.message(kept)).status, 'completed');
  assert.deepEqual(await f.events('session.steer_undelivered'), []);

  await f.settled((await f.steer(f.target(session), 'lost', 'lost')).id);
  const lost = f.steered[1]!.id;
  report(lost, false);
  report(lost, false);
  assert.doesNotThrow(() => report('no-such-steer', false));
  assert.equal((await f.message(lost)).status, 'expired');
  const events = await f.events('session.steer_undelivered');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.taskId, task.id);
  assert.equal(events[0]!.sessionId, session.id);
  assert.deepEqual(events[0]!.data, {
    dispatchId: session.activeDispatchId,
    taskId: task.id,
    messageId: lost,
  });
});

test('AC-0056-S04 an outcome that arrives before the steer is recorded applies once it is', async (t) => {
  let report!: (steerId: string) => void;
  const f = await setup(t, async (_text, id) => {
    report(id);
    return { status: 'accepted' };
  });
  const { session } = await f.running();
  report = (steerId) => f.inputs.at(-1)!.reportSteerOutcome!({ steerId, delivered: false });
  const op = await f.settled((await f.steer(f.target(session), 'early', 'early')).id);
  assert.equal(op.status, 'completed', 'the steer itself was accepted');
  assert.equal((await f.message(f.steered[0]!.id)).status, 'expired');
  assert.equal((await f.events('session.steer_undelivered')).length, 1);
});
