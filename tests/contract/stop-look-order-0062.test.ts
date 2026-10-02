import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { checkPolicy, profileSettings } from '../../packages/adapter-codex/src/local.ts';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { StopMarkers } from '../../packages/engine/src/stop-marker.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

// SPEC-0062: a stop marker looks for strays after the runtime has ended, and looks again while
// its time lasts; the network value 'remote'.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const posix = process.platform !== 'win32';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Ends 700 ms after SIGTERM, as a server that closes its work first.
const SLOW =
  "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 700)); setInterval(() => {}, 1000);";
// Ends 700 ms after its parent did, as a server whose input closed.
const ORPHAN =
  'setInterval(() => { if (process.ppid === 1) setTimeout(() => process.exit(0), 700); }, 20);';

test(
  'AC-0062-S01 a Codex dispatch whose app-server left a process that ends a moment later is proven stopped',
  { skip: !posix },
  async (t) => {
    const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0062-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dirs = {
      workspace: join(base, 'workspace'),
      state: join(base, 'state'),
      home: join(base, 'codex-home'),
      user: join(base, 'user'),
      markers: join(base, 'markers'),
      log: join(base, 'fixture.log'),
    };
    for (const dir of [dirs.workspace, dirs.state, dirs.home, dirs.user]) await mkdir(dir);
    await mkdir(dirs.markers, { mode: 0o700 });
    const observations: any[] = [];
    const adapter = createCodexAdapter({
      command: process.execPath,
      args: [fixture],
      env: {
        HOME: dirs.user,
        FIXTURE_LOG: dirs.log,
        // As an MCP server that closes its work before it exits: 700 ms after SIGTERM.
        FIXTURE_SERVER_CHILD: SLOW,
      },
      connection: { home: dirs.home },
      stopMarker: { directory: dirs.markers, onObservation: (item) => observations.push(item) },
      closeTimeoutMs: 20000,
    });
    t.after(() => adapter.close?.());
    const events: RuntimeEvent[] = [];
    const evidence: ExecutionEvidence[] = [];
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'offline',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: dirs.workspace,
      stateDir: dirs.state,
      signal: new AbortController().signal,
      reportExecutionEvidence: (item: ExecutionEvidence) => evidence.push(item),
    } as RuntimeInput))
      events.push(event);
    const logged = existsSync(dirs.log)
      ? readFileSync(dirs.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    const child = logged.find((entry) => entry.event === 'server-child')?.pid as number;
    assert.ok(child, 'the app-server started its process');
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.equal(alive(child), false, 'the process ended with the dispatch');
    assert.ok(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      `not proven stopped: ${JSON.stringify(observations)}`,
    );
    // The look came after the process had been ended: it found nothing to wait for.
    assert.equal(observations.at(-1)?.strays, 0);
    assert.equal(observations.at(-1)?.waited, undefined, JSON.stringify(observations));
  },
);

// A Claude stand-in that starts a process of its own, as Claude Code starts an MCP server.
const CLAUDE = String.raw`
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', process.argv[1]], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ pid: child.pid }) + '\n');
process.stdin.resume();
// It takes a moment to exit, during which its process is still its own.
process.stdin.on('end', () => setTimeout(() => process.exit(0), 400));
`;

test(
  'AC-0062-S01 a Claude dispatch whose Claude process left a process that ends a moment later is proven stopped',
  { skip: !posix },
  async (t) => {
    const root = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0062c-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const observations: any[] = [];
    let left = 0;
    t.after(() => {
      if (left && alive(left)) process.kill(left, 'SIGKILL');
    });
    const adapter = createClaudeAdapter({
      permissionProfile: 'workspace-write',
      stopMarker: {
        directory: join(root, 'markers'),
        onObservation: (item: any) => observations.push(item),
      },
      cleanupTimeoutMs: 15000,
      query: (request: ClaudeQueryRequest) => {
        const child = request.options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ['-e', CLAUDE, ORPHAN],
          cwd: request.options.cwd,
          env: {},
          signal: new AbortController().signal,
        });
        const started = new Promise<{ pid: number }>((resolve) => {
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
            left = (await started).pid;
            yield { type: 'system', subtype: 'init', session_id: 'native' };
            yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
          },
        };
      },
    } as unknown as ClaudeAdapterConfig);
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'), { mode: 0o700 });
    const evidence: ExecutionEvidence[] = [];
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'fixture',
      workspace: join(root, 'workspace'),
      stateDir: join(root, 'state'),
      prompt: 'offline fixture',
      permissionProfile: 'workspace-write',
      signal: new AbortController().signal,
      reportExecutionEvidence: (item: ExecutionEvidence) => evidence.push(item),
    } as RuntimeInput))
      events.push(event);
    assert.ok(left, `the Claude process started its process: ${JSON.stringify(events)}`);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.ok(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      `not proven stopped: ${JSON.stringify(observations)}`,
    );
    assert.equal(alive(left), false, 'the process had ended when the dispatch was proven stopped');
  },
);

const within = (ms: number) => {
  const deadline = performance.now() + ms;
  return {
    target: { dispatchId: 'observed' },
    terminal: { type: 'result', text: 'done' },
    remainingMs: () => Math.max(0, deadline - performance.now()),
  } as never;
};

test(
  'AC-0062-S02 an observation looks again while its time lasts, and vouches only without strays',
  { skip: !posix },
  async (t) => {
    const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0062o-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const records: any[] = [];
    const stray = { pid: 4242, command: 'server', started: 'now', ancestor: null };
    // What each look finds, in order; the last answer repeats.
    let answers: (object | null)[] = [];
    let looks = 0;
    const markers = new StopMarkers({
      root: join(base, 'markers'),
      onObservation: (item) => records.push(item),
      listStrays: async () => {
        looks++;
        return (answers.length > 1 ? answers.shift() : answers[0]) as never;
      },
    });
    t.after(() => markers.endAll(15_000));
    const none = { counted: [], foreign: [] };
    const one = { counted: [stray], foreign: [] };
    const observe = (found: (object | null)[], ms: number) => {
      markers.prepare('observed', '/bin/sh', workspace);
      answers = found;
      looks = 0;
      return markers.observer(within(ms));
    };
    // Nothing to wait for: one look.
    assert.equal(await observe([none], 60_000), true);
    assert.equal(looks, 1);
    assert.equal(records.at(-1).waited, undefined);
    // A process that is ending: gone at the third look.
    assert.equal(await observe([one, one, none], 60_000), true);
    assert.equal(looks, 3);
    assert.deepEqual(
      {
        stopped: records.at(-1).stopped,
        waited: records.at(-1).waited,
        strays: records.at(-1).strays,
      },
      { stopped: true, waited: true, strays: 0 },
    );
    // One that stays: the looks end after 3 seconds, although more time is left.
    let started = performance.now();
    assert.equal(await observe([one], 60_000), false);
    let took = performance.now() - started;
    assert.ok(took >= 2900 && took < 30_000, `it looked for ${Math.round(took)} ms`);
    assert.ok(looks > 3, `${looks} looks`);
    assert.equal(records.at(-1).reason, 'strays');
    assert.deepEqual(records.at(-1).strayProcesses, [stray]);
    // With less time, they end with it.
    started = performance.now();
    assert.equal(await observe([one], 700), false);
    took = performance.now() - started;
    assert.ok(took >= 500 && took < 2900, `it looked for ${Math.round(took)} ms`);
    // A look that cannot be made after one that found a stray: the stray stands.
    assert.equal(await observe([one, null], 60_000), false);
    assert.equal(records.at(-1).reason, 'strays');
    // The first look cannot be made: unlisted, as before.
    assert.equal(await observe([null], 60_000), false);
    assert.equal(records.at(-1).reason, 'unlisted');
  },
);

test(
  'AC-0062-S03 a host observer is called while the runtime is being closed, as before',
  { skip: !posix },
  async (t) => {
    const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0062h-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dirs = {
      workspace: join(base, 'workspace'),
      state: join(base, 'state'),
      home: join(base, 'codex-home'),
      user: join(base, 'user'),
      log: join(base, 'fixture.log'),
    };
    for (const dir of [dirs.workspace, dirs.state, dirs.home, dirs.user]) await mkdir(dir);
    let serverAlive: boolean | undefined;
    const adapter = createCodexAdapter({
      command: process.execPath,
      args: [fixture],
      env: { HOME: dirs.user, FIXTURE_LOG: dirs.log, FIXTURE_SERVER_CHILD: SLOW },
      connection: { home: dirs.home },
      closeTimeoutMs: 20000,
      observeExecutionStop: async () => {
        const child = readFileSync(dirs.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .find((entry) => entry.event === 'server-child')?.pid as number;
        serverAlive = alive(child);
        return true;
      },
    });
    t.after(() => adapter.close?.());
    const evidence: ExecutionEvidence[] = [];
    for await (const _ of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'offline',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: dirs.workspace,
      stateDir: dirs.state,
      signal: new AbortController().signal,
      reportExecutionEvidence: (item: ExecutionEvidence) => evidence.push(item),
    } as RuntimeInput));
    assert.equal(serverAlive, true, 'called before the app-server’s processes were ended');
    assert.ok(evidence.some((item) => item.remoteExecution === 'stopped'));
  },
);

test("AC-0062-N01 'remote' is the proxy with every domain and without local addresses", () => {
  const input = { permissionProfile: 'workspace-write', requestPermission: async () => true };
  const checked = checkPolicy({ mode: 'auto', network: 'remote' }, input as never);
  assert.equal(typeof checked, 'object', String(checked));
  assert.equal((checked as { network: unknown }).network, 'remote');
  assert.equal(typeof checkPolicy({ mode: 'auto', network: 'local' }, input as never), 'string');
  assert.equal(
    typeof checkPolicy({ mode: 'plan', network: 'remote' }, {
      permissionProfile: 'read-only',
    } as never),
    'string',
  );
  const settings = (network: unknown) =>
    profileSettings({ write: true, writePaths: ['/w'], none: [], network: network as never }).join(
      ' ',
    );
  const remote = settings('remote');
  assert.match(remote, /network=\{enabled=true,mode="full",domains=\{"\*"="allow"\}\}/);
  assert.doesNotMatch(remote, /allow_local_binding/);
  assert.match(remote, /features\.network_proxy=true/);
  assert.match(settings('direct'), /allow_local_binding=true/);
});
