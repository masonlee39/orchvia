import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { schemaValidator } from '../fixtures/schema-validator.ts';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const models = { fake: { models: ['alpha', 'beta'] } };
const runtime = (model: string) => ({ provider: 'fake', model });
const spec = (model = 'alpha', extra: Record<string, unknown> = {}) => ({
  goal: 'A deterministic task',
  runtime: runtime(model),
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});

/** Records every dispatch input; capability overrides model runtime declarations. */
function capturing(
  capabilities: (base: Record<string, unknown>) => Record<string, unknown>,
  before?: (input: RuntimeInput) => Promise<void>,
) {
  const base = createFakeAdapter();
  const inputs: RuntimeInput[] = [];
  const adapter: RuntimeAdapter = {
    ...base,
    capabilities: () =>
      capabilities(base.capabilities() as Record<string, unknown>) as ReturnType<
        RuntimeAdapter['capabilities']
      >,
    async *execute(input) {
      inputs.push(input);
      await before?.(input);
      yield* base.execute(input);
    },
  };
  return { adapter, inputs };
}
const withChange = (base: Record<string, unknown>) => ({ ...base, forkModelChange: true });
const withoutChange = (base: Record<string, unknown>) => {
  const { forkModelChange: _omit, ...rest } = base;
  return rest;
};

async function setup(overrides: Partial<EngineConfig> = {}, dir?: string) {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'orch-fork-model-')));
  await mkdir(join(root, 'workspace'), { recursive: true });
  const probe = capturing(withChange);
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [probe.adapter],
    providers: models,
    ...overrides,
  }).catch(async (error) => {
    // Tests that expect startup to fail get no close(); a directory passed in stays the caller's.
    if (!dir) await rm(root, { recursive: true, force: true });
    throw error;
  });
  return {
    root,
    engine,
    inputs: probe.inputs,
    sessions: () =>
      (
        (
          engine as unknown as { store: { db: { prepare(sql: string): { get(): unknown } } } }
        ).store.db
          .prepare('SELECT COUNT(*) AS n FROM sessions')
          .get() as { n: number }
      ).n,
    async close(keep = false) {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      if (!keep) await rm(root, { recursive: true, force: true });
    },
  };
}
const create = async (engine: Engine, taskSpec: Record<string, unknown>) =>
  (await engine.call('tasks.create', {
    spec: taskSpec,
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task did not become ${status}`);
}
async function complete(engine: Engine, task: TaskSnapshot) {
  const pending = await wait(engine, task.id, 'waiting_approval');
  await engine.call('approvals.decide', {
    approvalId: pending.approvalId,
    decision: { choice: 'approve', expectedRevision: 1 },
    idempotencyKey: crypto.randomUUID(),
  });
  return wait(engine, task.id, 'completed');
}
const target = (session: SessionSnapshot) => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedState: session.status,
  expectedDispatchId: session.activeDispatchId,
});
const reuse = (candidateSessionId: string) => ({
  requestedMode: 'reuse',
  independent: true,
  candidateSessionId,
  dependencyTaskIds: [],
  contextRefs: [],
  fallbackModes: [],
  maxQueueWaitMs: 1000,
});
/** A completed alpha source session and the artifact that can be forked. */
async function source(engine: Engine, extra: Record<string, unknown> = {}) {
  const task = await complete(engine, await create(engine, spec('alpha', extra)));
  const session = (await engine.call('sessions.get', {
    sessionId: task.sessionId,
  })) as SessionSnapshot;
  return { task, session, ref: task.artifactRefs[0] };
}
const fork = (engine: Engine, from: SessionSnapshot, ref: string, extra = {}, key = 'fork') =>
  engine.call('sessions.fork', {
    target: target(from),
    snapshotRef: ref,
    idempotencyKey: key,
    ...extra,
  }) as Promise<SessionSnapshot>;

test('0013-M01 engine providers accept an allowed model list and reject invalid lists', async () => {
  const f = await setup();
  try {
    for (const model of ['alpha', 'beta'])
      assert.equal((await create(f.engine, spec(model))).spec.runtime.model, model);
    await assert.rejects(create(f.engine, spec('gamma')), { code: 'VALIDATION_ERROR' });
  } finally {
    await f.close();
  }
  for (const providers of [
    { fake: { model: 'alpha', models: ['alpha'] } },
    { fake: { models: [] } },
    { fake: { models: ['alpha', 'alpha'] } },
    { fake: { models: ['alpha', ''] } },
    { fake: { models: 'alpha' } },
  ])
    await assert.rejects(
      async () => {
        const opened = await setup({ providers } as unknown as Partial<EngineConfig>);
        await opened.close();
      },
      { code: 'VALIDATION_ERROR' },
      JSON.stringify(providers),
    );
  const single = await setup({ providers: { fake: { model: 'alpha' } } });
  try {
    await create(single.engine, spec('alpha'));
    await assert.rejects(create(single.engine, spec('beta')), { code: 'VALIDATION_ERROR' });
  } finally {
    await single.close();
  }
});

test('0013-M01 removing an allowed model on restart keeps sessions and rejects new tasks', async () => {
  const first = await setup();
  const done = await complete(first.engine, await create(first.engine, spec('beta')));
  await first.close(true);
  const second = await setup({ providers: { fake: { models: ['alpha'] } } }, first.root);
  try {
    const kept = (await second.engine.call('sessions.get', {
      sessionId: done.sessionId,
    })) as SessionSnapshot;
    assert.equal(kept.model, 'beta');
    await assert.rejects(create(second.engine, spec('beta')), { code: 'VALIDATION_ERROR' });
  } finally {
    await second.close();
  }
});

test('0013-M01 JSON CLI configuration accepts models and rejects model plus models', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-fork-model-cli-')));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'), { mode: 0o700 });
    const write = async (fake: Record<string, unknown>) => {
      const path = join(root, `config-${crypto.randomUUID()}.json`);
      await writeFile(
        path,
        JSON.stringify({
          configVersion: 1,
          workspace: join(root, 'workspace'),
          stateDir: join(root, 'state'),
          providers: { fake },
        }),
      );
      return path;
    };
    const loaded = await loadConfig(await write({ models: ['alpha', 'beta'] }));
    assert.deepEqual(loaded.providers.fake.models, ['alpha', 'beta']);
    await loadConfig(await write({ model: 'alpha' }));
    for (const fake of [{ model: 'alpha', models: ['alpha'] }, {}, { models: [] }])
      await assert.rejects(loadConfig(await write(fake)), { code: 'INVALID_CONFIG' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('0013-M02 a model-changing fork requires acknowledgment and creates no session without it', async () => {
  const f = await setup();
  try {
    const { session, ref } = await source(f.engine);
    const before = f.sessions();
    await assert.rejects(fork(f.engine, session, ref, { model: 'beta' }, 'no-ack'), {
      code: 'CACHE_LOSS_NOT_ACKNOWLEDGED',
    });
    assert.equal(f.sessions(), before);
    const forked = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    assert.equal(forked.model, 'beta');
    assert.equal(forked.provider, 'fake');
    assert.equal(f.sessions(), before + 1);
    const unchanged = (await f.engine.call('sessions.get', {
      sessionId: session.id,
    })) as SessionSnapshot;
    assert.equal(unchanged.model, 'alpha');
    assert.equal(unchanged.revision, session.revision);
    const change = { fromModel: 'alpha', toModel: 'beta', promptCacheReuse: false };
    const op = (await f.engine.call('operations.lookup', {
      method: 'sessions.fork',
      scope: session.id,
      idempotencyKey: 'fork',
    })) as OperationSnapshot;
    assert.deepEqual((op.result as Record<string, unknown>).modelChange, change);
    const page = (await f.engine.call('events.read', { limit: 1000 })) as EventPage;
    const prepared = page.events.find((event) => event.type === 'session.fork_prepared');
    assert.deepEqual(prepared?.data.modelChange, change);
  } finally {
    await f.close();
  }
});

test('0013-M02 a fork idempotency key binds the target model', async () => {
  const f = await setup();
  try {
    const { session, ref } = await source(f.engine);
    const forked = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    const replay = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    assert.equal(replay.id, forked.id);
    await assert.rejects(fork(f.engine, session, ref, {}), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(fork(f.engine, session, ref, { model: 'alpha' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(
      fork(f.engine, session, ref, { model: 'beta', acknowledgeCacheLoss: 'yes' }, 'typed'),
      { code: 'VALIDATION_ERROR' },
    );
  } finally {
    await f.close();
  }
});

test('0013-M02 the fork runs on the target model with the source native binding', async () => {
  const f = await setup();
  try {
    const { task, session, ref } = await source(f.engine);
    const forked = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    await assert.rejects(
      create(f.engine, spec('alpha', { parentTaskId: task.id, contextPlan: reuse(forked.id) })),
      { code: 'SESSION_INCOMPATIBLE' },
    );
    const branch = await create(
      f.engine,
      spec('beta', { parentTaskId: task.id, contextPlan: reuse(forked.id) }),
    );
    await complete(f.engine, branch);
    const input = f.inputs.find((item) => item.taskId === branch.id);
    assert.equal(input?.model, 'beta');
    assert.equal(input?.forkSource?.providerSessionId, session.providerSessionId);
    assert.equal(input?.forkSource?.nativeCheckpoint, session.nativeCheckpoint);
  } finally {
    await f.close();
  }
});

test('0013-M02 omitting model or naming the source model keeps the existing fork', async () => {
  const f = await setup();
  try {
    const { session, ref } = await source(f.engine);
    for (const [extra, key] of [
      [{}, 'plain'],
      [{ model: 'alpha' }, 'same'],
    ] as const) {
      const forked = await fork(f.engine, session, ref, extra, key);
      assert.equal(forked.model, 'alpha');
      const op = (await f.engine.call('operations.lookup', {
        method: 'sessions.fork',
        scope: session.id,
        idempotencyKey: key,
      })) as OperationSnapshot;
      assert.equal((op.result as Record<string, unknown>).modelChange, undefined);
    }
  } finally {
    await f.close();
  }
});

test('0013-M02 targets must be listed and model changes need an explicit list', async () => {
  const listed = await setup();
  try {
    const { session, ref } = await source(listed.engine);
    await assert.rejects(
      fork(listed.engine, session, ref, { model: 'gamma', acknowledgeCacheLoss: true }, 'gamma'),
      { code: 'VALIDATION_ERROR', message: /allowed model/ },
    );
    assert.equal(
      (await fork(listed.engine, session, ref, { model: 'beta', acknowledgeCacheLoss: true }))
        .model,
      'beta',
    );
  } finally {
    await listed.close();
  }
  const unlisted = await setup({ providers: {} });
  try {
    const { session, ref } = await source(unlisted.engine);
    await assert.rejects(
      fork(unlisted.engine, session, ref, { model: 'beta', acknowledgeCacheLoss: true }),
      { code: 'VALIDATION_ERROR', message: /allowed model/ },
    );
  } finally {
    await unlisted.close();
  }
});

test('0013-M02 an inline fork keeps the source model', async () => {
  const f = await setup();
  try {
    const { task, session, ref } = await source(f.engine);
    await assert.rejects(
      create(
        f.engine,
        spec('beta', {
          parentTaskId: task.id,
          contextPlan: {
            requestedMode: 'fork',
            independent: true,
            candidateSessionId: session.id,
            snapshotRef: ref,
            dependencyTaskIds: [],
            contextRefs: [],
            fallbackModes: [],
            maxQueueWaitMs: 1000,
          },
        }),
      ),
      { code: 'SESSION_INCOMPATIBLE' },
    );
  } finally {
    await f.close();
  }
});

test('0013-M06 bound runtime tools cannot choose a model or claim a prepared fork', async () => {
  let checked!: (error?: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    checked = resolve;
  });
  const probe = capturing(withChange, async (input) => {
    if (input.prompt !== 'tool parent') return;
    try {
      const tools = (
        input as RuntimeInput & {
          orchestrationTools?: { call(name: string, args: unknown): Promise<unknown> };
        }
      ).orchestrationTools!;
      const fresh = { requestedMode: 'fresh', independent: true };
      for (const extra of [{ model: 'beta' }, { runtime: runtime('beta') }])
        await assert.rejects(
          tools.call('work_delegate', {
            goal: 'child',
            contextPlan: fresh,
            idempotencyKey: crypto.randomUUID(),
            ...extra,
          }),
          { code: 'VALIDATION_ERROR' },
        );
      await assert.rejects(
        tools.call('work_delegate', {
          goal: 'child',
          contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: prepared },
          idempotencyKey: crypto.randomUUID(),
        }),
        { code: 'UNAUTHORIZED' },
      );
      checked();
    } catch (error) {
      checked(error);
    }
  });
  let prepared = '';
  const f = await setup({ adapters: [probe.adapter], tools: { enabled: true } });
  try {
    const { session, ref } = await source(f.engine);
    prepared = (await fork(f.engine, session, ref, { model: 'beta', acknowledgeCacheLoss: true }))
      .id;
    await create(f.engine, { ...spec('alpha'), goal: 'tool parent' });
    const failure = await done;
    if (failure) throw failure;
  } finally {
    await f.close();
  }
});

test('0013-M03 model-changing forks require the declared runtime capability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-fork-model-cap-'));
  await mkdir(join(dir, 'workspace'));
  const plain = capturing(withoutChange);
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [plain.adapter],
    providers: models,
  });
  try {
    const { session, ref } = await source(engine);
    await assert.rejects(
      fork(engine, session, ref, { model: 'beta', acknowledgeCacheLoss: true }, 'unsupported'),
      { code: 'UNSUPPORTED_CAPABILITY' },
    );
    assert.equal((await fork(engine, session, ref, {}, 'same')).model, 'alpha');
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
  const malformed = capturing((base) => ({ ...base, forkModelChange: 'yes' }));
  await assert.rejects(
    async () => {
      const bad = await setup({ adapters: [malformed.adapter] });
      try {
        await create(bad.engine, spec('alpha'));
      } finally {
        await bad.close();
      }
    },
    { code: 'INVALID_RUNTIME_CONTRACT' },
  );
  assert.equal(createClaudeAdapter().capabilities().forkModelChange, true);
  assert.notEqual(
    createCodexAdapter({ executionStop: 'owner-reconcile' }).capabilities().forkModelChange,
    true,
  );
  assert.equal(createFakeAdapter().capabilities().forkModelChange, true);
});

test('0013-M04 context limits apply to the fork target model', async () => {
  const estimate = { inputTokens: 5000, outputReserveTokens: 0, toolReserveTokens: 0 };
  const f = await setup({
    contextLimits: {
      'fake/alpha': { windowTokens: 1_000_000, safetyTokens: 0 },
      'fake/beta': { windowTokens: 1000, safetyTokens: 0 },
    },
  });
  try {
    const { task, session, ref } = await source(f.engine, { contextEstimate: estimate });
    const forked = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    const branch = await create(
      f.engine,
      spec('beta', {
        parentTaskId: task.id,
        contextPlan: reuse(forked.id),
        contextEstimate: estimate,
      }),
    );
    assert.equal((await wait(f.engine, branch.id, 'paused')).reason, 'CONTEXT_CAPACITY');
  } finally {
    await f.close();
  }
});

test('0013-M04 an active budget needs a price for the fork target model', async () => {
  const f = await setup({
    pricing: [
      {
        provider: 'fake',
        model: 'alpha',
        currency: 'USD',
        version: 'fixture',
        inputTokenMode: 'uncached',
        perMillion: { input: '1', output: '1' },
      },
    ],
    budget: { currency: 'USD', maxCost: '10', reservePerDispatch: '0.01' },
  });
  try {
    const { task, session, ref } = await source(f.engine);
    const forked = await fork(f.engine, session, ref, {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    const branch = await create(
      f.engine,
      spec('beta', { parentTaskId: task.id, contextPlan: reuse(forked.id) }),
    );
    assert.equal((await wait(f.engine, branch.id, 'paused')).reason, 'BUDGET_PRICE_UNKNOWN');
  } finally {
    await f.close();
  }
});

test('0013-M06 fork parameters are negotiated, schema-valid and exposed by the TypeScript SDK', async () => {
  const validate = schemaValidator(
    JSON.parse(
      await readFile(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'),
    ),
  );
  const params = {
    target: {
      sessionId: 's',
      expectedGeneration: 1,
      expectedRevision: 1,
      expectedState: 'idle',
      expectedDispatchId: null,
    },
    snapshotRef: 'sha256:x',
    model: 'beta',
    acknowledgeCacheLoss: true,
    expectedStoreId: 'store',
    idempotencyKey: 'k',
  };
  validate('SessionForkParams', params);
  assert.throws(() => validate('SessionForkParams', { ...params, acknowledgeCacheLoss: 'yes' }));
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-fork-model-sdk-')));
  await mkdir(join(dir, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    providers: models,
    storage: { emergencyBytes: 4096 },
  });
  try {
    assert.equal(
      (orch.info.capabilities.sessionLifecycle as Record<string, unknown>).forkModel,
      true,
    );
    const handle = await orch.tasks.create(spec('alpha') as never);
    let current = await orch.tasks.get(handle.id);
    for (let i = 0; i < 400 && current.status !== 'waiting_approval'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = await orch.tasks.get(handle.id);
    }
    const approval = await orch.approvals.get(current.approvalId!);
    await (
      await orch.approvals.decide(approval.approvalId, {
        choice: 'approve',
        expectedRevision: approval.revision,
      })
    ).wait({ timeoutMs: 2000 });
    const done = await orch.tasks.get(handle.id);
    const from = await orch.sessions.get(done.sessionId);
    const forked = await orch.sessions.fork(target(from), done.artifactRefs[0], {
      model: 'beta',
      acknowledgeCacheLoss: true,
    });
    assert.equal(forked.model, 'beta');
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});
