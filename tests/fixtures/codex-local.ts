import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// SPEC-0035: an owned app-server standing in for the user's Codex CLI. It logs what it was given
// to FIXTURE_LOG and plays what the FIXTURE_* variables describe:
// - FIXTURE_USER_AGENT: `initialize`'s userAgent (default a supported version);
// - FIXTURE_THREAD_DELAY_MS: time before answering thread/start or thread/resume;
// - FIXTURE_THREAD_FAIL_ONCE: the first thread/start fails with this message;
// - FIXTURE_EXEC_STDOUT / FIXTURE_EXEC_ERROR: the answer to command/exec;
// - FIXTURE_REQUESTS: server requests sent during the turn, JSON [{ method, params, item? }], whose
//   answers become the turn's final message;
// - FIXTURE_HOOK_TRUST: the trust hooks/list reports for the session hook (default untrusted);
// - FIXTURE_HOOK_EVENTS: PreToolUse inputs, JSON [{ tool_name, tool_input }], run through the hook
//   command the adapter configured, as Codex runs it; their outputs become the final message;
// - FIXTURE_ITEM_COMMAND: a command item started during the turn, which then waits for an interrupt.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (entry: Record<string, unknown>) => {
  if (process.env.FIXTURE_LOG)
    appendFileSync(
      process.env.FIXTURE_LOG,
      JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\n',
    );
};
log({
  event: 'spawn',
  args: process.argv.slice(2),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    ORCHVIA_HOST_MCP_TOKEN_0: process.env.ORCHVIA_HOST_MCP_TOKEN_0,
    HOST_SECRET: process.env.HOST_SECRET,
    ORCHVIA_HOOK_SOCKET: process.env.ORCHVIA_HOOK_SOCKET,
    ORCHVIA_HOOK_TOKEN: process.env.ORCHVIA_HOOK_TOKEN ? 'set' : undefined,
    ORCHVIA_STOP_MARKER: process.env.ORCHVIA_STOP_MARKER,
    ZDOTDIR: process.env.ZDOTDIR,
    BASH_ENV: process.env.BASH_ENV,
  },
});
// With a stop marker: whether each shell's commands hold it, and whether the user's own startup
// file still runs (it sets USER_STARTUP).
if (process.env.ORCHVIA_STOP_MARKER)
  log({
    event: 'shells',
    shells: Object.fromEntries(
      ['/bin/zsh', '/bin/bash'].map((shell) => {
        const run = spawnSync(
          shell,
          [
            '-c',
            'test -e /dev/fd/9 && echo held || echo none; echo "startup=${USER_STARTUP:-none}"',
          ],
          // Not a socket on stdin: bash then reads ~/.bashrc instead of BASH_ENV, taking itself
          // for a shell sshd started; Codex gives commands pipes or a terminal.
          { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return [shell, run.error ? 'missing' : run.stdout.trim().replace(/\n/g, ' ')];
      }),
    ),
  });
let failedOnce = false;
const requests = JSON.parse(process.env.FIXTURE_REQUESTS ?? '[]') as {
  method: string;
  params: Record<string, unknown>;
  item?: Record<string, unknown>;
}[];
const answers: unknown[] = [];
let answered = 0;
// The hook command the adapter passed with -c.
const hookCommand = (() => {
  const setting = process.argv.find((arg) => arg.startsWith('hooks.PreToolUse='));
  const match = setting ? /command=("(?:[^"\\]|\\.)*")/.exec(setting) : null;
  return match ? (JSON.parse(match[1]!) as string) : null;
})();
const hookOutputs = () =>
  (JSON.parse(process.env.FIXTURE_HOOK_EVENTS ?? '[]') as object[]).map((event) => {
    const run = spawnSync('/bin/sh', ['-c', hookCommand ?? 'false'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', ...event }),
      encoding: 'utf8',
      env: process.env,
    });
    return { status: run.status, stdout: run.stdout.trim() };
  });
let finished = false;
const finish = (status = 'completed') => {
  if (finished) return;
  finished = true;
  const text = process.env.FIXTURE_HOOK_EVENTS
    ? JSON.stringify(hookOutputs())
    : JSON.stringify(answers);
  send({
    method: 'item/completed',
    params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', text } },
  });
  send({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status } },
  });
};
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method) log({ event: 'request', method: value.method, params: value.params ?? null });
  if (value.method === 'initialize')
    send({
      id: value.id,
      result: {
        userAgent: process.env.FIXTURE_USER_AGENT ?? 'orchvia_test/0.157.1 (fixture)',
        codexHome: process.env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'fixture',
      },
    });
  else if (value.method === 'thread/start' || value.method === 'thread/resume') {
    if (process.env.FIXTURE_THREAD_FAIL_ONCE && !failedOnce) {
      failedOnce = true;
      send({
        id: value.id,
        error: { code: -32000, message: process.env.FIXTURE_THREAD_FAIL_ONCE },
      });
      continue;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.FIXTURE_THREAD_DELAY_MS ?? 0)),
    );
    log({ event: 'thread-opened' });
    send({ id: value.id, result: { thread: { id: 'thread' } } });
  } else if (value.method === 'command/exec') {
    if (process.env.FIXTURE_EXEC_ERROR)
      send({ id: value.id, error: { code: -32000, message: process.env.FIXTURE_EXEC_ERROR } });
    else
      send({
        id: value.id,
        result: { exitCode: 0, stdout: process.env.FIXTURE_EXEC_STDOUT ?? '', stderr: '' },
      });
  } else if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'turn' } } });
    if (process.env.FIXTURE_ITEM_COMMAND) {
      send({
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            type: 'commandExecution',
            id: 'cmd-1',
            command: process.env.FIXTURE_ITEM_COMMAND,
            status: 'inProgress',
          },
        },
      });
      setTimeout(() => finish(), 1500);
    } else if (!requests.length) finish();
    requests.forEach((request, index) => {
      if (request.item)
        send({
          method: 'item/started',
          params: { threadId: 'thread', turnId: 'turn', item: request.item },
        });
      send({ id: `request-${index}`, method: request.method, params: request.params });
    });
  } else if (value.method === 'turn/interrupt') {
    send({ id: value.id, result: {} });
    finish('interrupted');
  } else if (
    value.method === undefined &&
    typeof value.id === 'string' &&
    value.id.startsWith('request-')
  ) {
    answers[Number(value.id.slice('request-'.length))] = value.result;
    if (++answered === requests.length) finish();
  } else if (value.method === 'hooks/list')
    send({
      id: value.id,
      result: {
        data: hookCommand
          ? [
              {
                cwd: value.params?.cwds?.[0] ?? '',
                hooks: [
                  {
                    key: '/<session-flags>/config.toml:pre_tool_use:0:0',
                    eventName: 'preToolUse',
                    handlerType: 'command',
                    command: hookCommand,
                    source: 'sessionFlags',
                    currentHash: 'sha256:fixture',
                    trustStatus: process.env.FIXTURE_HOOK_TRUST ?? 'untrusted',
                  },
                ],
                warnings: [],
                errors: [],
              },
            ]
          : [],
      },
    });
  else if (value.method === 'config/batchWrite') send({ id: value.id, result: { status: 'ok' } });
  else if (value.method === 'model/list')
    send({
      id: value.id,
      result: {
        data: [
          { id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', isDefault: true },
        ],
        nextCursor: value.params?.cursor ? null : 'page-2',
      },
    });
  else if (value.method === 'account/read')
    send({ id: value.id, result: { account: null, requiresOpenaiAuth: true } });
  else if (value.method === 'account/rateLimits/read')
    send({
      id: value.id,
      error: { code: -32000, message: 'codex account authentication required to read rate limits' },
    });
  else if (value.method === 'account/logout') send({ id: value.id, result: {} });
  else if (value.method === 'account/login/start') {
    if (value.params?.type === 'apiKey') send({ id: value.id, result: { type: 'apiKey' } });
    else {
      send({
        id: value.id,
        result: {
          type: value.params?.type,
          loginId: 'login-1',
          authUrl: 'https://auth.example/login',
        },
      });
      if (process.env.FIXTURE_LOGIN_COMPLETES)
        setTimeout(
          () =>
            send({
              method: 'account/login/completed',
              params: { loginId: 'login-1', success: true },
            }),
          100,
        );
    }
  } else if (value.method === 'account/login/cancel') {
    send({ id: value.id, result: { status: 'canceled' } });
    send({ method: 'account/login/completed', params: { loginId: 'login-1', success: false } });
  } else if (value.id !== undefined && value.method) send({ id: value.id, result: {} });
}
