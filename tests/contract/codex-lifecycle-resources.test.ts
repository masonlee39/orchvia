import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';
import { controlledExecutionBudget } from '../fixtures/execution-budget.ts';

const fixtureSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.argv[1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const mark = stage => fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify({pid:process.pid,stage}));
const noise = () => setInterval(() => send({method:'unrelated',params:{}}), 10);
setInterval(() => {}, 1000);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  mark(request.method);
  if(request.method === 'initialize') {
    if(mode === 'initialize' || mode === 'ignore-term') return;
    if(mode === 'request-rollback') return noise();
    if(mode === 'terminal-rollback') return setTimeout(() => send({id:request.id,result:{userAgent:'fixture'}}), 300);
    send({id:request.id,result:{userAgent:'fixture'}});
  } else if(request.method === 'thread/start') {
    send({id:request.id,result:{thread:{id:'owned-thread'}}});
  } else if(request.method === 'turn/start') {
    if(mode === 'turn-start') return;
    send({id:request.id,result:{turn:{id:'owned-turn'}}});
    noise();
  }
});
`;

async function bounded<T>(promise: Promise<T>, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture operation exceeded its test deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function setup(t: TestContext, mode: string, closeTimeoutMs = 300) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owned-'));
  const capturePath = join(dir, 'child.json');
  const rollback = mode.endsWith('-rollback');
  const controlled = controlledExecutionBudget(180);
  let deadlineStarted: number | undefined;
  const remaining = () =>
    180 - (deadlineStarted === undefined ? 0 : performance.now() - deadlineStarted);
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: ['-e', fixtureSource, mode],
    env: { FIXTURE_STATE: capturePath },
    requestTimeoutMs: mode === 'request-rollback' ? 180 : 10000,
    turnTimeoutMs: mode === 'terminal-rollback' ? 180 : 10000,
    closeTimeoutMs,
  });
  const sessionId = 'owned-resource-session';
  const events: RuntimeEvent[] = [];
  const finished = (async () => {
    for await (const event of adapter.execute({
      taskId: 'resource-task',
      sessionId,
      dispatchId: 'resource-dispatch',
      providerSessionId: null,
      model: 'fixture-model',
      workspace: process.cwd(),
      stateDir: dir,
      prompt: 'Offline fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      ...(rollback
        ? {
            executionBudget: {
              ...controlled.budget,
              remainingAcceptanceMs: remaining,
              remainingTurnMs: remaining,
            },
          }
        : {}),
    }))
      events.push(event);
    return events;
  })();
  let ownedPid: number | undefined;
  t.after(async () => {
    t.mock.restoreAll();
    if (ownedPid !== undefined) {
      try {
        process.kill(ownedPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await bounded(finished);
    await adapter.close?.().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const reached = async (stage: string) => {
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      try {
        const state = JSON.parse(await readFile(capturePath, 'utf8'));
        ownedPid = state.pid;
        if (state.stage === stage) return state.pid as number;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Owned fixture did not reach ${stage}`);
  };
  return {
    adapter,
    sessionId,
    events,
    finished,
    reached,
    startDeadline: () => {
      deadlineStarted = performance.now();
    },
  };
}

for (const mode of ['initialize', 'turn-start']) {
  test(
    `0003-A Codex adapter.close reaps its own ${mode} stall without waiting for the RPC deadline`,
    { timeout: 6000 },
    async (t) => {
      const f = await setup(t, mode);
      const pid = await f.reached(mode === 'initialize' ? 'initialize' : 'turn/start');
      assert.equal(typeof f.adapter.close, 'function');
      assert.equal(f.adapter.hasActiveResources?.(f.sessionId), true);
      assert.equal(f.adapter.hasActiveResources?.('unrelated-session'), false);
      const started = performance.now();
      await bounded(f.adapter.close!(), 700);
      const events = await bounded(f.finished, 700);
      assert.ok(
        performance.now() - started < 600,
        'close must use its cleanup budget, not the 10 second RPC deadline',
      );
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(f.adapter.hasActiveResources?.(f.sessionId), false);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.equal(
        (events[0] as Extract<RuntimeEvent, { type: 'error' }>).outcome,
        mode === 'initialize' ? 'failed' : 'unknown',
      );
    },
  );
}

test(
  '0003-A Codex close uses bounded TERM and KILL stages and confirms owned child exit',
  { timeout: 6000 },
  async (t) => {
    const f = await setup(t, 'ignore-term', 300);
    const pid = await f.reached('initialize');
    assert.equal(typeof f.adapter.close, 'function');
    const started = performance.now();
    await bounded(f.adapter.close!(), 1000);
    assert.ok(performance.now() - started < 750);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(f.adapter.hasActiveResources?.(f.sessionId), false);
    assert.equal((await bounded(f.finished)).at(-1)?.type, 'error');
  },
);

test(
  '0003-A Codex cleanup failure keeps the resource quarantined until actual owned process exit',
  { timeout: 6000 },
  async (t) => {
    const f = await setup(t, 'initialize', 80);
    const pid = await f.reached('initialize');
    assert.equal(typeof f.adapter.close, 'function');
    const mockKill = t.mock.method(ChildProcess.prototype, 'kill', () => false);
    await assert.rejects(bounded(f.adapter.close!(), 500), { code: 'SHUTDOWN_INCOMPLETE' });
    assert.equal(f.adapter.hasActiveResources?.(f.sessionId), true);
    assert.doesNotThrow(() => process.kill(pid, 0));
    mockKill.mock.restore();
    await bounded(f.adapter.close!(), 500);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(f.adapter.hasActiveResources?.(f.sessionId), false);
    const events = await bounded(f.finished);
    assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  },
);

for (const mode of ['request-rollback', 'terminal-rollback']) {
  test(
    `0003-A Codex ${mode} ignores wall-clock rollback while unrelated frames arrive`,
    { timeout: 6000 },
    async (t) => {
      const f = await setup(t, mode, 100);
      await f.reached(mode === 'request-rollback' ? 'initialize' : 'turn/start');
      if (mode === 'terminal-rollback') {
        await bounded(
          (async () => {
            while (!f.events.some((event) => event.type === 'accepted'))
              await new Promise((resolve) => setTimeout(resolve, 2));
          })(),
        );
      }
      const previous = Date.now();
      t.mock.method(Date, 'now', () => previous - 60000);
      const started = performance.now();
      f.startDeadline();
      const events = await bounded(f.finished, 700);
      assert.ok(performance.now() - started < 600);
      assert.equal(
        (events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome,
        mode === 'request-rollback' ? 'failed' : 'unknown',
      );
      assert.equal(f.adapter.hasActiveResources?.(f.sessionId), false);
    },
  );
}
