import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import type {
  Engine,
  EngineClock,
  EngineConfig,
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

type Tools = { call(name: string, args: unknown): Promise<unknown> };

const rule = (extra: Record<string, unknown> = {}) => ({
  id: 'lint',
  version: '1',
  argv: ['/usr/bin/true'],
  cwdRelative: 'app',
  timeoutMs: 5000,
  permissionProfile: 'read-only',
  success: { exitCode: 0 },
  ...extra,
});
const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});
const checks = { acceptance: { mode: 'checks', ruleRefs: [{ id: 'lint', version: '1' }] } };
const create = (engine: Engine, goal: string, extra: Record<string, unknown> = {}, key?: string) =>
  engine.call('tasks.create', {
    spec: spec(goal, extra),
    idempotencyKey: key ?? crypto.randomUUID(),
  }) as Promise<TaskSnapshot>;
const get = (engine: Engine, id: string) =>
  engine.call('tasks.get', { taskId: id }) as Promise<TaskSnapshot>;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = await get(engine, id);
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
const target = (session: SessionSnapshot) => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedState: session.status,
  expectedDispatchId: session.activeDispatchId,
});

/** A workspace with an `app` directory and a config that can be restarted in place. */
async function workspace(prefix: string, extra: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await mkdir(join(root, 'work', 'app'), { recursive: true });
  const config: EngineConfig = {
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    ...extra,
  };
  return { root, config, app: join(root, 'work', 'app') };
}
const stop = (engine: Engine) => engine.close({ mode: 'interrupt', timeoutMs: 1000 });

test('0017-A01 a registered rule whose directory was removed no longer blocks startup', async () => {
  const w = await workspace('orch-audit-rule-');
  let engine = await createEngine(w.config);
  try {
    await engine.call('rules.register', { rule: rule(), idempotencyKey: 'lint' }, { owner: true });
    await stop(engine);
    await rm(w.app, { recursive: true });
    engine = await createEngine(w.config);
    const listed = (await engine.call('rules.list', {})) as { rules: { id: string }[] };
    assert.deepEqual(
      listed.rules.map((item) => item.id),
      ['lint'],
    );
    await assert.rejects(create(engine, 'checked', checks), { code: 'INVALID_WORKSPACE_SCOPE' });
    await mkdir(w.app);
    assert.equal((await create(engine, 'checked again', checks)).verificationRules?.length, 1);
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A01 a configured rule with a missing path starts the engine and refuses its tasks', async () => {
  const w = await workspace('orch-audit-config-rule-');
  await rm(w.app, { recursive: true });
  const engine = await createEngine({ ...w.config, verificationRules: [rule()] as never });
  try {
    await assert.rejects(create(engine, 'checked', checks), { code: 'INVALID_WORKSPACE_SCOPE' });
    assert.equal((await create(engine, 'unchecked')).status, 'queued');
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A01 registration refuses a missing path with INVALID_WORKSPACE_SCOPE', async () => {
  const w = await workspace('orch-audit-register-');
  const engine = await createEngine(w.config);
  try {
    await assert.rejects(
      engine.call(
        'rules.register',
        { rule: rule({ cwdRelative: 'missing' }), idempotencyKey: 'missing' },
        { owner: true },
      ),
      { code: 'INVALID_WORKSPACE_SCOPE' },
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A01 a rollover carries a rule whose directory was removed', async () => {
  const w = await workspace('orch-audit-rollover-');
  for (const name of ['state', 'control', 'stores', 'archives'])
    await mkdir(join(w.root, name), { mode: 0o700 });
  const config: EngineConfig = {
    ...w.config,
    stores: {
      controlDir: join(w.root, 'control'),
      storesRoot: join(w.root, 'stores'),
      archiveRoot: join(w.root, 'archives'),
    },
  };
  let engine = await createEngine(config);
  try {
    await engine.call('rules.register', { rule: rule(), idempotencyKey: 'lint' }, { owner: true });
    await rm(w.app, { recursive: true });
    const record = (await engine.call(
      'stores.rollover',
      { idempotencyKey: 'roll' },
      { owner: true },
    )) as { status: string };
    assert.equal(record.status, 'completed');
    await stop(engine);
    engine = await createEngine(config);
    const listed = (await engine.call('rules.list', {})) as { rules: { source: string }[] };
    assert.deepEqual(
      listed.rules.map((item) => item.source),
      ['runtime'],
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A01 a check whose directory disappears after admission fails its verification', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      await gate;
      yield* base.execute(input);
    },
  };
  const w = await workspace('orch-audit-run-', {
    adapters: [adapter],
    verificationRules: [rule()] as never,
  });
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'checked', checks);
    await wait(engine, task.id, 'running');
    await rm(w.app, { recursive: true });
    release();
    const failed = await wait(engine, task.id, 'blocked');
    assert.equal(failed.reason, 'verification_failed');
  } finally {
    release();
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A02 an identical retry returns the original task after the default wait changes', async () => {
  const w = await workspace('orch-audit-retry-');
  const request = { contextPlan: { requestedMode: 'fresh', independent: true } };
  let engine = await createEngine({ ...w.config, limits: { defaultMaxQueueWaitMs: 30000 } });
  try {
    const first = await create(engine, 'retried', request, 'same-request');
    await stop(engine);
    engine = await createEngine({ ...w.config, limits: { defaultMaxQueueWaitMs: 600000 } });
    const retry = await create(engine, 'retried', request, 'same-request');
    assert.equal(retry.id, first.id);
    assert.equal(retry.routing?.maxQueueWaitMs, 30000);
    assert.equal(
      (await create(engine, 'new', request)).routing?.maxQueueWaitMs,
      600000,
      'new tasks still use the current default',
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A03 revise on a stopped session fails and leaves the approval pending', async () => {
  const w = await workspace('orch-audit-revise-');
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    const pending = await wait(engine, task.id, 'waiting_approval');
    const session = (await engine.call('sessions.get', {
      sessionId: task.sessionId,
    })) as SessionSnapshot;
    await engine.call('sessions.control', {
      target: target(session),
      command: { action: 'stop' },
      idempotencyKey: 'stop',
    });
    const approval = (await engine.call('approvals.get', {
      approvalId: pending.approvalId,
    })) as { revision: number; status: string };
    await assert.rejects(
      engine.call('approvals.decide', {
        approvalId: pending.approvalId,
        decision: { choice: 'revise', expectedRevision: approval.revision, comment: 'Add tests' },
        idempotencyKey: 'revise',
      }),
      { code: 'SESSION_CLOSED' },
    );
    const after = (await engine.call('approvals.get', {
      approvalId: pending.approvalId,
    })) as { revision: number; status: string };
    assert.deepEqual([after.status, after.revision], ['pending', approval.revision]);
    assert.equal((await get(engine, task.id)).status, 'waiting_approval');
    await approve(engine, task.id);
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

const send = (engine: Engine, task: TaskSnapshot, key: string) =>
  engine.call('messages.send', {
    spec: {
      taskId: task.id,
      toSessionId: task.sessionId,
      expectedGeneration: 1,
      kind: 'finding',
      summary: 'one more point',
    },
    idempotencyKey: key,
  }) as Promise<{ id: string; status: string }>;
async function stopSession(engine: Engine, sessionId: string) {
  const session = (await engine.call('sessions.get', { sessionId })) as SessionSnapshot;
  await engine.call('sessions.control', {
    target: target(session),
    command: { action: 'stop' },
    idempotencyKey: `stop-${sessionId}`,
  });
}
const expiredReasons = async (engine: Engine, messageId: string) =>
  ((await engine.call('events.read', { limit: 1000 })) as EventPage).events
    .filter((event) => event.type === 'message.expired' && event.data.messageId === messageId)
    .map((event) => event.data.reason);

test('0017-A05 approving a task whose session was stopped with a pending message completes it', async () => {
  const w = await workspace('orch-audit-approve-stopped-');
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    await wait(engine, task.id, 'waiting_approval');
    const message = await send(engine, task, 'finding');
    assert.equal(message.status, 'persisted');
    await stopSession(engine, task.sessionId!);
    const completed = await approve(engine, task.id);
    assert.equal(completed.status, 'completed');
    const after = (await engine.call('messages.get', { messageId: message.id })) as {
      status: string;
    };
    assert.equal(after.status, 'expired');
    assert.deepEqual(await expiredReasons(engine, message.id), ['session_stopped']);
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A05 stopping an idle session expires its pending messages at once', async () => {
  const w = await workspace('orch-audit-stop-idle-');
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    await wait(engine, task.id, 'waiting_approval');
    const message = await send(engine, task, 'finding');
    await stopSession(engine, task.sessionId!);
    const after = (await engine.call('messages.get', { messageId: message.id })) as {
      status: string;
    };
    assert.equal(after.status, 'expired', 'expired by the stop, before any decision');
    assert.deepEqual(await expiredReasons(engine, message.id), ['session_stopped']);
    assert.equal((await get(engine, task.id)).status, 'waiting_approval');
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A05 stopping a running session expires messages sent during the run when it ends', async () => {
  let holding = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      if (holding) await gate;
      yield* base.execute(input);
    },
  };
  const w = await workspace('orch-audit-stop-running-', { adapters: [adapter] });
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    await wait(engine, task.id, 'waiting_approval');
    const carried = await send(engine, task, 'carried');
    holding = true;
    const approval = (await engine.call('approvals.get', {
      approvalId: (await get(engine, task.id)).approvalId,
    })) as { approvalId: string; revision: number };
    await engine.call('approvals.decide', {
      approvalId: approval.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve-first',
    });
    await wait(engine, task.id, 'running');
    const late = await send(engine, task, 'late');
    await stopSession(engine, task.sessionId!);
    const during = (await engine.call('messages.get', { messageId: late.id })) as {
      status: string;
    };
    assert.equal(during.status, 'persisted', 'the session is still open until the run ends');
    release();
    await wait(engine, task.id, 'waiting_approval');
    const status = async (id: string) =>
      ((await engine.call('messages.get', { messageId: id })) as { status: string }).status;
    assert.equal(
      await status(carried.id),
      'completed',
      'the last dispatch settles what it carried',
    );
    assert.equal(await status(late.id), 'expired');
    assert.deepEqual(await expiredReasons(engine, late.id), ['session_stopped']);
    assert.equal(
      ((await engine.call('sessions.get', { sessionId: task.sessionId })) as SessionSnapshot)
        .status,
      'closed',
    );
    assert.equal((await approve(engine, task.id)).status, 'completed');
  } finally {
    release();
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A05 messages to a stopped session are refused with SESSION_CLOSED', async () => {
  const w = await workspace('orch-audit-send-stopped-');
  const engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    await wait(engine, task.id, 'waiting_approval');
    await stopSession(engine, task.sessionId!);
    await assert.rejects(send(engine, task, 'late'), { code: 'SESSION_CLOSED' });
    await assert.rejects(send(engine, task, 'late'), { code: 'SESSION_CLOSED' }, 'nothing stored');
    const types = ((await engine.call('events.read', { limit: 1000 })) as EventPage).events.map(
      (event) => event.type,
    );
    assert.ok(!types.includes('message.persisted'));
    assert.equal((await approve(engine, task.id)).status, 'completed');
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A05 startup expires pending messages that earlier versions left on stopped sessions', async () => {
  const w = await workspace('orch-audit-legacy-messages-');
  let engine = await createEngine(w.config);
  try {
    const task = await create(engine, 'reviewed');
    await wait(engine, task.id, 'waiting_approval');
    const message = await send(engine, task, 'finding');
    await stop(engine);
    // rc.10 closed the session and left the message persisted.
    const db = new DatabaseSync(join(w.config.stateDir, 'store.sqlite'));
    try {
      db.prepare("UPDATE sessions SET data=json_set(data,'$.status','closed') WHERE id=?").run(
        task.sessionId,
      );
    } finally {
      db.close();
    }
    engine = await createEngine(w.config);
    const after = (await engine.call('messages.get', { messageId: message.id })) as {
      status: string;
    };
    assert.equal(after.status, 'expired');
    assert.deepEqual(await expiredReasons(engine, message.id), ['session_stopped']);
    assert.equal((await approve(engine, task.id)).status, 'completed');
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

/** Engine time that fires timers only when a test advances it. */
class ManualClock implements EngineClock {
  wall = Date.now();
  mono = 0;
  timers = new Set<{ at: number; fn: () => void }>();
  wallNow = () => this.wall;
  monotonicNow = () => this.mono;
  setTimer = (fn: () => void, delay: number) => {
    const item = { at: this.mono + delay, fn };
    this.timers.add(item);
    return () => {
      this.timers.delete(item);
    };
  };
  advance(ms: number) {
    this.mono += ms;
    this.wall += ms;
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at))
      if (this.timers.has(timer) && timer.at <= this.mono) {
        this.timers.delete(timer);
        timer.fn();
      }
  }
}

/** A host whose runtime asks agent B to take work from every `requester` prompt. */
async function handoffHost(prefix: string, clock: ManualClock, hold?: Promise<void>) {
  const requested: string[] = [];
  let targetSession = '';
  const base = createFakeAdapter();
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      let accepted = false;
      for await (const event of base.execute(input)) {
        yield event;
        // Ask after acceptance, so holding the turn only runs down its total budget.
        if (accepted || !input.prompt.startsWith('requester')) continue;
        accepted = true;
        const tools = (input as RuntimeInput & { orchestrationTools: Tools }).orchestrationTools;
        const receipt = (await tools.call('work_delegate', {
          goal: 'please take this',
          contextPlan: {
            requestedMode: 'reuse',
            independent: true,
            candidateSessionId: targetSession,
          },
          idempotencyKey: 'handoff',
        })) as { handoffId: string };
        requested.push(receipt.handoffId);
        await hold;
      }
    },
  };
  const w = await workspace(prefix, {
    adapters: [adapter],
    clock,
    tools: { enabled: true, handoffs: true, handoffTtlMs: 60000 },
  });
  const engine = await createEngine(w.config);
  targetSession = (await approve(engine, (await create(engine, 'agent b')).id)).sessionId!;
  return { w, engine, requested };
}
/** Expired handoffs as events report them; unlike handoff reads, events.read expires nothing. */
const expired = async (engine: Engine) =>
  ((await engine.call('events.read', { limit: 1000 })) as EventPage).events
    .filter((event) => event.type === 'handoff.expired')
    .map((event) => event.data.handoffId);
async function eventually(check: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 100 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await check(), message);
}

test('0017-A04 a pending handoff expires on an idle host without other activity', async () => {
  const clock = new ManualClock();
  const { w, engine, requested } = await handoffHost('orch-audit-handoff-', clock);
  try {
    await wait(engine, (await create(engine, 'requester')).id, 'waiting_approval');
    assert.equal(requested.length, 1);
    clock.advance(59999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await expired(engine), [], 'not before its expiry');
    clock.advance(2);
    await eventually(
      async () => (await expired(engine)).includes(requested[0]),
      'expiry happened without a read',
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A04 a handoff expires while the requesting turn is still running', async () => {
  const clock = new ManualClock();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { w, engine, requested } = await handoffHost('orch-audit-handoff-run-', clock, hold);
  try {
    const task = await create(engine, 'requester');
    await eventually(async () => requested.length === 1, 'the runtime requested a handoff');
    clock.advance(60001);
    await eventually(
      async () => (await expired(engine)).includes(requested[0]),
      'expiry happened during the turn',
    );
    release();
    await wait(engine, task.id, 'waiting_approval');
  } finally {
    release();
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A04 the timer moves to the next pending handoff after each expiry', async () => {
  const clock = new ManualClock();
  const { w, engine, requested } = await handoffHost('orch-audit-handoff-next-', clock);
  try {
    await wait(engine, (await create(engine, 'requester one')).id, 'waiting_approval');
    clock.advance(30000);
    await wait(engine, (await create(engine, 'requester two')).id, 'waiting_approval');
    assert.equal(requested.length, 2);
    clock.advance(30001);
    await eventually(
      async () => (await expired(engine)).includes(requested[0]),
      'the first request expired at its own time',
    );
    assert.deepEqual(await expired(engine), [requested[0]]);
    clock.advance(30000);
    await eventually(
      async () => (await expired(engine)).includes(requested[1]),
      'the second request expired after the first',
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(w.root, { recursive: true, force: true });
  }
});

test('0017-A04 a restarted host arms the expiry of stored pending handoffs', async () => {
  const clock = new ManualClock();
  const host = await handoffHost('orch-audit-handoff-restart-', clock);
  let engine = host.engine;
  try {
    await wait(engine, (await create(engine, 'requester')).id, 'waiting_approval');
    await stop(engine);
    engine = await createEngine(host.w.config);
    clock.advance(60001);
    await eventually(
      async () => (await expired(engine)).includes(host.requested[0]),
      'expiry after a restart happened without a read',
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(host.w.root, { recursive: true, force: true });
  }
});

test('0017-A01 the CLI configuration checks only the shape of its rules', async () => {
  const w = await workspace('orch-audit-cli-');
  await mkdir(w.config.stateDir, { mode: 0o700 });
  try {
    const write = async (value: unknown) => {
      const path = join(w.root, `config-${crypto.randomUUID()}.json`);
      await writeFile(
        path,
        JSON.stringify({
          configVersion: 1,
          workspace: w.config.workspace,
          stateDir: w.config.stateDir,
          providers: { fake: { model: 'fixture' } },
          verificationRules: [value],
        }),
      );
      return path;
    };
    const loaded = await loadConfig(await write(rule({ cwdRelative: 'missing' })));
    assert.equal(loaded.verificationRules?.length, 1);
    await assert.rejects(loadConfig(await write(rule({ cwdRelative: '/abs' }))), {
      code: 'INVALID_CONFIG',
    });
    await assert.rejects(loadConfig(await write(rule({ cwdRelative: '../outside' }))), {
      code: 'INVALID_CONFIG',
    });
  } finally {
    await rm(w.root, { recursive: true, force: true });
  }
});
