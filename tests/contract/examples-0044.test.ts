import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0044 E03: every runnable example runs and prints what its documentation says.

const root = fileURLToPath(new URL('../..', import.meta.url));
const python = { ...process.env, PYTHONPATH: join(root, 'python/src') };
// The Python examples that start `orchvia host` take the 4 KiB test reserve (SPEC-0011 R10).
const reserve = ['--emergency-bytes', '4096'];

/** Runs an example to its end and returns its stdout lines. */
function run(command: string, args: string[], env = process.env, cwd = root): string[] {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return result.stdout.trimEnd().split('\n');
}
const node = (file: string, ...args: string[]) => run(process.execPath, [file, ...args]);
const py = (file: string, ...args: string[]) => run('python3', [file, ...args], python);

const CRASH = [
  '1. The host was killed while its runtime worked on the task',
  '2. After the restart: task blocked, session outcome_unknown',
  '3. Reconciled: task failed (reconciled_interrupted), session paused',
  '4. Dispatches sent again: 0',
];
const TEAM = [
  '1. The lead delegated "Check the changelog links": paused for the host',
  `2. The helper's prompt held the lead's message: "The API pages moved from docs/api/ to docs/reference/"`,
  '3. The host handed "Review the notes for tone" to the editor: completed, same session: true',
];

/** Where each example runs, or why no test here runs it. */
const COVERAGE: Record<string, string> = {
  'typescript/checks-and-dependencies.ts': 'here',
  'typescript/connect.ts': 'here',
  'typescript/crash-recovery.ts': 'here',
  'typescript/team-mailbox.ts': 'here',
  'typescript/quickstart.ts': 'here, and 0021-R01 in docs.test.ts',
  'typescript/hosted.ts': 'host-runtime-process.test.ts',
  'typescript/usage-forwarding.ts': 'usage-recovery.test.ts',
  'typescript/team-host.ts': 'started by python/team_mailbox.py',
  'typescript/team-runtime.ts': 'a module of the team examples',
  'typescript/local.ts': 'not run: waits for a person to type approve or deny',
  'typescript/quickstart-claude.ts': 'not run: calls Claude (scripts/quickstart-claude-smoke.mjs)',
  'typescript/writable-host.ts': 'not run: starts Claude Code and the Codex CLI',
  'python/checks_and_dependencies.py': 'here',
  'python/crash_recovery.py': 'here',
  'python/fake_roundtrip.py': 'here',
  'python/team_mailbox.py': 'here',
  'python/quickstart.py': 'here, and 0021-R12 in docs.test.ts',
};

test('AC-0044-E03 every example is run by a test or says why not', async () => {
  const files: string[] = [];
  // Python leaves its bytecode cache beside the examples it ran.
  for (const language of ['typescript', 'python'])
    for (const file of await readdir(join(root, 'examples', language)))
      if (!file.startsWith('.') && file !== '__pycache__') files.push(`${language}/${file}`);
  assert.deepEqual(files.sort(), Object.keys(COVERAGE).sort());
});

test('AC-0044-E03 the checks-and-dependencies examples complete both tasks in both languages', () => {
  const ts = JSON.parse(node('examples/typescript/checks-and-dependencies.ts').at(-1)!);
  const pyResult = JSON.parse(py('examples/python/checks_and_dependencies.py').at(-1)!);
  for (const [language, result] of [
    ['typescript', ts],
    ['python', pyResult],
  ]) {
    assert.equal(result.language, language);
    assert.equal(result.completed, 2);
    assert.equal(result.modelCalls, 0);
    assert.ok(result.snapshotItems > 0);
  }
});

test('AC-0044-E03 fake_roundtrip.py completes its fixture task', () => {
  const result = JSON.parse(py('examples/python/fake_roundtrip.py', ...reserve).join('\n'));
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'deterministic Python example result');
  assert.equal(result.model_calls, 'none');
});

test('AC-0044-E01 AC-0044-E03 the crash-recovery examples print the same four steps', () => {
  assert.deepEqual(node('examples/typescript/crash-recovery.ts'), CRASH);
  assert.deepEqual(py('examples/python/crash_recovery.py', ...reserve), CRASH);
});

test('AC-0044-E02 AC-0044-E03 the team-mailbox examples print the same three steps', () => {
  assert.deepEqual(node('examples/typescript/team-mailbox.ts'), TEAM);
  assert.deepEqual(py('examples/python/team_mailbox.py'), TEAM);
});

test('AC-0044-E03 connect.ts reads a task and its usage from a running host', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-examples-')));
  const sockets = await realpath(await mkdtemp('/tmp/oex-'));
  await mkdir(join(dir, 'workspace'));
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
  });
  const socketPath = join(sockets, 'rpc.sock');
  const host = await startUnixHost(engine, { socketPath });
  t.after(async () => {
    await host.close({ mode: 'interrupt', timeoutMs: 2000 });
    await rm(dir, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  });
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Read me from another process',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'connect-example',
  })) as TaskSnapshot;
  // Asynchronous: the host answers on this process's event loop while the example runs.
  const child = spawn(process.execPath, ['examples/typescript/connect.ts', socketPath, task.id], {
    cwd: root,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(task.id), stdout);
  assert.match(stdout, /Read me from another process/);
});

test('AC-0044-T04 the offline quickstarts run without installed dependencies', async (t) => {
  const copy = await realpath(await mkdtemp(join(tmpdir(), 'orch-bare-')));
  t.after(() => rm(copy, { recursive: true, force: true }));
  for (const part of ['package.json', 'packages', 'examples', 'python/src'])
    await cp(join(root, part), join(copy, part), {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
    });
  // The reserve guard lets the examples keep the production reserve only where they live in the
  // repository, so the copy runs without it, as a reader's checkout does.
  const guard = /--import\s+("[^"]*reserve-guard\.mjs"|\S*reserve-guard\.mjs)/g;
  const bare = {
    ...process.env,
    NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '').replace(guard, ''),
  };
  const ts = run(process.execPath, ['examples/typescript/quickstart.ts'], bare, copy);
  assert.equal(ts.at(-1), "The second task reused the first agent's session: true");
  const env = { ...process.env, PYTHONPATH: join(copy, 'python/src') };
  const pyLines = run('python3', ['examples/python/quickstart.py', ...reserve], env, copy);
  assert.equal(pyLines.at(-1), "The second task reused the first agent's session: true");
});
