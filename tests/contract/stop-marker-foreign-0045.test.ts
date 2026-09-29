import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StopMarkers,
  countsAsStray,
  type StopMarkerObservation,
} from '../../packages/engine/src/stop-marker.ts';
import { processTable } from '../../packages/engine/src/process-tree.ts';

// SPEC-0045 K01 to K03: a process in the workspace that something already running started is
// another tool's; one that an orphan's parent or a daemon started still counts.

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
const context = (dispatchId: string) =>
  ({
    target: { dispatchId },
    terminal: { type: 'result', text: 'done' },
    signal: new AbortController().signal,
    remainingMs: () => 15000,
  }) as never;
// Once `go` exists, starts `sleep 30` in the workspace, in the background, and waits for it.
const START = `while [ ! -f "$1" ]; do sleep 0.05; done; (cd "$2" && exec sleep 30) & wait`;

/** Starts `script go workspace` with its parent gone, and returns its PID. */
function detached(t: any, script: string, ...args: string[]): number {
  const run = spawnSync(
    '/bin/sh',
    ['-c', `/bin/sh "$0" "$@" 9<&- >/dev/null 2>&1 & echo $!`, script, ...args],
    { encoding: 'utf8' },
  );
  const pid = Number(run.stdout.trim());
  assert.ok(pid > 0, run.stderr);
  t.after(() => {
    for (const row of processTable())
      if (row.pid === pid || row.ppid === pid) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
  });
  return pid;
}
/** The child of `parent` once it appears. */
async function childOf(parent: number, t: any): Promise<number> {
  // The waiting loop's own short sleeps end once `go` exists.
  await delay(300);
  for (let i = 0; i < 200; i++) {
    const child = processTable().find(
      (row) => row.ppid === parent && row.command.endsWith('sleep'),
    );
    if (child) {
      t.after(() => alive(child.pid) && process.kill(child.pid, 'SIGKILL'));
      return child.pid;
    }
    await delay(25);
  }
  assert.fail(`no child of ${parent}`);
}

test(
  'AC-0045-K01 AC-0045-K02 a process that another running tool started is left out and named',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-foreign-')));
    const scripts = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-foreign-scripts-')));
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(scripts, { recursive: true, force: true });
    });
    await writeFile(join(scripts, 'start.sh'), START);
    // A shell of another tool: its parent is an ordinary process, not process 1.
    await writeFile(join(scripts, 'tool.sh'), `/bin/sh "${join(scripts, 'start.sh')}" "$@" & wait`);
    const tool = detached(t, join(scripts, 'tool.sh'), join(scripts, 'go-tool'), workspace);
    // A daemon: its parent is process 1 once the shell that started it has exited.
    const daemon = detached(t, join(scripts, 'start.sh'), join(scripts, 'go-daemon'), workspace);
    const shell = await (async () => {
      for (let i = 0; i < 200; i++) {
        const found = processTable().find((row) => row.ppid === tool);
        if (found) return found.pid;
        await delay(25);
      }
      assert.fail('the tool has no shell');
    })();
    // Both started more than lstart's second before the dispatches below.
    await delay(2200);
    const seen: StopMarkerObservation[] = [];
    const markers = new StopMarkers({ onObservation: (item) => seen.push(item) });
    t.after(() => markers.endAll(15000));

    markers.prepare('foreign', '/bin/sh', workspace);
    await writeFile(join(scripts, 'go-tool'), '');
    const foreign = await childOf(shell, t);
    assert.equal(await markers.observer(context('foreign')), true, "another tool's process");
    const first = seen.at(-1)!;
    assert.equal(first.strays, 0);
    assert.deepEqual(
      first.foreignProcesses?.map((item) => [item.pid, item.ancestor?.pid]),
      [[foreign, shell]],
    );
    assert.equal(alive(foreign), true, 'left running');
    process.kill(foreign, 'SIGKILL');

    const daemonParent = processTable().find((row) => row.pid === daemon)?.ppid;
    markers.prepare('daemon', '/bin/sh', workspace);
    await writeFile(join(scripts, 'go-daemon'), '');
    const started = await childOf(daemon, t);
    const stopped = await markers.observer(context('daemon'));
    const second = seen.at(-1)!;
    if (daemonParent === 1) {
      assert.equal(stopped, false, 'a daemon started it');
      assert.deepEqual(
        second.strayProcesses?.map((item) => [item.pid, item.ancestor?.pid]),
        [[started, daemon]],
      );
      assert.match(second.strayProcesses![0]!.command, /sleep$/);
    } else t.diagnostic(`the orphaned shell's parent is ${daemonParent}, not process 1`);
    process.kill(started, 'SIGKILL');
    await delay(100);
    assert.equal(await markers.observer(context('daemon')), true, 'once it is gone');
  },
);

test(
  'AC-0045-K01 an orphan still counts, with process 1 as its ancestor',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-orphan-')));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const seen: StopMarkerObservation[] = [];
    const markers = new StopMarkers({ onObservation: (item) => seen.push(item) });
    t.after(() => markers.endAll(15000));
    markers.prepare('orphan', '/bin/sh', workspace);
    const run = spawnSync('/bin/sh', ['-c', 'sleep 30 9<&- >/dev/null 2>&1 & echo $!'], {
      cwd: workspace,
      encoding: 'utf8',
    });
    const orphan = Number(run.stdout.trim());
    t.after(() => alive(orphan) && process.kill(orphan, 'SIGKILL'));
    const parent = processTable().find((row) => row.pid === orphan)?.ppid;
    assert.equal(await markers.observer(context('orphan')), false);
    const item = seen.at(-1)!.strayProcesses?.find((stray) => stray.pid === orphan);
    assert.ok(item, JSON.stringify(seen.at(-1)));
    assert.equal(item.ancestor?.pid, parent);
  },
);

test('AC-0045-K01 AC-0045-K03 which nearest earlier ancestor makes a stray', () => {
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });
  const app = '/Applications/Fork.app/Contents/MacOS/Fork';
  assert.equal(countsAsStray(undefined), true, 'no ancestor found');
  assert.equal(countsAsStray(row(1, 0, '/sbin/launchd')), true, 'an orphan');
  assert.equal(countsAsStray(row(500, 1, '/opt/homebrew/bin/tmux')), true, 'a daemon');
  assert.equal(countsAsStray(row(501, 1, '/usr/lib/systemd/systemd'), 'linux'), true);
  assert.equal(countsAsStray(row(502, 480, '/bin/zsh')), false, "another tool's shell");
  assert.equal(countsAsStray(row(503, 1, app), 'darwin'), false, 'an application on macOS');
  assert.equal(countsAsStray(row(503, 1, app), 'linux'), true, 'only on macOS');
  assert.equal(
    countsAsStray(row(504, 1, '/Applications/Fork.app/Contents/Helpers/daemon'), 'darwin'),
    true,
    "a helper inside a bundle is not the application's own executable",
  );
});
