import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { canonicalPath, samePath } from '../../packages/engine/src/paths.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0054: paths are compared as the volume names them; what a store recorded is never rewritten.

async function volume(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orch-case-engine-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'Project-x', 'WS', 'src'), { recursive: true });
  await mkdir(join(base, 'Other'), { recursive: true });
  return { base, insensitive: existsSync(join(base, 'project-x', 'ws')) };
}
const recorded = (stateDir: string) => {
  const db = new DatabaseSync(join(stateDir, 'store.sqlite'), { readOnly: true });
  try {
    return (
      db.prepare("SELECT value FROM metadata WHERE key='workspace'").get() as { value: string }
    ).value;
  } finally {
    db.close();
  }
};

test('AC-0054-P01 canonicalPath resolves what exists and keeps what does not', async (t) => {
  const { base } = await volume(t);
  assert.equal(
    canonicalPath(join(base, 'Project-x', 'WS', 'new', 'file.md')),
    join(base, 'Project-x', 'WS', 'new', 'file.md'),
  );
  assert.ok(samePath(join(base, 'Project-x'), join(base, 'Project-x')));
  assert.ok(!samePath(join(base, 'Project-x'), join(base, 'Other')));
  assert.ok(!samePath(join(base, 'missing-a'), join(base, 'missing-b')));
});

test('AC-0054-E01 a store opens with its workspace in another case, and its record stays', async (t) => {
  const { base, insensitive } = await volume(t);
  if (!insensitive) return t.skip('the volume is case-sensitive');
  const stateDir = join(base, 'state');
  const first = await createEngine({
    workspace: join(base, 'project-x', 'WS'),
    stateDir,
    adapters: [createFakeAdapter()],
  });
  await first.close();
  const before = recorded(stateDir);
  const second = await createEngine({
    workspace: join(base, 'Project-x', 'WS'),
    stateDir,
    adapters: [createFakeAdapter()],
  });
  await second.close();
  assert.equal(
    recorded(stateDir),
    before,
    'the record is not rewritten, so a rollback still opens it',
  );
});

test('AC-0054-E01 another directory is still another workspace', async (t) => {
  const { base } = await volume(t);
  const stateDir = join(base, 'state');
  const first = await createEngine({
    workspace: join(base, 'Project-x', 'WS'),
    stateDir,
    adapters: [createFakeAdapter()],
  });
  await first.close();
  await assert.rejects(
    createEngine({ workspace: join(base, 'Other'), stateDir, adapters: [createFakeAdapter()] }),
    { code: 'WORKSPACE_MISMATCH' },
  );
});

test('AC-0054-E02 a write path named in the case on disk is inside a workspace registered in another', async (t) => {
  const { base, insensitive } = await volume(t);
  if (!insensitive) return t.skip('the volume is case-sensitive');
  const engine: any = await createEngine({
    workspace: join(base, 'project-x', 'WS'),
    stateDir: join(base, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { permissionProfile: 'workspace-write' } },
    writeScopes: { main: ['.'] },
  });
  t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }));
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'write',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
      writeScope: 'main',
      writePath: join(base, 'Project-x', 'WS', 'src'),
    },
    idempotencyKey: 'write',
  })) as TaskSnapshot;
  assert.equal(task.writePaths?.length, 1);
  // Recorded in the workspace's own spelling, as tasks were before.
  assert.equal(task.writePaths![0], join(realpathSync(join(base, 'project-x', 'WS')), 'src'));
  // A write path recorded in another spelling of the same directory still conflicts.
  const holders = engine.writeConflictHolders(
    { writePaths: [join(base, 'project-x', 'ws', 'src')] },
    [
      {
        taskId: 'earlier',
        executionLease: { status: 'held' },
        writePaths: [join(base, 'PROJECT-X', 'WS')],
      },
    ],
  );
  assert.deepEqual(holders, ['earlier']);
});
