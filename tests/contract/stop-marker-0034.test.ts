import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { StopMarkers } from '../../packages/engine/src/stop-marker.ts';
import type {
  ExecutionEvidence,
  RuntimeCapabilities,
  RuntimeEvent,
} from '../../packages/engine/src/types.ts';

// SPEC-0034 B01: with stopMarker, every Bash command of a Claude dispatch runs through a wrapper
// that holds a marker file open, and the dispatch has stopped once nothing holds it.

const posix = process.platform !== 'win32';
const claude = (config: Record<string, unknown>) =>
  createClaudeAdapter(config as ClaudeAdapterConfig);
const covers = (adapter: { capabilities(): unknown }) =>
  (adapter.capabilities() as RuntimeCapabilities).executionEvidence?.terminalCoversExecution;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

// A Claude stand-in: runs one command through the shell prefix, as Claude Code's Bash tool does,
// and reports the PID the command left in the background.
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
  { result = true, config = {} }: { result?: boolean; config?: Record<string, unknown> } = {},
) {
  const state: { request?: ClaudeQueryRequest; ran?: { status: number; pid: number } } = {};
  t.after(() => {
    if (state.ran?.pid && alive(state.ran.pid)) process.kill(state.ran.pid, 'SIGKILL');
  });
  const adapter = claude({
    permissionProfile: 'workspace-write',
    stopMarker: true,
    // The stop observer's time; it returns once done, so only a loaded runner needs this much.
    cleanupTimeoutMs: 15000,
    ...config,
    query: (request: ClaudeQueryRequest) => {
      state.request = request;
      const env = (request.options as { env?: Record<string, string> }).env ?? {};
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
          if (result)
            yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  return { adapter, state };
}

async function run(adapter: ReturnType<typeof createClaudeAdapter>, t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-marker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence: ExecutionEvidence[] = [];
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'marker-task',
    sessionId: 'marker-session',
    dispatchId: 'marker-dispatch',
    providerSessionId: null,
    model: 'fixture',
    workspace: root,
    stateDir: join(root, 'state'),
    prompt: 'offline fixture',
    permissionProfile: 'workspace-write',
    signal: new AbortController().signal,
    reportExecutionEvidence: (item) => evidence.push(item),
  }))
    events.push(event);
  return { events, evidence };
}

test(
  '0034-B01 stopMarker is the stop proof and excludes the other choices',
  { skip: !posix },
  () => {
    assert.equal(covers(claude({ permissionProfile: 'workspace-write', stopMarker: true })), true);
    assert.equal(covers(claude({ extendOptions: () => ({}), stopMarker: true })), true);
    for (const extra of [
      { observeExecutionStop: async () => true },
      { executionStop: 'owner-reconcile' },
    ])
      assert.throws(
        () => claude({ permissionProfile: 'workspace-write', stopMarker: true, ...extra }),
        { code: 'INVALID_ADAPTER_CONFIG' },
        JSON.stringify(Object.keys(extra)),
      );
    assert.throws(() => claude({ permissionProfile: 'workspace-write', stopMarker: 'yes' }), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  },
);

test(
  '0034-B01 a backgrounded command holds the marker until the observer ends it',
  { skip: !posix },
  async (t) => {
    const { adapter, state } = markedClaude(t, 'sleep 30 >/dev/null 2>&1 & echo $!');
    const { events, evidence } = await run(adapter, t);
    const env = (state.request!.options as unknown as { env: Record<string, string> }).env;
    assert.ok(env.CLAUDE_CODE_SHELL, 'the shell the wrapper runs is the one Claude Code expects');
    assert.equal(state.ran?.status, 0);
    assert.ok(state.ran!.pid > 0);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.ok(
      evidence.some(
        (item) => item.source === 'resource_observation' && item.remoteExecution === 'stopped',
      ),
      JSON.stringify(evidence),
    );
    assert.equal(alive(state.ran!.pid), false, 'the background command was ended');
    const sandbox = (
      state.request!.options as unknown as { sandbox: { filesystem: { allowRead: string[] } } }
    ).sandbox;
    assert.ok(
      sandbox.filesystem.allowRead.some((path) => env.CLAUDE_CODE_SHELL_PREFIX.startsWith(path)),
      'sandboxed commands can read the marker',
    );
    await adapter.close();
  },
);

test(
  '0034-B01 a command that ignores SIGTERM is killed, and still counts as stopped',
  { skip: !posix },
  async (t) => {
    const { adapter, state } = markedClaude(
      t,
      'sh -c \'trap "" TERM; while :; do sleep 1; done\' >/dev/null 2>&1 & echo $!',
    );
    const { events } = await run(adapter, t);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.equal(alive(state.ran!.pid), false);
    await adapter.close();
  },
);

test(
  '0034-A03 a Claude dispatch without a terminal still ends its marked commands',
  { skip: !posix },
  async (t) => {
    const { adapter, state } = markedClaude(t, 'sleep 30 >/dev/null 2>&1 & echo $!', {
      result: false,
    });
    const { events, evidence } = await run(adapter, t);
    assert.equal((events.at(-1) as { outcome?: string }).outcome, 'unknown');
    assert.equal(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      false,
      'no terminal, so no stop proof',
    );
    for (let i = 0; i < 100 && alive(state.ran!.pid); i++) await delay(20);
    assert.equal(alive(state.ran!.pid), false);
    await adapter.close();
  },
);

test(
  '0034-B01b a host that sets its own shell prefix cannot also ask for stopMarker',
  { skip: !posix },
  async (t) => {
    assert.throws(
      () =>
        claude({
          stopMarker: true,
          options: { env: { CLAUDE_CODE_SHELL_PREFIX: '/host/prefix' } },
        }),
      { code: 'INVALID_ADAPTER_CONFIG' },
    );
    const previous = process.env.CLAUDE_CODE_SHELL_PREFIX;
    process.env.CLAUDE_CODE_SHELL_PREFIX = '/host/prefix';
    try {
      assert.throws(() => claude({ permissionProfile: 'workspace-write', stopMarker: true }), {
        code: 'INVALID_ADAPTER_CONFIG',
      });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SHELL_PREFIX;
      else process.env.CLAUDE_CODE_SHELL_PREFIX = previous;
    }
    // One chosen per dispatch is refused before submission.
    const { adapter, state } = markedClaude(t, 'true', {
      config: {
        permissionProfile: 'read-only',
        extendOptions: () => ({ env: { CLAUDE_CODE_SHELL_PREFIX: '/host/prefix' } }),
      },
    });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-marker-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.execute({
      taskId: 'marker-task',
      sessionId: 'marker-session',
      dispatchId: 'marker-dispatch',
      providerSessionId: null,
      model: 'fixture',
      workspace: root,
      stateDir: join(root, 'state'),
      prompt: 'offline fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
    }))
      events.push(event);
    assert.equal(state.request, undefined, 'no query was made');
    assert.equal((events.at(-1) as { outcome?: string }).outcome, 'failed', JSON.stringify(events));
  },
);

test(
  '0034-B01 the wrapper refuses to run a command that cannot hold the marker',
  { skip: !posix },
  async () => {
    const markers = new StopMarkers();
    const marker = markers.prepare('refused', '/bin/sh', tmpdir());
    try {
      // Linux's /bin/sh is often dash, where a failed `exec` redirection ends the shell with 2.
      const shells = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell));
      for (const shell of shells) {
        const status = (...args: string[]) => spawnSync(shell, [marker.wrapper, ...args]).status;
        assert.equal(status('exit 0'), 0, shell);
        await chmod(marker.path, 0o000);
        assert.equal(status('exit 0'), 126, shell);
        await chmod(marker.path, 0o600);
        assert.equal(status('exit 0', 'extra'), 126, shell);
      }
      assert.match(await readFile(marker.wrapper, 'utf8'), /exec 9</);
    } finally {
      assert.equal(await markers.endAll(15000), true);
    }
  },
);

test(
  '0034-B01 a marker whose holders cannot be listed is not stopped',
  { skip: !posix },
  async () => {
    const markers = new StopMarkers();
    const marker = markers.prepare('unlisted', '/bin/sh', tmpdir());
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      assert.equal(await markers.end('unlisted', () => 1000), false);
    } finally {
      process.env.PATH = path;
    }
    assert.equal(existsSync(marker.path), true, 'the marker stays');
    assert.equal(await markers.end('unlisted', () => 15000), true);
    assert.equal(existsSync(marker.path), false);
    await markers.endAll(15000);
  },
);

// SPEC-0034 B03 (D-0034-4 = 2): a program that closes inherited descriptors, as Python's
// subprocess does by default, drops the marker. What it leaves keeps its working directory, so a
// process started during the dispatch, in the workspace and outside the host's own process tree,
// means the dispatch has not stopped. Such a process is not ended: it may not be the dispatch's.

/** Starts `sleep` in `cwd` as an orphan outside this process's tree, as a daemon would be. */
function orphan(t: any, cwd: string, seconds = 30): number {
  const run = spawnSync('/bin/sh', ['-c', `sleep ${seconds} 9<&- >/dev/null 2>&1 & echo $!`], {
    cwd,
    encoding: 'utf8',
  });
  const pid = Number(run.stdout.trim());
  assert.ok(pid > 0, run.stderr);
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  return pid;
}
const context = (dispatchId: string) =>
  ({
    target: { dispatchId },
    terminal: { type: 'result', text: 'done' },
    signal: new AbortController().signal,
    // Returns once done; the time only matters on a loaded runner, where lsof takes seconds.
    remainingMs: () => 15000,
  }) as never;

test(
  '0034-B03 a process that dropped the marker keeps the dispatch unstopped, and is left running',
  { skip: !posix },
  async (t) => {
    const { adapter, state } = markedClaude(t, 'sleep 30 9<&- >/dev/null 2>&1 & echo $!');
    const { events, evidence } = await run(adapter, t);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.equal(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      false,
      JSON.stringify(evidence),
    );
    assert.equal(alive(state.ran!.pid), true, "not ended: it may not be the dispatch's");
    await adapter.close();
  },
);

test(
  '0034-B03 only processes started during the dispatch, in its workspace, count',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-strays-')));
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-elsewhere-')));
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    });
    const earlier = orphan(t, workspace);
    await delay(3100);
    const markers = new StopMarkers();
    t.after(() => markers.endAll(15000));
    markers.prepare('before', '/bin/sh', workspace);
    assert.equal(await markers.observer(context('before')), true, 'started before the dispatch');
    assert.equal(alive(earlier), true);
    markers.prepare('elsewhere', '/bin/sh', workspace);
    orphan(t, elsewhere);
    assert.equal(await markers.observer(context('elsewhere')), true, 'another directory');
    markers.prepare('own', '/bin/sh', workspace);
    const own = spawn('sleep', ['30'], { cwd: workspace, stdio: 'ignore' });
    t.after(() => own.kill('SIGKILL'));
    await delay(100);
    assert.equal(await markers.observer(context('own')), true, "the host's own tree");
    assert.equal(own.exitCode, null, 'left running');
    markers.prepare('during', '/bin/sh', workspace);
    const during = orphan(t, join(workspace));
    assert.equal(await markers.observer(context('during')), false);
    assert.equal(alive(during), true, 'left running');
    process.kill(during, 'SIGKILL');
    await delay(100);
    assert.equal(await markers.observer(context('during')), true, 'once it is gone');
  },
);
