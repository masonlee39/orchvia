import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as processTree from '../../packages/engine/src/process-tree.ts';
import { processTable } from '../../packages/engine/src/process-tree.ts';
import { StopMarkers, sweepStopMarkers } from '../../packages/engine/src/stop-marker.ts';

// SPEC-0061 T: the paths that already wait read the process table without holding the thread.

const posix = process.platform !== 'win32';

/** Counts the synchronous `ps` calls made while `use` runs. */
async function synchronousListings(t: any, use: () => Promise<unknown> | unknown): Promise<number> {
  const calls = t.mock.method(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  try {
    await use();
    return calls.mock.calls.filter((call: { arguments: unknown[] }) => call.arguments[0] === 'ps')
      .length;
  } finally {
    calls.mock.restore();
    syncBuiltinESMExports();
  }
}
async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0061-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'workspace'));
  return { root: join(base, 'markers'), workspace: join(base, 'workspace') };
}
const context = (dispatchId: string) =>
  ({
    target: { dispatchId },
    terminal: { type: 'result', text: 'done' },
    remainingMs: () => 15_000,
  }) as never;

test('AC-0061-T01 the asynchronous listing is the synchronous one', { skip: !posix }, async () => {
  const listAsync = (processTree as any).processTableAsync as () => Promise<
    ReturnType<typeof processTable>
  >;
  assert.equal(typeof listAsync, 'function');
  const own = (await listAsync()).find((row) => row.pid === process.pid);
  assert.deepEqual(
    own,
    processTable().find((row) => row.pid === process.pid),
  );
  assert.ok(own?.started && own.ppid > 0);
});

test(
  'AC-0061-T01 a stop marker observation and a sweep run no synchronous ps',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const markers = new StopMarkers({ root });
    t.after(() => markers.endAll(15_000));
    // Creating the instance directory reads this process's start time once, synchronously (T02).
    markers.prepare('observed', '/bin/sh', workspace);
    // A process in the workspace, so that the observation has a candidate to look up in the
    // process table. It is this process's own child, which is no stray.
    const inside = spawn('sleep', ['30'], { cwd: workspace, stdio: 'ignore' });
    t.after(() => inside.kill('SIGKILL'));
    let stopped: unknown;
    assert.equal(
      await synchronousListings(t, async () => {
        stopped = await markers.observer(context('observed'));
      }),
      0,
      'the observation',
    );
    assert.equal(stopped, true, 'a process of this host in the workspace is no stray');
    inside.kill('SIGKILL');
    assert.equal(await synchronousListings(t, () => sweepStopMarkers(root)), 0, 'the sweep');
  },
);

test(
  'AC-0061-T01 the end of a process tree runs no synchronous ps',
  { skip: !posix },
  async (t) => {
    const descendants = (processTree as any).descendantsOf as (
      pid: number,
    ) => Promise<processTree.TreeProcess[]>;
    assert.equal(typeof descendants, 'function');
    // A shell with a child of its own, as an app-server with a command.
    const parent = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    t.after(() => parent.kill('SIGKILL'));
    let found: processTree.TreeProcess[] = [];
    for (let n = 0; n < 200 && !found.length; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      found = await descendants(parent.pid!);
    }
    assert.equal(found.length, 1, 'the shell’s child');
    const alive = () => {
      try {
        process.kill(found[0]!.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(alive());
    const listings = await synchronousListings(t, async () => {
      assert.deepEqual(await descendants(parent.pid!), found);
      await processTree.endProcesses(found, 2000);
    });
    assert.equal(listings, 0);
    for (let n = 0; n < 200 && alive(); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(alive(), false, 'the child was ended');
  },
);

test(
  'AC-0061-T02 the synchronous cleanup still lists synchronously',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const markers = new StopMarkers({ root });
    t.after(() => markers.endAll(15_000));
    markers.prepare('held', '/bin/sh', workspace);
    let result: unknown;
    const listings = await synchronousListings(t, () => {
      result = markers.endAllSync(2000);
    });
    assert.ok(listings >= 1, 'a synchronous exit path cannot wait');
    assert.deepEqual(result, { stopped: true, holders: 0, ended: 0 });
    // The real call still works after the mock is gone.
    assert.ok(execFileSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' }));
  },
);
