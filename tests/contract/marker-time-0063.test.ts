import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

// SPEC-0063: a stop marker's waits last at least 5 seconds, whatever closeTimeoutMs or
// cleanupTimeoutMs is; a host with checks and no verificationEnvironment is warned once.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const posix = process.platform !== 'win32';

/** Puts an `lsof` that takes `ms` longer before the real one, for the rest of the test. */
async function slowLsof(t: any, base: string, ms: number): Promise<void> {
  const real = execFileSync('/bin/sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).trim();
  const bin = join(base, 'bin');
  await mkdir(bin);
  writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nsleep ${ms / 1000}\nexec ${real} "$@"\n`, {
    mode: 0o755,
  });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => {
    process.env.PATH = before;
  });
}
async function directories(t: any) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0063-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirs = {
    base,
    workspace: join(base, 'workspace'),
    state: join(base, 'state'),
    home: join(base, 'codex-home'),
    user: join(base, 'user'),
    log: join(base, 'fixture.log'),
  };
  for (const dir of [dirs.workspace, dirs.state, dirs.home, dirs.user]) await mkdir(dir);
  return dirs;
}
const input = (dirs: { workspace: string; state: string }, evidence: ExecutionEvidence[]) =>
  ({
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
  }) as RuntimeInput;

test(
  'AC-0063-O01 a Codex dispatch is proven stopped when lsof takes longer than closeTimeoutMs',
  { skip: !posix },
  async (t) => {
    const dirs = await directories(t);
    // Two listings of 0.7 seconds each: more than the configured second, far less than five.
    await slowLsof(t, dirs.base, 700);
    const observations: any[] = [];
    const adapter = createCodexAdapter({
      command: process.execPath,
      args: [fixture],
      env: { HOME: dirs.user, FIXTURE_LOG: dirs.log },
      connection: { home: dirs.home },
      stopMarker: {
        directory: join(dirs.base, 'markers'),
        onObservation: (o) => observations.push(o),
      },
      closeTimeoutMs: 1000,
    });
    t.after(() => adapter.close?.().catch(() => {}));
    await mkdir(join(dirs.base, 'markers'), { mode: 0o700 }).catch(() => {});
    const evidence: ExecutionEvidence[] = [];
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.execute(input(dirs, evidence))) events.push(event);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.ok(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      `not proven stopped: ${JSON.stringify(observations)}`,
    );
  },
);

test(
  'AC-0063-O01 a Claude dispatch is proven stopped when lsof takes longer than cleanupTimeoutMs',
  { skip: !posix },
  async (t) => {
    const dirs = await directories(t);
    await slowLsof(t, dirs.base, 700);
    const observations: any[] = [];
    const adapter = createClaudeAdapter({
      permissionProfile: 'workspace-write',
      stopMarker: {
        directory: join(dirs.base, 'markers'),
        onObservation: (o: any) => observations.push(o),
      },
      cleanupTimeoutMs: 1000,
      query: (request: ClaudeQueryRequest) => {
        const child = request.options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
          cwd: request.options.cwd,
          env: {},
          signal: new AbortController().signal,
        });
        return {
          close() {
            child.stdin.end();
          },
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'native' };
            yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
          },
        };
      },
    } as unknown as ClaudeAdapterConfig);
    t.after(() => adapter.close?.().catch(() => {}));
    const evidence: ExecutionEvidence[] = [];
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.execute({ ...input(dirs, evidence), model: 'fixture' }))
      events.push(event);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.ok(
      evidence.some((item) => item.remoteExecution === 'stopped'),
      `not proven stopped: ${JSON.stringify(observations)}`,
    );
  },
);

test('AC-0063-O03 a host observer still gets the configured time', { skip: !posix }, async (t) => {
  const dirs = await directories(t);
  let remaining: number | undefined;
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: { HOME: dirs.user, FIXTURE_LOG: dirs.log },
    connection: { home: dirs.home },
    closeTimeoutMs: 1000,
    observeExecutionStop: async (context) => {
      remaining = context.remainingMs();
      return true;
    },
  });
  t.after(() => adapter.close?.().catch(() => {}));
  for await (const _ of adapter.execute(input(dirs, [])));
  assert.ok(remaining !== undefined && remaining <= 1000 && remaining > 0, String(remaining));
});

const rule = {
  id: 'check',
  version: '1',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwdRelative: '.',
  timeoutMs: 20_000,
  permissionProfile: 'read-only',
  success: { exitCode: 0 },
};
const CODE = 'ORCHVIA_VERIFICATION_ENVIRONMENT_DEFAULT';
/** Starts an engine with `config` and returns the warnings of that code it gave, and the engine. */
async function started(t: any, config: Record<string, unknown>) {
  const dir = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0063w-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'workspace'));
  const warnings: string[] = [];
  const listen = (warning: Error & { code?: string }) => {
    if (warning.code === CODE) warnings.push(warning.message);
  };
  process.on('warning', listen);
  t.after(() => process.off('warning', listen));
  const engine: any = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
    ...config,
  } as never);
  t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
  // A warning is emitted on the next tick.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  return { engine, warnings, settle };
}

test('0065-B02 the default changed, so a host with checks is no longer warned at start', async (t) => {
  assert.deepEqual((await started(t, { verificationRules: [rule] })).warnings, []);
  for (const value of ['inherit', 'minimal'])
    assert.deepEqual(
      (await started(t, { verificationRules: [rule], verificationEnvironment: value })).warnings,
      [],
      value,
    );
  assert.deepEqual((await started(t, {})).warnings, [], 'no checks');
});

test('0065-B02 a host is not warned at a registered rule either', async (t) => {
  const { engine, warnings, settle } = await started(t, {});
  assert.deepEqual(warnings, []);
  for (const version of ['1', '2']) {
    await engine.call(
      'rules.register',
      { rule: { ...rule, version }, idempotencyKey: `rule-${version}` },
      { owner: true },
    );
    await settle();
    assert.deepEqual(warnings, [], `after version ${version}`);
  }
});
