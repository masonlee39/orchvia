import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { Store } from '../../packages/engine/src/store.ts';
import type {
  RuntimeAdapter,
  RuntimeInput,
  Engine,
  EngineConfig,
  TaskSnapshot,
  SessionSnapshot,
} from '../../packages/engine/src/types.ts';

const spec = {
  goal: 'parent',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Owner review'] },
};
async function run(
  action: (input: RuntimeInput, engine: Engine) => Promise<void>,
  options: Partial<EngineConfig> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-tools-'));
  await mkdir(join(dir, 'workspace'));
  const fake = createFakeAdapter();
  let engine: Engine;
  let complete!: () => void;
  let failure: unknown;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input) {
      if (input.prompt === 'parent') {
        try {
          await action(input, engine);
        } catch (error) {
          failure = error;
        }
        complete();
      }
      yield* fake.execute(input);
    },
  };
  engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    tools: { enabled: true },
    ...options,
  } as EngineConfig);
  try {
    await engine.call('tasks.create', { spec, idempotencyKey: 'parent' });
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('Tool fixture timed out')), 1500);
        t.unref();
      }),
    ]);
    if (failure) throw failure;
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
}

test('AC-F05 four bound tools delegate, replay, send, read and control only the granted subtree', async () => {
  await run(async (input, engine) => {
    const tools = (
      input as RuntimeInput & {
        orchestrationTools?: {
          definitions: { name: string }[];
          call(name: string, args: unknown): Promise<unknown>;
        };
      }
    ).orchestrationTools;
    assert.ok(tools);
    assert.deepEqual(
      tools.definitions.map((d) => d.name),
      ['work_delegate', 'work_send', 'work_read', 'work_control'],
    );
    const request = {
      goal: 'child',
      contextPlan: { requestedMode: 'fresh', independent: true },
      idempotencyKey: 'child-key',
    };
    const child = (await tools.call('work_delegate', request)) as unknown as TaskSnapshot;
    const repeated = (await tools.call('work_delegate', request)) as unknown as TaskSnapshot;
    assert.equal(child.id, repeated.id);
    assert.equal(child.spec.parentTaskId, input.taskId);
    const session = (await tools.call('work_read', { kind: 'session', id: child.sessionId })) as {
      generation: number;
    };
    await tools.call('work_send', {
      taskId: child.id,
      toSessionId: child.sessionId,
      expectedGeneration: session.generation,
      kind: 'finding',
      summary: 'bounded context',
      idempotencyKey: 'message',
    });
    const outsider = (await engine.call('tasks.create', {
      spec: { ...spec, goal: 'outside' },
      idempotencyKey: 'outside',
    })) as TaskSnapshot;
    await assert.rejects(tools.call('work_read', { kind: 'task', id: outsider.id }), {
      code: 'UNAUTHORIZED',
    });
    await assert.rejects(tools.call('approvals.decide', {}), { code: 'UNAUTHORIZED' });
    await assert.rejects(tools.call('work_delegate', { ...request, actor: 'host_owner' }), {
      code: 'VALIDATION_ERROR',
    });
    await assert.rejects(
      tools.call('work_control', {
        target: { sessionId: outsider.sessionId },
        command: { action: 'stop' },
        idempotencyKey: 'control',
      }),
      { code: 'UNAUTHORIZED' },
    );
  });
});

test('AC-F05 stale grants reject calls after a dispatch has finished', async () => {
  let retained: { call(name: string, args: unknown): Promise<unknown> } | undefined;
  await run(async (input) => {
    retained = (input as unknown as { orchestrationTools: typeof retained }).orchestrationTools;
    assert.ok(retained);
  });
  await assert.rejects(retained!.call('work_read', { kind: 'task', id: 'anything' }), {
    code: 'STALE_GRANT',
  });
});

test('AC-F09 delegation and identical-read loops stop at finite durable limits', async () => {
  await run(
    async (input) => {
      const tools = (
        input as unknown as {
          orchestrationTools: { call(name: string, args: unknown): Promise<unknown> };
        }
      ).orchestrationTools;
      assert.ok(tools);
      await tools.call('work_read', { kind: 'task', id: input.taskId });
      await tools.call('work_read', { kind: 'task', id: input.taskId });
      await assert.rejects(tools.call('work_read', { kind: 'task', id: input.taskId }), {
        code: 'TOOL_LOOP_LIMIT',
      });
    },
    { tools: { enabled: true, maxRepeatedCalls: 2 } } as Partial<EngineConfig>,
  );
});

test('0012-R01 a client pause cannot be resumed by a bound runtime tool', async () => {
  await run(
    async (input, engine) => {
      const tools = input.orchestrationTools!;
      const child = (await tools.call('work_delegate', {
        goal: 'paused child',
        contextPlan: { requestedMode: 'fresh', independent: true },
        idempotencyKey: 'paused-child',
      })) as unknown as TaskSnapshot;
      const session = async () =>
        (await engine.call('sessions.get', { sessionId: child.sessionId })) as {
          id: string;
          generation: number;
          revision: number;
          activeDispatchId: string | null;
          status: string;
          pauseOrigin?: string;
        };
      const target = (s: Awaited<ReturnType<typeof session>>) => ({
        sessionId: s.id,
        expectedGeneration: s.generation,
        expectedRevision: s.revision,
        expectedDispatchId: s.activeDispatchId,
        expectedState: s.status,
      });
      await engine.call('sessions.control', {
        target: target(await session()),
        command: { action: 'pause' },
        idempotencyKey: 'client-pause',
      });
      assert.equal((await session()).pauseOrigin, 'client');
      for (const action of ['stop', 'rotate', 'compact'])
        await assert.rejects(
          tools.call('work_control', {
            target: target(await session()),
            command: { action },
            idempotencyKey: `runtime-${action}-client`,
          }),
          { code: 'UNAUTHORIZED' },
        );
      await assert.rejects(
        tools.call('work_control', {
          target: target(await session()),
          command: { action: 'resume' },
          idempotencyKey: 'runtime-resume-client',
        }),
        { code: 'UNAUTHORIZED' },
      );
      assert.equal((await session()).status, 'paused');
      const store = (engine as unknown as { store: Store }).store;
      const legacy = store.require<SessionSnapshot>('sessions', child.sessionId!);
      delete legacy.pauseOrigin;
      store.put('sessions', legacy.id, legacy);
      await assert.rejects(
        tools.call('work_control', {
          target: target(await session()),
          command: { action: 'resume' },
          idempotencyKey: 'runtime-resume-legacy',
        }),
        { code: 'UNAUTHORIZED' },
      );
      await engine.call('sessions.control', {
        target: target(await session()),
        command: { action: 'pause' },
        idempotencyKey: 'client-claims-legacy',
      });
      assert.equal((await session()).pauseOrigin, 'client');
      await engine.call('sessions.control', {
        target: target(await session()),
        command: { action: 'resume' },
        idempotencyKey: 'client-resume',
      });
      assert.equal((await session()).pauseOrigin, undefined);
      await tools.call('work_control', {
        target: target(await session()),
        command: { action: 'pause' },
        idempotencyKey: 'runtime-pause',
      });
      assert.equal((await session()).pauseOrigin, 'runtime');
      await tools.call('work_control', {
        target: target(await session()),
        command: { action: 'resume' },
        idempotencyKey: 'runtime-resume-own',
      });
      assert.equal((await session()).pauseOrigin, undefined);
      await tools.call('work_control', {
        target: target(await session()),
        command: { action: 'pause' },
        idempotencyKey: 'runtime-pause-again',
      });
      await engine.call('sessions.control', {
        target: target(await session()),
        command: { action: 'pause' },
        idempotencyKey: 'client-takes-pause',
      });
      assert.equal((await session()).pauseOrigin, 'client');
      await assert.rejects(
        tools.call('work_control', {
          target: target(await session()),
          command: { action: 'resume' },
          idempotencyKey: 'runtime-resume-taken',
        }),
        { code: 'UNAUTHORIZED' },
      );
    },
    { limits: { maxActiveSessions: 1 } },
  );
});

test('0012-R01 client pause origin remains durable across engine restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-pause-origin-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const config = {
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
  };
  let engine = await createEngine(config);
  try {
    const task = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'durable-pause',
    })) as TaskSnapshot;
    for (let i = 0; i < 100; i++) {
      if (
        ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status ===
        'waiting_approval'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const original = (await engine.call('sessions.get', { sessionId: task.sessionId })) as {
      id: string;
      generation: number;
      revision: number;
      activeDispatchId: string | null;
      status: string;
      pauseOrigin?: string;
    };
    assert.equal(original.status, 'idle');
    const target = (s: typeof original) => ({
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    });
    await engine.call('sessions.control', {
      target: target(original),
      command: { action: 'pause' },
      idempotencyKey: 'pause-before-restart',
    });
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    engine = await createEngine(config);
    const persisted = (await engine.call('sessions.get', {
      sessionId: task.sessionId,
    })) as typeof original;
    assert.equal(persisted.status, 'paused');
    assert.equal(persisted.pauseOrigin, 'client');
    await engine.call('sessions.control', {
      target: target(persisted),
      command: { action: 'resume' },
      idempotencyKey: 'resume-after-restart',
    });
    const resumed = (await engine.call('sessions.get', {
      sessionId: task.sessionId,
    })) as typeof original;
    assert.equal(resumed.pauseOrigin, undefined);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});

test('0012-R02 bound reads do not scan unrelated tasks', async () => {
  await run(async (input, engine) => {
    const store = (engine as unknown as { store: Store }).store;
    const original = store.all.bind(store);
    store.all = (table) => {
      if (table === 'tasks') throw new Error('global task scan in bound tool');
      return original(table);
    };
    try {
      const task = (await input.orchestrationTools!.call('work_read', {
        kind: 'task',
        id: input.taskId,
      })) as { id: string };
      assert.equal(task.id, input.taskId);
    } finally {
      store.all = original;
    }
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE json_extract(data, '$.spec.parentTaskId')=?",
      )
      .all(input.taskId) as { detail: string }[];
    assert.ok(plan.some((row) => row.detail.includes('SEARCH tasks USING INDEX tasks_parent')));
  });
});
