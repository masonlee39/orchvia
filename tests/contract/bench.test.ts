import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0021 E04: the benchmark harness runs every arm offline, with no model call.
const root = fileURLToPath(new URL('../../', import.meta.url));

type Row = {
  id: string;
  track: string;
  session?: string;
  startMs: number;
  endMs: number;
  costUsd: number;
  pass: { hidden: boolean; own: boolean };
};
type Report = {
  fake: boolean;
  budget: { spentUsd: number; stopped: boolean };
  runs: { arm: string; requests: Row[]; totals: { passed: number; costUsd: number } }[];
};

async function bench(...extra: string[]): Promise<Report> {
  return benchExpecting(0, ...extra);
}

async function benchExpecting(status: number, ...extra: string[]): Promise<Report> {
  const directory = await mkdtemp(join(tmpdir(), 'orchvia-bench-test-'));
  try {
    const out = join(directory, 'report.json');
    const run = spawnSync(process.execPath, ['bench/run.mjs', '--fake', '--out', out, ...extra], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, status, run.stderr);
    return JSON.parse(await readFile(out, 'utf8')) as Report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('0021-E04 every arm completes the four requests offline and passes the hidden checks', async () => {
  const report = await bench('--require-pass');
  assert.equal(report.fake, true);
  assert.deepEqual(
    report.runs.map((run) => run.arm),
    ['single', 'fresh', 'parallel', 'orchvia'],
  );
  for (const run of report.runs) {
    assert.equal(run.requests.length, 4, run.arm);
    assert.equal(run.totals.passed, 4, `${run.arm}: ${JSON.stringify(run.requests)}`);
    assert.equal(run.totals.costUsd, 0, 'no model was called');
  }
  const orchvia = report.runs.find((run) => run.arm === 'orchvia')!.requests;
  const byId = Object.fromEntries(orchvia.map((row) => [row.id, row]));
  // Each follow-up reuses its track's warm session, and the two tracks use different sessions.
  assert.equal(byId.X2!.session, byId.X1!.session);
  assert.equal(byId.Y2!.session, byId.Y1!.session);
  assert.notEqual(byId.X1!.session, byId.Y1!.session);
  // The two first requests run at the same time.
  assert.ok(byId.X1!.startMs < byId.Y1!.endMs && byId.Y1!.startMs < byId.X1!.endMs);
});

test('0021-E04 a request whose work is missing fails its checks and is reported so', async () => {
  // --require-pass, as CI uses it, turns the failed request into a failed run.
  const report = await benchExpecting(1, '--arms', 'fresh', '--fake-skip', 'X2', '--require-pass');
  const rows = Object.fromEntries(report.runs[0]!.requests.map((row) => [row.id, row]));
  assert.deepEqual(rows.X2!.pass, { hidden: false, own: true });
  assert.deepEqual(rows.Y2!.pass, { hidden: true, own: true });
  assert.equal(report.runs[0]!.totals.passed, 3);
});

test('0021-E05 the harness stops before a request once the budget is spent', async () => {
  const report = await bench('--budget-usd', '0');
  assert.equal(report.budget.stopped, true);
  assert.equal(report.runs.length, 0);
});

// The host's stop proof for one writable dispatch (bench/stop.mjs), while the other track may still
// run in the same workspace. It needs lsof and ps, as the orchvia arm does.
type StopInput = {
  adapter: { hasActiveResources(sessionId: string): boolean };
  workspace: string;
  target: { sessionId: string };
  signal: AbortSignal;
};
const stopModule = new URL('../../bench/stop.mjs', import.meta.url).href;
const { executionStopped } = (await import(stopModule)) as {
  executionStopped(input: StopInput): Promise<boolean>;
};
const idle = { hasActiveResources: () => false };
const target = { sessionId: 'session-restock' };

async function withWorkspace(body: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-bench-stop-')));
  // Files that no process has open, as in the benchmark's project: lsof then exits with 1 even
  // when it lists a process.
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'inventory.js'), 'export {};\n');
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('0021-E04 the stop proof holds while the other track still works in the workspace', async () => {
  await withWorkspace(async (workspace) => {
    // A child of this process, as the other track's live Claude process is a child of the harness.
    const other = spawn('sleep', ['30'], { cwd: workspace, stdio: 'ignore' });
    try {
      const stopped = await executionStopped({
        adapter: idle,
        workspace,
        target,
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(stopped, true);
    } finally {
      other.kill();
    }
  });
});

test('0021-E04 the stop proof fails while a process that outlived its parent works in the workspace', async () => {
  await withWorkspace(async (workspace) => {
    // The shell exits at once; its background process is reparented away from this process.
    const orphan = Number(
      execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], {
        cwd: workspace,
        encoding: 'utf8',
      }).trim(),
    );
    try {
      const stopped = await executionStopped({
        adapter: idle,
        workspace,
        target,
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(stopped, false);
    } finally {
      process.kill(orphan);
    }
  });
});

test("0021-E04 the stop proof waits for the dispatch's own Claude process to exit", async () => {
  await withWorkspace(async (workspace) => {
    const stillRunning = { hasActiveResources: (id: string) => id === target.sessionId };
    assert.equal(
      await executionStopped({
        adapter: stillRunning,
        workspace,
        target,
        signal: AbortSignal.timeout(300),
      }),
      false,
    );
    let running = true;
    setTimeout(() => (running = false), 200);
    const begin = performance.now();
    assert.equal(
      await executionStopped({
        adapter: { hasActiveResources: () => running },
        workspace,
        target,
        signal: AbortSignal.timeout(10_000),
      }),
      true,
    );
    assert.ok(performance.now() - begin >= 150);
  });
});
