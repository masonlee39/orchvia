import { connect } from 'node:net';

// SPEC-0035 R01: Codex runs this program before each tool call as its PreToolUse hook, outside the
// command sandbox. It hands the call to the adapter over the dispatch's private socket and tells
// Codex to refuse it unless the host allows it; anything that goes wrong refuses it too.

const WAIT_MS = 590_000;

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}
function deny(reason: string): void {
  print({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

async function ask(event: unknown): Promise<{ allow?: unknown; reason?: unknown }> {
  const path = process.env.ORCHVIA_HOOK_SOCKET;
  const token = process.env.ORCHVIA_HOOK_TOKEN;
  if (!path || !token) throw new Error('no channel to the host');
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the host did not answer'));
    }, WAIT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token, event }) + '\n'));
    socket.on('data', (data: string) => {
      buffer += data;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('the host closed the channel'));
    });
  });
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const answer = await ask(JSON.parse(raw || '{}'));
  if (answer.allow !== true)
    deny(typeof answer.reason === 'string' && answer.reason ? answer.reason : 'The host refused');
} catch (error) {
  deny(`Orchvia could not ask the host: ${error instanceof Error ? error.message : String(error)}`);
}
