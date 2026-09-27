import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { RuntimeInspection, TaskSnapshot } from '../../packages/engine/src/types.ts';

test('AC-F11 Codex inspection reads original thread using owned stdio without resuming', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-inspection-'));
  await mkdir(join(dir, 'workspace'));
  await mkdir(join(dir, 'state'));
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/codex-inspection.ts', import.meta.url))],
  });
  try {
    const result = await adapter.inspect!({
      sessionId: 'session',
      providerSessionId: 'original',
      generation: 1,
      dispatchId: 'dispatch',
      workspace: join(dir, 'workspace'),
      stateDir: join(dir, 'state'),
      limit: 4,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'found');
    assert.equal(result.execution, 'unknown');
    assert.deepEqual(result.records, [{ id: 'original-turn', status: 'completed' }]);
    assert.equal(adapter.hasActiveResources?.('session'), false);
  } finally {
    await adapter.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC-F11 unavailable native inspection stays bounded and does not settle the task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-inspection-timeout-'));
  await mkdir(join(dir, 'workspace'));
  const adapter = {
    ...createFakeAdapter(),
    inspect: () => new Promise<RuntimeInspection>(() => {}),
  };
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [adapter],
  });
  try {
    const task = (await engine.call('tasks.create', {
      spec: {
        goal: 'history',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['review'] },
      },
      idempotencyKey: 'task',
    })) as TaskSnapshot;
    while (
      ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status !==
      'waiting_approval'
    )
      await new Promise((done) => setTimeout(done, 2));
    const before = await engine.call('tasks.get', { taskId: task.id });
    const inspection = (await engine.call('sessions.inspect', {
      sessionId: task.sessionId,
      timeoutMs: 10,
    })) as RuntimeInspection;
    assert.equal(inspection.status, 'unavailable');
    assert.equal(inspection.execution, 'unknown');
    assert.deepEqual(await engine.call('tasks.get', { taskId: task.id }), before);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
