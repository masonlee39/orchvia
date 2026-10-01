import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  createCodexAdapter,
  type CodexAdapterConfig,
} from '../../packages/adapter-codex/src/index.ts';
import type {
  ExecutionBudget,
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

const fixtureSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.argv[1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
setInterval(() => {}, 1000);
const reply = (id, result) => send({id,result});
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.FIXTURE_REQUESTS, request.method + '\n');
  if(request.method === 'initialize') {
    if(mode === 'gate-init') {
      const timer = setInterval(() => {
        if(!fs.existsSync(process.env.FIXTURE_GATE)) return;
        clearInterval(timer); reply(request.id,{userAgent:'isolation-fixture'});
      }, 2);
    } else reply(request.id,{userAgent:'isolation-fixture'});
  } else if(request.method === 'thread/start') {
    reply(request.id,{thread:{id:'isolated-thread'}});
  } else if(request.method === 'turn/start') {
    reply(request.id,{turn:{id:'isolated-turn'}});
    if(mode === 'stall-terminal') return;
    if(mode === 'disconnect') return setTimeout(() => process.exit(0), 20);
    if(mode === 'foreign') {
      send({method:'turn/completed',params:{threadId:'another-thread',turn:{id:'isolated-turn',status:'completed'}}});
      send({method:'turn/completed',params:{threadId:'isolated-thread',turn:{id:'another-turn',status:'completed'}}});
      return setTimeout(() => process.exit(0), 20);
    }
    send({method:'thread/tokenUsage/updated',params:{threadId:'isolated-thread',turnId:'isolated-turn',tokenUsage:{last:{inputTokens:1,outputTokens:1},total:{totalTokens:2}}}});
    setTimeout(() => {
      send({method:'item/completed',params:{threadId:'isolated-thread',turnId:'isolated-turn',item:{type:'agentMessage',text:'isolated result'}}});
      send({method:'turn/completed',params:{threadId:'isolated-thread',turn:{id:'isolated-turn',status:'completed'}}});
    },mode === 'delayed-terminal' ? 30 : 20);
  }
});
`;

function hostBudget(total = 1800000) {
  let elapsed = 0;
  const enteredAt = '2026-09-19T00:00:00.000Z';
  const budget: ExecutionBudget = {
    policyVersion: 2,
    enteredAt,
    acceptanceDeadlineAt: new Date(Date.parse(enteredAt) + 30000).toISOString(),
    deadlineAt: new Date(Date.parse(enteredAt) + total).toISOString(),
    effectiveAcceptanceMs: 30000,
    effectiveTurnMs: total,
    acceptanceSource: 'host-default',
    turnSource: 'host-default',
    remainingAcceptanceMs: () => 30000 - elapsed,
    remainingTurnMs: () => total - elapsed,
  };
  return {
    budget,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Isolation fixture exceeded its test deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function setup(
  t: TestContext,
  mode = 'complete',
  options: {
    config?: Partial<CodexAdapterConfig>;
    input?: Partial<RuntimeInput>;
    onEvent?: (event: RuntimeEvent) => void;
    onEvidence?: (evidence: ExecutionEvidence) => void;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-a2-'));
  const pidPath = join(dir, 'pid'),
    requestsPath = join(dir, 'requests'),
    gatePath = join(dir, 'gate');
  const adapter = createCodexAdapter({
    // A fixture command never outlives its turn, so the host observer may vouch (SPEC-0034 A01).
    observeExecutionStop: async () => true,
    command: process.execPath,
    args: ['-e', fixtureSource, mode],
    // Time for the fixture's process to end. A loaded machine takes longer than the 20 ms this
    // was: the adapter then rightly reported that cleanup was unconfirmed, and a test that
    // expected the result failed. A test of a cleanup that fails sets its own short time.
    closeTimeoutMs: 5000,
    env: { FIXTURE_PID: pidPath, FIXTURE_REQUESTS: requestsPath, FIXTURE_GATE: gatePath },
    ...options.config,
  });
  const events: RuntimeEvent[] = [],
    reports: ExecutionEvidence[] = [];
  const finished = (async () => {
    for await (const event of adapter.execute({
      taskId: 'a2-task',
      sessionId: 'a2-session',
      dispatchId: 'a2-dispatch',
      generation: 7,
      providerSessionId: null,
      model: 'offline-fixture',
      workspace: process.cwd(),
      stateDir: dir,
      prompt: 'Offline execution isolation fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      ...options.input,
      reportExecutionEvidence: (evidence) => {
        reports.push(evidence);
        options.onEvidence?.(evidence);
      },
    })) {
      events.push(event);
      options.onEvent?.(event);
    }
    return events;
  })();
  const pid = async (): Promise<number | null> => {
    try {
      return Number(await readFile(pidPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  t.after(async () => {
    t.mock.restoreAll();
    const ownedPid = await pid();
    if (ownedPid !== null) {
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
  const requests = async () => {
    try {
      return (await readFile(requestsPath, 'utf8')).trim().split('\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const reached = async (method: string) =>
    bounded(
      (async () => {
        while (!(await requests()).includes(method))
          await new Promise((resolve) => setTimeout(resolve, 2));
      })(),
    );
  return {
    adapter,
    events,
    reports,
    finished,
    pid,
    requests,
    reached,
    openGate: () => writeFile(gatePath, 'continue'),
  };
}

test('A2 Codex advertises only explicit provider caps and, since 0034-A01, no terminal coverage', () => {
  const defaults = createCodexAdapter({ executionStop: 'owner-reconcile' }).capabilities();
  assert.deepEqual(defaults.executionBudget, {
    version: 2,
    acceptanceCapMs: null,
    turnCapMs: null,
  });
  assert.deepEqual(defaults.executionEvidence, { version: 1, terminalCoversExecution: false });
  assert.deepEqual(
    createCodexAdapter({
      executionStop: 'owner-reconcile',
      requestTimeoutMs: 123,
      turnTimeoutMs: 456,
    }).capabilities().executionBudget,
    { version: 2, acceptanceCapMs: 123, turnCapMs: 456 },
  );
});

for (const mode of ['host', 'standalone']) {
  test(`A2 Codex ${mode} default total budget permits an accepted turn beyond 300 seconds`, async (t) => {
    const host = hostBudget();
    const realNow = performance.now.bind(performance);
    let offset = 0;
    t.mock.method(performance, 'now', () => realNow() + offset);
    const f = await setup(t, 'complete', {
      input: mode === 'host' ? { executionBudget: host.budget } : {},
      onEvent: (event) => {
        if (event.type === 'usage') {
          offset += 301000;
          host.advance(301000);
        }
      },
    });
    const events = await bounded(f.finished);
    assert.equal(events.at(-1)?.type, 'result');
    assert.equal(
      (events.at(-1) as Extract<RuntimeEvent, { type: 'result' }>).text,
      'isolated result',
    );
  });
}

test('A2 Codex initialization consumes the host total budget and does not submit after it expires', async (t) => {
  const host = hostBudget(1000);
  const f = await setup(t, 'gate-init', { input: { executionBudget: host.budget } });
  await f.reached('initialize');
  host.advance(1000);
  await f.openGate();
  const events = await bounded(f.finished);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  assert.equal((await f.requests()).includes('turn/start'), false);
  assert.ok(
    f.reports.some(
      (report) =>
        report.source === 'pre_submission' &&
        report.localResources === 'stopped' &&
        report.remoteExecution === 'stopped',
    ),
  );
});

test('A2 Codex acceptance cannot refresh the injected host total budget', async (t) => {
  const host = hostBudget(1000);
  const f = await setup(t, 'complete', {
    config: { turnTimeoutMs: 3600000 },
    input: { executionBudget: host.budget },
    onEvent: (event) => {
      if (event.type === 'accepted') host.advance(1000);
    },
  });
  const events = await bounded(f.finished);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(
    events.some((event) => event.type === 'result'),
    false,
  );
});

test('A2 Codex a longer explicit standalone acceptance cap replaces the standalone default', async (t) => {
  const realNow = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, 'now', () => realNow() + offset);
  const f = await setup(t, 'gate-init', { config: { requestTimeoutMs: 60000 } });
  await f.reached('initialize');
  offset += 30001;
  await f.openGate();
  assert.equal((await bounded(f.finished)).at(-1)?.type, 'result');
});

test('A2 Codex a longer explicit standalone turn cap replaces the standalone default', async (t) => {
  const realNow = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, 'now', () => realNow() + offset);
  const f = await setup(t, 'complete', {
    config: { turnTimeoutMs: 3600000 },
    onEvent: (event) => {
      if (event.type === 'usage') offset += 1801000;
    },
  });
  assert.equal((await bounded(f.finished)).at(-1)?.type, 'result');
});

test('A2 Codex explicit total cap also starts at execute rather than after acceptance', async (t) => {
  const realNow = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, 'now', () => realNow() + offset);
  const f = await setup(t, 'complete', {
    config: { turnTimeoutMs: 1000 },
    onEvent: (event) => {
      if (event.type === 'accepted') offset += 1000;
    },
  });
  const events = await bounded(f.finished);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
});

test('A2 Codex uses the negotiated host clock instead of starting another explicit-cap timer', async (t) => {
  const host = hostBudget(1000);
  host.budget.effectiveAcceptanceMs = 1000;
  host.budget.acceptanceSource = 'provider-explicit';
  host.budget.turnSource = 'provider-explicit';
  const realNow = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, 'now', () => realNow() + offset);
  const f = await setup(t, 'complete', {
    config: { requestTimeoutMs: 1000, turnTimeoutMs: 1000 },
    input: { executionBudget: host.budget },
    onEvent: (event) => {
      if (event.type === 'usage') offset += 1001;
    },
  });
  const events = await bounded(f.finished);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
});

test('A2 Codex reports a matching terminal and native checkpoint before full stopping evidence', async (t) => {
  const f = await setup(t);
  const events = await bounded(f.finished);
  assert.deepEqual(
    events.map((event) => event.type),
    ['accepted', 'usage', 'result'],
  );
  const first = f.reports[0],
    last = f.reports.at(-1);
  assert.equal(first?.source, 'runtime_terminal');
  assert.equal(first?.localResources, 'unknown');
  // SPEC-0034 A01: the terminal alone no longer shows that execution stopped; the observer does.
  assert.equal(first?.remoteExecution, 'unknown');
  assert.deepEqual(first?.terminal, {
    type: 'result',
    text: 'isolated result',
    providerSessionId: 'isolated-thread',
    nativeCheckpoint: 'isolated-turn',
  });
  assert.equal(last?.localResources, 'stopped');
  assert.equal(last?.remoteExecution, 'stopped');
  for (const [index, report] of f.reports.entries()) {
    assert.equal(report.sequence, index + 1);
    assert.equal(report.dispatchId, 'a2-dispatch');
    assert.equal(report.sessionId, 'a2-session');
    assert.equal(report.generation, 7);
    assert.equal(report.provider, 'codex');
    assert.equal(report.providerSessionId, 'isolated-thread');
    assert.equal(report.providerTurnId, 'isolated-turn');
  }
});

test('A2 Codex retains the terminal through cleanup failure and notifies late exit after its iterator ended', async (t) => {
  t.mock.method(ChildProcess.prototype, 'kill', () => false);
  // The process cannot be ended here, so the cleanup's whole time passes: keep it short.
  const f = await setup(t, 'complete', { config: { closeTimeoutMs: 20 } });
  const events = await bounded(f.finished);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.ok(
    f.reports.some(
      (report) => report.source === 'runtime_terminal' && report.terminal?.type === 'result',
    ),
  );
  assert.equal(
    f.reports.some((report) => report.localResources === 'stopped'),
    false,
  );
  const before = f.reports.length;
  const pid = await f.pid();
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await bounded(
    (async () => {
      while (f.reports.length === before) await new Promise((resolve) => setTimeout(resolve, 2));
    })(),
  );
  const last = f.reports.at(-1)!;
  assert.equal(last.source, 'resource_observation');
  assert.equal(last.localResources, 'stopped');
  assert.equal(last.remoteExecution, 'stopped');
  assert.equal(last.dispatchId, 'a2-dispatch');
  assert.equal(last.generation, 7);
  assert.equal(events.at(-1)?.type, 'error', 'late evidence must not append a success event');
});

for (const mode of ['disconnect', 'foreign']) {
  test(`A2 Codex ${mode} cannot turn local process exit into remote stopping proof`, async (t) => {
    const f = await setup(t, mode);
    const events = await bounded(f.finished);
    assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
    assert.ok(f.reports.length);
    assert.ok(f.reports.some((report) => report.localResources === 'stopped'));
    assert.ok(f.reports.every((report) => report.remoteExecution === 'unknown'));
    assert.equal(
      f.reports.some((report) => report.source === 'runtime_terminal'),
      false,
    );
  });
}

test('A2 Codex explicit pre-submission failure has complete stopping proof and standalone generation one', async (t) => {
  const f = await setup(t, 'complete', {
    input: { permissionProfile: 'workspace-write', generation: undefined },
  });
  const events = await bounded(f.finished);
  assert.deepEqual(events, [
    { type: 'error', message: 'Codex adapter supports read-only only', outcome: 'failed' },
  ]);
  assert.equal(await f.pid(), null);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].source, 'pre_submission');
  assert.equal(f.reports[0].localResources, 'stopped');
  assert.equal(f.reports[0].remoteExecution, 'stopped');
  assert.equal(f.reports[0].generation, 1);
});

test('A2 Codex retains terminal evidence but cannot return success when the host deadline expires during evidence persistence', async (t) => {
  const host = hostBudget(1000);
  const f = await setup(t, 'complete', {
    input: { executionBudget: host.budget },
    onEvidence: (report) => {
      if (report.source === 'runtime_terminal') host.advance(1000);
    },
  });
  const events = await bounded(f.finished);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.ok(f.reports.some((report) => report.terminal?.type === 'result'));
  assert.ok(
    f.reports.some(
      (report) => report.localResources === 'stopped' && report.remoteExecution === 'stopped',
    ),
  );
});

test('A2 Codex timer wakeups recheck a fixed host budget instead of timing it out locally', async (t) => {
  const host = hostBudget(20);
  host.budget.effectiveAcceptanceMs = 20;
  host.budget.remainingAcceptanceMs = () => 20;
  host.budget.remainingTurnMs = () => 20;
  const f = await setup(t, 'delayed-terminal', { input: { executionBudget: host.budget } });
  const events = await bounded(f.finished, 700);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
});

test('A2 Codex stalled stream still expires when the authoritative host remaining budget reaches zero', async (t) => {
  const host = hostBudget(180);
  const started = performance.now();
  host.budget.remainingTurnMs = () => 180 - (performance.now() - started);
  const f = await setup(t, 'stall-terminal', { input: { executionBudget: host.budget } });
  const events = await bounded(f.finished, 700);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.ok(performance.now() - started < 650);
  assert.ok(f.reports.every((report) => report.remoteExecution === 'unknown'));
});
