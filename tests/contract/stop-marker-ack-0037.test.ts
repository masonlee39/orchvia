import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeStopMarkers,
  endStopMarkersSync,
  staleStopMarkers,
  sweepStopMarkers,
} from '../../packages/adapter-claude/src/index.ts';
import { StopMarkers } from '../../packages/engine/src/stop-marker.ts';

// SPEC-0037: a sweep that keeps what it proved until the host acknowledges it, and one synchronous
// cleanup for every instance of this process under a host directory.

const posix = process.platform !== 'win32';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
// Calls that return once done get time for a loaded runner (see SPEC-0036's TDD).
const TIME = { timeoutMs: 20000 };

async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0037-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'markers'),
    workspace = join(base, 'workspace');
  await mkdir(workspace);
  return { root, workspace };
}

/** An instance under `root` whose host has exited, leaving `command`'s background process. */
function deadInstance(t: any, root: string, workspace: string, command: string, id = 'dead') {
  const out = execFileSync(
    process.execPath,
    [
      new URL('../fixtures/stop-marker-instance.ts', import.meta.url).pathname,
      root,
      workspace,
      command,
      id,
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
    pid: number;
    instance: string;
    marker: string;
  };
  t.after(() => {
    if (result.pid > 0 && alive(result.pid)) process.kill(result.pid, 'SIGKILL');
  });
  return result;
}
const files = async (instance: string) => (existsSync(instance) ? await readdir(instance) : []);

test(
  '0037-K01 keepProven keeps a proven dispatch, which stays proven',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const dead = deadInstance(t, root, workspace, 'sleep 30 >/dev/null 2>&1 & echo $!', 'kept');
    const swept = await sweepStopMarkers(root, { ...TIME, keepProven: true });
    assert.equal(swept.stopped, true, JSON.stringify(swept));
    assert.equal(swept.dispatches[0]?.dispatchId, 'kept');
    assert.equal(swept.dispatches[0]?.proven, true);
    assert.equal(alive(dead.pid), false);
    assert.ok((await files(dead.instance)).some((file) => file.endsWith('.proven')));
    assert.ok((await files(dead.instance)).some((file) => file.endsWith('.tag')));
    // A process started in the workspace since then does not turn it back.
    const later = Number(
      spawnSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout.trim(),
    );
    t.after(() => {
      if (alive(later)) process.kill(later, 'SIGKILL');
    });
    for (const check of [staleStopMarkers, sweepStopMarkers]) {
      const again = await check(root, { ...TIME, keepProven: true });
      assert.deepEqual(
        again.dispatches.map(({ dispatchId, stopped, proven }) => ({
          dispatchId,
          stopped,
          proven,
        })),
        [{ dispatchId: 'kept', stopped: true, proven: true }],
        check.name,
      );
    }
    assert.ok(alive(later), 'nothing was ended for a proven dispatch');
  },
);

test(
  '0037-K02 without keepProven a sweep removes what it proves, as before, proven or not',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const dead = deadInstance(t, root, workspace, 'true', 'plain');
    await sweepStopMarkers(root, { ...TIME, keepProven: true });
    assert.ok((await files(dead.instance)).some((file) => file.endsWith('.proven')));
    const swept = await sweepStopMarkers(root, TIME);
    assert.equal(swept.stopped, true);
    assert.equal(swept.dispatches[0]?.proven, true);
    assert.equal(existsSync(dead.instance), false, 'removed with its proof');
  },
);

test(
  '0037-K03 acknowledging removes proven dispatches only, and repeats harmlessly',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const proven = deadInstance(t, root, workspace, 'true', 'proven');
    // Its own workspace: a process that dropped a marker keeps every dispatch of its workspace
    // open, this test's proven one included.
    const elsewhere = join(workspace, '..', 'workspace-open');
    await mkdir(elsewhere);
    const open = deadInstance(
      t,
      root,
      elsewhere,
      'sleep 30 9<&- >/dev/null 2>&1 & echo $!',
      'open',
    );
    // The open dispatch keeps the sweep looking for its whole time; under load one look takes seconds.
    const swept = await sweepStopMarkers(root, { timeoutMs: 40000, keepProven: true });
    assert.deepEqual(
      Object.fromEntries(swept.dispatches.map((item) => [item.dispatchId, item.stopped])),
      { proven: true, open: false },
    );
    // A live instance with nothing marked right now keeps its directory for its next dispatch.
    const live = new StopMarkers({ root });
    t.after(() => live.endAll(15000));
    const liveDirectory = live.directory;
    const acknowledged = acknowledgeStopMarkers(root, ['proven', 'open', 'unknown']);
    assert.equal(existsSync(liveDirectory), true, 'a live instance keeps its directory');
    assert.deepEqual(acknowledged, {
      removed: ['proven'],
      refused: [{ dispatchId: 'open', reason: 'not_proven' }],
      missing: ['unknown'],
    });
    assert.equal(existsSync(proven.instance), false, 'an instance with nothing left goes');
    assert.ok(
      (await files(open.instance)).some((file) => file.endsWith('.tag')),
      'kept',
    );
    assert.deepEqual(acknowledgeStopMarkers(root, ['proven']), {
      removed: [],
      refused: [],
      missing: ['proven'],
    });
    assert.ok(existsSync(root), 'the root stays');
  },
);

test(
  '0037-K04 an acknowledgement cut short never leaves an unproven dispatch looking proven',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    // Cut after the marker went: what is left is removed by the next sweep and never reported.
    const first = deadInstance(t, root, workspace, 'true', 'cut-after-tag');
    await sweepStopMarkers(root, { ...TIME, keepProven: true });
    await rm(first.marker);
    // Cut before the marker went, after the proof was lost: examined again, not taken as proven.
    const second = deadInstance(
      t,
      root,
      workspace,
      'sleep 30 9<&- >/dev/null 2>&1 & echo $!',
      'lost-proof',
    );
    process.kill(second.pid, 'SIGKILL');
    await delay(100);
    await sweepStopMarkers(root, { ...TIME, keepProven: true });
    await rm(second.marker.replace(/\.tag$/, '.proven'));
    const later = Number(
      spawnSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout.trim(),
    );
    t.after(() => {
      if (alive(later)) process.kill(later, 'SIGKILL');
    });
    const swept = await staleStopMarkers(root, TIME);
    assert.deepEqual(
      swept.dispatches.map(({ dispatchId, stopped, proven }) => ({ dispatchId, stopped, proven })),
      [{ dispatchId: 'lost-proof', stopped: false, proven: undefined }],
    );
    await sweepStopMarkers(root, { timeoutMs: 1000, keepProven: true });
    assert.equal(existsSync(first.instance), false, 'the rest of a cut acknowledgement goes');
  },
);

test(
  '0037-Y02 one synchronous cleanup covers every instance of this process under a root',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    assert.deepEqual(endStopMarkersSync(root, 300), {
      stopped: true,
      holders: 0,
      ended: 0,
      instances: [],
    });
    const listed: string[][] = [];
    const counted = (paths: string[], since: number, timeoutMs: number) => {
      listed.push(paths);
      return StopMarkers.listHolders(paths, since, timeoutMs);
    };
    const a = new StopMarkers({ root, listHolders: counted });
    const b = new StopMarkers({ root });
    // Under another host directory of this same process.
    const other = new StopMarkers({ root: join(root, '..', 'other-markers') });
    t.after(async () => {
      for (const markers of [a, b, other]) await markers.endAll(15000);
    });
    const pids = [a, b, other].map((markers, i) => {
      const marker = markers.prepare(`sync-${i}`, '/bin/sh', workspace);
      const pid = Number(
        spawnSync(marker.wrapper, ['sleep 30 >/dev/null 2>&1 & echo $!'], {
          cwd: workspace,
          encoding: 'utf8',
        }).stdout.trim(),
      );
      t.after(() => {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      });
      return pid;
    });
    // On a loaded runner one call may end the holders without verifying; the next finds none.
    let result = endStopMarkersSync(root, 2000);
    let holders = result.holders;
    for (let i = 0; !result.stopped && i < 5; i++) {
      result = endStopMarkersSync(root, 2000);
      holders = Math.max(holders, result.holders);
    }
    assert.equal(result.stopped, true, JSON.stringify(result));
    assert.equal(holders >= 2, true, JSON.stringify(result));
    assert.deepEqual(
      result.instances.map((item: { instance: string }) => item.instance).sort(),
      [a.directory, b.directory].sort(),
    );
    assert.equal(alive(pids[0]!), false);
    assert.equal(alive(pids[1]!), false);
    assert.equal(alive(pids[2]!), true, 'an instance under another directory is not touched');
    // One listing covers both instances' markers, not one listing each.
    assert.equal(listed[0]?.length, 2, JSON.stringify(listed));
    assert.ok(listed[0]!.every((path) => path.startsWith(root)));
  },
);
