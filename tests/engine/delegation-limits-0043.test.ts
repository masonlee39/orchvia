import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0043 E01: the delegation and tool-call limits that SPEC-0009 F09 names.

type Tools = { call(name: string, args: unknown): Promise<unknown> };
const spec = {
  goal: 'parent',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Owner review'] },
};
const fresh = { requestedMode: 'fresh', independent: true };

/**
 * Runs `action` inside the dispatch whose prompt starts with `goal`, with its bound tools, then
 * returns the task it ran in and its events. `before` runs in the parent's dispatch first, when
 * the goal is another task's.
 */
async function within(
  goal: string,
  tools: Record<string, number>,
  action: (tools: Tools, input: RuntimeInput) => Promise<void>,
  before?: (tools: Tools) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-limits-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  let taskId = '';
  let failure: unknown;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => (complete = resolve));
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input) {
      if (before && input.prompt.startsWith('parent'))
        await before(input.orchestrationTools as Tools).catch((error) => (failure = error));
      if (input.prompt.startsWith(goal)) {
        taskId = input.taskId;
        try {
          await action(input.orchestrationTools as Tools, input);
        } catch (error) {
          failure = error;
        }
        complete();
      }
      yield* fake.execute(input);
    },
  };
  const engine: Engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    tools: { enabled: true, ...tools },
  } as EngineConfig);
  try {
    await engine.call('tasks.create', { spec, idempotencyKey: 'parent' });
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 10_000).unref(),
      ),
    ]);
    if (failure) throw failure;
    const task = (await engine.call('tasks.get', { taskId })) as TaskSnapshot;
    const page = (await engine.call('events.read', { taskId, limit: 200 })) as EventPage;
    return { task, events: page.events };
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
}

/** A limit's error, its event and the task's reason, and later calls of the turn refused. */
function assertLimit(result: Awaited<ReturnType<typeof within>>, code: string) {
  assert.equal(result.task.reason, code);
  const reached = result.events.filter((event) => event.type === 'tool.limit_reached');
  assert.equal(reached.length, 1);
  assert.equal(reached[0]!.data.code, code);
}

test('AC-0043-E01 DELEGATION_CHILD_LIMIT ends the delegation past maxChildren', async () => {
  const result = await within('parent', { maxChildren: 2 }, async (tools) => {
    for (const key of ['first', 'second'])
      await tools.call('work_delegate', { goal: key, contextPlan: fresh, idempotencyKey: key });
    await assert.rejects(
      tools.call('work_delegate', { goal: 'third', contextPlan: fresh, idempotencyKey: 'third' }),
      { code: 'DELEGATION_CHILD_LIMIT' },
    );
    await assert.rejects(tools.call('work_read', { kind: 'task', id: 'x' }), {
      code: 'STALE_GRANT',
    });
  });
  assertLimit(result, 'DELEGATION_CHILD_LIMIT');
});

test('AC-0043-E01 DELEGATION_DEPTH_LIMIT ends a delegation at maxDepth', async () => {
  // The parent delegates a child; the child, one level down, may not delegate at maxDepth 1.
  const result = await within(
    'child',
    { maxDepth: 1 },
    async (tools) => {
      await assert.rejects(
        tools.call('work_delegate', {
          goal: 'grandchild',
          contextPlan: fresh,
          idempotencyKey: 'grand',
        }),
        { code: 'DELEGATION_DEPTH_LIMIT' },
      );
      await assert.rejects(tools.call('work_read', { kind: 'task', id: 'x' }), {
        code: 'STALE_GRANT',
      });
    },
    async (tools) => {
      await tools.call('work_delegate', {
        goal: 'child',
        contextPlan: fresh,
        idempotencyKey: 'child',
      });
    },
  );
  assertLimit(result, 'DELEGATION_DEPTH_LIMIT');
});

test('AC-0043-E01 TOOL_CALL_LIMIT ends the call past maxCallsPerDispatch', async () => {
  const result = await within('parent', { maxCallsPerDispatch: 3 }, async (tools, input) => {
    for (let i = 0; i < 3; i++) await tools.call('work_read', { kind: 'task', id: input.taskId });
    await assert.rejects(tools.call('work_read', { kind: 'task', id: input.taskId }), {
      code: 'TOOL_CALL_LIMIT',
    });
    await assert.rejects(tools.call('work_read', { kind: 'task', id: input.taskId }), {
      code: 'STALE_GRANT',
    });
  });
  assertLimit(result, 'TOOL_CALL_LIMIT');
});
