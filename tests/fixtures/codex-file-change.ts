import { createInterface } from 'node:readline';

// SPEC-0038: an owned app-server that proposes one file change and asks to approve it, as Codex
// does: the item with its paths first, then the request, which names only the item. FIXTURE_CHANGES
// holds the item's changes; FIXTURE_NO_ITEM leaves the item out.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const changes = JSON.parse(process.env.FIXTURE_CHANGES ?? '[]');
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start')
    send({ id: value.id, result: { thread: { id: 'thread' } } });
  else if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'turn' } } });
    const item = { type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' };
    if (!process.env.FIXTURE_NO_ITEM)
      send({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item } });
    send({
      id: 'permission',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'patch-1', reason: null },
    });
  } else if (value.id === 'permission' && value.result) {
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'agentMessage', text: value.result.decision },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    });
  }
}
