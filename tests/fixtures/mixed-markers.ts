import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';

// SPEC-0039 M: a Claude and a Codex member of one process marking under one host directory, each
// running a dispatch that leaves `sleep 60` in the background and then waits.

const BACKGROUND = 'sleep 60 >/dev/null 2>&1 & echo $!';
const codexFixture = fileURLToPath(new URL('./codex-local.ts', import.meta.url));

// A Claude stand-in that runs one command through the shell prefix, as the Bash tool does.
const CLAUDE = String.raw`
const { spawnSync } = require('node:child_process');
const [prefix, command] = process.argv.slice(1);
const run = spawnSync(prefix, [command], { encoding: 'utf8' });
process.stdout.write(JSON.stringify({ pid: Number(run.stdout.trim()) }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

export async function mixedMembers(root: string, base: string) {
  const dirs = Object.fromEntries(
    ['claude-ws', 'claude-state', 'codex-ws', 'codex-state', 'codex-home', 'user'].map((name) => [
      name,
      join(base, name),
    ]),
  );
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = join(base, 'codex.log');
  let claudePid: Promise<number>;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const claude = createClaudeAdapter({
    permissionProfile: 'workspace-write',
    cleanupTimeoutMs: 15000,
    stopMarker: { directory: root },
    query: (request: ClaudeQueryRequest) => {
      const env = (request.options as unknown as { env?: Record<string, string> }).env ?? {};
      const child = request.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ['-e', CLAUDE, env.CLAUDE_CODE_SHELL_PREFIX ?? '/nonexistent', BACKGROUND],
        cwd: request.options.cwd,
        env: {},
        signal: new AbortController().signal,
      });
      claudePid = new Promise<number>((resolve) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]!).pid);
        });
      });
      return {
        close() {
          child.stdin.end();
        },
        async *[Symbol.asyncIterator]() {
          await claudePid;
          yield { type: 'system', subtype: 'init', session_id: 'native' };
          await held;
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  } as unknown as ClaudeAdapterConfig);
  const codex = createCodexAdapter({
    command: process.execPath,
    args: [codexFixture],
    env: { HOME: dirs.user!, FIXTURE_LOG: log, FIXTURE_BACKGROUND: BACKGROUND },
    connection: { home: dirs['codex-home']! },
    stopMarker: { directory: root },
    closeTimeoutMs: 15000,
  });
  const abort = new AbortController();
  const drain = async (events: AsyncIterable<RuntimeEvent>) => {
    const seen: RuntimeEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  };
  const input = (name: string, signal: AbortSignal) => ({
    taskId: `task-${name}`,
    sessionId: `session-${name}`,
    dispatchId: `dispatch-${name}`,
    providerSessionId: null,
    model: 'fixture',
    prompt: 'offline fixture',
    permissionProfile: 'workspace-write' as const,
    workspace: dirs[`${name}-ws`]!,
    stateDir: dirs[`${name}-state`]!,
    signal,
    reportExecutionEvidence: () => {},
  });
  const done = Promise.all([
    drain(claude.execute(input('claude', new AbortController().signal))),
    drain(codex.execute(input('codex', abort.signal))),
  ]);
  done.catch(() => {});
  const codexPid = async () => {
    for (let i = 0; i < 600; i++) {
      if (existsSync(log)) {
        const line = readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((text) => JSON.parse(text))
          .find((entry) => entry.event === 'background');
        if (line) return line.pid as number;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the Codex member never started its command');
  };
  return {
    claude,
    codex,
    async pids() {
      const codex = await codexPid();
      for (let i = 0; i < 600 && !claudePid; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return { claude: await claudePid, codex };
    },
    /** Lets both dispatches end. */
    async finish() {
      release();
      abort.abort();
      const results = await done;
      await Promise.all([claude.close?.(), codex.close?.()]);
      return results;
    },
  };
}
