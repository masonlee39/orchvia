import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// SPEC-0052 P03: the capacity benchmark measures mixed load.
const script = fileURLToPath(new URL('../../scripts/capacity-benchmark.ts', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000 });

test('AC-0052-P03 the benchmark runs with retained artifacts and readers, and reports them', () => {
  const result = run('0', '3', '--artifacts', '0,40', '--readers', '1');
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout).rows;
  assert.deepEqual(
    rows.map((row: any) => [row.historyTasks, row.artifactFiles, row.readers]),
    [
      [0, 0, 1],
      [0, 40, 1],
    ],
  );
  for (const row of rows) {
    assert.equal(row.fixtureTasks, 3);
    assert.ok(row.readP95Ms['tasks.list'] >= 0 && row.readP95Ms['events.read'] >= 0);
    assert.equal(typeof row.eventLoopMaxMs, 'number');
    assert.equal(row.modelCalls, 0);
  }
});

test('AC-0052-P03 the benchmark refuses options out of range', () => {
  for (const args of [
    ['0', '1', '--artifacts', '-1'],
    ['0', '1', '--readers', '17'],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /--artifacts 0\.\.100000 and --readers 0\.\.16/);
  }
});
