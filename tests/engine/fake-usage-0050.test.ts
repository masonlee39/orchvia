import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { engineConfig, loadConfig } from '../../packages/cli/src/config.ts';
import type { Engine, TaskSnapshot, UsageRecord } from '../../packages/engine/src/types.ts';

// SPEC-0050 U01: the fake runtime reports a configured usage once per dispatch.

async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'orch-fake-usage-')));
  await mkdir(join(path, 'workspace'));
  await mkdir(join(path, 'state'), { mode: 0o700 });
  return path;
}
async function settle(engine: Engine, id: string, status: string) {
  for (let n = 0; n < 500; n++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${id} did not reach ${status}`);
}
async function run(engine: Engine) {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Report usage',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['read'] },
    },
    idempotencyKey: 'u01',
  })) as TaskSnapshot;
  await settle(engine, task.id, 'waiting_approval');
  return (await engine.call('usage.get', { taskId: task.id })) as { records: UsageRecord[] };
}

test('0050-U01 the fake reports its configured usage once per dispatch, in process', async () => {
  const path = await root();
  const engine = await createEngine({
    workspace: join(path, 'workspace'),
    stateDir: join(path, 'state'),
    adapters: [createFakeAdapter({ usage: { inputTokens: 120, outputTokens: 30 } })],
    providers: { fake: { model: 'fixture' } },
  });
  try {
    const { records } = await run(engine);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.inputTokens, 120);
    assert.equal(records[0]!.outputTokens, 30);
  } finally {
    await engine.close();
    await rm(path, { recursive: true, force: true });
  }
});

test('0050-U01 without usage the fake reports none, as before', async () => {
  const path = await root();
  const engine = await createEngine({
    workspace: join(path, 'workspace'),
    stateDir: join(path, 'state'),
    adapters: [createFakeAdapter()],
    providers: { fake: { model: 'fixture' } },
  });
  try {
    assert.deepEqual((await run(engine)).records, []);
  } finally {
    await engine.close();
    await rm(path, { recursive: true, force: true });
  }
});

test('0050-U01 the CLI passes providers.fake.usage and refuses an invalid one', async () => {
  const path = await root();
  const write = async (usage: unknown) => {
    const file = join(path, `config-${crypto.randomUUID()}.json`);
    await writeFile(
      file,
      JSON.stringify({
        configVersion: 1,
        workspace: join(path, 'workspace'),
        stateDir: join(path, 'state'),
        providers: { fake: { model: 'fixture', usage } },
        storage: { emergencyBytes: 4096 },
      }),
    );
    return file;
  };
  try {
    const config = await engineConfig(
      await loadConfig(await write({ inputTokens: 7, outputTokens: 0 })),
    );
    const engine = await createEngine(config);
    try {
      const { records } = await run(engine);
      assert.deepEqual(
        records.map((r) => [r.inputTokens, r.outputTokens]),
        [[7, 0]],
      );
    } finally {
      await engine.close();
    }
    for (const usage of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 1 },
      { inputTokens: 1, outputTokens: 1, cached: 1 },
      'many',
    ])
      await assert.rejects(
        loadConfig(await write(usage)),
        { code: 'INVALID_CONFIG' },
        JSON.stringify(usage),
      );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
