import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StopMarkers, sweepStopMarkers } from '../../packages/engine/src/stop-marker.ts';

// SPEC-0064: holders that could not be listed again after they were signalled are `unlisted`,
// not `holders_left`.

const posix = process.platform !== 'win32';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0064-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'markers');
  await mkdir(root, { mode: 0o700 });
  return { base, root };
}

test(
  'AC-0064-U01 an observation whose second listing of the holders fails says unlisted',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const records: any[] = [];
    const markers = new StopMarkers({ root, onObservation: (item) => records.push(item) });
    t.after(() => markers.endAll(15_000));
    const marker = markers.prepare('observed', '/bin/sh', workspace);
    // A process that holds the marker and ignores SIGTERM, so that the holders are listed again.
    const holder = spawn(
      '/bin/sh',
      ['-c', 'trap "" TERM; exec 9<"$0"; while :; do sleep 1; done', marker.path],
      { stdio: 'ignore' },
    );
    t.after(() => holder.kill('SIGKILL'));
    // An lsof that answers once and then takes longer than the observation has.
    const real = execFileSync('/bin/sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).trim();
    const bin = join(base, 'bin');
    await mkdir(bin);
    const calls = join(base, 'calls');
    writeFileSync(
      join(bin, 'lsof'),
      `#!/bin/sh\nif [ -e '${calls}' ]; then sleep 30; fi\n: > '${calls}'\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    t.after(() => {
      process.env.PATH = before;
    });
    // The holder opens the marker a moment after it starts.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deadline = performance.now() + 2000;
    const stopped = await markers.observer({
      target: { dispatchId: 'observed' },
      terminal: { type: 'result', text: 'done' },
      remainingMs: () => Math.max(0, deadline - performance.now()),
    } as never);
    process.env.PATH = before;
    assert.equal(stopped, false);
    const record = records.at(-1);
    assert.ok(record.holders >= 1, JSON.stringify(record));
    assert.equal(record.reason, 'unlisted', JSON.stringify(record));
    assert.equal(record.ended, 0);
  },
);

test(
  'AC-0064-U01 a sweep whose second listing of the holders fails says unlisted',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const workspace = join(base, 'left');
    await mkdir(workspace);
    const out = execFileSync(
      process.execPath,
      [
        new URL('../fixtures/stop-marker-instance.ts', import.meta.url).pathname,
        root,
        workspace,
        'sleep 120 >/dev/null 2>&1 & echo $!',
        'left',
      ],
      { encoding: 'utf8' },
    );
    const { pid } = JSON.parse(out.trim().split('\n').at(-1)!) as { pid: number };
    t.after(() => alive(pid) && process.kill(pid, 'SIGKILL'));
    let calls = 0;
    const swept = await sweepStopMarkers(root, {
      timeoutMs: 3000,
      listHolders: async (_path, timeoutMs) => {
        if (calls++ === 0) return [pid];
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return null;
      },
    });
    const dispatch = swept.dispatches[0]!;
    assert.equal(dispatch.stopped, false);
    assert.deepEqual(dispatch.holders, [pid]);
    assert.equal(dispatch.reason, 'unlisted', JSON.stringify(dispatch));
  },
);

test(
  'AC-0064-U02 a synchronous cleanup whose holders cannot be listed says unlisted',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const records: any[] = [];
    let answer: number[] | null = null;
    const markers = new StopMarkers({
      root,
      onObservation: (item) => records.push(item),
      listHolders: () => answer,
    });
    markers.prepare('observed', '/bin/sh', workspace);
    assert.deepEqual(markers.endAllSync(2000), {
      stopped: false,
      holders: 0,
      ended: 0,
      unlisted: true,
    });
    assert.equal(records.at(-1).kind, 'sync');
    assert.equal(records.at(-1).reason, 'unlisted');
    // Listed, with nothing holding: stopped, and no reason.
    answer = [];
    assert.deepEqual(markers.endAllSync(2000), { stopped: true, holders: 0, ended: 0 });
    assert.equal(records.at(-1).reason, undefined);
  },
);
