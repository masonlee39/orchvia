import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0050 B: a benchmark run keeps every finished request, reports failures, reserves before it
// starts a request, and has a direct arm with the same parallelism and session reuse as orchvia.
const root = fileURLToPath(new URL('../../', import.meta.url));

type Row = {
  id: string;
  track: string;
  status: string;
  message?: string;
  session?: string;
  startMs: number;
  endMs: number;
  costUsd: number | null;
};
type Report = {
  aborted?: { message: string };
  budget: { limitUsd: number; reserveUsd: number | null; spentUsd: number; stopped: boolean };
  runs: { arm: string; requests: Row[]; totals: { passed: number; costUsd: number | null } }[];
};

/**
 * No run of these tests may reach a model, even while a guard under test is missing: the harness
 * gets a private home without credentials and a model endpoint on a closed loopback port.
 */
function sealed(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(ANTHROPIC_|CLAUDE_)/.test(key)) env[key] = value;
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_AUTH_TOKEN: 'sealed-test-no-credentials',
  };
}

async function bench(status: number, ...extra: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'orchvia-bench-0050-'));
  try {
    const out = join(directory, 'report.json');
    const run = spawnSync(process.execPath, ['bench/run.mjs', '--out', out, ...extra], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: sealed(directory),
    });
    assert.equal(run.status, status, run.stderr);
    const rows = (await readFile(`${out}.rows.jsonl`, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row & { arm: string; rep: number });
    const report = JSON.parse(await readFile(out, 'utf8').catch(() => 'null')) as Report | null;
    return { report, rows, stderr: run.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('0050-B01 0050-B02 a request that throws is a row; the rest of its track did not run; every row was saved', async () => {
  const { report, rows } = await bench(
    0,
    '--fake',
    '--arms',
    'fresh,orchvia',
    '--fake-throw',
    'X1',
  );
  for (const arm of ['fresh', 'orchvia']) {
    const run = report!.runs.find((r) => r.arm === arm)!;
    const byId = Object.fromEntries(run.requests.map((row) => [row.id, row]));
    assert.equal(byId.X1!.status, 'error', arm);
    assert.match(byId.X1!.message!, /fake-throw/);
    assert.equal(byId.X1!.costUsd, null, 'an error row has no known cost');
    assert.equal(byId.X2!.status, 'not_run', arm);
    assert.equal(byId.Y2!.status, 'completed', `${arm}: the other track goes on`);
    assert.equal(run.totals.costUsd, null, 'an unknown cost is never counted as 0');
    // B01: each row reached the rows file as it finished.
    assert.deepEqual(
      rows
        .filter((row) => row.arm === arm)
        .map((row) => row.id)
        .sort(),
      ['X1', 'X2', 'Y1', 'Y2'],
    );
  }
});

test('0050-B01 the report is written even when the harness itself fails', async () => {
  const { report, rows } = await bench(
    1,
    '--fake',
    '--arms',
    'fresh',
    '--fake-harness-throw',
    'Y1',
  );
  assert.match(report!.aborted!.message, /fake-harness-throw/);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['X1'],
    'the rows finished before the failure are kept',
  );
});

test('0050-B03 a reservation stops a start that could pass the budget', async () => {
  const args = ['--fake', '--arms', 'parallel', '--budget-usd', '0.25', '--fake-cost-usd', '0.1'];
  const reserved = (await bench(0, ...args, '--reserve-usd', '0.1')).report!;
  assert.ok(reserved.budget.spentUsd <= 0.25, `spent ${reserved.budget.spentUsd}`);
  assert.equal(reserved.budget.stopped, true);
  assert.equal(reserved.budget.reserveUsd, 0.1);
  const statuses = reserved.runs[0]!.requests.map((row) => row.status).sort();
  assert.deepEqual(statuses, ['completed', 'completed', 'not_run', 'not_run']);
  // Without a reservation, both follow-ups start while the first two are unsettled: over budget.
  const unreserved = (await bench(0, ...args)).report!;
  assert.ok(unreserved.budget.spentUsd > 0.25, `spent ${unreserved.budget.spentUsd}`);
});

test('0050-B03 a paid run with a budget requires --reserve-usd', async () => {
  const { stderr } = await bench(1, '--arms', 'fresh', '--budget-usd', '1');
  assert.match(stderr, /--reserve-usd/);
});

test('0050-B04 the parallel arm runs both tracks at once, each resuming its own session', async () => {
  const report = (await bench(0, '--fake', '--arms', 'parallel', '--require-pass')).report!;
  const byId = Object.fromEntries(report.runs[0]!.requests.map((row) => [row.id, row]));
  assert.equal(byId.X2!.session, byId.X1!.session);
  assert.equal(byId.Y2!.session, byId.Y1!.session);
  assert.notEqual(byId.X1!.session, byId.Y1!.session);
  assert.ok(byId.X1!.startMs < byId.Y1!.endMs && byId.Y1!.startMs < byId.X1!.endMs);
});
