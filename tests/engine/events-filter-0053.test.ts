import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import {
  createOrchestrator,
  openOrchestratorReadOnly,
} from '../../packages/sdk-typescript/src/index.ts';
import type { EventPage } from '../../packages/engine/src/types.ts';

// SPEC-0053 F: events.read filters by type in the engine, and leaves progress out by default.

async function setup(t: any) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-events-filter-')));
  await mkdir(join(dir, 'workspace'));
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
  };
  const engine: any = await createEngine(config);
  t.after(async () => {
    await engine.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const store = engine.store;
  /** Events as a running turn writes them: `n` progress events between two others. */
  const write = (n: number, taskId = 'task-1') =>
    store.transaction(() => {
      store.event('dispatch.started', { dispatchId: 'd' }, { taskId });
      for (let i = 0; i < n; i++)
        store.event('dispatch.progress', { dispatchId: 'd', kind: 'thinking' }, { taskId });
      store.event('task.completed', { status: 'completed' }, { taskId });
    });
  const read = (params: Record<string, unknown> = {}) =>
    engine.call('events.read', { limit: 1000, ...params }) as Promise<EventPage>;
  return { engine, store, write, read, config, dir };
}
const types = (page: EventPage) => page.events.map((event) => event.type);

test('AC-0053-F01 progress is left out by default, and read when asked for', async (t) => {
  const s = await setup(t);
  s.write(3);
  const all = await s.read({ excludeTypes: [] });
  assert.equal(types(all).filter((type) => type === 'dispatch.progress').length, 3);
  const plain = await s.read();
  assert.ok(!types(plain).includes('dispatch.progress'));
  assert.deepEqual(
    types(plain),
    types(all).filter((type) => type !== 'dispatch.progress'),
  );
  assert.equal(plain.cursor, all.cursor, 'the cursor moves past what was left out');
  assert.deepEqual(types(await s.read({ types: ['dispatch.progress'] })), [
    'dispatch.progress',
    'dispatch.progress',
    'dispatch.progress',
  ]);
  assert.deepEqual(
    types(await s.read({ excludeTypes: ['dispatch.progress', 'dispatch.started'] })),
    types(plain).filter((type) => type !== 'dispatch.started'),
  );
  // With a task, as a host pages through one task.
  assert.deepEqual(types(await s.read({ taskId: 'task-1' })), [
    'dispatch.started',
    'task.completed',
  ]);
});

test('AC-0053-F01 invalid filters are refused', async (t) => {
  const s = await setup(t);
  for (const params of [
    { types: ['a'], excludeTypes: ['b'] },
    { types: [] },
    { types: 'dispatch.progress' },
    { excludeTypes: Array.from({ length: 51 }, (_, i) => `t${i}`) },
    { types: [''] },
  ])
    await assert.rejects(s.read(params), { code: 'VALIDATION_ERROR' }, JSON.stringify(params));
});

test('AC-0053-F02 a read scans at most 5,000 events and moves its cursor past them', async (t) => {
  const s = await setup(t);
  const before = (await s.read({ excludeTypes: [] })).cursor;
  s.write(6000);
  const first = await s.read({ afterCursor: before, storeId: s.engine.storeId, limit: 10 });
  assert.deepEqual(types(first), ['dispatch.started']);
  assert.equal(BigInt(first.cursor) - BigInt(before), 5000n);
  const second = await s.read({ afterCursor: first.cursor, storeId: s.engine.storeId, limit: 10 });
  assert.deepEqual(types(second), ['task.completed']);
});

test('AC-0053-F03 the SDKs pass the filter, and a read-only store filters alike', async (t) => {
  const s = await setup(t);
  s.write(2);
  await s.engine.close();
  const orch = await createOrchestrator({ ...s.config, storage: { emergencyBytes: 4096 } });
  const page = await orch.events.read({ types: ['dispatch.progress'] });
  assert.deepEqual(types(page), ['dispatch.progress', 'dispatch.progress']);
  const iterated: string[] = [];
  const controller = new AbortController();
  try {
    for await (const event of orch.events({ excludeTypes: [], signal: controller.signal })) {
      iterated.push(event.type);
      if (iterated.filter((type) => type === 'dispatch.progress').length === 2) controller.abort();
    }
  } catch {
    // Aborted once both progress events arrived.
  }
  assert.ok(iterated.includes('dispatch.progress'));
  await orch.close();
  const reader = await openOrchestratorReadOnly({ stateDir: s.config.stateDir });
  try {
    const plain = await reader.events.read({ limit: 1000 });
    assert.ok(!types(plain).includes('dispatch.progress'));
    assert.equal(types(await reader.events.read({ types: ['dispatch.progress'] })).length, 2);
  } finally {
    await reader.close();
  }
});
