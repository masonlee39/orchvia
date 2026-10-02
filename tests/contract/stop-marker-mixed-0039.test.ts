import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import * as claudePackage from '../../packages/adapter-claude/src/index.ts';
import * as codexPackage from '../../packages/adapter-codex/src/index.ts';
import { mixedMembers } from '../fixtures/mixed-markers.ts';

// SPEC-0039 M: one host marker directory for Claude and Codex members.

const marked = process.platform !== 'win32' && /(zsh|bash)$/.test(os.userInfo().shell ?? '');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const reap = (t: any, pids: number[]) =>
  t.after(() => {
    for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  });

async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0039m-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'markers');
  await mkdir(root, { mode: 0o700 });
  return { base, root };
}

test('AC-0039-M01 both packages export the one sweep', () => {
  for (const name of ['sweepStopMarkers', 'staleStopMarkers', 'endStopMarkersSync'] as const)
    assert.equal(claudePackage[name], codexPackage[name], name);
});

test(
  'AC-0039-M01 a sweep ends what a dead Claude and Codex member left under one root',
  { skip: !marked },
  async (t) => {
    const { base, root } = await roots(t);
    const out = execFileSync(
      process.execPath,
      [new URL('../fixtures/mixed-marker-host.ts', import.meta.url).pathname, root, base],
      { encoding: 'utf8' },
    );
    const pids = JSON.parse(out.trim().split('\n').at(-1)!) as { claude: number; codex: number };
    reap(t, [pids.claude, pids.codex]);
    assert.equal(alive(pids.claude) && alive(pids.codex), true, JSON.stringify(pids));
    const stale = await claudePackage.staleStopMarkers(root, { timeoutMs: 40000 });
    assert.deepEqual(stale.dispatches.map((item) => item.dispatchId).sort(), [
      'dispatch-claude',
      'dispatch-codex',
    ]);
    const swept = await codexPackage.sweepStopMarkers(root, { timeoutMs: 40000 });
    assert.equal(swept.stopped, true, JSON.stringify(swept));
    assert.equal(alive(pids.claude), false, 'the Claude member left nothing running');
    assert.equal(alive(pids.codex), false, 'the Codex member left nothing running');
  },
);

test(
  'AC-0039-M02 a synchronous cleanup ends both running members under one root',
  { skip: !marked },
  async (t) => {
    const { base, root } = await roots(t);
    const members = await mixedMembers(root, join(base, 'live'));
    const pids = await members.pids();
    reap(t, [pids.claude, pids.codex]);
    assert.equal(alive(pids.claude) && alive(pids.codex), true, JSON.stringify(pids));
    // On a loaded runner one call may end the holders without verifying; the next finds none.
    let result = codexPackage.endStopMarkersSync(root, 2000);
    for (let i = 0; !result.stopped && i < 5; i++)
      result = codexPackage.endStopMarkersSync(root, 2000);
    assert.equal(result.stopped, true, JSON.stringify(result));
    assert.equal(result.instances.length, 2, 'one instance for each member');
    assert.equal(alive(pids.claude), false, 'the Claude command ended');
    assert.equal(alive(pids.codex), false, 'the Codex command ended');
    await members.finish();
  },
);
