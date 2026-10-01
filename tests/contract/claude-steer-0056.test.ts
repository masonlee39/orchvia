import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0056: steering a Claude member. An offline query stands in for Claude Code: the test feeds
// it messages and sees what the adapter puts on the prompt stream and when it interrupts.

const STEER = '22222222-2222-4222-8222-222222222222';
const target = { sessionId: 's', dispatchId: 'd', generation: 1 };
const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const assistant = (content: unknown[]) => ({
  type: 'assistant',
  session_id: 'expected',
  parent_tool_use_id: null,
  message: { role: 'assistant', content },
});
const toolUse = assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }]);
const toolResult = {
  type: 'user',
  session_id: 'expected',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
};
const result = (uuids: string[], text = 'done') => ({
  type: 'result',
  subtype: 'success',
  session_id: 'expected',
  result: text,
  usage: { input_tokens: 1 },
  user_message_uuids: uuids,
});

function claude(t: any, options: { receipt?: unknown; compact?: boolean } = {}) {
  const given: Record<string, any>[] = [];
  const interrupts: unknown[] = [];
  const outcomes: { steerId: string; delivered: boolean }[] = [];
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 5000,
    query: withClaudeProcess((request) => {
      void (async () => {
        for await (const message of request.prompt) given.push(message as Record<string, any>);
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (out.length) yield out.shift();
            if (ended) return;
            await new Promise<void>((resolve) => (wake = resolve));
          }
        },
        async interrupt(args?: unknown) {
          interrupts.push(args);
          return options.receipt;
        },
        close() {
          ended = true;
          wake?.();
        },
      } as never;
    }),
  });
  const events: RuntimeEvent[] = [];
  const order: string[] = [];
  const done = (async () => {
    for await (const event of adapter.execute({
      taskId: 't',
      sessionId: 's',
      dispatchId: 'd',
      providerSessionId: null,
      workspace: process.cwd(),
      stateDir: '/private/tmp/unused-claude-steer',
      model: 'offline',
      prompt: 'fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      ...(options.compact ? { nativeAction: 'compact' as const } : {}),
      reportSteerOutcome(outcome) {
        outcomes.push(outcome);
        order.push(`outcome:${outcome.delivered}`);
      },
    })) {
      if (event.type === 'usage') continue;
      events.push(event);
      order.push(event.type);
    }
  })();
  const emit = (...messages: unknown[]) => {
    out.push(...messages);
    wake?.();
  };
  emit({ type: 'system', subtype: 'init', session_id: 'expected' });
  // Bounded: a turn the adapter never ends fails the test instead of holding the run.
  const settled = Promise.race([
    done,
    new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('the dispatch did not end')), 5000);
      timer.unref();
    }),
  ]);
  settled.catch(() => {});
  t.after(async () => {
    ended = true;
    wake?.();
    await Promise.race([done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
  });
  /** The stream ends without a result. */
  const end = () => {
    ended = true;
    wake?.();
  };
  return { adapter, given, interrupts, outcomes, events, order, emit, end, done: settled };
}
const steers = (c: ReturnType<typeof claude>) =>
  c.given.filter((message) => message.uuid === STEER);

test('AC-0056-S01 the Claude adapter can be steered while its turn runs, and not otherwise', async (t) => {
  assert.equal(createClaudeAdapter({ query: (() => {}) as never }).capabilities().steer, true);
  const c = claude(t);
  await until(() => c.events.length === 1, 'acceptance');
  assert.deepEqual(await c.adapter.steer!({ ...target, dispatchId: 'other' }, 'x', STEER), {
    status: 'rejected',
    turnEnded: true,
    message: 'no running turn for this dispatch',
  });
  assert.deepEqual(await c.adapter.steer!(target, 'held', STEER), {
    status: 'accepted',
    outcomePending: true,
  });
  c.emit(result([]));
  await c.done;
  assert.equal((await c.adapter.steer!(target, 'late', STEER)).status, 'rejected');
  const compaction = claude(t, { compact: true });
  await until(() => compaction.events.length === 1, 'acceptance');
  assert.deepEqual(await compaction.adapter.steer!(target, 'x', STEER), {
    status: 'rejected',
    turnEnded: false,
    notSteerable: true,
    message: 'a compaction cannot be steered',
  });
  compaction.emit(result([]));
  await compaction.done.catch(() => {});
});

test('AC-0056-S02 AC-0056-S03 a steer during a tool call is given at once and delivered', async (t) => {
  const c = claude(t);
  c.emit(toolUse);
  await until(() => c.events.length === 1, 'acceptance');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await c.adapter.steer!(target, 'keep config.json', STEER), {
    status: 'accepted',
    outcomePending: true,
  });
  await until(() => steers(c).length === 1, 'the steer on the prompt stream');
  assert.deepEqual(
    { ...steers(c)[0], session_id: undefined },
    {
      type: 'user',
      message: { role: 'user', content: 'keep config.json' },
      parent_tool_use_id: null,
      session_id: undefined,
      uuid: STEER,
      priority: 'next',
    },
  );
  c.emit(toolResult, result(['first', STEER]));
  await c.done;
  assert.deepEqual(c.outcomes, [{ steerId: STEER, delivered: true }]);
  assert.deepEqual(c.interrupts, []);
  assert.deepEqual(c.order, ['accepted', 'outcome:true', 'result']);
});

test('AC-0056-S02 AC-0056-S03 a steer without a tool call is held, given when one starts, or dropped', async (t) => {
  const later = claude(t);
  await until(() => later.events.length === 1, 'acceptance');
  await later.adapter.steer!(target, 'wait for a tool', STEER);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(steers(later).length, 0, 'held: no tool call is outstanding');
  later.emit(toolUse);
  await until(() => steers(later).length === 1, 'the steer once a tool call started');
  later.emit(toolResult, result([STEER]));
  await later.done;
  assert.deepEqual(later.outcomes, [{ steerId: STEER, delivered: true }]);

  const never = claude(t);
  await until(() => never.events.length === 1, 'acceptance');
  await never.adapter.steer!(target, 'the answer is being written', STEER);
  never.emit(result(['first']));
  await never.done;
  assert.equal(steers(never).length, 0, 'never given: nothing waits in Claude Code');
  assert.deepEqual(never.outcomes, [{ steerId: STEER, delivered: false }]);
  assert.deepEqual(never.interrupts, []);
  assert.deepEqual(never.order, ['accepted', 'outcome:false', 'result']);
});

test('AC-0056-S03 a given steer that the result does not list is cancelled before the terminal', async (t) => {
  const c = claude(t, { receipt: { still_queued: [], cancelled: [STEER] } });
  c.emit(toolUse);
  await until(() => c.events.length === 1, 'acceptance');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await c.adapter.steer!(target, 'too late for the fold', STEER);
  await until(() => steers(c).length === 1, 'the steer on the prompt stream');
  c.emit(toolResult, result(['first']));
  await c.done;
  assert.deepEqual(c.interrupts, [{ cancelQueued: true }]);
  assert.deepEqual(c.outcomes, [{ steerId: STEER, delivered: false }]);
  assert.deepEqual(c.order, ['accepted', 'outcome:false', 'result']);
  assert.equal((c.events.at(-1) as { text?: string }).text, 'done');
});

test('AC-0056-S03 a queued turn that had started is read to its result before the terminal', async (t) => {
  const c = claude(t, { receipt: { still_queued: [], cancelled: [] } });
  c.emit(toolUse);
  await until(() => c.events.length === 1, 'acceptance');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await c.adapter.steer!(target, 'too late for the fold', STEER);
  await until(() => steers(c).length === 1, 'the steer on the prompt stream');
  c.emit(toolResult, result(['first'], "the turn's answer"));
  await until(() => c.interrupts.length === 1, 'the interrupt');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(c.events.length, 1, 'the terminal waits for the started turn to end');
  c.emit({ type: 'result', subtype: 'error_during_execution', session_id: 'expected', usage: {} });
  await c.done;
  assert.deepEqual(c.order, ['accepted', 'outcome:false', 'result']);
  assert.equal((c.events.at(-1) as { text?: string }).text, "the turn's answer");
});

// SPEC-0058 D03: without a result nothing says whether Claude Code read a steer it was given.
test('AC-0058-D03 a turn that ends without a result reports a held steer, and not a given one', async (t) => {
  const given = claude(t);
  given.emit(toolUse);
  await until(() => given.events.length === 1, 'acceptance');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await given.adapter.steer!(target, 'given, then the stream ends', STEER);
  await until(() => steers(given).length === 1, 'the steer on the prompt stream');
  given.end();
  await given.done.catch(() => {});
  assert.deepEqual(given.outcomes, [], 'unknown: the engine records it so');

  const held = claude(t);
  await until(() => held.events.length === 1, 'acceptance');
  await held.adapter.steer!(target, 'held, then the stream ends', STEER);
  held.end();
  await held.done.catch(() => {});
  assert.equal(steers(held).length, 0);
  assert.deepEqual(held.outcomes, [{ steerId: STEER, delivered: false }]);
});
