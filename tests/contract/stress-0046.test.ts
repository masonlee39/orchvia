import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0046: tests that depend on time are run under load every week, before they fail a PR.

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const script = join(root, 'scripts/stress.mjs');

async function stress(t: any, ...args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-stress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary.md');
  const run = spawnSync(
    process.execPath,
    [script, '--burners', '0', '--summary', summary, '--logs', join(dir, 'logs'), ...args],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { status: run.status, stderr: run.stderr, summary: await readFile(summary, 'utf8') };
}

test('AC-0046-S02 copies that pass leave a passing summary', async (t) => {
  const run = await stress(
    t,
    '--copies',
    '2',
    '--',
    process.execPath,
    '-e',
    "console.log('✔ fine (1ms)')",
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.summary, /\| 1 \| passed \|/);
  assert.match(run.summary, /\| 2 \| passed \|/);
});

test('AC-0046-S02 a failing copy fails the run and names its tests', async (t) => {
  const failing = [
    '-e',
    "console.log('✖ AC-X01 a wall-clock bound (12ms)'); console.log('FAIL: test_socket (test_host.Tests.test_socket)'); process.exit(1)",
  ];
  const run = await stress(t, '--copies', '2', '--', process.execPath, ...failing);
  assert.equal(run.status, 1);
  assert.match(run.summary, /\| 1 \| failed \|/);
  assert.match(run.summary, /AC-X01 a wall-clock bound/);
  assert.match(run.summary, /test_socket/);
});

test('AC-0046-S02 the number of copies is bounded', async () => {
  for (const copies of ['0', '9', 'x']) {
    const run = spawnSync(process.execPath, [script, '--copies', copies, '--', 'true'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 2, copies);
  }
});

test('AC-0046-S01 the stress workflow runs every Monday and on demand, reading only', () => {
  const workflow = read('.github/workflows/stress.yml');
  assert.match(workflow, /schedule:\n\s+- cron: '0 7 \* \* 1'/);
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+copies:/);
  assert.match(workflow, /os: ubuntu-24\.04[\s\S]*node: 22\.18\.0/);
  assert.match(workflow, /os: macos-14/);
  assert.match(workflow, /os: macos-15-intel/);
  assert.match(workflow, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(workflow, /issues: write|git push|gh issue/);
  // The input reaches the script through the environment, which checks it.
  assert.doesNotMatch(workflow, /run:.*\$\{\{\s*inputs\./);
  assert.match(workflow, /node scripts\/stress\.mjs --copies "\$COPIES"/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /npm run test:python/);
});

test('AC-0046-R01 CONTRIBUTING has the rules for tests that depend on time', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /## Tests that depend on time/);
  for (const rule of [/EngineClock/, /node scripts\/stress\.mjs/, /docs\/ci-flakes\.md/])
    assert.match(contributing, rule);
});

test('AC-0046-L01 every rerun of the CI is in the ledger', () => {
  const ledger = read('docs/ci-flakes.md');
  for (const run of [
    '36436194321',
    '36408774807',
    '35832001307',
    '35749328231',
    '35704670275',
    '35700235667',
    '35622995711',
    '35615323933',
  ])
    assert.ok(ledger.includes(run), run);
});
