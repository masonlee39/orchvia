import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  CallContext,
  Engine,
  OperationSnapshot,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

type Session = SessionSnapshot & { pauseOrigin?: string };

const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
  ...extra,
});
const target = (session: SessionSnapshot) => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedState: session.status,
  expectedDispatchId: session.activeDispatchId,
});
const session = (engine: Engine, id: string) =>
  engine.call('sessions.get', { sessionId: id }) as Promise<Session>;
const task = (engine: Engine, id: string) =>
  engine.call('tasks.get', { taskId: id }) as Promise<TaskSnapshot>;
const resume = (engine: Engine, value: SessionSnapshot, key: string, context?: CallContext) =>
  engine.call(
    'sessions.control',
    { target: target(value), command: { action: 'resume' }, idempotencyKey: key },
    context,
  ) as Promise<OperationSnapshot>;
async function wait(engine: Engine, id: string, status: string) {
  let current: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    current = await task(engine, id);
    if (current.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${current?.status}/${current?.reason}`);
}
/** A task that reuses the session runs on it and keeps its native identity. */
async function continuesOn(engine: Engine, ended: TaskSnapshot) {
  const before = await session(engine, ended.sessionId!);
  assert.ok(before.providerSessionId, 'the session has native history to continue');
  const next = (await engine.call('tasks.create', {
    spec: spec('continue', {
      parentTaskId: ended.id,
      contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: before.id },
    }),
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
  const done = await wait(engine, next.id, 'waiting_approval');
  assert.equal(done.sessionId, before.id);
  assert.equal((await session(engine, before.id)).providerSessionId, before.providerSessionId);
}

test('0016-S01 a crashed dispatch reconciled as interrupted leaves a session that resumes and continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-session-crash-'));
  const workspace = join(dir, 'workspace'),
    stateDir = join(dir, 'state');
  await mkdir(workspace);
  const child = spawn(
    process.execPath,
    ['tests/fixtures/dispatch-crash-owner.ts', workspace, stateDir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  let engine: Engine | undefined;
  try {
    const crashed = await new Promise<TaskSnapshot>((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 10000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          clearTimeout(timer);
          resolve(JSON.parse(data.split('\n')[0]));
        }
      });
    });
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    engine = await createEngine({ workspace, stateDir, adapters: [createFakeAdapter()] });
    assert.equal((await task(engine, crashed.id)).status, 'blocked');
    const unknown = await session(engine, crashed.sessionId!);
    assert.equal(unknown.status, 'outcome_unknown');
    await assert.rejects(resume(engine, unknown, 'too-early'), { code: 'OUTCOME_UNKNOWN' });
    await engine.call(
      'sessions.reconcile',
      {
        target: target(unknown),
        evidence: {
          source: 'owner_attestation',
          summary: 'The killed owner left no process, and the user checked the files.',
          localResources: 'stopped',
          remoteExecution: 'stopped',
          sideEffects: 'resolved',
          outcome: 'interrupted',
        },
        idempotencyKey: 'reconcile',
      },
      { owner: true },
    );
    const failed = await task(engine, crashed.id);
    assert.deepEqual([failed.status, failed.reason], ['failed', 'reconciled_interrupted']);
    const paused = await session(engine, crashed.sessionId!);
    assert.equal(paused.status, 'paused');
    const resumed = await resume(engine, paused, 'resume');
    assert.equal(resumed.status, 'completed');
    const idle = await session(engine, crashed.sessionId!);
    assert.deepEqual([idle.status, idle.pauseOrigin], ['idle', undefined]);
    assert.equal((await resume(engine, paused, 'resume')).id, resumed.id);
    assert.equal((await resume(engine, idle, 'again')).status, 'noop');
    await continuesOn(engine, failed);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await engine?.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});

for (const choice of ['approve', 'deny'] as const)
  test(`0016-S01 a session paused before its task was ${choice === 'approve' ? 'approved' : 'denied'} resumes and continues`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-session-ended-'));
    await mkdir(join(dir, 'workspace'));
    let active = false;
    const base = createFakeAdapter();
    const engine = await createEngine({
      workspace: join(dir, 'workspace'),
      stateDir: join(dir, 'state'),
      adapters: [{ ...base, hasActiveResources: () => active }],
    });
    try {
      const agent = (await engine.call('tasks.create', {
        spec: spec('agent'),
        idempotencyKey: 'agent',
      })) as TaskSnapshot;
      const pending = await wait(engine, agent.id, 'waiting_approval');
      await engine.call('sessions.control', {
        target: target(await session(engine, agent.sessionId!)),
        command: { action: 'pause' },
        idempotencyKey: 'pause',
      });
      const approval = (await engine.call('approvals.get', {
        approvalId: pending.approvalId,
      })) as { revision: number };
      await engine.call('approvals.decide', {
        approvalId: pending.approvalId,
        decision: { choice, expectedRevision: approval.revision },
        idempotencyKey: 'decide',
      });
      const ended = await wait(engine, agent.id, choice === 'approve' ? 'completed' : 'failed');
      const paused = await session(engine, agent.sessionId!);
      assert.deepEqual([paused.status, paused.pauseOrigin], ['paused', 'client']);
      await assert.rejects(
        engine.call('sessions.control', {
          target: target(paused),
          command: { action: 'pause' },
          idempotencyKey: 'pause-again',
        }),
        { code: 'STALE_TARGET' },
      );
      const runtime = {
        runtimeActor: {
          sessionId: paused.id,
          taskId: agent.id,
          dispatchId: 'bound-dispatch',
          generation: paused.generation,
        },
      };
      await assert.rejects(resume(engine, paused, 'by-runtime', runtime), {
        code: 'UNAUTHORIZED',
      });
      active = true;
      await assert.rejects(resume(engine, paused, 'while-active'), {
        code: 'RUNTIME_STILL_ACTIVE',
      });
      active = false;
      await resume(engine, paused, 'resume');
      assert.equal((await session(engine, agent.sessionId!)).status, 'idle');
      await continuesOn(engine, ended);
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    }
  });
