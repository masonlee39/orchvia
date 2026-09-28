import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { descendantsOf, endProcesses } from '../../engine/src/process-tree.ts';

// The JSON-RPC connection to one owned Codex app-server child, shared by dispatches, inspection
// and the connection API (SPEC-0035 C).

export type Message = Record<string, unknown>;
export function record(value: unknown): Message | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Message)
    : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MessageQueue {
  static readonly limit = 256;
  private values: (Message | null)[] = [];
  private waiting: {
    resolve: (value: Message | null) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  } | null = null;
  private ended = false;
  push(value: Message | null): boolean {
    if (this.ended) return true;
    if (value === null) this.ended = true;
    if (this.waiting) {
      const { resolve, timer } = this.waiting;
      this.waiting = null;
      if (timer) clearTimeout(timer);
      resolve(value);
    } else if (value !== null) {
      if (this.values.length >= MessageQueue.limit) return false;
      this.values.push(value);
    }
    return true;
  }
  async next(remainingMs: () => number): Promise<Message | null> {
    if (this.values.length > 0) return this.values.shift() ?? null;
    if (this.ended) return null;
    return new Promise((resolve, reject) => {
      const waiting: NonNullable<MessageQueue['waiting']> = { resolve, reject };
      const check = () => {
        if (this.waiting !== waiting) return;
        try {
          const remaining = remainingMs();
          if (remaining <= 0) throw new Error('Codex app-server response timed out');
          waiting.timer = setTimeout(check, Math.max(1, remaining));
        } catch (error) {
          this.waiting = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      this.waiting = waiting;
      check();
    });
  }
}

export class AppServerConnection {
  private child: ChildProcessWithoutNullStreams;
  private queue = new MessageQueue();
  private deferred: Message[] = [];
  private nextId = 0;
  private protocolError: string | null = null;
  private exited: Promise<void>;
  private exitConfirmed = false;
  private shutdownRequested = false;
  private closing: Promise<boolean> | null = null;
  private remainingRequestMs: () => number;
  private closeTimeoutMs: number;
  constructor(
    child: ChildProcessWithoutNullStreams,
    timeouts: { remainingRequestMs: () => number; closeTimeoutMs: number },
    onExit: () => void,
  ) {
    this.child = child;
    this.remainingRequestMs = timeouts.remainingRequestMs;
    this.closeTimeoutMs = timeouts.closeTimeoutMs;
    this.exited = new Promise((resolve) => {
      const confirmExit = () => {
        this.exitConfirmed = true;
        resolve();
        onExit();
      };
      child.once('exit', confirmExit);
      child.once('error', () => {
        if (child.pid === undefined) confirmExit();
      });
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        if (lineEnd > 1_048_576) {
          this.protocolError = 'Codex app-server frame exceeds 1 MiB';
          child.kill();
          return;
        }
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        try {
          const message = record(JSON.parse(line));
          if (!message) throw new Error('non-object message');
          if (!this.queue.push(message)) {
            this.protocolError = 'Codex app-server queue limit exceeded';
            this.queue.push(null);
            child.kill();
            return;
          }
        } catch {
          this.protocolError = 'Codex app-server emitted invalid JSON';
          child.kill();
          return;
        }
      }
      if (buffer.length > 1_048_576) {
        this.protocolError = 'Codex app-server frame exceeds 1 MiB';
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', (error) => {
      this.protocolError = error.message;
      this.queue.push(null);
    });
    child.on('error', (error) => {
      this.protocolError = error.message;
      this.queue.push(null);
    });
    child.on('close', () => this.queue.push(null));
  }
  send(method: string, params?: Message): number {
    if (this.shutdownRequested || this.exitConfirmed)
      throw new Error('Codex app-server connection is closed');
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ method, id, ...(params ? { params } : {}) }) + '\n');
    return id;
  }
  notify(method: string, params: Message = {}): void {
    if (this.shutdownRequested || this.exitConfirmed)
      throw new Error('Codex app-server connection is closed');
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  respond(id: unknown, result: Message): void {
    if (this.shutdownRequested || this.exitConfirmed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  async request(method: string, params?: Message, onSent?: () => void): Promise<Message> {
    if (this.remainingRequestMs() <= 0) throw new Error('Codex app-server response timed out');
    const id = this.send(method, params);
    onSent?.();
    while (true) {
      const remaining = this.remainingRequestMs();
      if (remaining <= 0) throw new Error('Codex app-server response timed out');
      const message = await this.queue.next(this.remainingRequestMs);
      if (!message) throw new Error(this.protocolError ?? 'Codex app-server disconnected');
      if (message.method !== undefined || message.id !== id) {
        if (this.deferred.length >= MessageQueue.limit)
          throw new Error('Codex app-server queue limit exceeded');
        this.deferred.push(message);
        continue;
      }
      if (message.error) {
        const failure = record(message.error);
        throw new Error(
          typeof failure?.message === 'string' ? failure.message : `${method} failed`,
        );
      }
      const result = record(message.result);
      if (!result) throw new Error(`${method} returned invalid result`);
      return result;
    }
  }
  async next(remainingTurnMs: () => number): Promise<Message | null> {
    const remaining = remainingTurnMs();
    if (remaining <= 0) throw new Error('Codex app-server turn terminal timed out');
    return this.deferred.shift() ?? (await this.queue.next(remainingTurnMs));
  }
  failure(): string | null {
    return this.protocolError;
  }
  hasActiveResources(): boolean {
    return !this.exitConfirmed;
  }
  close(): Promise<boolean> {
    if (this.exitConfirmed) return Promise.resolve(true);
    if (this.closing) return this.closing;
    this.shutdownRequested = true;
    this.deferred = [];
    this.queue.push(null);
    const closing = this.stop();
    this.closing = closing;
    void closing.then(
      () => {
        if (this.closing === closing) this.closing = null;
      },
      () => {
        if (this.closing === closing) this.closing = null;
      },
    );
    return this.closing;
  }
  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitConfirmed) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  private async stop(): Promise<boolean> {
    // SPEC-0034 A03: the commands the app-server started run in groups of their own and outlive
    // it, so they are listed before it exits and ended after.
    const started = this.child.pid === undefined ? [] : descendantsOf(this.child.pid);
    const exited = await this.stopServer();
    await endProcesses(started, this.closeTimeoutMs);
    return exited;
  }
  private async stopServer(): Promise<boolean> {
    this.child.stdin.end();
    if (await this.waitForExit(0)) return true;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(this.closeTimeoutMs)) return true;
    this.child.kill('SIGKILL');
    return this.waitForExit(this.closeTimeoutMs);
  }
}
