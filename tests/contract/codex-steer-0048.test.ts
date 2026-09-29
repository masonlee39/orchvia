import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0048 C01: the Codex member steers its running turn with turn/steer.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const MODELS = JSON.stringify([[{ id: 'gpt-a', model: 'gpt-a' }]]);
const target = { sessionId: 'session', dispatchId: 'dispatch', generation: 1 };

/** A dispatch whose turn runs a command for 1.5 seconds; `during` steers while it runs. */
async function steering(
  t: any,
  env: Record<string, string>,
  during: (adapter: any) => Promise<unknown>,
) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0048-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of ['workspace', 'state', 'codex-home', 'user']) await mkdir(join(base, dir));
  const log = join(base, 'fixture.log');
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: {
      HOME: join(base, 'user'),
      FIXTURE_LOG: log,
      FIXTURE_MODELS: MODELS,
      FIXTURE_ITEM_COMMAND: 'make',
      ...env,
    },
    connection: { home: join(base, 'codex-home') },
    executionStop: 'owner-reconcile',
    requestTimeoutMs: 1000,
    policy: () => ({ mode: 'auto' }),
  } as never);
  let answer: Promise<unknown> | undefined;
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      ...target,
      providerSessionId: null,
      model: 'gpt-a',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: join(base, 'workspace'),
      stateDir: join(base, 'state'),
      signal: new AbortController().signal,
      reportExecutionEvidence: () => {},
    } as RuntimeInput)) {
      events.push(event);
      if (event.type === 'accepted')
        answer = during(adapter).then(
          (value) => value,
          (error) => error,
        );
    }
    const after = await adapter.steer!(target, 'too late', 'late');
    const requests = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.event === 'request' && entry.method === 'turn/steer')
      : [];
    return { answer: await answer, after, requests, last: events.at(-1) };
  } finally {
    await adapter.close?.();
  }
}

test('AC-0048-C01 the Codex member declares steer and sends turn/steer with its own turn id', async (t) => {
  assert.equal(
    createCodexAdapter({ executionStop: 'owner-reconcile' } as never).capabilities().steer,
    true,
  );
  const run = await steering(t, {}, (adapter) =>
    adapter.steer(target, "Don't touch config.json", 'm1'),
  );
  assert.deepEqual(run.answer, { status: 'accepted' });
  assert.deepEqual(
    run.requests.map((entry) => entry.params),
    [
      {
        threadId: 'thread',
        expectedTurnId: 'turn',
        input: [{ type: 'text', text: "Don't touch config.json", text_elements: [] }],
        clientUserMessageId: 'm1',
      },
    ],
  );
  assert.equal(run.last?.type, 'result', 'the turn went on');
  // After the turn ended: refused as ended, with no request.
  assert.deepEqual(run.after, {
    status: 'rejected',
    turnEnded: true,
    message: 'no running turn for this dispatch',
  });
});

test('AC-0048-C01 an error answer is a refusal; a steerability error says so', async (t) => {
  const refused = await steering(t, { FIXTURE_STEER_ERROR: 'input must not be empty' }, (adapter) =>
    adapter.steer(target, 'x', 'm2'),
  );
  assert.deepEqual(refused.answer, {
    status: 'rejected',
    turnEnded: false,
    notSteerable: false,
    message: 'input must not be empty',
  });
  const fixed = await steering(
    t,
    {
      FIXTURE_STEER_ERROR: 'cannot steer a review turn',
      FIXTURE_STEER_DATA: JSON.stringify({ codexErrorInfo: 'activeTurnNotSteerable' }),
    },
    (adapter) => adapter.steer(target, 'x', 'm3'),
  );
  assert.equal((fixed.answer as { notSteerable?: boolean }).notSteerable, true);
});

test('AC-0048-C01 no answer is not a refusal', async (t) => {
  const run = await steering(t, { FIXTURE_STEER_SILENT: '1' }, (adapter) =>
    adapter.steer(target, 'x', 'm4'),
  );
  assert.ok(run.answer instanceof Error, String(run.answer));
});
