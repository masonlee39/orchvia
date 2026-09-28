import { createServer, createConnection, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { answerMcpMessage, toolErrorCode } from './mcp-server.ts';
import { ORCHESTRATION_TOOLS, TOOL_NAMES, type RuntimeTools } from './tools.ts';
import type { Json } from './types.ts';

const MAX_FRAME = 1_048_576;
type BridgeEnv = { AGENT_ORCH_BRIDGE_TOKEN: string; AGENT_ORCH_BRIDGE_SOCKET: string };
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** One credential, one dispatch, one bounded request per connection. No public listener. */
export async function createToolBridge(tools: RuntimeTools, signal: AbortSignal) {
  if (signal.aborted) throw failure('STALE_GRANT');
  // A short socket path is necessary on macOS; this directory is always mode 0700.
  const directory = await mkdtemp('/tmp/ao-');
  await chmod(directory, 0o700);
  const path = join(directory, 's');
  const token = randomBytes(32).toString('hex');
  let revoked = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (revoked || sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      if (received) {
        socket.destroy();
        return;
      }
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        try {
          const value: unknown = JSON.parse(buffer.slice(0, end));
          if (
            !object(value) ||
            typeof value.token !== 'string' ||
            value.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(value.token), Buffer.from(token))
          )
            throw failure('UNAUTHORIZED');
          if (revoked || signal.aborted) throw failure('STALE_GRANT');
          if (
            typeof value.name !== 'string' ||
            !TOOL_NAMES.includes(value.name as (typeof TOOL_NAMES)[number])
          )
            throw failure('UNKNOWN_TOOL');
          const result = await tools.call(value.name, value.request);
          const frame = JSON.stringify({ result });
          if (Buffer.byteLength(frame) > MAX_FRAME) throw failure('RESULT_LIMIT');
          socket.end(frame + '\n');
        } catch (error) {
          // Never echo private connection data or a callback exception into model-visible text.
          socket.end(JSON.stringify({ error: toolErrorCode(error) }) + '\n');
        }
      })();
    });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    revoked = true;
    signal.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve) => server.close(() => resolve())).then(() =>
      rm(directory, { recursive: true, force: true }),
    );
    return closing;
  };
  const abort = () => {
    void close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await close();
      throw failure('STALE_GRANT');
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    env: { AGENT_ORCH_BRIDGE_TOKEN: token, AGENT_ORCH_BRIDGE_SOCKET: path } satisfies BridgeEnv,
    close,
  };
}

export async function callToolBridge(
  env: BridgeEnv,
  name: string,
  request: unknown,
): Promise<Json> {
  const frame = JSON.stringify({ token: env.AGENT_ORCH_BRIDGE_TOKEN, name, request }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME) throw failure('REQUEST_LIMIT');
  if (!env.AGENT_ORCH_BRIDGE_TOKEN || !env.AGENT_ORCH_BRIDGE_SOCKET) throw failure('UNAUTHORIZED');
  return new Promise((resolve, reject) => {
    const socket = createConnection(env.AGENT_ORCH_BRIDGE_SOCKET);
    let done = false,
      buffer = '';
    const finish = (error?: Error, value?: Json) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? null);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => finish(failure('BRIDGE_TIMEOUT')));
    socket.on('connect', () => socket.write(frame));
    socket.on('error', () => finish(failure('BRIDGE_UNAVAILABLE')));
    socket.on('close', () => finish(failure('BRIDGE_UNAVAILABLE')));
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        finish(failure('RESULT_LIMIT'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, end));
        if (value.error) finish(failure(value.error));
        else finish(undefined, value.result);
      } catch {
        finish(failure('INVALID_BRIDGE_RESPONSE'));
      }
    });
  });
}

export async function runToolBridge(): Promise<void> {
  const env = {
    AGENT_ORCH_BRIDGE_TOKEN: process.env.AGENT_ORCH_BRIDGE_TOKEN ?? '',
    AGENT_ORCH_BRIDGE_SOCKET: process.env.AGENT_ORCH_BRIDGE_SOCKET ?? '',
  };
  // Keep credentials only in this closure, not inherited by any later child.
  delete process.env.AGENT_ORCH_BRIDGE_TOKEN;
  delete process.env.AGENT_ORCH_BRIDGE_SOCKET;
  let buffer = '';
  for await (const data of process.stdin) {
    buffer += data.toString('utf8');
    if (Buffer.byteLength(buffer) > MAX_FRAME) throw failure('REQUEST_LIMIT');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(line);
        if (!object(decoded)) throw failure('INVALID_REQUEST');
        value = decoded;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Invalid JSON' },
          }) + '\n',
        );
        continue;
      }
      const answer = await answerMcpMessage(value, ORCHESTRATION_TOOLS, (name, request) =>
        callToolBridge(env, name, request),
      );
      if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
    }
  }
}

/** Whether this module is the program, also when it was started through a symbolic link. */
function isProgram(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isProgram()) {
  runToolBridge().catch(() => {
    process.stderr.write('Tool bridge stopped\n');
    process.exitCode = 1;
  });
}
