import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimePermissionRequest } from '../../packages/engine/src/types.ts';

// SPEC-0038: Codex approves a file change by item ID only; the adapter checks the paths the item
// named before asking the host, and passes them on. It also keeps credentials out of commands.

type Change = { path: string; kind: Record<string, unknown>; diff?: string };

async function dirs(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-0038-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace'),
    state = join(base, 'state');
  await mkdir(workspace);
  await mkdir(state);
  return { base, workspace, state };
}

/** Runs one dispatch against the file-change fixture and returns what the host and app saw. */
async function approve(
  t: any,
  workspace: string,
  state: string,
  changes: (workspace: string) => Change[],
  options: { noItem?: boolean; writePaths?: string[] } = {},
) {
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    permissionProfile: 'workspace-write',
    command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/codex-file-change.ts', import.meta.url))],
    env: {
      FIXTURE_CHANGES: JSON.stringify(changes(workspace)),
      ...(options.noItem ? { FIXTURE_NO_ITEM: '1' } : {}),
    },
  });
  t.after(() => adapter.close?.());
  const asked: RuntimePermissionRequest[] = [];
  let decision: string | undefined;
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    workspace,
    stateDir: state,
    model: 'offline',
    prompt: 'change a file',
    permissionProfile: 'workspace-write',
    ...(options.writePaths ? { writePaths: options.writePaths } : {}),
    signal: new AbortController().signal,
    async requestPermission(request) {
      asked.push(request);
      return true;
    },
  }))
    if (event.type === 'result') decision = event.text;
  return { asked, decision };
}

const add = (path: string): Change => ({ path, kind: { type: 'add' }, diff: '+x\n' });

test('0038-P01 a change outside the workspace is declined without asking the host', async (t) => {
  const { base, workspace, state } = await dirs(t);
  const { asked, decision } = await approve(t, workspace, state, (ws) => [
    add(join(ws, 'inside.txt')),
    add(join(base, 'outside.txt')),
  ]);
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a request whose item was never seen is declined', async (t) => {
  const { workspace, state } = await dirs(t);
  const { asked, decision } = await approve(t, workspace, state, (ws) => [add(join(ws, 'a.txt'))], {
    noItem: true,
  });
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a path through a symbolic link that leaves the workspace is declined', async (t) => {
  const { base, workspace, state } = await dirs(t);
  await mkdir(join(base, 'elsewhere'));
  await symlink(join(base, 'elsewhere'), join(workspace, 'link'));
  const { asked, decision } = await approve(t, workspace, state, (ws) => [
    add(join(ws, 'link', 'new', 'file.txt')),
  ]);
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a dangling symbolic link to a file outside is declined', async (t) => {
  const { base, workspace, state } = await dirs(t);
  // Writing through it would create the file it names, outside the workspace.
  await symlink(join(base, 'not-yet'), join(workspace, 'dangling'));
  const { asked, decision } = await approve(t, workspace, state, (ws) => [
    add(join(ws, 'dangling')),
  ]);
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a move whose destination leaves the workspace is declined', async (t) => {
  const { base, workspace, state } = await dirs(t);
  const { asked, decision } = await approve(t, workspace, state, (ws) => [
    { path: join(ws, 'a.txt'), kind: { type: 'update', move_path: join(base, 'moved.txt') } },
  ]);
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a change outside narrowed write paths is declined', async (t) => {
  const { workspace, state } = await dirs(t);
  await mkdir(join(workspace, 'allowed'));
  const { asked, decision } = await approve(
    t,
    workspace,
    state,
    (ws) => [add(join(ws, 'other.txt'))],
    { writePaths: ['allowed'] },
  );
  assert.equal(decision, 'decline');
  assert.equal(asked.length, 0);
});

test('0038-P01 a change inside the write paths reaches the host with its paths', async (t) => {
  const { workspace, state } = await dirs(t);
  const { asked, decision } = await approve(t, workspace, state, (ws) => [
    add(join(ws, 'new', 'dir', 'file.txt')),
    { path: 'relative.txt', kind: { type: 'delete' } },
    { path: join(ws, 'b.txt'), kind: { type: 'update', move_path: join(ws, 'c.txt') } },
  ]);
  assert.equal(decision, 'accept');
  assert.equal(asked.length, 1);
  assert.deepEqual((asked[0]!.permission as { changes: unknown }).changes, [
    { path: join(workspace, 'new', 'dir', 'file.txt'), kind: 'add' },
    { path: join(workspace, 'relative.txt'), kind: 'delete' },
    { path: join(workspace, 'b.txt'), kind: 'update', movePath: join(workspace, 'c.txt') },
  ]);
});

test('0038-P02 commands start without the shell snapshot and with the default excludes', async (t) => {
  const { workspace, state } = await dirs(t);
  const fixture = fileURLToPath(new URL('../fixtures/codex-policy.ts', import.meta.url));
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fixture],
  });
  t.after(() => adapter.close?.());
  let text = '';
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    workspace,
    stateDir: state,
    model: 'offline',
    prompt: 'policy',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
  }))
    if (event.type === 'result') text = event.text;
  const args: string[] = JSON.parse(text).args;
  for (const setting of [
    'features.shell_snapshot=false',
    'shell_environment_policy.ignore_default_excludes=false',
  ])
    assert.ok(args.includes(setting), `${setting} in ${JSON.stringify(args)}`);
});
