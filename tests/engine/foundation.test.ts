import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  TaskSnapshot,
  OperationSnapshot,
  SessionSnapshot,
  ApprovalRequest,
  EventPage,
  MessageSnapshot,
} from '../../packages/engine/src/types.ts';

function approvalClock() {
  let wall = Date.now();
  return {
    advance(ms: number) {
      wall += ms;
    },
    clock: {
      wallNow: () => wall,
      monotonicNow: () => performance.now(),
      setTimer(callback: () => void, delay: number) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
  };
}
const spec = {
  goal: 'Inspect the fixture',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human' as const, criteria: ['Evidence checked'] },
};
async function fixture(overrides: Partial<EngineConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-engine-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const stateDir = join(dir, 'state');
  const config: EngineConfig = {
    workspace,
    stateDir,
    adapters: [createFakeAdapter({ result: 'verified candidate' })],
    ...overrides,
  };
  const engine = await createEngine(config);
  return {
    engine,
    config,
    async cleanup() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function call<T>(
  engine: Engine,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (await engine.call(method, params)) as T;
}
async function until<T>(
  fn: () => Promise<T>,
  predicate: (x: T) => boolean,
  timeout = 2000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('Expected state was not reached');
}
async function create(engine: Engine, key = 'task-1'): Promise<TaskSnapshot> {
  return call(engine, 'tasks.create', { spec, idempotencyKey: key });
}
const task = (engine: Engine, id: string) =>
  call<TaskSnapshot>(engine, 'tasks.get', { taskId: id });
const session = (engine: Engine, id: string) =>
  call<SessionSnapshot>(engine, 'sessions.get', { sessionId: id });
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, expected);
  return true;
};

// AC01: real exclusive owner lock, without deleting a previous owner's files.
test('AC01 rejects a second owner and allows reopening after release', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createEngine(f.config), code('HOST_ALREADY_RUNNING'));
    await f.engine.close();
    const reopened = await createEngine(f.config);
    assert.equal(reopened.storeId, f.engine.storeId);
    assert.notEqual(reopened.instanceId, f.engine.instanceId);
    await reopened.close();
  } finally {
    await f.cleanup();
  }
});

test('AC01 rejects state inside workspace and workspace identity drift', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      createEngine({ ...f.config, stateDir: join(f.config.workspace, 'state') }),
      code('VALIDATION_ERROR'),
    );
    await f.engine.close();
    const other = join(f.config.workspace, 'other');
    await mkdir(other);
    await assert.rejects(
      createEngine({ ...f.config, workspace: other }),
      code('WORKSPACE_MISMATCH'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC02 same key reuses task across restart, changed payload conflicts', async () => {
  const f = await fixture();
  try {
    const a = await create(f.engine);
    const b = await create(f.engine);
    assert.equal(a.id, b.id);
    await assert.rejects(
      call(f.engine, 'tasks.create', {
        spec: { ...spec, goal: 'different' },
        idempotencyKey: 'task-1',
      }),
      code('IDEMPOTENCY_CONFLICT'),
    );
    await f.engine.close();
    const next = await createEngine(f.config);
    try {
      assert.equal((await create(next)).id, a.id);
      const op = await call<OperationSnapshot>(next, 'operations.lookup', {
        method: 'tasks.create',
        scope: 'local',
        idempotencyKey: 'task-1',
      });
      assert.equal(op.targetId, a.id);
      assert.equal(op.status, 'completed');
    } finally {
      await next.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('AC03 accepts only configured provider, model and supported acceptance', async () => {
  const f = await fixture({ providers: { fake: { model: 'test' } } });
  try {
    await assert.rejects(
      call(f.engine, 'tasks.create', {
        spec: { ...spec, runtime: { provider: 'missing', model: 'test' } },
        idempotencyKey: 'x',
      }),
      code('VALIDATION_ERROR'),
    );
    await assert.rejects(
      call(f.engine, 'tasks.create', {
        spec: { ...spec, runtime: { provider: 'fake', model: 'other' } },
        idempotencyKey: 'x',
      }),
      code('VALIDATION_ERROR'),
    );
    await assert.rejects(
      call(f.engine, 'tasks.create', {
        spec: { ...spec, acceptance: { mode: 'checks', criteria: [] } },
        idempotencyKey: 'x',
      }),
      code('VALIDATION_ERROR'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC04 runtime output requires an explicit current human decision', async () => {
  const f = await fixture();
  try {
    const created = await create(f.engine);
    const waiting = await until(
      () => task(f.engine, created.id),
      (t) => t.status === 'waiting_approval',
    );
    assert.equal(waiting.result, 'verified candidate');
    assert.ok(waiting.artifactRefs.length === 1);
    const approval = await call<ApprovalRequest>(f.engine, 'approvals.get', {
      approvalId: waiting.approvalId,
    });
    await assert.rejects(
      call(f.engine, 'approvals.decide', {
        approvalId: approval.approvalId,
        decision: { choice: 'approve', expectedRevision: approval.revision + 1 },
        idempotencyKey: 'decision-bad',
      }),
      code('STALE_TARGET'),
    );
    const decision = {
      approvalId: approval.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'decision',
    };
    const op = await call<OperationSnapshot>(f.engine, 'approvals.decide', decision);
    assert.equal(op.status, 'completed');
    assert.equal((await task(f.engine, created.id)).status, 'completed');
    assert.equal((await call<OperationSnapshot>(f.engine, 'approvals.decide', decision)).id, op.id);
    await assert.rejects(
      call(f.engine, 'approvals.decide', { ...decision, idempotencyKey: 'second' }),
      code('STALE_TARGET'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC04 denied and expired approvals never complete the task', async () => {
  const clock = approvalClock();
  const f = await fixture({ approvalTtlMs: 20, clock: clock.clock });
  try {
    const created = await create(f.engine);
    const waiting = await until(
      () => task(f.engine, created.id),
      (t) => t.status === 'waiting_approval',
    );
    clock.advance(30);
    await assert.rejects(
      call(f.engine, 'approvals.decide', {
        approvalId: waiting.approvalId,
        decision: { choice: 'approve', expectedRevision: 1 },
        idempotencyKey: 'expired',
      }),
      code('STALE_TARGET'),
    );
    assert.notEqual((await task(f.engine, created.id)).status, 'completed');
  } finally {
    await f.cleanup();
  }
});

test('AC05 durable events replay without duplicates and reject wrong store or future cursor', async () => {
  const f = await fixture();
  try {
    const created = await create(f.engine);
    await until(
      () => task(f.engine, created.id),
      (t) => t.status === 'waiting_approval',
    );
    const all = await call<EventPage>(f.engine, 'events.read', { taskId: created.id });
    assert.ok(all.events.some((e) => e.type === 'approval.requested'));
    assert.equal(new Set(all.events.map((e) => e.eventId)).size, all.events.length);
    assert.ok(all.events.every((e) => e.storeId === f.engine.storeId));
    const rest = await call<EventPage>(f.engine, 'events.read', {
      afterCursor: all.cursor,
      storeId: all.storeId,
    });
    assert.deepEqual(rest.events, []);
    await assert.rejects(
      call(f.engine, 'events.read', { afterCursor: all.cursor, storeId: 'wrong' }),
      code('CURSOR_EXPIRED'),
    );
    await assert.rejects(
      call(f.engine, 'events.read', { afterCursor: '999999', storeId: all.storeId }),
      code('CURSOR_EXPIRED'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC03 limits concurrent dispatches without creating manager model calls', async () => {
  let active = 0,
    peak = 0,
    invocations = 0;
  const base = createFakeAdapter({ delayMs: 30 });
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      active++;
      invocations++;
      peak = Math.max(peak, active);
      try {
        yield* base.execute(input);
      } finally {
        active--;
      }
    },
  };
  const f = await fixture({ adapters: [adapter], limits: { maxActiveSessions: 2 } });
  try {
    const tasks = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(f.engine, `task-${i}`)),
    );
    for (const t of tasks)
      await until(
        () => task(f.engine, t.id),
        (s) => s.status === 'waiting_approval',
      );
    assert.equal(peak, 2);
    assert.equal(invocations, 5);
    assert.equal(active, 0);
  } finally {
    await f.cleanup();
  }
});

test('AC06 explicit cancellation waits for observed interruption', async () => {
  const f = await fixture({ adapters: [createFakeAdapter({ delayMs: 500 })] });
  try {
    const t = await create(f.engine);
    await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'running',
    );
    const op = await call<OperationSnapshot>(f.engine, 'tasks.cancel', {
      taskId: t.id,
      idempotencyKey: 'cancel',
    });
    await until(
      () => call<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id }),
      (s) => s.status === 'completed',
    );
    assert.equal((await task(f.engine, t.id)).status, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('AC07 drain timeout retains owner and can continue to closure', async () => {
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = createFakeAdapter();
  const execute = fake.execute.bind(fake);
  fake.execute = async function* (input) {
    for await (const event of execute(input)) {
      yield event;
      if (event.type === 'accepted') await terminalGate;
    }
  };
  const f = await fixture({ adapters: [fake] });
  try {
    const t = await create(f.engine);
    await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'running',
    );
    let operationId = '';
    await assert.rejects(f.engine.close({ mode: 'drain', timeoutMs: 1 }), (error) => {
      assert.equal((error as any).code, 'SHUTDOWN_INCOMPLETE');
      assert.equal((error as any).client, f.engine);
      operationId = (error as any).operationId;
      return true;
    });
    assert.ok(operationId);
    assert.equal((await task(f.engine, t.id)).status, 'running');
    release();
    assert.equal(
      (await f.engine.close({ mode: 'drain', timeoutMs: 1000, operationId })).status,
      'closed',
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test('AC07 unprivileged client cannot shut down owner', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.engine.call('host.shutdown', { mode: 'drain', timeoutMs: 100 }, { owner: false }),
      code('UNAUTHORIZED'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC09 paused mailbox is persistent and duplicates do not start two turns', async () => {
  const f = await fixture({ adapters: [createFakeAdapter({ delayMs: 100 })] });
  try {
    const t = await create(f.engine);
    const s = await until(
      () => session(f.engine, t.sessionId),
      (s) => s.status === 'running',
    );
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    const op = await call<OperationSnapshot>(f.engine, 'sessions.control', {
      target,
      command: { action: 'pause', mode: 'interrupt' },
      idempotencyKey: 'pause',
    });
    await until(
      () => call<OperationSnapshot>(f.engine, 'operations.get', { operationId: op.id }),
      (o) => o.status === 'completed',
    );
    const messageSpec = {
      taskId: t.id,
      toSessionId: s.id,
      expectedGeneration: s.generation,
      kind: 'finding',
      summary: 'additional evidence',
    };
    const m = await call<MessageSnapshot>(f.engine, 'messages.send', {
      spec: messageSpec,
      idempotencyKey: 'message',
    });
    assert.equal(m.status, 'persisted');
    assert.equal(
      (
        await call<MessageSnapshot>(f.engine, 'messages.send', {
          spec: messageSpec,
          idempotencyKey: 'message',
        })
      ).id,
      m.id,
    );
    await assert.rejects(
      call(f.engine, 'messages.send', {
        spec: { ...messageSpec, expectedGeneration: 99 },
        idempotencyKey: 'old',
      }),
      code('STALE_TARGET'),
    );
    await f.engine.close();
    const reopened = await createEngine(f.config);
    try {
      assert.equal(
        (await call<MessageSnapshot>(reopened, 'messages.get', { messageId: m.id })).status,
        'persisted',
      );
      assert.equal((await task(reopened, t.id)).status, 'paused');
      await call(reopened, 'tasks.resume', { taskId: t.id, idempotencyKey: 'resume' });
      await until(
        () => task(reopened, t.id),
        (s) => s.status === 'waiting_approval',
      );
      assert.equal(
        (await call<MessageSnapshot>(reopened, 'messages.get', { messageId: m.id })).status,
        'completed',
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('AC10 stale control cannot interrupt a newer state', async () => {
  const f = await fixture();
  try {
    const t = await create(f.engine);
    await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'waiting_approval',
    );
    const s = await session(f.engine, t.sessionId);
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision - 1,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    await assert.rejects(
      call(f.engine, 'sessions.control', {
        target,
        command: { action: 'pause' },
        idempotencyKey: 'stale',
      }),
      code('STALE_TARGET'),
    );
    await assert.rejects(
      call(f.engine, 'sessions.control', {
        target: { ...target, expectedRevision: s.revision },
        command: { action: 'compact' },
        idempotencyKey: 'compact',
      }),
      code('UNSUPPORTED_CAPABILITY'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AC06 end of stream without terminal evidence is blocked, not retried', async () => {
  let calls = 0;
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute() {
      calls++;
      yield { type: 'accepted', providerSessionId: 'fake-native' };
    },
  };
  const f = await fixture({ adapters: [adapter] });
  try {
    const t = await create(f.engine);
    const unknown = await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'blocked',
    );
    assert.match(unknown.reason!, /unknown/i);
    await assert.rejects(
      call(f.engine, 'tasks.resume', { taskId: t.id, idempotencyKey: 'unsafe' }),
      code('OUTCOME_UNKNOWN'),
    );
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});

test('AC12 missing usage stays unknown instead of becoming zero', async () => {
  const f = await fixture();
  try {
    const t = await create(f.engine);
    await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'waiting_approval',
    );
    const usage = await call<{ records: unknown[]; completeness: string }>(f.engine, 'usage.get', {
      taskId: t.id,
    });
    assert.deepEqual(usage.records, []);
    assert.equal(usage.completeness, 'unknown');
  } finally {
    await f.cleanup();
  }
});

test('AC07 adapter cleanup obeys the same bounded shutdown deadline', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = createFakeAdapter();
  const f = await fixture({ adapters: [{ ...base, close: () => gate }] });
  try {
    const result = await Promise.race([
      f.engine.close({ timeoutMs: 5 }).then(
        () => 'closed',
        (e) => e,
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    assert.notEqual(result, 'hung', 'close must not hang inside adapter cleanup');
    assert.equal((result as any).code, 'SHUTDOWN_INCOMPLETE');
    release();
    await f.engine.close({ operationId: (result as any).operationId, timeoutMs: 500 });
  } finally {
    release();
    await f.cleanup();
  }
});

test('AC09 final-result-only acceptance preserves the native session identity', async () => {
  const base = createFakeAdapter();
  const f = await fixture({
    adapters: [
      {
        ...base,
        async *execute(input) {
          const terminal = {
            type: 'result' as const,
            text: 'evidence',
            providerSessionId: 'native-result-only',
          };
          const evidence = {
            version: 1 as const,
            dispatchId: input.dispatchId,
            sessionId: input.sessionId,
            generation: input.generation ?? 1,
            provider: 'fake',
            providerSessionId: 'native-result-only',
            observedAt: new Date().toISOString(),
          };
          input.reportExecutionEvidence?.({
            ...evidence,
            sequence: 1,
            source: 'runtime_terminal',
            localResources: 'unknown',
            remoteExecution: 'stopped',
            detail: 'fixture returned its only terminal event',
            terminal,
          });
          try {
            yield terminal;
          } finally {
            input.reportExecutionEvidence?.({
              ...evidence,
              sequence: 2,
              source: 'resource_observation',
              localResources: 'stopped',
              remoteExecution: 'stopped',
              detail: 'fixture iterator finished without retained resources',
            });
          }
        },
      },
    ],
  });
  try {
    const t = await create(f.engine);
    await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'waiting_approval',
    );
    assert.equal((await session(f.engine, t.sessionId)).providerSessionId, 'native-result-only');
  } finally {
    await f.cleanup();
  }
});

test('AC10 pause operation cannot be replaced silently by concurrent cancel intent', async () => {
  const f = await fixture({ adapters: [createFakeAdapter({ delayMs: 100 })] });
  try {
    const t = await create(f.engine);
    const s = await until(
      () => session(f.engine, t.sessionId),
      (s) => s.status === 'running',
    );
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    const pause = await call<OperationSnapshot>(f.engine, 'sessions.control', {
      target,
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'pause',
    });
    const cancel = await call<OperationSnapshot>(f.engine, 'tasks.cancel', {
      taskId: t.id,
      idempotencyKey: 'cancel-after-pause',
    });
    await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'cancelled',
    );
    const p = await call<OperationSnapshot>(f.engine, 'operations.get', { operationId: pause.id });
    assert.equal(
      p.status,
      'rejected',
      'superseded pause must not claim to have paused a cancelled task',
    );
    assert.equal(
      (await call<OperationSnapshot>(f.engine, 'operations.get', { operationId: cancel.id }))
        .status,
      'completed',
    );
  } finally {
    await f.cleanup();
  }
});

test('AC01 names beginning with two dots are still children of the workspace', async () => {
  const f = await fixture();
  let unexpected: Engine | undefined;
  try {
    await assert.rejects(async () => {
      unexpected = await createEngine({
        ...f.config,
        stateDir: join(f.config.workspace, '..state'),
      });
    }, code('VALIDATION_ERROR'));
  } finally {
    await unexpected?.close();
    await f.cleanup();
  }
});

test('AC09 acceptance cannot bypass an explicit paused session to deliver queued mail', async () => {
  let calls = 0;
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      calls++;
      yield* base.execute(input);
    },
  };
  const f = await fixture({ adapters: [adapter] });
  try {
    const t = await create(f.engine);
    const waiting = await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'waiting_approval',
    );
    const s = await session(f.engine, t.sessionId);
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    await call(f.engine, 'sessions.control', {
      target,
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'pause-review',
    });
    const message = await call<MessageSnapshot>(f.engine, 'messages.send', {
      spec: {
        taskId: t.id,
        toSessionId: s.id,
        expectedGeneration: s.generation,
        kind: 'finding',
        summary: 'Review after explicit resume',
      },
      idempotencyKey: 'waiting-mail',
    });
    await call(f.engine, 'approvals.decide', {
      approvalId: waiting.approvalId,
      decision: { choice: 'approve', expectedRevision: 1 },
      idempotencyKey: 'approval',
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, 'approval is not authorization to resume a paused recipient');
    assert.equal((await task(f.engine, t.id)).status, 'paused');
    assert.equal((await session(f.engine, s.id)).status, 'paused');
    assert.equal(
      (await call<MessageSnapshot>(f.engine, 'messages.get', { messageId: message.id })).status,
      'persisted',
    );
    await call(f.engine, 'tasks.resume', { taskId: t.id, idempotencyKey: 'explicit-resume' });
    await until(
      () => task(f.engine, t.id),
      (s) => s.status === 'waiting_approval',
    );
    assert.equal(calls, 2);
  } finally {
    await f.cleanup();
  }
});

test('AC04 session resume reissues expired acceptance without rerunning completed work', async () => {
  const clock = approvalClock();
  let calls = 0;
  const base = createFakeAdapter();
  const f = await fixture({
    approvalTtlMs: 50,
    clock: clock.clock,
    adapters: [
      {
        ...base,
        async *execute(input) {
          calls++;
          yield* base.execute(input);
        },
      },
    ],
  });
  try {
    const t = await create(f.engine);
    const first = await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'waiting_approval',
    );
    clock.advance(70);
    const s = await session(f.engine, t.sessionId);
    assert.equal(s.status, 'paused');
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    await call(f.engine, 'sessions.control', {
      target,
      command: { action: 'resume' },
      idempotencyKey: 'resume-expired',
    });
    const second = await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'waiting_approval',
    );
    assert.equal(calls, 1, 'acceptance expiry cannot replay the business goal');
    assert.notEqual(second.approvalId, first.approvalId);
    assert.deepEqual(second.artifactRefs, first.artifactRefs);
  } finally {
    await f.cleanup();
  }
});

test('AC10 terminal identity failure resolves pending control as outcome_unknown', async () => {
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute() {
      yield { type: 'accepted', providerSessionId: 'native-a' };
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'result', text: 'Wrong native session', providerSessionId: 'native-b' };
    },
  };
  const f = await fixture({ adapters: [adapter] });
  try {
    const t = await create(f.engine);
    const s = await until(
      () => session(f.engine, t.sessionId),
      (s) => s.providerSessionId === 'native-a',
    );
    const target = {
      sessionId: s.id,
      expectedGeneration: s.generation,
      expectedRevision: s.revision,
      expectedDispatchId: s.activeDispatchId,
      expectedState: s.status,
    };
    const pause = await call<OperationSnapshot>(f.engine, 'sessions.control', {
      target,
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'pause-before-invalid-result',
    });
    await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'blocked',
    );
    const op = await call<OperationSnapshot>(f.engine, 'operations.get', { operationId: pause.id });
    assert.equal(op.status, 'outcome_unknown');
    assert.equal(op.error?.code, 'OUTCOME_UNKNOWN');
  } finally {
    await f.cleanup();
  }
});

test('AC11 large Unicode output stays in its artifact and has a bounded inline preview', async () => {
  const full = '证据'.repeat(200000);
  const f = await fixture({ adapters: [createFakeAdapter({ result: full })] });
  try {
    const t = await create(f.engine);
    const result = await until(
      () => task(f.engine, t.id),
      (t) => t.status === 'waiting_approval',
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) < 262144,
      'snapshot must fit in one RPC frame',
    );
    // SPEC-0042 C01: the note is English.
    assert.match(
      result.result!,
      /\n\[Preview truncated; the full result is in artifact [^\]]+\]$/,
      'preview must disclose that text was shortened',
    );
    const { readFile } = await import('node:fs/promises');
    const artifact = join(f.config.stateDir, 'artifacts', `${result.artifactRefs[0].slice(7)}.txt`);
    assert.equal(await readFile(artifact, 'utf8'), full);
  } finally {
    await f.cleanup();
  }
});

test('AC05 event replay is bounded by encoded bytes without losing the next cursor', async () => {
  const f = await fixture({ adapters: [createFakeAdapter({ result: 'x'.repeat(80000) })] });
  try {
    const tasks = await Promise.all(
      Array.from({ length: 20 }, (_, i) => create(f.engine, `large-${i}`)),
    );
    for (const t of tasks)
      await until(
        () => task(f.engine, t.id),
        (t) => t.status === 'waiting_approval',
        10000,
      );
    let cursor = '0';
    const events = [];
    while (true) {
      const page = await call<EventPage>(f.engine, 'events.read', {
        afterCursor: cursor,
        storeId: f.engine.storeId,
        limit: 1000,
      });
      assert.ok(
        Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 - 512,
        'each page must fit its RPC envelope',
      );
      if (page.cursor === cursor) break;
      cursor = page.cursor;
      events.push(...page.events);
    }
    assert.equal(
      events.filter((event) => event.type === 'approval.requested').length,
      tasks.length,
    );
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  } finally {
    await f.cleanup();
  }
});
