import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeAdapter,
  staleStopMarkers,
  sweepStopMarkers,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
  type StopMarkerObservation,
} from '../../packages/adapter-claude/src/index.ts';
import { StopMarkers } from '../../packages/engine/src/stop-marker.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0036: a host-chosen marker directory that outlives the host, a sweep of what an earlier
// instance left, a bounded synchronous cleanup, and observations reported to the host.

const posix = process.platform !== 'win32';
// The synchronous cleanup stops 10 ms before its time, but a loaded runner can suspend this
// process well past it (up to 180 ms seen locally under 3 burners per core). Contract tests only
// check that it stops at its time rather than running on; the native case checks 300 ms.
const SLACK_MS = 1000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const claude = (config: Record<string, unknown>) =>
  createClaudeAdapter(config as ClaudeAdapterConfig);
const kill = (t: any, pid: number) =>
  t.after(() => {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  });

async function roots(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0036-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'markers'),
    workspace = join(base, 'workspace'),
    state = join(base, 'state');
  await mkdir(workspace);
  await mkdir(state, { mode: 0o700 });
  return { base, root, workspace, state };
}

/** An instance under `root` whose host has exited, leaving `command`'s background process. */
function deadInstance(t: any, root: string, workspace: string, command: string) {
  const out = execFileSync(
    process.execPath,
    [
      new URL('../fixtures/stop-marker-instance.ts', import.meta.url).pathname,
      root,
      workspace,
      command,
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
    status: number;
    pid: number;
    instance: string;
    marker: string;
  };
  kill(t, result.pid);
  return result;
}

// A Claude stand-in that runs one command through the shell prefix, as the Bash tool does.
const CLAUDE = String.raw`
const { spawnSync } = require('node:child_process');
const [prefix, command] = process.argv.slice(1);
const run = spawnSync(prefix, [command], { encoding: 'utf8' });
process.stdout.write(JSON.stringify({ status: run.status, pid: Number(run.stdout.trim()) }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

function markedClaude(
  t: any,
  command: string,
  config: Record<string, unknown>,
  hold?: Promise<void>,
) {
  const state: { request?: ClaudeQueryRequest; ran?: { status: number; pid: number } } = {};
  t.after(() => {
    if (state.ran?.pid && alive(state.ran.pid)) process.kill(state.ran.pid, 'SIGKILL');
  });
  const adapter = claude({
    permissionProfile: 'workspace-write',
    // The stop observer's time; it returns once done, so only a loaded runner needs this much.
    cleanupTimeoutMs: 15000,
    ...config,
    query: (request: ClaudeQueryRequest) => {
      state.request = request;
      const env = (request.options as unknown as { env?: Record<string, string> }).env ?? {};
      const child = request.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ['-e', CLAUDE, env.CLAUDE_CODE_SHELL_PREFIX ?? '/nonexistent', command],
        cwd: request.options.cwd,
        env: {},
        signal: new AbortController().signal,
      });
      const ran = new Promise<{ status: number; pid: number }>((resolve) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]!));
        });
      });
      return {
        close() {
          child.stdin.end();
        },
        async *[Symbol.asyncIterator]() {
          state.ran = await ran;
          yield { type: 'system', subtype: 'init', session_id: 'native' };
          await hold;
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  return { adapter, state };
}

async function run(
  adapter: ReturnType<typeof createClaudeAdapter>,
  workspace: string,
  stateDir: string,
) {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'task-0036',
    sessionId: 'session-0036',
    dispatchId: 'dispatch-0036',
    providerSessionId: null,
    model: 'fixture',
    workspace,
    stateDir,
    prompt: 'offline fixture',
    permissionProfile: 'workspace-write',
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events;
}

test(
  '0036-D01 the host directory is checked when the adapter is created',
  { skip: !posix },
  async (t) => {
    const { base, root } = await roots(t);
    const make = (directory: unknown) =>
      claude({ permissionProfile: 'workspace-write', stopMarker: { directory } });
    make(root);
    assert.equal(statSync(root).mode & 0o777, 0o700, 'created private');
    const open = join(base, 'open');
    await mkdir(open, { mode: 0o777 });
    await chmod(open, 0o777);
    const link = join(base, 'link');
    await symlink(root, link);
    for (const directory of ['relative/markers', open, link, 42])
      assert.throws(() => make(directory), { code: 'INVALID_ADAPTER_CONFIG' }, String(directory));
    assert.throws(
      () =>
        claude({
          permissionProfile: 'workspace-write',
          stopMarker: { directory: root, onObservation: 1 },
        }),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
    assert.throws(
      () =>
        claude({
          permissionProfile: 'workspace-write',
          stopMarker: { directory: root, extra: true },
        }),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
  },
);

test(
  '0036-D02 an instance directory holds its record and each dispatch its workspace',
  { skip: !posix },
  async (t) => {
    const { root, workspace, state } = await roots(t);
    const { adapter, state: seen } = markedClaude(t, 'true', { stopMarker: { directory: root } });
    const events = await run(adapter, workspace, state);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    const [instance, ...others] = await readdir(root);
    assert.equal(others.length, 0);
    assert.match(instance!, new RegExp(`^${process.pid}-[0-9a-f]{8}$`));
    const record = JSON.parse(await readFile(join(root, instance!, 'instance.json'), 'utf8'));
    assert.equal(record.version, 1);
    assert.equal(record.pid, process.pid);
    assert.equal(typeof record.started, 'string');
    const allowRead = (
      seen.request!.options as unknown as { sandbox: { filesystem: { allowRead: string[] } } }
    ).sandbox.filesystem.allowRead;
    assert.ok(allowRead.includes(join(root, instance!)), 'the instance directory, not the root');
    assert.equal(allowRead.includes(root), false);
    await adapter.close();
    assert.equal(existsSync(root), true, 'the host root stays');
  },
);

test(
  '0036-D01 a workspace or state directory overlapping the root refuses the dispatch',
  { skip: !posix },
  async (t) => {
    const { base, workspace, state } = await roots(t);
    for (const directory of [join(workspace, 'markers'), join(state, 'markers'), base]) {
      const { adapter, state: seen } = markedClaude(t, 'true', { stopMarker: { directory } });
      const events = await run(adapter, workspace, state);
      assert.equal(seen.request, undefined, directory);
      assert.equal((events.at(-1) as { outcome?: string }).outcome, 'failed', directory);
      await adapter.close();
    }
  },
);

test(
  '0036-S01 a sweep ends what a dead instance left; the stale check only looks',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const dead = deadInstance(t, root, workspace, 'sleep 30 >/dev/null 2>&1 & echo $!');
    assert.equal(dead.status, 0);
    assert.ok(alive(dead.pid));
    const stale = await staleStopMarkers(root, { timeoutMs: 20000 });
    assert.equal(stale.stopped, false);
    assert.deepEqual(
      stale.dispatches.map(({ dispatchId, holders }) => ({ dispatchId, holders })),
      [{ dispatchId: 'dead-dispatch', holders: [dead.pid] }],
    );
    assert.ok(alive(dead.pid), 'the stale check ends nothing');
    const observed: StopMarkerObservation[] = [];
    const swept = await sweepStopMarkers(root, {
      timeoutMs: 20000,
      onObservation: (item) => observed.push(item),
    });
    assert.equal(swept.stopped, true, JSON.stringify(swept));
    assert.equal(swept.dispatches[0]?.ended, 1);
    for (let i = 0; i < 50 && alive(dead.pid); i++) await delay(20);
    assert.equal(alive(dead.pid), false);
    assert.equal(existsSync(dead.instance), false, 'the dead instance is removed');
    assert.equal(existsSync(root), true, 'the root stays');
    assert.deepEqual(
      observed.map(({ kind, dispatchId, holders, ended, stopped }) => ({
        kind,
        dispatchId,
        holders,
        ended,
        stopped,
      })),
      [{ kind: 'sweep', dispatchId: 'dead-dispatch', holders: 1, ended: 1, stopped: true }],
    );
    assert.equal(
      (await sweepStopMarkers(root, { timeoutMs: 20000 })).stopped,
      true,
      'nothing left',
    );
  },
);

test(
  '0036-S02 a sweep leaves the instances of live processes, this one included',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const markers = new StopMarkers({ root });
    t.after(() => markers.endAll(15000));
    const marker = markers.prepare('live-dispatch', '/bin/sh', workspace);
    const pid = Number(
      spawnSync(marker.wrapper, ['sleep 30 >/dev/null 2>&1 & echo $!'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout.trim(),
    );
    kill(t, pid);
    const swept = await sweepStopMarkers(root, { timeoutMs: 20000 });
    assert.deepEqual(swept.dispatches, []);
    assert.deepEqual(swept.liveInstances, [markers.directory]);
    assert.equal(swept.stopped, true);
    assert.ok(alive(pid), 'a live instance is not signalled');
  },
);

test('0036-S03 a reused PID does not keep a dead instance alive', { skip: !posix }, async (t) => {
  const { root, workspace } = await roots(t);
  const dead = deadInstance(t, root, workspace, 'sleep 30 >/dev/null 2>&1 & echo $!');
  const record = join(dead.instance, 'instance.json');
  const saved = JSON.parse(await readFile(record, 'utf8'));
  // The recorded PID is now this process's, but it started at another time.
  await writeFile(
    record,
    JSON.stringify({ ...saved, pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' }),
  );
  // A sweep returns once proven; the time only matters on a loaded runner.
  const swept = await sweepStopMarkers(root, { timeoutMs: 20000 });
  assert.equal(swept.stopped, true, JSON.stringify(swept));
  for (let i = 0; i < 50 && alive(dead.pid); i++) await delay(20);
  assert.equal(alive(dead.pid), false);
});

test(
  '0036-S04 after a restart, a process that dropped the marker keeps its dispatch unstopped',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const dead = deadInstance(t, root, workspace, 'sleep 30 9<&- >/dev/null 2>&1 & echo $!');
    const started = performance.now();
    // The sweep keeps looking while its time lasts; under load one look takes seconds.
    const swept = await sweepStopMarkers(root, { timeoutMs: 4000 });
    assert.ok(performance.now() - started < 4000 + 2000, 'bounded by its time');
    assert.equal(swept.stopped, false);
    assert.deepEqual(swept.dispatches[0]?.strays, [dead.pid]);
    assert.equal(swept.dispatches[0]?.reason, 'strays');
    assert.ok(alive(dead.pid), "not ended: it may not be the dispatch's");
    assert.equal(existsSync(dead.instance), true, 'kept for a later sweep');
    process.kill(dead.pid, 'SIGKILL');
    await delay(100);
    assert.equal(
      (await sweepStopMarkers(root, { timeoutMs: 20000 })).stopped,
      true,
      'once it is gone',
    );
    assert.equal(existsSync(dead.instance), false);
  },
);

test(
  '0036-S05 a marker without its dispatch record is never proven stopped',
  { skip: !posix },
  async (t) => {
    const { root, workspace } = await roots(t);
    const dead = deadInstance(t, root, workspace, 'true');
    await rm(dead.marker.replace(/\.tag$/, '.json'));
    const swept = await sweepStopMarkers(root, { timeoutMs: 20000 });
    assert.equal(swept.stopped, false);
    assert.equal(swept.dispatches[0]?.reason, 'metadata_missing');
    assert.equal(swept.dispatches[0]?.dispatchId, null);
  },
);

test(
  "0036-Y01 the synchronous cleanup ends this instance's holders within its time",
  { skip: !posix },
  async (t) => {
    const { root, workspace, state } = await roots(t);
    assert.deepEqual(
      claude({
        permissionProfile: 'workspace-write',
        stopMarker: { directory: root },
      }).endStopMarkersSync(300),
      { stopped: true, holders: 0, ended: 0 },
      'nothing marked',
    );
    for (const [budget, strict] of [
      [300, false],
      [2000, true],
    ] as const) {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      t.after(() => release());
      const observed: StopMarkerObservation[] = [];
      const { adapter, state: seen } = markedClaude(
        t,
        'sleep 30 >/dev/null 2>&1 & echo $!',
        {
          stopMarker: {
            directory: root,
            onObservation: (item: StopMarkerObservation) => observed.push(item),
          },
        },
        hold,
      );
      const running = run(adapter, workspace, state);
      try {
        for (let i = 0; i < 1000 && !seen.ran; i++) await delay(10);
        assert.ok(seen.ran && alive(seen.ran.pid), 'the command runs');
        const started = performance.now();
        const result = adapter.endStopMarkersSync(budget);
        const elapsed = performance.now() - started;
        // Always: within its time, and never stopped while the holder runs.
        assert.ok(elapsed < budget + SLACK_MS, `${elapsed} ms of ${budget}`);
        if (result.stopped) assert.equal(alive(seen.ran.pid), false, JSON.stringify(result));
        if (strict) {
          // With more time it ends the holder; on a loaded runner one call may not verify it.
          let stopped = result.stopped;
          for (let i = 0; !stopped && i < 5; i++)
            stopped = adapter.endStopMarkersSync(budget).stopped;
          assert.equal(stopped, true, JSON.stringify(result));
          assert.equal(alive(seen.ran.pid), false);
        }
        assert.equal(observed.at(-1)?.kind, 'sync');
      } finally {
        release();
        await running;
        await adapter.close();
      }
    }
  },
);

test(
  '0036-O01 each stop observation reaches the host, and a failing callback changes nothing',
  { skip: !posix },
  async (t) => {
    const { root, workspace, state } = await roots(t);
    const observed: StopMarkerObservation[] = [];
    const { adapter } = markedClaude(t, 'sleep 30 >/dev/null 2>&1 & echo $!', {
      stopMarker: {
        directory: root,
        onObservation: (item: StopMarkerObservation) => {
          observed.push(item);
          throw new Error('host diagnostics failed');
        },
      },
    });
    const events = await run(adapter, workspace, state);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.deepEqual(
      observed.map(({ kind, dispatchId, holders, ended, strays, stopped }) => ({
        kind,
        dispatchId,
        holders,
        ended,
        strays,
        stopped,
      })),
      [
        {
          kind: 'dispatch',
          dispatchId: 'dispatch-0036',
          holders: 1,
          ended: 1,
          strays: 0,
          stopped: true,
        },
      ],
    );
    await adapter.close();
  },
);

test(
  '0036-Y01 a holder that ignores SIGTERM is killed within the time',
  { skip: !posix },
  async (t) => {
    const { workspace } = await roots(t);
    const markers = new StopMarkers();
    t.after(() => markers.endAll(15000));
    const marker = markers.prepare('stubborn', '/bin/sh', workspace);
    const pid = Number(
      spawnSync(
        marker.wrapper,
        ['sh -c \'trap "" TERM; while :; do sleep 1; done\' >/dev/null 2>&1 & echo $!'],
        { cwd: workspace, encoding: 'utf8' },
      ).stdout.trim(),
    );
    kill(t, pid);
    const started = performance.now();
    const result = markers.endAllSync(300);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 300 + SLACK_MS, `${elapsed} ms`);
    if (result.stopped) assert.equal(alive(pid), false, JSON.stringify(result));
    // Under load the listings may not fit in 300 ms; with more time it ends the holder.
    let again = result.stopped;
    for (let i = 0; !again && i < 5; i++) again = markers.endAllSync(2000).stopped;
    assert.equal(again, true, 'with more time it ends the holder');
    assert.equal(alive(pid), false);
    assert.equal(existsSync(marker.path), true, 'the marker stays for the next sweep');
  },
);

test(
  '0036-D03 with a host directory, the marker of a dispatch not proven stopped stays for a sweep',
  { skip: !posix },
  async (t) => {
    const { root, workspace, state } = await roots(t);
    const { adapter, state: seen } = markedClaude(t, 'sleep 30 9<&- >/dev/null 2>&1 & echo $!', {
      stopMarker: { directory: root },
    });
    const events = await run(adapter, workspace, state);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    await adapter.close();
    assert.ok(alive(seen.ran!.pid), 'the process that dropped the marker was left running');
    const [instance] = await readdir(root);
    const files = await readdir(join(root, instance!));
    assert.ok(
      files.some((file) => file.endsWith('.tag')),
      JSON.stringify(files),
    );
    assert.ok(
      files.some((file) => file.endsWith('.json') && file !== 'instance.json'),
      JSON.stringify(files),
    );
  },
);

test(
  '0036-Y01 the synchronous cleanup is not stopped while holders keep starting, or unlisted',
  { skip: !posix },
  async (t) => {
    const { workspace } = await roots(t);
    // Through the listing seam: a holder that is always there again, as when each one starts
    // another before it ends, and a listing that fails after the holders were signalled.
    const lists: [string, (pid: number) => () => number[] | null][] = [
      ['respawning', (pid) => () => [pid]],
      [
        'unlisted',
        (pid) => {
          let calls = 0;
          return () => (calls++ ? null : [pid]);
        },
      ],
    ];
    for (const [name, answers] of lists) {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      t.after(() => child.kill('SIGKILL'));
      const list = answers(child.pid!);
      const markers = new StopMarkers({ listHolders: list });
      t.after(() => markers.endAll(15000));
      markers.prepare(name, '/bin/sh', workspace);
      const started = performance.now();
      const result = markers.endAllSync(300);
      assert.ok(performance.now() - started < 300 + SLACK_MS, name);
      assert.equal(result.stopped, false, `${name} ${JSON.stringify(result)}`);
      assert.equal(result.holders, 1, name);
      await new Promise((resolve) => child.once('exit', resolve));
      // SIGTERM, or SIGKILL when a loaded runner lets the grace pass first.
      assert.ok(['SIGTERM', 'SIGKILL'].includes(child.signalCode ?? ''), `${name}: signalled`);
    }
  },
);
