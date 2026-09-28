import { createInterface } from 'node:readline';

// SPEC-0035 J01: an owned app-server that, like Codex 0.153.4 and 0.157.1, sends the thread's
// previous usage again at the start of a compaction on a resumed thread, under the compaction's
// own turn, before the compaction request's usage.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const usage = (lastInput: number, totalInput: number, requests: number) => ({
  last: {
    inputTokens: lastInput,
    cachedInputTokens: 0,
    outputTokens: 10,
    totalTokens: lastInput + 10,
  },
  total: {
    inputTokens: totalInput,
    cachedInputTokens: 0,
    outputTokens: 10 * requests,
    totalTokens: totalInput + 10 * requests,
  },
});
const done = (turnId: string, item: unknown) => {
  send({ method: 'item/completed', params: { threadId: 'thread', turnId, item } });
  send({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } },
  });
};
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start' || value.method === 'thread/resume')
    send({ id: value.id, result: { thread: { id: 'thread' } } });
  else if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'turn-1' } } });
    send({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread', turnId: 'turn-1', tokenUsage: usage(1000, 1000, 1) },
    });
    done('turn-1', { type: 'agentMessage', text: 'first' });
  } else if (value.method === 'thread/compact/start') {
    send({ id: value.id, result: {} });
    send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'compact-1' } } });
    // The previous usage again, now under the compaction's turn.
    send({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread', turnId: 'compact-1', tokenUsage: usage(1000, 1000, 1) },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread', turnId: 'compact-1', tokenUsage: usage(2000, 3000, 2) },
    });
    done('compact-1', { type: 'contextCompaction', id: 'compaction' });
  }
}
