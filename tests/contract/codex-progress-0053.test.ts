import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type {
  RuntimeEvent,
  RuntimeInput,
  RuntimeProgress,
} from '../../packages/engine/src/types.ts';

// SPEC-0053 E04: the Codex adapter reports item starts, message deltas and retrying errors.

const fixture = fileURLToPath(new URL('../fixtures/codex-local.ts', import.meta.url));
const MODELS = JSON.stringify([[{ id: 'gpt-a', model: 'gpt-a' }]]);
const started = (item: Record<string, unknown>) => ({ method: 'item/started', params: { item } });
const NOTIFICATIONS = [
  started({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' }),
  started({
    type: 'fileChange',
    id: 'f1',
    changes: [
      { path: '/w/a.ts', kind: { type: 'update' } },
      { path: '/w/b.ts', kind: { type: 'add' } },
    ],
    status: 'inProgress',
  }),
  started({
    type: 'mcpToolCall',
    id: 'm1',
    server: 'docs',
    tool: 'lookup',
    arguments: { q: 'secret' },
  }),
  started({ type: 'webSearch', id: 'w1', query: 'orchvia' }),
  started({ type: 'agentMessage', id: 'a1', text: '' }),
  started({ type: 'reasoning', id: 'r1' }),
  { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Running tests.' } },
  {
    method: 'error',
    params: {
      willRetry: true,
      error: {
        message: 'Reconnecting... 2/5 (stream disconnected before completion)',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        additionalDetails: null,
      },
    },
  },
  {
    method: 'error',
    params: {
      willRetry: true,
      error: {
        message: 'Reconnecting... waiting for network',
        codexErrorInfo: null,
        additionalDetails: null,
      },
    },
  },
  {
    method: 'error',
    params: { willRetry: false, error: { message: 'final', codexErrorInfo: null } },
  },
  { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'hidden' } },
  {
    method: 'item/completed',
    params: {
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: 'npm test',
        status: 'completed',
        exitCode: 0,
        durationMs: 1500,
      },
    },
  },
  {
    method: 'item/completed',
    params: { item: { type: 'fileChange', id: 'f1', changes: [], status: 'failed' } },
  },
  { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'done' } } },
];

async function run(t: any, reportProgress?: (progress: RuntimeProgress) => void) {
  const base = await realpath(await mkdtemp(join(os.tmpdir(), 'orchvia-0053-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of ['workspace', 'state', 'codex-home', 'user']) await mkdir(join(base, dir));
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fixture],
    env: {
      HOME: join(base, 'user'),
      FIXTURE_MODELS: MODELS,
      FIXTURE_NOTIFICATIONS: JSON.stringify(NOTIFICATIONS),
    },
    connection: { home: join(base, 'codex-home') },
    executionStop: 'owner-reconcile',
    policy: () => ({ mode: 'auto' }),
  } as never);
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'gpt-a',
      prompt: 'go',
      permissionProfile: 'workspace-write',
      workspace: join(base, 'workspace'),
      stateDir: join(base, 'state'),
      signal: new AbortController().signal,
      reportExecutionEvidence: () => {},
      ...(reportProgress ? { reportProgress } : {}),
    } as RuntimeInput))
      events.push(event);
  } finally {
    await adapter.close?.();
  }
  return events;
}

test('AC-0053-E04 the Codex adapter reports item starts, message deltas and retrying errors', async (t) => {
  const reported: RuntimeProgress[] = [];
  const events = await run(t, (progress) => reported.push(progress));
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events.at(-1)));
  // Without Codex's own duration, the adapter times the item from its start.
  const measured = reported.find(
    (progress) => progress.kind === 'tool_finished' && progress.tool === 'fileChange',
  ) as { durationMs: number } | undefined;
  assert.ok(measured && Number.isInteger(measured.durationMs) && measured.durationMs >= 0);
  measured.durationMs = 0;
  assert.deepEqual(reported, [
    { kind: 'tool_started', tool: 'commandExecution', command: 'npm test' },
    { kind: 'tool_started', tool: 'fileChange', paths: ['/w/a.ts', '/w/b.ts'] },
    { kind: 'tool_started', tool: 'lookup', server: 'docs' },
    { kind: 'tool_started', tool: 'webSearch' },
    { kind: 'thinking' },
    { kind: 'assistant_text', text: 'Running tests.' },
    {
      kind: 'api_retry',
      attempt: 2,
      maxRetries: 5,
      delayMs: null,
      status: 502,
      message: 'Reconnecting... 2/5 (stream disconnected before completion)',
    },
    {
      kind: 'api_retry',
      attempt: null,
      maxRetries: null,
      delayMs: null,
      status: null,
      message: 'Reconnecting... waiting for network',
    },
    { kind: 'thinking' },
    { kind: 'tool_finished', tool: 'commandExecution', ok: true, durationMs: 1500, exitCode: 0 },
    { kind: 'tool_finished', tool: 'fileChange', ok: false, durationMs: 0, exitCode: null },
  ]);
});

test('AC-0053-E04 without the callback the turn runs as before', async (t) => {
  const events = await run(t);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events.at(-1)));
});
