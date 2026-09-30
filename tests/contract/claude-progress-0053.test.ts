import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';
import type { RuntimeEvent, RuntimeProgress } from '../../packages/engine/src/types.ts';

// SPEC-0053 E03: the Claude adapter reports its main loop's tool starts, text and retries.

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  session_id: 'expected',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content },
});

async function run(reportProgress?: (progress: RuntimeProgress) => void) {
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 5000,
    query: withClaudeProcess(() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'expected' };
        yield {
          type: 'system',
          subtype: 'api_retry',
          session_id: 'expected',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 1200,
          error_status: 529,
          error: 'server_error',
        };
        // Thinking starts: a partial message of the main loop, long before the whole message.
        yield {
          type: 'stream_event',
          session_id: 'expected',
          parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        };
        yield assistant([
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'Running the tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/src/app.ts' } },
          { type: 'tool_use', id: 't3', name: 'mcp__docs__lookup', input: { q: 'secret' } },
        ]);
        // A subagent's calls are not the turn's own.
        yield assistant(
          [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } }],
          't9',
        );
        yield {
          type: 'user',
          session_id: 'expected',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
              { type: 'tool_result', tool_use_id: 't2', content: 'no such file', is_error: true },
              { type: 'tool_result', tool_use_id: 't3', content: 'found' },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'expected',
          result: 'done',
          usage: { input_tokens: 1 },
        };
      })(),
    ),
  });
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 't',
    sessionId: 's',
    dispatchId: 'd',
    providerSessionId: null,
    workspace: process.cwd(),
    stateDir: '/private/tmp/unused-claude-progress',
    model: 'offline',
    prompt: 'fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    ...(reportProgress ? { reportProgress } : {}),
  }))
    events.push(event);
  return events;
}

test('AC-0053-E03 the Claude adapter reports tool starts, text and retries of its main loop', async () => {
  const reported: RuntimeProgress[] = [];
  const events = await run((progress) => reported.push(progress));
  assert.equal(events.at(-1)?.type, 'result');
  // The adapter times each call from its start to its result.
  for (const progress of reported)
    if (progress.kind === 'tool_finished') {
      assert.ok(Number.isInteger(progress.durationMs) && progress.durationMs! >= 0);
      progress.durationMs = 0;
    }
  assert.deepEqual(reported, [
    {
      kind: 'api_retry',
      attempt: 2,
      maxRetries: 10,
      delayMs: 1200,
      status: 529,
      message: 'server_error',
    },
    { kind: 'thinking' },
    { kind: 'thinking' },
    { kind: 'assistant_text', text: 'Running the tests.' },
    { kind: 'tool_started', tool: 'Bash', command: 'npm test' },
    { kind: 'tool_started', tool: 'Edit', paths: ['/w/src/app.ts'] },
    { kind: 'tool_started', tool: 'lookup', server: 'docs' },
    { kind: 'tool_finished', tool: 'Bash', ok: true, durationMs: 0, exitCode: null },
    { kind: 'tool_finished', tool: 'Edit', ok: false, durationMs: 0, exitCode: null },
    { kind: 'tool_finished', tool: 'lookup', ok: true, durationMs: 0, exitCode: null },
  ]);
});

test('AC-0053-E03 without the callback the turn runs as before', async () => {
  const events = await run();
  assert.equal(events.at(-1)?.type, 'result');
});
