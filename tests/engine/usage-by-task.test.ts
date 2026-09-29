import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
  UsageRecord,
} from '../../packages/engine/src/types.ts';

// SPEC-0029 A: token totals of 1 to 100 tasks in one call, each task's own records per model.

type Store = {
  db: {
    prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  };
};
type Totals = {
  records: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  unknownRecords: number;
};
type TaskTotals = {
  taskId: string;
  byModel: (Totals & { provider: string; model: string | null })[];
  totals: Totals;
  completeness: 'reported' | 'unknown';
  reasoningEfforts: string[];
};
type ByTask = { tasks: TaskTotals[]; missing: string[] };

/** A fake runtime that reports one usage record per dispatch, with counts taken from the goal. */
function reporting(): RuntimeAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        yield event;
        if (event.type === 'accepted') {
          const unknown = input.prompt.includes('unknown usage');
          const size = Number(/size=(\d+)/.exec(input.prompt)?.[1] ?? 1);
          yield {
            type: 'usage',
            usageId: 'u1',
            usage: {
              inputTokens: unknown ? null : size * 10,
              cachedInputTokens: unknown ? null : size,
              cacheWriteInputTokens: null,
              outputTokens: unknown ? null : size * 2,
              raw: { size },
            },
          };
        }
      }
    },
  };
}
async function setup(overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-usage-by-task-')));
  await mkdir(join(root, 'workspace'));
  const stateDir = join(root, 'state');
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [reporting()],
    providers: { fake: { models: ['small', 'large'] } },
    ...overrides,
  });
  return {
    engine,
    stateDir,
    store: (engine as unknown as { store: Store }).store,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function create(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'small' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      ...extra,
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
}
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
async function approve(engine: Engine, id: string) {
  const task = await wait(engine, id, 'waiting_approval');
  const approval = (await engine.call('approvals.get', { approvalId: task.approvalId })) as {
    revision: number;
  };
  await engine.call('approvals.decide', {
    approvalId: task.approvalId,
    decision: { choice: 'approve', expectedRevision: approval.revision },
    idempotencyKey: crypto.randomUUID(),
  });
  return wait(engine, id, 'completed');
}
/** A root with a child on the large model and a grandchild, and a task whose usage is unknown. */
async function tree(engine: Engine) {
  const root = await create(engine, 'root size=1');
  await approve(engine, root.id);
  const child = await create(engine, 'child size=2', {
    parentTaskId: root.id,
    runtime: { provider: 'fake', model: 'large' },
  });
  await approve(engine, child.id);
  const grandchild = await create(engine, 'grandchild size=4', { parentTaskId: child.id });
  await approve(engine, grandchild.id);
  const unknown = await create(engine, 'unknown usage');
  await approve(engine, unknown.id);
  return { root, child, grandchild, unknown };
}
const totals = (size: number): Totals => ({
  records: 1,
  inputTokens: size * 10,
  cachedInputTokens: size,
  cacheWriteInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  outputTokens: size * 2,
  unknownRecords: 0,
});

test('0029-A01 usage.byTask totals each task’s own records per model, in the order requested', async () => {
  const f = await setup();
  try {
    const { root, child, grandchild, unknown } = await tree(f.engine);
    const result = (await f.engine.call('usage.byTask', {
      taskIds: [child.id, 'missing-1', root.id, unknown.id, grandchild.id, 'missing-0'],
    })) as ByTask;
    assert.deepEqual(result.missing, ['missing-1', 'missing-0']);
    assert.deepEqual(
      result.tasks.map((task) => task.taskId),
      [child.id, root.id, unknown.id, grandchild.id],
    );
    const [childTotals, rootTotals, unknownTotals, grandchildTotals] = result.tasks;
    assert.deepEqual(childTotals, {
      taskId: child.id,
      byModel: [{ provider: 'fake', model: 'large', ...totals(2) }],
      totals: totals(2),
      completeness: 'reported',
      reasoningEfforts: [],
    });
    // A task's own records only: the root does not count its children.
    assert.deepEqual(rootTotals.totals, totals(1));
    assert.deepEqual(grandchildTotals.byModel, [
      { provider: 'fake', model: 'small', ...totals(4) },
    ]);
    assert.equal(unknownTotals.completeness, 'unknown');
    assert.equal(unknownTotals.totals.unknownRecords, 1);
    assert.equal(unknownTotals.totals.inputTokens, 0);
    // The same records and completeness as usage.get of each task.
    for (const entry of result.tasks) {
      const single = (await f.engine.call('usage.get', { taskId: entry.taskId })) as {
        records: UsageRecord[];
        completeness: string;
      };
      assert.equal(entry.totals.records, single.records.length, entry.taskId);
      assert.equal(entry.completeness, single.completeness, entry.taskId);
    }
    // Records written before SPEC-0028 E01 take their session's model, and none once the
    // dispatch was collected.
    f.store.db
      .prepare(
        "UPDATE usage SET data=json_remove(data,'$.model','$.sessionId','$.rootTaskId','$.recordedAt')",
      )
      .run();
    f.store.db
      .prepare("DELETE FROM dispatches WHERE json_extract(data,'$.taskId')=?")
      .run(grandchild.id);
    const older = (await f.engine.call('usage.byTask', {
      taskIds: [child.id, grandchild.id],
    })) as ByTask;
    assert.deepEqual(
      older.tasks.map((task) => task.byModel.map((entry) => entry.model)),
      [['large'], [null]],
    );
  } finally {
    await f.close();
  }
});

test('0029-A01 usage.byTask refuses an empty, longer or repeated list', async () => {
  const f = await setup();
  try {
    const task = await create(f.engine, 'task');
    await wait(f.engine, task.id, 'waiting_approval');
    const hundred = Array.from({ length: 100 }, (_, n) => `missing-${n}`);
    const all = (await f.engine.call('usage.byTask', { taskIds: hundred })) as ByTask;
    assert.equal(all.missing.length, 100);
    assert.deepEqual(all.tasks, []);
    for (const bad of [
      {},
      { taskIds: [] },
      { taskIds: [...hundred, 'one-more'] },
      { taskIds: [task.id, task.id] },
      { taskIds: [''] },
      { taskIds: task.id },
      { taskIds: [task.id], extra: true },
    ])
      await assert.rejects(f.engine.call('usage.byTask', bad), { code: 'VALIDATION_ERROR' });
  } finally {
    await f.close();
  }
});

/** Records every statement the store prepares while `run` runs. */
async function statements(store: Store, run: () => Promise<unknown>): Promise<string[]> {
  const db = store.db as unknown as { prepare(sql: string): unknown };
  const prepare = db.prepare;
  const seen: string[] = [];
  db.prepare = (sql: string) => {
    seen.push(sql);
    return prepare.call(store.db, sql);
  };
  try {
    await run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

test('0029-A02 usage.byTask reads the records of all its tasks in one indexed statement', async () => {
  const f = await setup();
  try {
    const { root, child, unknown } = await tree(f.engine);
    const sql = await statements(f.store, () =>
      f.engine.call('usage.byTask', { taskIds: [root.id, child.id, unknown.id, 'missing'] }),
    );
    // Counted as prepared, not as distinct text: one statement per task would repeat one text.
    const usageStatements = sql.filter((statement) => /\busage\b/.test(statement));
    assert.equal(usageStatements.length, 1, JSON.stringify(usageStatements));
    const steps: string[] = [];
    for (const statement of new Set(sql))
      if (/\b(tasks|usage)\b/.test(statement))
        for (const step of f.store.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as {
          detail: string;
        }[])
          steps.push(step.detail);
    assert.deepEqual(
      steps.filter((step) => /^SCAN /.test(step)),
      [],
      JSON.stringify(steps),
    );
    assert.ok(
      steps.some((step) => step.includes('usage_task')),
      JSON.stringify(steps),
    );
  } finally {
    await f.close();
  }
});

test('0029-A03 a read-only view answers usage.byTask as the engine does', async () => {
  const f = await setup();
  try {
    const { root, child, unknown } = await tree(f.engine);
    const taskIds = [unknown.id, root.id, 'missing', child.id];
    const online = await f.engine.call('usage.byTask', { taskIds });
    const reader = await openReadOnlyEngine({ stateDir: f.stateDir });
    try {
      assert.deepEqual(await reader.call('usage.byTask', { taskIds }), online);
      const hello = (await reader.call('initialize', {
        protocolVersion: '2.0',
        sdkVersion: 'test',
      })) as { capabilities: { workflow: Record<string, unknown> } };
      assert.equal(hello.capabilities.workflow.usageByTask, true);
    } finally {
      await reader.close();
    }
    const hello = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(hello.capabilities.workflow.usageByTask, true);
  } finally {
    await f.close();
  }
});
