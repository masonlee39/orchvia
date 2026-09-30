import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { validateWire } from '../../packages/engine/src/index.ts';
import type {
  EngineClock,
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  RuntimeProgress,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0053: a running turn's progress reaches the host as `dispatch.progress` events.

/** A runtime that hands its input to the test and works until released. */
async function setup(t: any) {
  let offset = 0;
  const clock: EngineClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now() + offset,
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-progress-')));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const fake = createFakeAdapter();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: (input: RuntimeInput) => void;
  const running = new Promise<RuntimeInput>((resolve) => (started = resolve));
  const adapter = {
    ...fake,
    async *execute(input: RuntimeInput) {
      yield { type: 'accepted', providerSessionId: `fake-${input.sessionId}` };
      started(input);
      await held;
      for await (const event of fake.execute(input)) if (event.type !== 'accepted') yield event;
    },
  } as RuntimeAdapter;
  const engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    clock,
  });
  t.after(async () => {
    release();
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'work',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const input = await running;
  return {
    engine,
    task,
    input,
    workspace,
    report: (progress: unknown) => input.reportProgress!(progress as RuntimeProgress),
    advance: (ms: number) => (offset += ms),
    release,
    async progress() {
      const events: EventPage['events'] = [];
      let cursor = '0';
      for (;;) {
        const page = (await engine.call('events.read', {
          limit: 1000,
          types: ['dispatch.progress'],
          ...(cursor === '0' ? {} : { afterCursor: cursor, storeId: engine.storeId }),
        })) as EventPage;
        events.push(...page.events);
        if (!page.events.length) return events;
        cursor = page.cursor;
      }
    },
  };
}

test('AC-0053-E01 a tool start, text and a retry are written with their bounds', async (t) => {
  const s = await setup(t);
  assert.equal(typeof s.input.reportProgress, 'function');
  s.report({
    kind: 'tool_started',
    tool: 'Bash',
    command: `npm test ${'x'.repeat(300)}`,
    paths: [join(s.workspace, 'src', 'app.ts'), '/etc/hosts'],
  });
  s.report({ kind: 'tool_started', tool: 'lookup', server: 'docs' });
  s.report({ kind: 'assistant_text', text: 'y'.repeat(400) });
  s.report({
    kind: 'api_retry',
    attempt: 2,
    maxRetries: 10,
    delayMs: 1200,
    status: 529,
    message: 'Overloaded',
  });
  const events = await s.progress();
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(event.taskId, s.task.id);
    assert.equal(event.sessionId, s.task.sessionId);
    assert.equal(event.data.dispatchId, s.input.dispatchId);
    validateWire('DispatchProgressData', event.data);
  }
  const [bash, mcp, text, retry] = events.map((event) => event.data);
  assert.equal(bash.tool, 'Bash');
  assert.equal((bash.command as string).length, 200);
  assert.deepEqual(bash.paths, ['src/app.ts', '/etc/hosts']);
  assert.deepEqual(mcp, {
    dispatchId: s.input.dispatchId,
    kind: 'tool_started',
    tool: 'lookup',
    server: 'docs',
  });
  assert.equal(text.text, 'y'.repeat(280));
  assert.deepEqual(retry, {
    dispatchId: s.input.dispatchId,
    kind: 'api_retry',
    attempt: 2,
    maxRetries: 10,
    delayMs: 1200,
    status: 529,
    message: 'Overloaded',
  });
  assert.throws(() => validateWire('DispatchProgressData', { ...retry, kind: 'other' }), {
    code: 'INVALID_WIRE_DATA',
  });
});

test('AC-0053-E01 AC-0053-A02 malformed progress is dropped, counted, and never throws', async (t) => {
  const s = await setup(t);
  for (const bad of [
    null,
    'text',
    { kind: 'nope' },
    { kind: 'tool_started' },
    { kind: 'assistant_text', text: 3 },
  ])
    assert.doesNotThrow(() => s.report(bad));
  s.report({ kind: 'tool_started', tool: 'Read', paths: [join(s.workspace, 'a.txt')] });
  const [event] = await s.progress();
  assert.equal(event.data.dropped, 5);
  assert.deepEqual(event.data.paths, ['a.txt']);
});

test('AC-0053-E02 text is throttled by the monotonic clock, and kept for the next event', async (t) => {
  const s = await setup(t);
  s.report({ kind: 'assistant_text', text: 'first. ' });
  s.advance(1000);
  s.report({ kind: 'assistant_text', text: 'second. ' });
  s.report({ kind: 'tool_started', tool: 'Bash', command: 'ls' });
  s.advance(4100);
  s.report({ kind: 'assistant_text', text: 'third.' });
  const texts = (await s.progress())
    .filter((event) => event.data.kind === 'assistant_text')
    .map((event) => event.data.text);
  assert.deepEqual(texts, ['first. ', 'second. third.']);
});

test('AC-0053-E02 the 1,001st progress writes limit_reached once, then nothing', async (t) => {
  const s = await setup(t);
  for (let n = 0; n < 1010; n++) s.report({ kind: 'tool_started', tool: `tool-${n}` });
  const events = await s.progress();
  assert.equal(events.length, 1001);
  assert.deepEqual(events.at(-1)!.data, {
    dispatchId: s.input.dispatchId,
    kind: 'limit_reached',
    limit: 1000,
  });
  assert.equal(events.at(-2)!.data.tool, 'tool-999');
});

test('AC-0053-E05 a finished tool is written with its outcome and time', async (t) => {
  const s = await setup(t);
  s.report({ kind: 'tool_finished', tool: 'Bash', ok: false, durationMs: 1234, exitCode: 2 });
  s.report({ kind: 'tool_finished', tool: 'Read', ok: true, durationMs: null, exitCode: null });
  for (const bad of [
    { kind: 'tool_finished', tool: 'Bash' },
    { kind: 'tool_finished', tool: 'x', ok: 'yes' },
  ])
    s.report(bad);
  const events = (await s.progress()).map((event) => event.data);
  assert.deepEqual(events, [
    {
      dispatchId: s.input.dispatchId,
      kind: 'tool_finished',
      tool: 'Bash',
      ok: false,
      durationMs: 1234,
      exitCode: 2,
    },
    {
      dispatchId: s.input.dispatchId,
      kind: 'tool_finished',
      tool: 'Read',
      ok: true,
      durationMs: null,
      exitCode: null,
    },
  ]);
  for (const data of events) validateWire('DispatchProgressData', data);
});

test('AC-0053-E06 thinking is written without content, at most every 30 seconds', async (t) => {
  const s = await setup(t);
  s.report({ kind: 'thinking' });
  s.advance(10_000);
  s.report({ kind: 'thinking' });
  s.advance(20_100);
  s.report({ kind: 'thinking', text: 'never stored' });
  const events = (await s.progress()).map((event) => event.data);
  assert.deepEqual(events, [
    { dispatchId: s.input.dispatchId, kind: 'thinking' },
    { dispatchId: s.input.dispatchId, kind: 'thinking' },
  ]);
  for (const data of events) validateWire('DispatchProgressData', data);
});

test('AC-0053-E07 secrets in a command and in text are masked before they are written', async (t) => {
  const s = await setup(t);
  s.report({
    kind: 'tool_started',
    tool: 'Bash',
    command:
      'curl -H "Authorization: Bearer abc.DEF-123" --api-key k123 GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx deploy',
  });
  s.report({
    kind: 'assistant_text',
    text: 'Use sk-ant-api03-abcdefghijkl and AKIAABCDEFGHIJKLMNOP; password: hunter2. Done.',
  });
  const [command, text] = (await s.progress()).map((event) => event.data);
  assert.equal(
    command.command,
    'curl -H "Authorization: Bearer ***" --api-key *** GITHUB_TOKEN=*** deploy',
  );
  assert.equal(text.text, 'Use *** and ***; password: ***. Done.');
});

test('AC-0053-A02 progress after the turn ended is not written', async (t) => {
  const s = await setup(t);
  s.release();
  for (let i = 0; i < 200; i++) {
    const task = (await s.engine.call('tasks.get', { taskId: s.task.id })) as TaskSnapshot;
    if (task.status === 'waiting_approval') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  s.report({ kind: 'tool_started', tool: 'late' });
  assert.deepEqual(await s.progress(), []);
});
