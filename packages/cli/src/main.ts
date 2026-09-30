#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, openReadOnlyEngine } from '../../engine/src/index.ts';
import type { CloseOptions } from '../../engine/src/types.ts';
import { connectOrchestrator } from '../../sdk-typescript/src/index.ts';
import { doctor } from './doctor.ts';
import { observeTask } from './observe.ts';
import { engineConfig, loadConfig } from './config.ts';
import { OWNER_EOF_TIMEOUT_MS, startStdioHost, startUnixHost } from './host.ts';

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function flags(args: string[], allowed: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2)))
      fail('INVALID_ARGUMENT', `Unknown argument: ${name}`);
    const key = name.slice(2);
    if (key in result) fail('INVALID_ARGUMENT', `Duplicate argument: ${name}`);
    if (['stdio', 'interactive', 'follow', 'read-only'].includes(key)) result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', `Missing value for ${name}`);
      result[key] = value;
    }
  }
  return result;
}
function required(options: Record<string, string | true>, key: string) {
  if (typeof options[key] !== 'string') fail('INVALID_ARGUMENT', `--${key} is required`);
  return options[key] as string;
}
function print(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

/**
 * Takes the host's stop signals before it accepts connections (SPEC-0023 S01). A signal that arrives
 * while the host starts is kept, and the host shuts down in order once `attach` gives it the close
 * action (S03).
 */
function hostSignals() {
  let target:
    | { close: (options: CloseOptions) => Promise<void>; options: CloseOptions }
    | undefined;
  let requested = false;
  let stopping = false;
  let operationId: string | undefined;
  const stop = () => {
    requested = true;
    if (!target || stopping) return;
    stopping = true;
    target
      .close({ ...target.options, ...(operationId ? { operationId } : {}) })
      .catch((error) => {
        const pendingId =
          error.operationId ?? error.details?.operationId ?? error.data?.operationId;
        if (typeof pendingId === 'string') operationId = pendingId;
        console.error(
          JSON.stringify({
            code: error.code ?? 'SHUTDOWN_FAILED',
            message: error.message,
            ...(operationId ? { operationId } : {}),
          }),
        );
      })
      .finally(() => {
        stopping = false;
      });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // SPEC-0023 P05: Claude processes lead their own groups, so a closing terminal reaches only the host.
  process.on('SIGHUP', stop);
  return {
    /** A stop signal arrived, and the host must not announce that it is ready (S02). */
    get requested() {
      return requested;
    },
    attach(close: (options: CloseOptions) => Promise<void>, options: CloseOptions) {
      target = { close, options };
      if (requested) stop();
    },
    remove() {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGHUP', stop);
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'tool-bridge') {
    if (args.length)
      fail('INVALID_ARGUMENT', 'tool-bridge uses only its private inherited binding');
    await (await import('../../engine/src/tool-bridge.ts')).runToolBridge();
    return;
  }
  if (command === '--help' || command === 'help') {
    process.stdout.write(
      'orchvia host --config FILE [--stdio | --socket PATH]\norchvia host --read-only --state-dir DIR --stdio\norchvia doctor --config FILE | --socket PATH\norchvia submit --socket PATH --task FILE [--idempotency-key KEY]\norchvia status --socket PATH --task TASK_ID\norchvia run --socket PATH --task FILE [--interactive] [--follow] [--timeout-ms N] [--idempotency-key KEY]\norchvia attach --socket PATH --task TASK_ID [--interactive] [--follow] [--after-cursor N] [--timeout-ms N]\norchvia control --socket PATH --target FILE --action pause|resume|stop|compact|rotate [--mode drain|interrupt] [--idempotency-key KEY]\norchvia approve --socket PATH --approval ID --revision N --decision approve|deny [--idempotency-key KEY]\norchvia --version\n',
    );
    return;
  }
  if (command === '--version') {
    // The CLI package's own manifest: packages/cli/package.json, or the package root for dist/main.js.
    const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    process.stdout.write(`${JSON.parse(manifest).version}\n`);
    return;
  }
  if (command === 'host') {
    const options = flags(args, ['config', 'stdio', 'socket', 'read-only', 'state-dir']);
    if (options.stdio && options.socket)
      fail('INVALID_ARGUMENT', '--stdio and --socket are mutually exclusive');
    // Runtime diagnostics must never corrupt the stdio wire stream.
    console.log = console.info = console.debug = (...values: unknown[]) => console.error(...values);
    if (options['read-only'] || options['state-dir'] !== undefined) {
      // SPEC-0027 R09: read a store over stdio without a configuration or an engine.
      if (!options['read-only']) fail('INVALID_ARGUMENT', '--state-dir needs --read-only');
      if (options.config !== undefined || options.socket !== undefined || !options.stdio)
        fail('INVALID_ARGUMENT', '--read-only takes --state-dir and --stdio only');
      const stateDir = required(options, 'state-dir');
      if (!isAbsolute(stateDir)) fail('INVALID_ARGUMENT', '--state-dir must be an absolute path');
      const reader = await openReadOnlyEngine({ stateDir });
      const signals = hostSignals();
      try {
        const connection = startStdioHost(reader);
        signals.attach(connection.shutdown, {});
        await connection.closed;
      } finally {
        signals.remove();
        await reader.close();
      }
      return;
    }
    const config = await loadConfig(required(options, 'config'));
    const socketPath =
      typeof options.socket === 'string' ? options.socket : config.transport?.socketPath;
    const stdio = options.stdio === true || (!options.socket && config.transport?.mode === 'stdio');
    if (!stdio && !socketPath)
      fail('INVALID_ARGUMENT', 'Use --stdio, --socket PATH, or configure transport.socketPath');
    const engine = await createEngine({
      ...(await engineConfig(config)),
      // SPEC-0027 F03: one line when an internal failure stops the engine.
      onFatal: (failure) =>
        process.stderr.write(
          JSON.stringify({
            code: 'SCHEDULER_FAILED',
            message: `The engine stopped after ${failure.step} failed`,
            failure,
          }) + '\n',
        ),
    });
    const shutdown = {
      mode: config.shutdown?.mode ?? 'interrupt',
      timeoutMs: config.shutdown?.timeoutMs ?? (stdio ? OWNER_EOF_TIMEOUT_MS : 1000),
    } satisfies CloseOptions;
    // Until here a stop signal ends the process like a crash during startup: no client can connect
    // yet, and recovery dispatches nothing. From here it shuts the host down in order (SPEC-0023 S).
    const signals = hostSignals();
    try {
      if (stdio) {
        const connection = startStdioHost(engine);
        signals.attach(connection.shutdown, shutdown);
        await connection.closed;
      } else {
        const host = await startUnixHost(engine, { socketPath: socketPath! });
        signals.attach(host.close, shutdown);
        if (!signals.requested) process.stderr.write(`orchvia listening on ${socketPath}\n`);
        await host.closed;
      }
    } catch (error) {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      throw error;
    } finally {
      signals.remove();
    }
    return;
  }
  if (!['doctor', 'status', 'submit', 'approve', 'run', 'attach', 'control'].includes(command))
    fail('UNSUPPORTED_COMMAND', `Unknown command: ${command ?? '(missing)'}`);
  const allowed =
    command === 'doctor'
      ? ['config', 'socket']
      : command === 'status'
        ? ['socket', 'task']
        : command === 'submit'
          ? ['socket', 'task', 'idempotency-key']
          : command === 'run' || command === 'attach'
            ? [
                'socket',
                'task',
                'idempotency-key',
                'interactive',
                'follow',
                'timeout-ms',
                'after-cursor',
              ]
            : command === 'control'
              ? ['socket', 'target', 'action', 'mode', 'idempotency-key']
              : ['socket', 'approval', 'revision', 'decision', 'idempotency-key'];
  const options = flags(args, allowed);
  if (command === 'doctor' && options.config) {
    if (options.socket) fail('INVALID_ARGUMENT', 'doctor accepts either --config or --socket');
    const config = await loadConfig(required(options, 'config'));
    const result = await doctor(config);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const client = await connectOrchestrator({ socketPath: required(options, 'socket') });
  try {
    if (command === 'doctor') print({ ok: true, ...client.info, runtimeAcceptance: 'not_run' });
    else if (command === 'status') print(await client.tasks.get(required(options, 'task')));
    else if (command === 'control') {
      const target = JSON.parse(await readFile(required(options, 'target'), 'utf8'));
      const action = required(options, 'action');
      if (!['pause', 'resume', 'stop', 'compact', 'rotate'].includes(action))
        fail('INVALID_ARGUMENT', 'Unsupported control action');
      const mode = options.mode;
      if (mode !== undefined && !['drain', 'interrupt'].includes(String(mode)))
        fail('INVALID_ARGUMENT', 'Invalid control mode');
      const mutation = {
        idempotencyKey:
          typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
      };
      const operation =
        action === 'compact'
          ? await client.sessions.compact(target, mutation)
          : action === 'rotate'
            ? await client.sessions.rotate(target, mutation)
            : await client.sessions.control(
                target,
                {
                  action: action as 'pause' | 'resume' | 'stop',
                  ...(mode ? { mode: mode as 'drain' | 'interrupt' } : {}),
                },
                mutation,
              );
      print(operation.initial);
    } else if (command === 'run' || command === 'attach') {
      const timeoutMs = Number(options['timeout-ms'] ?? 300000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000)
        fail('INVALID_ARGUMENT', 'timeout-ms must be 1..86400000');
      if (options.interactive && (!process.stdin.isTTY || !process.stdout.isTTY))
        fail('INTERACTIVE_TERMINAL_REQUIRED', '--interactive requires a terminal');
      let taskId = required(options, 'task');
      if (command === 'run') {
        const spec = JSON.parse(await readFile(taskId, 'utf8'));
        const task = await client.tasks.create(spec, {
          idempotencyKey:
            typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
        });
        print({ kind: 'task', task: task.initial });
        taskId = task.id;
      }
      await observeTask(
        client,
        taskId,
        {
          interactive: options.interactive === true,
          follow: options.follow === true,
          timeoutMs,
          ...(typeof options['after-cursor'] === 'string'
            ? { afterCursor: options['after-cursor'] }
            : {}),
        },
        print,
      );
    } else if (command === 'submit') {
      const spec = JSON.parse(await readFile(required(options, 'task'), 'utf8'));
      const task = await client.tasks.create(spec, {
        idempotencyKey:
          typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
      });
      print(task.initial);
    } else {
      const decision = required(options, 'decision');
      if (decision !== 'approve' && decision !== 'deny')
        fail('INVALID_ARGUMENT', '--decision must be approve or deny');
      const revision = Number(required(options, 'revision'));
      if (!Number.isSafeInteger(revision) || revision < 0)
        fail('INVALID_ARGUMENT', '--revision must be a non-negative integer');
      const operation = await client.approvals.decide(
        required(options, 'approval'),
        { choice: decision, expectedRevision: revision },
        {
          idempotencyKey:
            typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
        },
      );
      print(operation.initial);
    }
  } finally {
    await client.close();
  }
}

// npm installs the command as a symbolic link to this file (SPEC-0051 B01).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        code: error.code ?? 'CLI_ERROR',
        message: error.message,
        ...(error.retryIdentity ? { retryIdentity: error.retryIdentity } : {}),
        ...(error.details ? { details: error.details } : {}),
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
