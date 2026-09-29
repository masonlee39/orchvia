import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0042 E05: usage.byTask lists the efforts each task ran with.

/** A fake runtime that reports one usage record per effort named in its goal (`efforts=a,b`). */
function reporting(): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
      for await (const event of fake.execute(input)) {
        yield event;
        if (event.type !== 'accepted') continue;
        const named = /efforts=(\S+)/.exec(input.prompt)?.[1]?.split(',') ?? [];
        for (const [i, effective] of named.entries())
          yield {
            type: 'usage',
            usageId: `u${i}`,
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 1,
              raw: {
                _reasoningEffort: {
                  requested: null,
                  effective: effective === 'null' ? null : effective,
                  source: 'modelDefault',
                },
              },
            },
          };
        if (/plain/.test(input.prompt))
          yield {
            type: 'usage',
            usageId: 'plain',
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 1,
              raw: { other: true },
            },
          };
      }
    },
  };
}

test('AC-0042-E05 usage.byTask lists each task’s efforts in first-recorded order, online and read-only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-efforts-')));
  await mkdir(join(root, 'workspace'));
  const stateDir = join(root, 'state');
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [reporting()],
  });
  try {
    const info = (await engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(info.capabilities.workflow.reasoningEfforts, true);
    const deliver = async (goal: string) => {
      const task = (await engine.call('tasks.create', {
        spec: {
          goal,
          runtime: { provider: 'fake', model: 'fixture' },
          acceptance: { mode: 'human', criteria: ['Review'] },
        },
        idempotencyKey: crypto.randomUUID(),
      })) as TaskSnapshot;
      for (let i = 0; i < 400; i++) {
        const current = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
        if (current.status === 'waiting_approval') return current;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('never delivered');
    };
    const mixed = await deliver('efforts=high,low,high,null plain');
    const none = await deliver('plain');
    const taskIds = [mixed.id, none.id];
    const byTask = (await engine.call('usage.byTask', { taskIds })) as {
      tasks: { taskId: string; reasoningEfforts: string[] }[];
    };
    assert.deepEqual(
      byTask.tasks.map((task) => task.reasoningEfforts),
      [['high', 'low'], []],
    );
    const reader = await openReadOnlyEngine({ stateDir });
    try {
      assert.deepEqual(await reader.call('usage.byTask', { taskIds }), byTask);
      const hello = (await reader.call('initialize', {
        protocolVersion: '2.0',
        sdkVersion: 'test',
      })) as { capabilities: { workflow: Record<string, unknown> } };
      assert.equal(hello.capabilities.workflow.reasoningEfforts, true);
    } finally {
      await reader.close();
    }
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
