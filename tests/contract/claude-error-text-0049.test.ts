import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0049 E01: a Claude result that is an error keeps its own text as the error message.

async function terminal(result: Record<string, unknown>) {
  const adapter = createClaudeAdapter({
    // A loaded runner may take longer to end the process; the text must not depend on it.
    cleanupTimeoutMs: 5000,
    query: withClaudeProcess(() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'expected' };
        yield { type: 'result', session_id: 'expected', usage: { input_tokens: 1 }, ...result };
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
    stateDir: '/private/tmp/unused-claude-error-text',
    model: 'offline',
    prompt: 'fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>;
}

test('AC-0049-E01 an API error reported as a success with is_error keeps its text', async () => {
  const last = await terminal({
    subtype: 'success',
    is_error: true,
    result: 'API Error: Connection lost mid-response',
  });
  assert.equal(last.type, 'error');
  // The adapter may add a note on cleanup; the error's own text comes first.
  assert.match(last.message, /^API Error: Connection lost mid-response/);
  assert.equal(last.outcome, 'failed');
});

test('AC-0049-E01 errors, when given, still come first; without either, the subtype', async () => {
  const listed = await terminal({
    subtype: 'success',
    is_error: true,
    errors: ['rate limited', 'retry later'],
    result: 'API Error: 429',
  });
  assert.match(listed.message, /^rate limited; retry later/);
  const bare = await terminal({ subtype: 'error_max_turns' });
  assert.match(bare.message, /^error_max_turns/);
});
