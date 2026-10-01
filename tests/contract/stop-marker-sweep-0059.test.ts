import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stopMarker from '../../packages/engine/src/stop-marker.ts';
import {
  StopMarkers,
  acknowledgeStopMarkers,
  sweepStopMarkers,
} from '../../packages/engine/src/stop-marker.ts';

// SPEC-0059: a sweep's wait for strays is bounded and happens once per dispatch, no dispatch takes
// another's time, an application's processes are another tool's, and a host can retire a dispatch
// that its user confirmed.

const posix = process.platform !== 'win32';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0059-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root: join(base, 'markers') };
}
/** An instance whose host has exited, leaving `command`'s background process in its workspace. */
async function deadInstance(t: any, base: string, root: string, name: string, command: string) {
  const workspace = join(base, name);
  await mkdir(workspace);
  const out = execFileSync(
    process.execPath,
    [
      new URL('../fixtures/stop-marker-instance.ts', import.meta.url).pathname,
      root,
      workspace,
      command,
      name,
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as { pid: number; instance: string };
  t.after(() => {
    if (result.pid > 0 && alive(result.pid)) process.kill(result.pid, 'SIGKILL');
  });
  return { ...result, workspace, dispatchId: name };
}
// A process that dropped the marker and stays in the workspace: what a stray is.
const STRAY = 'sleep 120 9<&- >/dev/null 2>&1 & echo $!';
const CLEAN = 'true; echo 0';
const of = (swept: stopMarker.StopMarkerSweep, dispatchId: string) =>
  swept.dispatches.find((dispatch) => dispatch.dispatchId === dispatchId)!;

test(
  "AC-0059-T01 a dispatch with a stray does not take another dispatch's time",
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    await deadInstance(t, base, root, 'a-stray', STRAY);
    await deadInstance(t, base, root, 'b-clean', CLEAN);
    await deadInstance(t, base, root, 'c-stray', STRAY);
    await deadInstance(t, base, root, 'd-clean', CLEAN);
    const swept = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 20_000 });
    for (const clean of ['b-clean', 'd-clean']) {
      assert.equal(of(swept, clean).stopped, true, JSON.stringify(of(swept, clean)));
      assert.equal(of(swept, clean).proven, true);
    }
    for (const stray of ['a-stray', 'c-stray']) {
      assert.equal(of(swept, stray).stopped, false);
      assert.equal(of(swept, stray).reason, 'strays', JSON.stringify(of(swept, stray)));
    }
    assert.equal(swept.stopped, false);
  },
);

test(
  'AC-0059-T02 AC-0059-T03 the wait for a stray is bounded, and happens once for a dispatch',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const dead = await deadInstance(t, base, root, 'stays', STRAY);
    const started = performance.now();
    const first = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 60_000 });
    // The wait is three seconds; the rest is listings, which a loaded machine slows.
    assert.ok(performance.now() - started < 30_000, 'it did not wait out its sixty seconds');
    assert.equal(of(first, 'stays').reason, 'strays');
    assert.equal(of(first, 'stays').waited, true, 'the first sweep waited for the stray');
    assert.ok(alive(dead.pid), 'a stray is never ended');
    const second = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 60_000 });
    assert.equal(of(second, 'stays').reason, 'strays');
    assert.equal(of(second, 'stays').waited, undefined, 'a later sweep does not wait again');
    // The record stays one that an earlier version reads.
    const name = readdirSync(dead.instance).find(
      (file) => file.endsWith('.json') && file !== 'instance.json',
    )!;
    const record = JSON.parse(await readFile(join(dead.instance, name), 'utf8'));
    assert.equal(record.dispatchId, 'stays');
    assert.equal(record.workspace, dead.workspace);
    assert.ok(Number.isFinite(record.startedAt));
    assert.ok(Number.isFinite(Date.parse(record.strayWaitAt)), JSON.stringify(record));
  },
);

test(
  'AC-0059-T02 a stray that exits during the wait leaves its dispatch proven',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    await deadInstance(t, base, root, 'leaves', 'sleep 1 9<&- >/dev/null 2>&1 & echo $!');
    const swept = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 60_000 });
    assert.equal(of(swept, 'leaves').stopped, true, JSON.stringify(of(swept, 'leaves')));
  },
);

test('AC-0059-A01 a process below an application that launchd started is another tool’s', () => {
  const sort = (stopMarker as any).sortStrays as (
    candidates: number[],
    rows: { pid: number; ppid: number; pgid: number; started: string; command: string }[],
    since: number,
    self: number,
    platform: NodeJS.Platform,
  ) => { counted: stopMarker.StrayProcess[]; foreign: stopMarker.StrayProcess[] };
  assert.equal(typeof sort, 'function');
  const since = Date.parse('2026-10-01T10:00:00Z');
  const before = '2026-10-01T09:00:00Z',
    after = '2026-10-01T11:00:00Z';
  const row = (pid: number, ppid: number, started: string, command: string) => ({
    pid,
    ppid,
    pgid: pid,
    started,
    command,
  });
  const rows = [
    row(1, 0, before, '/sbin/launchd'),
    // An application started after the dispatch, its helper, and a shell in the workspace.
    row(100, 1, after, '/Applications/Claude.app/Contents/MacOS/Claude'),
    row(101, 100, after, '/Applications/Claude.app/Contents/Helpers/claude'),
    row(102, 101, after, '/bin/zsh'),
    // A daemon that launchd adopted: ssh's shared connection.
    row(200, 1, after, '/usr/bin/ssh'),
    // An orphan below nothing but launchd.
    row(300, 1, after, '/bin/sleep'),
    // A helper inside a bundle that launchd started is not an application's own executable.
    row(400, 1, after, '/Applications/Fork.app/Contents/Helpers/daemon'),
    row(401, 400, after, '/bin/sh'),
    // The application itself, in the workspace: nothing above it but launchd.
    row(500, 1, after, '/Applications/Other.app/Contents/MacOS/Other'),
    row(9000, 1, before, '/usr/local/bin/node'),
  ];
  const sorted = sort([102, 200, 300, 401, 500], rows, since, 9000, 'darwin');
  assert.deepEqual(
    sorted.foreign.map((item) => item.pid),
    [102],
  );
  assert.deepEqual(
    sorted.counted.map((item) => item.pid),
    [200, 300, 401, 500],
  );
  assert.deepEqual(sorted.foreign[0]!.ancestor, {
    pid: 100,
    command: '/Applications/Claude.app/Contents/MacOS/Claude',
  });
  // SPEC-0059 A02: each names when it started.
  assert.equal(sorted.counted[0]!.started, after);
  assert.equal(sorted.foreign[0]!.started, after);
  // Only on macOS does launchd start an application's executable for each running application.
  assert.deepEqual(
    sort([102], rows, since, 9000, 'linux').counted.map((item) => item.pid),
    [102],
  );
});

test(
  'AC-0059-R01 a host retires a dispatch that its user confirmed, proven or not',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const dead = await deadInstance(t, base, root, 'confirmed', STRAY);
    await deadInstance(t, base, root, 'other', STRAY);
    const swept = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 20_000 });
    assert.equal(of(swept, 'confirmed').reason, 'strays');
    assert.deepEqual(acknowledgeStopMarkers(root, ['confirmed']), {
      removed: [],
      refused: [{ dispatchId: 'confirmed', reason: 'not_proven' }],
      missing: [],
    });
    assert.deepEqual(acknowledgeStopMarkers(root, ['confirmed', 'absent'], { attested: true }), {
      removed: ['confirmed'],
      refused: [],
      missing: ['absent'],
    });
    assert.equal(existsSync(dead.instance), false, 'the dead instance had nothing else');
    assert.ok(alive(dead.pid), 'the stray is not ended: it may be the user’s own');
    const after = await sweepStopMarkers(root, { keepProven: true, timeoutMs: 20_000 });
    assert.deepEqual(
      after.dispatches.map((dispatch) => dispatch.dispatchId),
      ['other'],
    );
    assert.deepEqual(acknowledgeStopMarkers(root, ['confirmed'], { attested: true }).missing, [
      'confirmed',
    ]);
  },
);

test(
  'AC-0059-R02 a process that still holds the marker refuses the retirement',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    // Not swept: the holder still runs.
    const dead = await deadInstance(t, base, root, 'held', 'sleep 120 >/dev/null 2>&1 & echo $!');
    assert.deepEqual(acknowledgeStopMarkers(root, ['held'], { attested: true }), {
      removed: [],
      refused: [{ dispatchId: 'held', reason: 'holders_left' }],
      missing: [],
    });
    assert.equal(existsSync(dead.instance), true);
    assert.ok(alive(dead.pid), 'an acknowledgement ends nothing');
  },
);

test(
  'AC-0059-R02 a dispatch of an instance that still runs is not retired',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const workspace = join(base, 'live');
    await mkdir(workspace);
    const markers = new StopMarkers({ root });
    t.after(() => markers.endAll(15_000));
    const marker = markers.prepare('live-dispatch', '/bin/sh', workspace);
    spawnSync(marker.wrapper, ['true'], { cwd: workspace, encoding: 'utf8' });
    assert.deepEqual(acknowledgeStopMarkers(root, ['live-dispatch'], { attested: true }), {
      removed: [],
      refused: [{ dispatchId: 'live-dispatch', reason: 'instance_live' }],
      missing: [],
    });
    assert.equal(existsSync(marker.path), true);
  },
);
