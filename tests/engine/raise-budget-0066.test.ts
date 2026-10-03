import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0066: raising a root task's budget.

/** A fake runtime whose every dispatch costs 0.1 USD at the price below. */
function billing(): RuntimeAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    async *execute(input: RuntimeInput) {
      yield {
        type: 'usage',
        usageId: 'bill',
        usage: {
          inputTokens: 10000,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          raw: {},
        },
      };
      for await (const event of base.execute(input))
        yield event.type === 'result' ? { ...event, usageComplete: true } : event;
    },
  };
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-raise-budget-')));
  await mkdir(join(root, 'workspace'));
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [billing()],
    pricing: [
      {
        provider: 'fake',
        model: 'fixture',
        currency: 'USD',
        version: 'fixture',
        inputTokenMode: 'uncached',
        perMillion: { input: '10', output: '10' },
      },
    ],
  };
  const f = {
    engine: await createEngine(config),
    async restart() {
      await f.engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      f.engine = await createEngine({ ...config, adapters: [billing()] });
    },
    async close() {
      await f.engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}
const key = () => crypto.randomUUID();
const budget = (maxCost: string) => ({ currency: 'USD', maxCost, reservePerDispatch: '0.1' });
const create = async (engine: Engine, spec: Record<string, unknown>) =>
  (await engine.call('tasks.create', { spec, idempotencyKey: key() })) as TaskSnapshot;
const step = (engine: Engine, goal: string, extra: Record<string, unknown> = {}) =>
  create(engine, {
    goal,
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['Review'] },
    ...extra,
  });
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
const raise = (engine: Engine, taskId: string, maxCost: unknown, idempotencyKey = key()) =>
  engine.call('tasks.raiseBudget', {
    taskId,
    maxCost,
    idempotencyKey,
  }) as Promise<OperationSnapshot>;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await get(engine, id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected, String(error));
  return true;
};

test('0066-B01 B03 B05 a raised budget lets the task that it had paused be resumed and dispatched', async () => {
  const f = await setup();
  try {
    const run = await create(f.engine, {
      goal: 'one run',
      executor: 'host',
      budget: budget('0.15'),
    });
    const first = await step(f.engine, 'first', { parentTaskId: run.id });
    await wait(f.engine, first.id, 'waiting_approval');
    const second = await step(f.engine, 'second', { parentTaskId: run.id });
    const own = await step(f.engine, 'own smaller budget', {
      parentTaskId: run.id,
      budget: budget('0.12'),
    });
    assert.equal((await wait(f.engine, second.id, 'paused')).reason, 'TASK_BUDGET_EXHAUSTED');
    assert.equal((await wait(f.engine, own.id, 'paused')).reason, 'TASK_BUDGET_EXHAUSTED');
    // Resuming without more money pauses it again.
    await f.engine.call('tasks.resume', { taskId: second.id, idempotencyKey: key() });
    assert.equal((await wait(f.engine, second.id, 'paused')).reason, 'TASK_BUDGET_EXHAUSTED');

    const op = await raise(f.engine, run.id, '1');
    assert.equal(op.status, 'completed');
    assert.deepEqual(op.result, {
      taskId: run.id,
      previousMaxCost: '0.15',
      maxCost: '1',
      pausedTaskIds: [second.id, own.id],
    });
    assert.equal((await get(f.engine, run.id)).spec.budget!.maxCost, '1');
    // B03: the copies the children took follow; a child's own amount stays.
    assert.equal((await get(f.engine, first.id)).spec.budget!.maxCost, '1');
    assert.equal((await get(f.engine, second.id)).spec.budget!.maxCost, '1');
    assert.equal((await get(f.engine, own.id)).spec.budget!.maxCost, '0.12');
    // D-bud-2: nothing is resumed by the raise.
    assert.equal((await get(f.engine, second.id)).status, 'paused');
    const raised = (
      (await f.engine.call('events.read', { taskId: run.id })) as {
        events: { type: string; data: Record<string, unknown> }[];
      }
    ).events.filter((event) => event.type === 'task.budget_raised');
    assert.equal(raised.length, 1);
    assert.deepEqual(raised[0].data, {
      previousMaxCost: '0.15',
      maxCost: '1',
      currency: 'USD',
      raisedTaskIds: [first.id, second.id],
    });
    await f.engine.call('tasks.resume', { taskId: second.id, idempotencyKey: key() });
    await wait(f.engine, second.id, 'waiting_approval');
    const costs = (await f.engine.call('costs.get', { taskId: run.id, scope: 'tree' })) as {
      totals: { USD: string };
    };
    assert.equal(costs.totals.USD, '0.2', 'the run stays one tree');
  } finally {
    await f.close();
  }
});

test('0066-B03 a run of one step is not stopped by the copy the step took', async () => {
  const f = await setup();
  try {
    const run = await create(f.engine, { goal: 'run', executor: 'host', budget: budget('0.15') });
    const only = await step(f.engine, 'the only step', { parentTaskId: run.id });
    const review = await wait(f.engine, only.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', {
      approvalId: review.approvalId,
    })) as { revision: number };
    const revise = () =>
      f.engine.call('approvals.decide', {
        approvalId: review.approvalId,
        decision: { choice: 'revise', comment: 'again', expectedRevision: approval.revision },
        idempotencyKey: key(),
      });
    await revise();
    assert.equal((await wait(f.engine, only.id, 'paused')).reason, 'TASK_BUDGET_EXHAUSTED');
    const op = await raise(f.engine, run.id, '0.5');
    assert.deepEqual((op.result as { pausedTaskIds: string[] }).pausedTaskIds, [only.id]);
    await f.engine.call('tasks.resume', { taskId: only.id, idempotencyKey: key() });
    await wait(f.engine, only.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('0066-B02 it only raises, and only a root task with a budget', async () => {
  const f = await setup();
  try {
    const run = await create(f.engine, { goal: 'run', executor: 'host', budget: budget('0.5') });
    const child = await create(f.engine, { goal: 'child', executor: 'host', parentTaskId: run.id });
    const bare = await create(f.engine, { goal: 'no budget', executor: 'host' });
    for (const amount of ['0.5', '0.4', '0', 'much', 5, '-1', '1e3', undefined])
      await assert.rejects(
        raise(f.engine, run.id, amount),
        code('VALIDATION_ERROR'),
        String(amount),
      );
    await assert.rejects(raise(f.engine, child.id, '1'), code('VALIDATION_ERROR'));
    await assert.rejects(raise(f.engine, bare.id, '1'), code('VALIDATION_ERROR'));
    await assert.rejects(raise(f.engine, 'missing', '1'), code('NOT_FOUND'));
    await assert.rejects(
      f.engine.call('tasks.raiseBudget', {
        taskId: run.id,
        maxCost: '1',
        currency: 'EUR',
        idempotencyKey: key(),
      }),
      code('VALIDATION_ERROR'),
    );
    const before = await get(f.engine, run.id);
    assert.equal(before.spec.budget!.maxCost, '0.5');
    // A root that ended still takes children, so its budget can still be raised.
    await f.engine.call('tasks.complete', {
      taskId: run.id,
      outcome: 'completed',
      idempotencyKey: key(),
    });
    assert.equal((await raise(f.engine, run.id, '0.50001')).status, 'completed');
    const after = await get(f.engine, run.id);
    assert.equal(after.spec.budget!.maxCost, '0.50001');
    assert.equal(after.spec.budget!.reservePerDispatch, '0.1');
    assert.equal(after.status, 'completed');
  } finally {
    await f.close();
  }
});

test('0066-B04 B07 a repeated raise returns the first operation, and the amount holds after a restart', async () => {
  const f = await setup();
  try {
    const run = await step(f.engine, 'a runtime root', { budget: budget('0.5') });
    const ended = await create(f.engine, { goal: 'ended', executor: 'host', parentTaskId: run.id });
    await f.engine.call('tasks.cancel', { taskId: ended.id, idempotencyKey: key() });
    const idempotencyKey = key();
    const op = await raise(f.engine, run.id, '2', idempotencyKey);
    assert.equal((await raise(f.engine, run.id, '2', idempotencyKey)).id, op.id);
    await assert.rejects(
      raise(f.engine, run.id, '3', idempotencyKey),
      code('IDEMPOTENCY_CONFLICT'),
    );
    assert.equal(
      (await get(f.engine, ended.id)).spec.budget!.maxCost,
      '0.5',
      'an ended task keeps its amount',
    );
    await f.restart();
    assert.equal((await get(f.engine, run.id)).spec.budget!.maxCost, '2');
    const info = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(info.capabilities.workflow.budgetRaise, true);
  } finally {
    await f.close();
  }
});
