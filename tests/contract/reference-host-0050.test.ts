import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openOrchestratorReadOnly } from '../../packages/sdk-typescript/src/index.ts';
import type { EventEnvelope, TaskSnapshot } from '../../packages/engine/src/types.ts';
import { Journal } from '../../examples/reference-host/journal.ts';
import { resolveStep } from '../../examples/reference-host/host.ts';

// SPEC-0050: the reference host runs change → tests → review → decision in TypeScript and in
// Python, and recovers from a crash at each injected point without creating, running or counting
// anything twice.

const root = fileURLToPath(new URL('../..', import.meta.url));
type Lang = 'ts' | 'py';
const LANGS: Lang[] = ['ts', 'py'];
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  last: Record<string, any> | null;
}

/** Runs one host command in its own process group, as a person would from a terminal. */
function host(lang: Lang, dir: string, args: string[]): Promise<Exit> {
  const command = lang === 'ts' ? process.execPath : 'python3';
  const script = join(root, 'examples/reference-host', lang === 'ts' ? 'host.ts' : 'host.py');
  const child = spawn(
    command,
    [script, ...args, '--root', dir, '--emergency-bytes', '4096', '--node', process.execPath],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, PYTHONPATH: join(root, 'python/src') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      reject(new Error(`host ${args.join(' ')} timed out\n${stderr}`));
    }, 90_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      let last: Record<string, any> | null = null;
      try {
        last = line ? JSON.parse(line) : null;
      } catch {}
      resolve({ code, signal, stdout, stderr, last });
    });
  });
}
async function ok(lang: Lang, dir: string, args: string[]) {
  const exit = await host(lang, dir, args);
  assert.equal(exit.code, 0, `${lang} ${args.join(' ')}\n${exit.stderr}`);
  return exit.last!;
}
async function killedAt(lang: Lang, dir: string, args: string[]) {
  const exit = await host(lang, dir, args);
  assert.equal(exit.signal, 'SIGKILL', `${lang} ${args.join(' ')} was not killed\n${exit.stderr}`);
  return exit;
}
async function setup(t: { after(fn: () => Promise<void>): void }, pass = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-refhost-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'workspace'));
  if (pass) await writeFile(join(dir, 'workspace', 'tests-pass'), '');
  return dir;
}

/** What the engine and the journal hold for one run, read after the host stopped. */
async function facts(dir: string, runId: string) {
  const orch = await openOrchestratorReadOnly({ stateDir: join(dir, 'state') });
  try {
    const listed = await orch.tasks.list({ label: `refhost:${runId}`, limit: 100 });
    const byStep: Record<string, TaskSnapshot[]> = {};
    for (const task of listed.tasks) {
      const step = String((task.spec.metadata as Record<string, unknown>).stepId);
      (byStep[step] ??= []).push(task);
    }
    const events: EventEnvelope[] = [];
    let cursor = '0';
    for (;;) {
      const page = await orch.events.read({
        afterCursor: cursor,
        storeId: orch.storeId,
        limit: 256,
      });
      events.push(...page.events);
      if (!page.events.length) break;
      cursor = page.cursor;
    }
    const ids = listed.tasks.map((task) => task.id);
    const dispatches = (id: string) =>
      events.filter((event) => event.type === 'dispatch.started' && event.taskId === id).length;
    const records = (await Promise.all(ids.map((id) => orch.usage.get(id)))).flatMap(
      (result) => result.records,
    );
    const journal = new Journal(join(dir, 'journal.sqlite'));
    try {
      const steps = journal.steps(runId);
      const usage = journal.usage(orch.storeId, ids);
      return {
        storeId: orch.storeId,
        byStep,
        events,
        steps,
        decisions: journal.decisions(runId),
        dispatches,
        records,
        journalUsage: usage,
      };
    } finally {
      journal.close();
    }
  } finally {
    await orch.close();
  }
}
/** The checks after every fault (SPEC-0050 F): one task per step, usage counted once. */
async function invariants(dir: string, runId: string) {
  const f = await facts(dir, runId);
  for (const [step, tasks] of Object.entries(f.byStep))
    assert.equal(tasks.length, 1, `step ${step} has ${tasks.length} tasks`);
  for (const step of f.steps)
    if (step.state === 'submitted')
      assert.equal(step.taskId, f.byStep[step.stepId]![0]!.id, `journal task of ${step.stepId}`);
  const dispatchIds = f.records.map((record) => record.dispatchId);
  assert.equal(new Set(dispatchIds).size, dispatchIds.length, 'one usage record per dispatch');
  assert.deepEqual(
    f.journalUsage.map((row) => row.usageRecordId).sort(),
    f.records.map((record) => record.id).sort(),
    'the journal counts each usage record once',
  );
  const sum = (values: (number | null)[]) => values.reduce<number>((n, v) => n + (v ?? 0), 0);
  assert.equal(
    sum(f.journalUsage.map((row) => row.inputTokens)),
    sum(f.records.map((record) => record.inputTokens)),
  );
  return f;
}
const task = (f: Awaited<ReturnType<typeof facts>>, step: string) => f.byStep[step]?.[0];

for (const lang of LANGS) {
  test(`0050-W01 0050-W02 0050-J01 ${lang}: the run reaches review, then approve completes it`, async (t) => {
    const dir = await setup(t);
    const started = await ok(lang, dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
    assert.equal(started.state, 'awaiting_review');
    let f = await invariants(dir, 'r1');
    const change = task(f, 'change')!,
      review = task(f, 'review')!;
    assert.equal(change.status, 'completed');
    assert.equal(review.status, 'waiting_approval');
    assert.deepEqual(review.spec.dependencyTaskIds, [change.id]);
    // W02: the review started after the change completed, and received its result.
    const completedAt = f.events.find(
      (e) => e.type === 'task.completed' && e.taskId === change.id,
    )!.cursor;
    const reviewStarted = f.events.find(
      (e) => e.type === 'dispatch.started' && e.taskId === review.id,
    )!.cursor;
    assert.ok(Number(reviewStarted) > Number(completedAt));
    assert.match(review.result ?? '', /Untrusted dependency result/);
    if (lang === 'ts') assert.equal(review.spec.runtime.provider, 'reviewer');
    assert.deepEqual([f.dispatches(change.id), f.dispatches(review.id)], [1, 1]);
    const done = await ok(lang, dir, ['decide', '--run', 'r1', '--choice', 'approve']);
    assert.equal(done.state, 'done');
    f = await invariants(dir, 'r1');
    assert.equal(task(f, 'review')!.status, 'completed');
    assert.equal(f.records.length, 2, 'each dispatch reported its usage');
  });

  test(`0050-W03 ${lang}: failing tests block the change, the review never starts, abandon ends both`, async (t) => {
    const dir = await setup(t, false);
    const started = await ok(lang, dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
    assert.equal(started.state, 'tests_failed');
    let f = await invariants(dir, 'r1');
    const change = task(f, 'change')!,
      review = task(f, 'review')!;
    assert.equal(change.status, 'blocked');
    assert.equal(change.reason, 'verification_failed');
    assert.equal(f.dispatches(change.id), 2, 'one repair');
    assert.equal(review.status, 'waiting_dependency');
    assert.equal(f.dispatches(review.id), 0);
    const abandoned = await ok(lang, dir, ['abandon', '--run', 'r1']);
    assert.equal(abandoned.state, 'abandoned');
    f = await invariants(dir, 'r1');
    assert.deepEqual(
      [task(f, 'change')!.status, task(f, 'review')!.status],
      ['cancelled', 'cancelled'],
    );
  });

  test(`0050-W04 ${lang}: revise requeues the review with the comment; deny fails it`, async (t) => {
    const dir = await setup(t);
    await ok(lang, dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
    const revised = await ok(lang, dir, [
      'decide',
      '--run',
      'r1',
      '--choice',
      'revise',
      '--comment',
      'Name the missing test',
    ]);
    assert.equal(revised.state, 'awaiting_review');
    let f = await invariants(dir, 'r1');
    const review = task(f, 'review')!;
    assert.equal(f.dispatches(review.id), 2);
    assert.match(review.result ?? '', /Name the missing test/);
    const denied = await ok(lang, dir, ['decide', '--run', 'r1', '--choice', 'deny']);
    assert.equal(denied.state, 'rejected');
    f = await invariants(dir, 'r1');
    assert.equal(task(f, 'review')!.status, 'failed');
    assert.equal(f.decisions.length, 2);
  });

  for (const [id, fault] of [
    ['F01', 'after-intent'],
    ['F03', 'before-projection-commit'],
  ])
    test(`0050-${id} ${lang}: killed ${fault}, the next start recovers without doing anything twice`, async (t) => {
      const dir = await setup(t);
      await killedAt(lang, dir, [
        'start',
        '--run',
        'r1',
        '--goal',
        'Add restock()',
        '--fault',
        fault,
      ]);
      const resumed = await ok(lang, dir, ['advance', '--run', 'r1']);
      assert.equal(resumed.state, 'awaiting_review');
      const f = await invariants(dir, 'r1');
      assert.deepEqual(
        [f.dispatches(task(f, 'change')!.id), f.dispatches(task(f, 'review')!.id)],
        [1, 1],
      );
      assert.equal(f.records.length, 2);
    });

  test(`0050-F02 ${lang}: killed after the engine started the change, before its receipt: found, not resent, unknown`, async (t) => {
    const dir = await setup(t);
    await killedAt(lang, dir, [
      'start',
      '--run',
      'r1',
      '--goal',
      'Add restock()',
      '--fault',
      'after-send',
    ]);
    let f = await facts(dir, 'r1');
    assert.equal(f.steps.find((s) => s.stepId === 'change')!.state, 'intended');
    const resumed = await ok(lang, dir, ['advance', '--run', 'r1']);
    // The embedded engine died with the host during the dispatch: its outcome is unknown.
    assert.equal(resumed.state, 'needs_reconcile');
    f = await invariants(dir, 'r1');
    const change = f.steps.find((s) => s.stepId === 'change')!;
    assert.equal(change.state, 'submitted', 'the receipt was found, not created again');
    assert.equal(f.dispatches(change.taskId!), 1);
  });

  test(`0050-F04 ${lang}: killed during the change's dispatch, the task stays unknown until the owner reconciles`, async (t) => {
    const dir = await setup(t);
    await killedAt(lang, dir, [
      'start',
      '--run',
      'r1',
      '--goal',
      'Add restock()',
      '--fault',
      'during-dispatch',
    ]);
    const resumed = await ok(lang, dir, ['advance', '--run', 'r1']);
    assert.equal(resumed.state, 'needs_reconcile');
    let f = await invariants(dir, 'r1');
    const change = task(f, 'change')!;
    assert.equal(change.status, 'blocked');
    assert.match(change.reason ?? '', /^outcome_unknown/);
    assert.equal(f.dispatches(change.id), 1, 'nothing was resent');
    // Advancing again changes nothing: unknown stays unknown.
    assert.equal((await ok(lang, dir, ['advance', '--run', 'r1'])).state, 'needs_reconcile');
    const reconciled = await ok(lang, dir, [
      'reconcile',
      '--run',
      'r1',
      '--outcome',
      'interrupted',
      '--summary',
      'The runtime process is gone; the workspace is unchanged',
    ]);
    assert.equal(reconciled.state, 'ended');
    f = await invariants(dir, 'r1');
    assert.equal(task(f, 'change')!.status, 'failed');
    assert.equal(f.dispatches(task(f, 'change')!.id), 1);
  });

  test(`0050-F05 ${lang}: killed after the decision was sent, the next start records one decision`, async (t) => {
    const dir = await setup(t);
    await ok(lang, dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
    await killedAt(lang, dir, [
      'decide',
      '--run',
      'r1',
      '--choice',
      'approve',
      '--fault',
      'after-decide-send',
    ]);
    const resumed = await ok(lang, dir, ['advance', '--run', 'r1']);
    assert.equal(resumed.state, 'done');
    const f = await invariants(dir, 'r1');
    assert.equal(f.decisions.length, 1);
    assert.equal(f.decisions[0]!.state, 'submitted');
    assert.equal(
      f.events.filter((e) => e.type === 'approval.approved').length,
      1,
      'one decision reached the engine',
    );
  });

  test(`0050-T05 ${lang}: a replayed projection changes nothing; an expired cursor needs a person`, async (t) => {
    const dir = await setup(t);
    await ok(lang, dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
    const before = await invariants(dir, 'r1');
    const db = new DatabaseSync(join(dir, 'journal.sqlite'));
    const rows = () =>
      JSON.stringify([
        db.prepare('SELECT * FROM projection ORDER BY taskId').all(),
        db.prepare('SELECT * FROM usage ORDER BY usageRecordId').all(),
        db.prepare('SELECT * FROM approvals ORDER BY approvalId').all(),
      ]).replace(/"blockedByAt":"[^"]*"/g, '');
    const projected = rows();
    db.prepare("UPDATE checkpoint SET cursor='0'").run();
    await ok(lang, dir, ['advance', '--run', 'r1']);
    assert.equal(rows(), projected, 'replaying every event changed no row');
    db.prepare("UPDATE checkpoint SET cursor='999999'").run();
    const expired = await ok(lang, dir, ['advance', '--run', 'r1']);
    assert.equal(expired.state, 'attention');
    assert.match(JSON.stringify(expired), /CURSOR_EXPIRED/);
    db.close();
    assert.equal((await invariants(dir, 'r1')).records.length, before.records.length);
  });
}

test('0050-F06 py: the Python host survives its engine child dying during a dispatch', async (t) => {
  const dir = await setup(t);
  const exit = await ok('py', dir, [
    'start',
    '--run',
    'r1',
    '--goal',
    'Add restock()',
    '--fault',
    'engine-exit',
  ]);
  assert.equal(exit.state, 'needs_reconcile');
  const f = await invariants(dir, 'r1');
  assert.equal(f.dispatches(task(f, 'change')!.id), 1, 'nothing was resent');
});

test('0050-J01 the TypeScript inspector reads a journal the Python host wrote', async (t) => {
  const dir = await setup(t);
  await ok('py', dir, ['start', '--run', 'r1', '--goal', 'Add restock()']);
  const inspected = await inspect(dir, ['--json']);
  const run = inspected.runs.find((r: any) => r.runId === 'r1');
  assert.equal(run.state, 'awaiting_review');
  assert.equal(run.steps.length, 2);
});

/** Runs the inspector and returns its JSON. */
async function inspect(dir: string, args: string[]) {
  const child = spawn(
    process.execPath,
    [join(root, 'examples/reference-host/inspect.ts'), '--root', dir, ...args],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, stderr);
  return args.includes('--json') ? JSON.parse(stdout) : stdout;
}

test('0050-I01 0050-I03 0050-I04 each state names its next step; inspecting changes nothing', async (t) => {
  const pass = await setup(t),
    fail = await setup(t, false),
    unknown = await setup(t);
  await ok('ts', pass, ['start', '--run', 'r1', '--goal', 'Add restock()']);
  await ok('ts', fail, ['start', '--run', 'r1', '--goal', 'Add restock()']);
  await killedAt('ts', unknown, [
    'start',
    '--run',
    'r1',
    '--goal',
    'x',
    '--fault',
    'during-dispatch',
  ]);
  await ok('ts', unknown, ['advance', '--run', 'r1']);
  const expectations: [string, string, RegExp][] = [
    [pass, 'awaiting_review', /reviewer: approve, deny or revise/],
    [fail, 'tests_failed', /abandon the run or start a new one/],
    [unknown, 'needs_reconcile', /reconcile; never resend/],
  ];
  for (const [dir, state, next] of expectations) {
    const before = await facts(dir, 'r1');
    const json = await inspect(dir, ['--json']);
    const text = await inspect(dir, []);
    const after = await facts(dir, 'r1');
    assert.equal(after.events.length, before.events.length, 'inspecting wrote no event');
    const run = json.runs.find((r: any) => r.runId === 'r1');
    assert.equal(run.state, state);
    assert.match(run.next, next);
    assert.match(text, next);
    // blockedBy is what the host last read from its running engine, with the time; never a guess.
    const review = run.steps.find((step: any) => step.stepId === 'review');
    if (review.status === 'waiting_dependency') {
      assert.equal(review.blockedBy.reason, 'dependency');
      assert.equal(typeof review.blockedBy.at, 'string');
    } else assert.equal(review.blockedBy, null);
    if (state === 'needs_reconcile') {
      // I04: an unknown count is never shown as a total.
      assert.equal(run.cost.total, null);
    } else {
      assert.equal(typeof run.cost.inputTokens, 'number');
      assert.equal(run.cost.unknownRecords, 0);
    }
  }
});

test('0050-T04 each recovery outcome of an intended step is taken as specified', async (t) => {
  const dir = await setup(t);
  const journal = new Journal(join(dir, 'journal.sqlite'));
  t.after(() => journal.close());
  let n = 0;
  const intend = (storeId = 's1') => {
    const stepId = `step-${++n}`;
    journal.intendStep({
      runId: 'r',
      stepId,
      storeId,
      idempotencyKey: `refhost/r/${stepId}`,
      request: JSON.stringify({ goal: 'x' }),
    });
    return journal.step('r', stepId)!;
  };
  const error = (code: string) => Object.assign(new Error(code), { code });
  const client = (lookup: () => Promise<any>, create?: () => Promise<any>) => {
    const calls: string[] = [];
    return {
      calls,
      info: { storeId: 's1' },
      operations: {
        lookup: async () => {
          calls.push('lookup');
          return lookup();
        },
      },
      tasks: {
        create: async (spec: unknown, options: { idempotencyKey: string }) => {
          calls.push(`create ${options.idempotencyKey} ${JSON.stringify(spec)}`);
          return create ? create() : { id: 'created' };
        },
      },
    };
  };
  // Found: the receipt is recorded, nothing is sent.
  let c = client(async () => ({ status: 'completed', targetId: 't1' }));
  let step = intend();
  await resolveStep(journal, c, step);
  assert.deepEqual(
    [journal.step('r', step.stepId)!.state, journal.step('r', step.stepId)!.taskId],
    ['submitted', 't1'],
  );
  assert.deepEqual(c.calls, ['lookup']);
  // Not found in the same store: the frozen request is sent with the same key.
  c = client(async () => {
    throw error('NOT_FOUND');
  });
  step = intend();
  await resolveStep(journal, c, step);
  assert.equal(journal.step('r', step.stepId)!.taskId, 'created');
  assert.deepEqual(c.calls, ['lookup', `create ${step.idempotencyKey} {"goal":"x"}`]);
  // Everything else needs a person and sends nothing again.
  for (const [make, reason] of [
    [
      () =>
        client(async () => {
          throw error('OPERATION_HISTORY_EXPIRED');
        }),
      'OPERATION_HISTORY_EXPIRED',
    ],
    [() => client(async () => ({ status: 'outcome_unknown', targetId: '' })), 'OUTCOME_UNKNOWN'],
    [
      () =>
        client(
          async () => {
            throw error('NOT_FOUND');
          },
          async () => {
            throw error('IDEMPOTENCY_CONFLICT');
          },
        ),
      'IDEMPOTENCY_CONFLICT',
    ],
  ] as [() => ReturnType<typeof client>, string][]) {
    c = make();
    step = intend();
    await resolveStep(journal, c, step);
    const after = journal.step('r', step.stepId)!;
    assert.equal(after.state, 'attention', reason);
    assert.match(after.attention!, new RegExp(reason));
    assert.ok(c.calls.filter((call) => call.startsWith('create')).length <= 1, reason);
  }
  c = client(async () => ({ status: 'completed', targetId: 't1' }));
  step = intend('another-store');
  await resolveStep(journal, c, step);
  assert.match(journal.step('r', step.stepId)!.attention!, /store_changed/);
  assert.deepEqual(c.calls, []);
  // A failure that says nothing about the outcome leaves the intent for the next start.
  c = client(async () => {
    throw error('REQUEST_FAILED');
  });
  step = intend();
  await assert.rejects(resolveStep(journal, c, step));
  assert.equal(journal.step('r', step.stepId)!.state, 'intended');
});
