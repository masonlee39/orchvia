import type {
  ExecutionEvidence,
  Json,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  RuntimeTerminalEvent,
  RuntimeProgress,
  RuntimeUsageEvent,
} from '../../engine/src/types.ts';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { observeRuntimeStop, requireStopProof } from '../../engine/src/stop-observation.ts';
import {
  StopMarkers,
  type StopMarkerObservation,
  type StopMarkerAcknowledgeOptions,
  type StopMarkerAcknowledgement,
  type StopMarkerSyncResult,
} from '../../engine/src/stop-marker.ts';
import { existsSync } from 'node:fs';
import { adapterProviderName } from '../../engine/src/runtime.ts';
import {
  buildClaudeOptions,
  claudeReadPolicy,
  copyClaudeOptions,
  validateClaudeOptions,
} from './options.ts';
import { createClaudeMcpServer } from './mcp.ts';
import { inspectClaudeSession } from './inspection.ts';
export { createClaudeMcpServer, type ClaudeMcpDependencies } from './mcp.ts';
export { inspectClaudeSession, type ClaudeInspectionDependencies } from './inspection.ts';
export { processGroupsStopped } from './process-groups.ts';
export {
  acknowledgeStopMarkers,
  endStopMarkersSync,
  sweepStopMarkers,
  staleStopMarkers,
  type StopMarkerAcknowledgeOptions,
  type StopMarkerAcknowledgement,
  type StopMarkerRootSyncResult,
  type StopMarkerDispatch,
  type StopMarkerObservation,
  type StopMarkerReason,
  type StopMarkerSweep,
  type StopMarkerSweepOptions,
  type StopMarkerSyncResult,
} from '../../engine/src/stop-marker.ts';
import { killProcessGroup, signalProcessGroup } from './process-groups.ts';
import type {
  ClaudeAdapterConfig,
  ClaudeHostOptions,
  ClaudeQuery,
  ClaudeQueryFactory,
  ClaudeQueryRequest,
  ClaudeSpawnOptions,
  ClaudeUserMessage,
} from './options.ts';
export type {
  ClaudeAdapterConfig,
  ClaudeHostOptions,
  ClaudeOptionsContext,
  ClaudeOwnedOption,
  ClaudePolicyOptions,
  ClaudeQuery,
  ClaudeQueryFactory,
  ClaudeQueryRequest,
  ClaudeSpawnOptions,
  ClaudeUserMessage,
} from './options.ts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * The calls of a result's query outside its main loop, one observation per model (SPEC-0031 A02 to
 * A04): the result's `modelUsage` minus the main loop's `usage` of the same result. A dispatch runs
 * one query with one user message, so both cover this dispatch alone.
 */
function outsideUsage(
  dispatchId: string,
  model: string,
  main: RecordValue | null,
  models: RecordValue | null,
  /** SPEC-0032 A01: each key's counts for this dispatch alone, when the result's continue. */
  own?: Record<string, (number | null)[]>,
): RuntimeUsageEvent[] {
  const keys = models ? Object.keys(models) : [];
  if (!models || !keys.length) return [];
  const id = (key: string) =>
    `${dispatchId}:outside:${
      key.length <= 128
        ? key
        : `sha256-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
    }`;
  const unknown = (usageId: string, raw: unknown, name?: string): RuntimeUsageEvent => ({
    type: 'usage',
    usageId,
    usage: {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      ...(name ? { model: name } : {}),
      raw: raw as Json,
    },
  });
  const canonical = (key: string) => {
    const value = record(models[key])?.canonicalModel;
    return typeof value === 'string' && value ? value : undefined;
  };
  const byCanonical = keys.filter((key) => canonical(key) === model);
  const mainKey = keys.includes(model)
    ? model
    : byCanonical.length === 1
      ? byCanonical[0]
      : keys.length === 1
        ? keys[0]
        : undefined;
  if (mainKey === undefined) return [unknown(`${dispatchId}:outside:unknown`, models)];
  const events: RuntimeUsageEvent[] = [];
  for (const key of keys) {
    const entry = record(models[key]);
    // The main model's calls keep the dispatch's model, as its main loop's do (A03).
    const name = key === mainKey ? undefined : (canonical(key) ?? key);
    const counts =
      own?.[key] ??
      [
        entry?.inputTokens,
        entry?.cacheReadInputTokens,
        entry?.cacheCreationInputTokens,
        entry?.outputTokens,
      ].map(nonnegativeInt);
    const loop =
      key === mainKey
        ? [
            main?.input_tokens,
            main?.cache_read_input_tokens,
            main?.cache_creation_input_tokens,
            main?.output_tokens,
          ].map(nonnegativeInt)
        : [0, 0, 0, 0];
    if (
      counts.some((count) => count === null) ||
      loop.some((count) => count === null) ||
      counts.some((count, index) => count! < loop[index]!)
    ) {
      events.push(unknown(id(key), models[key], name));
      continue;
    }
    const rest = counts.map((count, index) => count! - loop[index]!);
    if (rest.every((count) => count === 0)) continue;
    events.push({
      type: 'usage',
      usageId: id(key),
      usage: {
        inputTokens: rest[0],
        cachedInputTokens: rest[1],
        cacheWriteInputTokens: rest[2],
        outputTokens: rest[3],
        ...(name ? { model: name } : {}),
        raw: models[key] as Json,
      },
    });
  }
  return events;
}
/** Claude Code 2.1.277 and later continue a resumed or forked session's totals (SPEC-0032 A01). */
function continuesTotals(version: string | undefined): boolean | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major !== 2 ? major > 2 : minor !== 1 ? minor > 1 : patch >= 277;
}
/** Each key's four counts, in the order of an outside observation; undefined when any is missing. */
function modelTotals(models: RecordValue | null): Record<string, number[]> | undefined {
  if (!models || !Object.keys(models).length || Object.keys(models).length > 64) return undefined;
  const totals: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(models)) {
    const entry = record(value);
    const counts = [
      entry?.inputTokens,
      entry?.cacheReadInputTokens,
      entry?.cacheCreationInputTokens,
      entry?.outputTokens,
    ].map(nonnegativeInt);
    if (counts.some((count) => count === null)) return undefined;
    totals[key] = counts as number[];
  }
  return totals;
}
/** The totals a baseline names for `sessionId`, when they are this adapter's cumulative ones. */
function baselineTotals(
  baseline: RuntimeInput['usageBaseline'],
  sessionId: string | undefined,
): Record<string, number[]> | undefined {
  const totals = record(baseline?.totals);
  const models = record(totals?.models);
  if (
    !totals ||
    !models ||
    totals.version !== 1 ||
    totals.cumulative !== true ||
    !sessionId ||
    totals.sessionId !== sessionId
  )
    return undefined;
  const result: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(models)) {
    if (!Array.isArray(value) || value.length !== 4) return undefined;
    const counts = value.map(nonnegativeInt);
    if (counts.some((count) => count === null)) return undefined;
    result[key] = counts as number[];
  }
  return result;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function nativeTerminal(message: RecordValue, sessionId: string): RuntimeTerminalEvent {
  if (
    message.terminal_reason === 'aborted_streaming' ||
    message.terminal_reason === 'aborted_tools'
  )
    return { type: 'interrupted' };
  if (message.subtype !== 'success' || message.is_error === true) {
    // SPEC-0049 E01: an API error comes as a success with is_error and its text in `result`.
    const listed = Array.isArray(message.errors) ? message.errors.map(String).join('; ') : '';
    const text = typeof message.result === 'string' ? message.result.trim() : '';
    return {
      type: 'error',
      message: listed || text || String(message.subtype ?? 'Claude failed'),
      outcome: 'failed',
    };
  }
  return typeof message.result === 'string'
    ? {
        type: 'result',
        text: message.result,
        providerSessionId: sessionId,
        ...([
          'input_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
          'output_tokens',
        ].every((key) => nonnegativeInt(record(message.usage)?.[key]) !== null)
          ? { usageComplete: true }
          : {}),
      }
    : { type: 'error', message: 'Claude success result lacks text', outcome: 'unknown' };
}

export interface ClaudeRuntimeAdapter extends RuntimeAdapter {
  hasActiveResources(sessionId: string): boolean;
  close(): Promise<void>;
  /**
   * SPEC-0036 Y01: for a host's synchronous exit path, ends within `timeoutMs` what holds this
   * adapter's markers and never throws. `stopped` only when a last listing found none; without
   * `stopMarker`, nothing is marked and it is true.
   */
  endStopMarkersSync(timeoutMs: number): StopMarkerSyncResult;
  /**
   * SPEC-0059 R03: with `{ attested: true }`, retires dispatches of this adapter that were not
   * proven stopped, once the host's user confirmed that they stopped; see the guide.
   */
  acknowledgeStopMarkers(
    dispatchIds: string[],
    options?: StopMarkerAcknowledgeOptions,
  ): StopMarkerAcknowledgement;
}
interface ActiveQuery {
  sessionId: string;
  dispatchId: string;
  generation: number;
  controller: AbortController;
  closeInput: () => void;
  query: ClaudeQuery | null;
  processes: Set<{ child: ChildProcessWithoutNullStreams; exited: boolean }>;
  spawnObserved: boolean;
  cleanupRequested: boolean;
  observationEnded: boolean;
  stopped: Promise<void>;
  resolveStopped: () => void;
  iterator: AsyncIterator<unknown> | null;
  cleaned: boolean;
  cleanupPromise: Promise<boolean> | null;
  onCleanupConfirmed: () => void;
}

function deadlineOption(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new RangeError(`${name} must be a finite positive millisecond integer`);
  return value;
}

class WaitEnded extends Error {}
async function withinDeadline<T>(
  work: Promise<T>,
  remainingMs: () => number,
  signal: AbortSignal,
  stage: string,
  useLocalTimer: boolean,
  onLateValue?: (value: T) => void,
  wakeup?: AbortSignal,
): Promise<T> {
  // Observe both outcomes before an already-expired deadline or signal can return early.
  const observed = work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  if (signal.aborted) throw new WaitEnded(`${stage} aborted`);
  const remaining = remainingMs();
  if (remaining <= 0) throw new WaitEnded(`${stage} timed out`);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      wakeup?.removeEventListener('abort', recheck);
      callback();
    };
    const onAbort = () => finish(() => reject(new WaitEnded(`${stage} aborted`)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = (): void => {
      if (settled) return;
      clearTimeout(timer);
      const left = remainingMs();
      if (left <= 0) {
        finish(() => reject(new WaitEnded(`${stage} timed out`)));
        return;
      }
      // In host mode this is only a wake-up. The host's monotonic callback decides expiry.
      timer = setTimeout(recheck, useLocalTimer ? left : Math.min(left, 50));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    wakeup?.addEventListener('abort', recheck, { once: true });
    if (signal.aborted) onAbort();
    if (!settled) timer = setTimeout(recheck, useLocalTimer ? remaining : Math.min(remaining, 50));
    // The observed promise cannot reject, including after timeout or cancellation wins.
    observed.then((result) => {
      if (result.ok) {
        if (settled || remainingMs() <= 0) {
          try {
            onLateValue?.(result.value);
          } catch {
            /* A late observation cannot change the already-settled wait. */
          }
          finish(() => reject(new WaitEnded(`${stage} timed out`)));
        } else finish(() => resolve(result.value));
      } else finish(() => reject(result.error));
    });
  });
}

async function loadDefaultQuery(): Promise<ClaudeQueryFactory> {
  let sdk: { query?: ClaudeQueryFactory };
  try {
    sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      query?: ClaudeQueryFactory;
    };
  } catch (cause) {
    throw new Error(
      'Claude query requires @anthropic-ai/claude-agent-sdk, or a host-provided config.query',
      { cause },
    );
  }
  if (typeof sdk.query !== 'function') throw new Error('Claude Agent SDK query() is unavailable');
  return sdk.query;
}

const invalidConfig = (message: string) =>
  Object.assign(new Error(message), { code: 'INVALID_ADAPTER_CONFIG' });
const SHELL_PREFIX = 'CLAUDE_CODE_SHELL_PREFIX';
const hostEnv = (options: object): Record<string, string | undefined> | undefined => {
  const env = (options as { env?: unknown }).env;
  return env !== null && typeof env === 'object' ? (env as Record<string, string>) : undefined;
};

/** SPEC-0034 B01, SPEC-0036: the markers that `stopMarker` asks for, or undefined. */
function stopMarkers(
  config: Pick<ClaudeAdapterConfig, 'stopMarker' | 'observeExecutionStop' | 'executionStop'>,
  options: object,
): StopMarkers | undefined {
  const choice: unknown = config.stopMarker;
  if (choice === undefined || choice === false) return undefined;
  let host:
    | { directory: string; onObservation?: (item: StopMarkerObservation) => void }
    | undefined;
  if (choice !== true) {
    const value = choice as Record<string, unknown> | null;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'directory' && key !== 'onObservation') ||
      (value.onObservation !== undefined && typeof value.onObservation !== 'function')
    )
      throw invalidConfig(
        'Claude adapter: stopMarker must be true or { directory, onObservation? }',
      );
    host = value as typeof host;
  }
  if (process.platform === 'win32')
    throw invalidConfig('Claude adapter: stopMarker needs macOS or Linux');
  if (config.observeExecutionStop !== undefined || config.executionStop !== undefined)
    throw invalidConfig(
      'Claude adapter: stopMarker supplies the stop observer; leave out observeExecutionStop and executionStop',
    );
  if ((hostEnv(options) ?? process.env)[SHELL_PREFIX] !== undefined)
    throw invalidConfig(
      `Claude adapter: the host already sets ${SHELL_PREFIX}, so stopMarker cannot wrap commands; keep the host's own stop observer`,
    );
  try {
    return new StopMarkers(host ? { root: host.directory, onObservation: host.onObservation } : {});
  } catch (error) {
    throw invalidConfig(`Claude adapter: ${errorMessage(error)}`);
  }
}

/** Runs every Bash command of the dispatch through its marker wrapper (SPEC-0034 B01). */
function markCommands(
  markers: StopMarkers,
  dispatchId: string,
  workspace: string,
  stateDir: string,
  options: object,
): void {
  const target = options as Record<string, unknown>;
  const env = hostEnv(target) ?? process.env;
  if (env[SHELL_PREFIX] !== undefined)
    throw new Error(`The host sets ${SHELL_PREFIX}, which stopMarker owns`);
  const shell = env.CLAUDE_CODE_SHELL ?? ['/bin/bash', '/bin/zsh'].find((path) => existsSync(path));
  if (!shell) throw new Error('stopMarker needs bash or zsh');
  const marker = markers.prepare(dispatchId, shell, workspace, stateDir);
  target.env = { ...env, [SHELL_PREFIX]: marker.wrapper, CLAUDE_CODE_SHELL: shell };
  const sandbox = target.sandbox as { filesystem?: { allowRead?: string[] } } | undefined;
  if (sandbox?.filesystem)
    sandbox.filesystem.allowRead = [
      ...new Set([...(sandbox.filesystem.allowRead ?? []), markers.directory]),
    ];
}

/**
 * SPEC-0053 E03: reads the progress in each message of Claude's main loop. It remembers each tool
 * call from its start, to report its end with its outcome and time.
 */
function claudeProgress(): (message: Record<string, unknown>) => RuntimeProgress[] {
  const calls = new Map<string, { tool: string; at: number }>();
  return (message) => {
    const found: RuntimeProgress[] = [];
    const count = (value: unknown) => (typeof value === 'number' ? value : null);
    if (message.type === 'system' && message.subtype === 'api_retry') {
      const error = message.error;
      found.push({
        kind: 'api_retry',
        attempt: count(message.attempt),
        maxRetries: count(message.max_retries),
        delayMs: count(message.retry_delay_ms),
        status: count(message.error_status),
        message:
          typeof error === 'string'
            ? error
            : error === undefined || error === null
              ? null
              : JSON.stringify(error),
      });
    }
    // A thinking block starts long before its message is whole (SPEC-0053 E06).
    const event = message.event as
      | { type?: unknown; content_block?: { type?: unknown } }
      | undefined;
    if (
      message.type === 'stream_event' &&
      event?.type === 'content_block_start' &&
      (event.content_block?.type === 'thinking' ||
        event.content_block?.type === 'redacted_thinking')
    )
      found.push({ kind: 'thinking' });
    const content = (message.message as { content?: unknown } | undefined)?.content;
    if ((message.type !== 'assistant' && message.type !== 'user') || !Array.isArray(content))
      return found;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const { type, text, name, input, id } = block as Record<string, unknown>;
      if (type === 'thinking' || type === 'redacted_thinking') found.push({ kind: 'thinking' });
      if (type === 'text' && typeof text === 'string' && text)
        found.push({ kind: 'assistant_text', text });
      if (type === 'tool_result') {
        const { tool_use_id: callId, is_error: failed } = block as Record<string, unknown>;
        const call = typeof callId === 'string' ? calls.get(callId) : undefined;
        if (!call) continue;
        calls.delete(callId as string);
        found.push({
          kind: 'tool_finished',
          tool: call.tool,
          ok: failed !== true,
          durationMs: Math.max(0, Math.round(performance.now() - call.at)),
          exitCode: null,
        });
      }
      if (type !== 'tool_use' || typeof name !== 'string') continue;
      // An MCP tool is named mcp__<server>__<tool>; its arguments are left out (SPEC-0053 E01).
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (typeof id === 'string')
        calls.set(id, { tool: mcp ? mcp[2] : name, at: performance.now() });
      if (mcp) {
        found.push({ kind: 'tool_started', tool: mcp[2], server: mcp[1] });
        continue;
      }
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const paths = ['file_path', 'notebook_path', 'path']
        .map((key) => args[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      found.push({
        kind: 'tool_started',
        tool: name,
        ...(typeof args.command === 'string' ? { command: args.command } : {}),
        ...(paths.length ? { paths } : {}),
      });
    }
    return found;
  };
}

export function createClaudeAdapter<Extra extends object = object>(
  config: ClaudeAdapterConfig<Extra> = {},
): ClaudeRuntimeAdapter {
  const providerName = adapterProviderName(config.provider, 'claude');
  const readPolicy = claudeReadPolicy(config);
  const profile = config.permissionProfile ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(profile))
    throw Object.assign(new Error('Invalid Claude permission profile'), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  if (config.options !== undefined) validateClaudeOptions(config.options);
  for (const callback of [
    config.query,
    config.extendOptions,
    config.observeExecutionStop,
    config.createMcpServer,
    config.inspectSession,
  ])
    if (callback !== undefined && typeof callback !== 'function')
      throw Object.assign(new Error('Invalid Claude host callback'), {
        code: 'INVALID_ADAPTER_CONFIG',
      });
  const initialOptions = copyClaudeOptions(config.options ?? ({} as ClaudeHostOptions<Extra>));
  const coversExecution =
    profile === 'read-only' && config.options === undefined && config.extendOptions === undefined;
  const markers = stopMarkers(config, initialOptions);
  const observeExecutionStop = markers?.observer ?? config.observeExecutionStop;
  requireStopProof('Claude adapter', coversExecution, { ...config, observeExecutionStop });
  const requestTimeoutMs = deadlineOption(config.requestTimeoutMs, 'requestTimeoutMs', 30_000);
  const turnTimeoutMs = deadlineOption(config.turnTimeoutMs, 'turnTimeoutMs', 1_800_000);
  const cleanupTimeoutMs = deadlineOption(config.cleanupTimeoutMs, 'cleanupTimeoutMs', 1_000);
  const interruptTimeoutMs = deadlineOption(
    config.interruptTimeoutMs,
    'interruptTimeoutMs',
    30_000,
  );
  const active = new Set<ActiveQuery>();
  // SPEC-0056: each dispatch's running turn, for steers.
  const steering = new Map<
    string,
    {
      ended: boolean;
      compact: boolean;
      /** Main-loop tool calls that started and have not returned. */
      outstanding: Set<string>;
      /** Accepted, waiting for a tool call to start. */
      held: ClaudeUserMessage[];
      /** Given to Claude Code, by uuid. */
      given: Set<string>;
      give(message: ClaudeUserMessage): void;
    }
  >();
  let closed = false;

  function confirmCleanup(handle: ActiveQuery): void {
    if (
      handle.cleaned ||
      !handle.cleanupRequested ||
      !handle.spawnObserved ||
      [...handle.processes].some((process) => !process.exited)
    )
      return;
    handle.cleaned = true;
    active.delete(handle);
    handle.resolveStopped();
    handle.onCleanupConfirmed();
  }

  function spawnOwned(
    handle: ActiveQuery,
    options: ClaudeSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    // Seal the factory's launch callback before cleanup; a delayed SDK spawn cannot escape ownership.
    if (
      closed ||
      handle.cleanupRequested ||
      handle.controller.signal.aborted ||
      options.signal.aborted
    )
      throw new Error('Claude process spawn rejected after cancellation or cleanup');
    handle.spawnObserved = true;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: 'pipe',
      windowsHide: true,
      // SPEC-0023 P01: the process leads its own group, which its descendants share.
      detached: process.platform !== 'win32',
    });
    const state = { child, exited: false };
    handle.processes.add(state);
    child.once('exit', () => {
      state.exited = true;
      confirmCleanup(handle);
    });
    child.on('error', () => {
      // ENOENT/EACCES before a PID exists means no child was created. A later error is not exit proof.
      if (child.pid === undefined) {
        state.exited = true;
        confirmCleanup(handle);
      }
    });
    // This adapter has no stderr consumer API; always drain the private pipe to prevent backpressure.
    child.stderr.resume();
    child.stdin.on('error', () => {
      /* A closed private pipe is not process exit evidence. */
    });
    return child;
  }

  function cleanup(handle: ActiveQuery): Promise<boolean> {
    if (handle.cleaned) return Promise.resolve(true);
    if (handle.cleanupPromise) return handle.cleanupPromise;
    const startedAt = performance.now();
    handle.cleanupRequested = true;
    handle.closeInput();
    handle.controller.abort();
    handle.cleanupPromise = (async () => {
      let recovered = false;
      const recoverOwned = (): void => {
        if (recovered) return;
        recovered = true;
        for (const { child, exited } of handle.processes) {
          if (exited) continue;
          try {
            child.stdin.end();
          } catch {
            /* Still attempt signalling if the private pipe cannot be closed. */
          }
          try {
            signalProcessGroup(child, 'SIGTERM');
          } catch {
            /* Failed signalling is not exit proof; retain the original handle. */
          }
        }
        // SPEC-0023 P04: when the cleanup window ends, kill what is left of each group.
        setTimeout(
          () => {
            for (const { child } of handle.processes) killProcessGroup(child);
          },
          Math.max(0, cleanupTimeoutMs - (performance.now() - startedAt)),
        );
      };
      let closeStarted = false;
      try {
        if (handle.query?.close) {
          // Also observe a custom factory's async close without treating its resolution as exit proof.
          void Promise.resolve(handle.query.close()).catch(recoverOwned);
          closeStarted = true;
        }
      } catch {
        /* Recover only the child handles captured by this execution. */
      }
      if (!closeStarted) recoverOwned();
      try {
        // Observe rejection even when the iterator stays pending beyond our bounded cleanup wait.
        void Promise.resolve(handle.iterator?.return?.()).catch(() => {});
      } catch {
        /* A throwing iterator does not discard the owned process handles. */
      }
      confirmCleanup(handle);
      if (handle.cleaned) return true;
      return new Promise<boolean>((resolve) => {
        // Give SDK cleanup a grace period, then independently recover owned children even if
        // close()/return() never settle or the SDK did not forward our AbortController.
        const elapsed = performance.now() - startedAt;
        const recoveryTimer = setTimeout(recoverOwned, Math.max(0, cleanupTimeoutMs / 2 - elapsed));
        const timer = setTimeout(
          () => {
            clearTimeout(recoveryTimer);
            resolve(false);
          },
          Math.max(0, cleanupTimeoutMs - elapsed),
        );
        handle.stopped.then(() => {
          clearTimeout(timer);
          clearTimeout(recoveryTimer);
          resolve(true);
        });
      });
    })();
    return handle.cleanupPromise;
  }

  return {
    provider: providerName,
    hasActiveResources(sessionId: string): boolean {
      return [...active].some((handle) => handle.sessionId === sessionId && !handle.cleaned);
    },
    prepareUnobservedCleanup(target) {
      const handles = [...active].filter((handle) => handle.sessionId === target.sessionId);
      if (
        handles.length === 0 ||
        handles.some(
          (handle) =>
            handle.dispatchId !== target.dispatchId ||
            handle.generation !== target.generation ||
            !handle.cleanupRequested ||
            !handle.observationEnded ||
            handle.spawnObserved ||
            handle.processes.size !== 0,
        )
      )
        return null;
      return () => {
        // Owner attestation retires bookkeeping only. Keep cleaned=false for late observations;
        // neither this disposition nor hasActiveResources=false is an automatic exit certificate.
        for (const handle of handles) active.delete(handle);
      };
    },
    capabilities: () => ({
      provider: providerName,
      resume: true,
      interrupt: true,
      // SPEC-0056 S01: a line from the user joins the running turn at its next tool round.
      steer: true,
      permissionProfiles: [profile],
      fork: true,
      // SPEC-0013 M05: a native fork resends the source history to the requested model.
      forkModelChange: true,
      readFence: readPolicy.fence,
      compact: true,
      toolBridge: true,
      inspect: true,
      executionBudget: {
        version: 2,
        acceptanceCapMs: config.requestTimeoutMs ?? null,
        turnCapMs: config.turnTimeoutMs ?? null,
      },
      executionEvidence: {
        version: 1,
        terminalCoversExecution: coversExecution || observeExecutionStop !== undefined,
      },
    }),
    async steer(target, text, steerId) {
      const turn = steering.get(target.dispatchId);
      if (!turn || turn.ended)
        return {
          status: 'rejected',
          turnEnded: true,
          message: 'no running turn for this dispatch',
        };
      if (turn.compact)
        return {
          status: 'rejected',
          turnEnded: false,
          notSteerable: true,
          message: 'a compaction cannot be steered',
        };
      const message: ClaudeUserMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
        uuid: steerId as ClaudeUserMessage['uuid'],
        priority: 'next',
      };
      // SPEC-0056 S02, invariant 2: Claude Code folds a queued message into the turn only between
      // tool rounds; given at any other time it would start a turn of its own.
      if (turn.outstanding.size) {
        turn.given.add(steerId);
        turn.give(message);
      } else turn.held.push(message);
      // SPEC-0058 D01: whether the turn takes it is reported later.
      return { status: 'accepted', outcomePending: true };
    },
    async inspect(input) {
      if (config.query && !config.inspectSession)
        return {
          providerSessionId: input.providerSessionId,
          execution: 'unknown',
          records: [],
          truncated: false,
          status: 'unavailable',
          detail:
            'Host-provided query requires a matching config.inspectSession reader; no default SDK was loaded',
        };
      return (config.inspectSession ?? inspectClaudeSession)(input);
    },
    endStopMarkersSync(timeoutMs: number): StopMarkerSyncResult {
      return markers?.endAllSync(timeoutMs) ?? { stopped: true, holders: 0, ended: 0 };
    },
    acknowledgeStopMarkers(dispatchIds, options) {
      return (
        markers?.acknowledge(dispatchIds, options) ?? {
          removed: [],
          refused: [],
          missing: [...dispatchIds],
        }
      );
    },
    async close(): Promise<void> {
      closed = true;
      const results = await Promise.all([...active].map(cleanup));
      if (markers && !(await markers.endAll(cleanupTimeoutMs))) results.push(false);
      if (results.some((result) => !result) || [...active].some((handle) => !handle.cleaned))
        throw new Error('Claude SDK cleanup unconfirmed; adapter resources may still be active');
    },
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      const startedAt = performance.now();
      let sequence = 0;
      let sessionId: string | null = input.providerSessionId;
      let nativeCheckpoint: string | undefined;
      let compactBoundary: Json | undefined;
      let matchedTerminal: RuntimeTerminalEvent | null = null;
      const report = (
        source: ExecutionEvidence['source'],
        localResources: ExecutionEvidence['localResources'],
        remoteExecution: ExecutionEvidence['remoteExecution'],
        detail: string,
        terminal?: RuntimeTerminalEvent,
      ): void => {
        if (!input.reportExecutionEvidence) return;
        const evidence: ExecutionEvidence = {
          version: 1,
          sequence: ++sequence,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider: providerName,
          providerSessionId: sessionId ?? input.providerSessionId,
          ...(nativeCheckpoint ? { providerTurnId: nativeCheckpoint } : {}),
          source,
          observedAt: new Date().toISOString(),
          localResources,
          remoteExecution,
          detail,
          ...(terminal ? { terminal } : {}),
        };
        // An engine callback records its own persistence failure and stops scheduling.
        try {
          input.reportExecutionEvidence(evidence);
        } catch {
          /* Preserve the runtime outcome; never manufacture a successful release. */
        }
      };
      const preSubmission = (detail: string): void =>
        report('pre_submission', 'stopped', 'stopped', detail);
      const remainingAcceptance = (): number =>
        input.executionBudget
          ? Math.min(
              input.executionBudget.remainingAcceptanceMs(),
              input.executionBudget.remainingTurnMs(),
            )
          : Math.min(requestTimeoutMs, turnTimeoutMs) - (performance.now() - startedAt);
      const remainingTurn = (): number =>
        input.executionBudget
          ? input.executionBudget.remainingTurnMs()
          : turnTimeoutMs - (performance.now() - startedAt);
      if (closed) {
        preSubmission('adapter closed before submission');
        yield { type: 'error', message: 'Claude adapter is closed', outcome: 'failed' };
        return;
      }
      if (input.permissionProfile !== profile) {
        preSubmission('unsupported permission profile');
        yield {
          type: 'error',
          message: `Claude adapter supports ${profile} only`,
          outcome: 'failed',
        };
        return;
      }
      if (input.signal.aborted) {
        preSubmission('input cancelled before submission');
        yield { type: 'interrupted' };
        return;
      }
      const controller = new AbortController();
      let submitted = false;
      let toolsRevoked = false;
      let turnStarted = false;
      const observeProgress = claudeProgress();
      let interruptSent = false;
      let interruptRequestedAt: number | undefined;
      let handle: ActiveQuery | null = null;
      const requestInterrupt = (): void => {
        if (
          interruptRequestedAt === undefined ||
          !turnStarted ||
          interruptSent ||
          !handle?.query ||
          matchedTerminal
        )
          return;
        interruptSent = true;
        try {
          // A receipt, rejection, or missing method cannot replace a matched native terminal.
          void Promise.resolve(handle.query.interrupt?.()).catch(() => {});
        } catch {
          /* Keep observing the independently authoritative terminal until the deadline. */
        }
      };
      const onAbort = () => {
        if (!submitted) controller.abort();
        else {
          interruptRequestedAt ??= performance.now();
          requestInterrupt();
        }
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      let closeInput!: () => void;
      const inputClosed = new Promise<void>((resolve) => {
        closeInput = resolve;
      });
      // SPEC-0056: steers join the open prompt stream after the dispatch's own prompt.
      const queued: ClaudeUserMessage[] = [];
      let wakePrompt: (() => void) | undefined;
      let promptClosed = false;
      void inputClosed.then(() => {
        promptClosed = true;
        wakePrompt?.();
      });
      const turn = {
        ended: false,
        compact: input.nativeAction === 'compact',
        outstanding: new Set<string>(),
        held: [] as ClaudeUserMessage[],
        given: new Set<string>(),
        give(message: ClaudeUserMessage) {
          queued.push({ ...message, session_id: sessionId ?? '' });
          wakePrompt?.();
        },
      };
      steering.set(input.dispatchId, turn);
      let steersSettled = false;
      async function* prompt(): AsyncIterable<ClaudeUserMessage> {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: input.nativeAction === 'compact' ? '/compact' : input.prompt,
          },
          parent_tool_use_id: null,
          session_id: input.providerSessionId ?? '',
          uuid: randomUUID(),
        };
        for (;;) {
          while (queued.length) yield queued.shift()!;
          if (promptClosed) return;
          await new Promise<void>((resolve) => (wakePrompt = resolve));
        }
      }
      const request: ClaudeQueryRequest<Extra> = {
        prompt: prompt(),
        options: {
          model: input.model,
          cwd: input.workspace,
          ...(input.providerSessionId ? { resume: input.providerSessionId } : {}),
          ...(!input.providerSessionId && input.forkSource
            ? {
                resume: input.forkSource.providerSessionId,
                forkSession: true,
                resumeSessionAt: input.forkSource.nativeCheckpoint,
              }
            : {}),
          settingSources: [],
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Glob', 'Grep'],
          disallowedTools: ['mcp__*'],
          permissionMode: 'dontAsk',
          abortController: controller,
          includePartialMessages: true,
          spawnClaudeCodeProcess: (options) => {
            if (!handle) throw new Error('Claude process ownership is unavailable');
            return spawnOwned(handle, options);
          },
        } as ClaudeQueryRequest<Extra>['options'],
      };
      let accepted = false;
      let terminal = false;
      const remainingObservation = (): number =>
        Math.min(
          accepted ? remainingTurn() : remainingAcceptance(),
          interruptRequestedAt === undefined
            ? Infinity
            : interruptTimeoutMs - (performance.now() - interruptRequestedAt),
        );
      let pending: RuntimeEvent[] = [];
      let cleanupConfirmed = true;
      let hostStopped = false;
      let stopObservation: Promise<boolean> | undefined;
      const observeStop = (): void => {
        if (coversExecution || !matchedTerminal || stopObservation) return;
        // SPEC-0023 P02: every Claude process this dispatch started, each leading its own group.
        const started =
          process.platform === 'win32'
            ? []
            : [...(handle?.processes ?? [])].flatMap(({ child }) =>
                child.pid === undefined ? [] : [{ pid: child.pid, processGroupId: child.pid }],
              );
        stopObservation = observeRuntimeStop(
          observeExecutionStop,
          {
            target: {
              taskId: input.taskId,
              sessionId: input.sessionId,
              dispatchId: input.dispatchId,
              generation: input.generation ?? 1,
              provider: providerName,
              providerSessionId: sessionId,
            },
            terminal: matchedTerminal,
            ...(started.length ? { processes: started } : {}),
          },
          cleanupTimeoutMs,
          () => {
            hostStopped = true;
            report(
              'resource_observation',
              handle?.cleaned ? 'stopped' : 'unknown',
              'stopped',
              'Host observed full Claude execution stop for this dispatch',
            );
          },
        );
      };
      let receivedUsage: RuntimeUsageEvent | undefined;
      let cliVersion: string | undefined;
      let outsideUsageEvents: RuntimeUsageEvent[] = [];
      const captureUsage = (message: RecordValue): void => {
        if (receivedUsage) return;
        const source = record(message.usage);
        const cacheWrite = nonnegativeInt(source?.cache_creation_input_tokens);
        const durations = record(source?.cache_creation);
        const fiveMinutes = nonnegativeInt(durations?.ephemeral_5m_input_tokens);
        const oneHour = nonnegativeInt(durations?.ephemeral_1h_input_tokens);
        receivedUsage = {
          type: 'usage',
          usageId: `${input.dispatchId}:result`,
          usage: {
            inputTokens: nonnegativeInt(source?.input_tokens),
            cachedInputTokens: nonnegativeInt(source?.cache_read_input_tokens),
            cacheWriteInputTokens: cacheWrite,
            // SPEC-0030 A01: the cache writes by duration, only when they add up to the total.
            ...(cacheWrite !== null &&
            fiveMinutes !== null &&
            oneHour !== null &&
            fiveMinutes + oneHour === cacheWrite
              ? { cacheWrite5mInputTokens: fiveMinutes, cacheWrite1hInputTokens: oneHour }
              : {}),
            outputTokens: nonnegativeInt(source?.output_tokens),
            raw: source ? (source as Json) : null,
          },
        };
        const models = record(message.modelUsage);
        const totals = modelTotals(models);
        const cumulative = continuesTotals(cliVersion);
        const observed = typeof message.session_id === 'string' ? message.session_id : undefined;
        // SPEC-0032 A02: the session's totals after this dispatch, for the dispatch after it.
        if (totals && cumulative !== undefined && observed)
          receivedUsage.sessionTotals = {
            version: 1,
            sessionId: observed,
            cumulative,
            models: totals,
          };
        input.reportUsage?.(receivedUsage);
        // A01, A03 to A05: a resumed or forked session's totals continue from the dispatch before
        // this one on Claude Code 2.1.277 and later; without a matching baseline, or a version, what
        // this dispatch alone used outside its main loop is unknown.
        const continued = !!input.providerSessionId || !!input.forkSource;
        let own: Record<string, (number | null)[]> | undefined;
        let unknownOutside = false;
        if (continued && cumulative !== false && models && Object.keys(models).length) {
          const before =
            cumulative === true
              ? baselineTotals(
                  input.usageBaseline,
                  input.providerSessionId ?? input.forkSource?.providerSessionId,
                )
              : undefined;
          if (!before) unknownOutside = true;
          else {
            own = {};
            for (const key of Object.keys(models)) {
              const now = totals?.[key];
              const earlier = before[key] ?? [0, 0, 0, 0];
              own[key] =
                now && now.every((count, index) => count >= earlier[index])
                  ? now.map((count, index) => count - earlier[index])
                  : [null, null, null, null];
            }
          }
        }
        outsideUsageEvents = unknownOutside
          ? [
              {
                type: 'usage',
                usageId: `${input.dispatchId}:outside:unknown`,
                usage: {
                  inputTokens: null,
                  cachedInputTokens: null,
                  cacheWriteInputTokens: null,
                  outputTokens: null,
                  raw: models as Json,
                },
              },
            ]
          : outsideUsage(input.dispatchId, input.model, source, models, own);
        for (const event of outsideUsageEvents) input.reportUsage?.(event);
      };
      const observeLateStep = (step: IteratorResult<unknown>): void => {
        if (step.done || matchedTerminal) return;
        const message = record(step.value);
        if (!message || message.type !== 'result') return;
        const observedId =
          typeof message.session_id === 'string' && message.session_id.length > 0
            ? message.session_id
            : null;
        const expectedId = sessionId ?? input.providerSessionId;
        if (!observedId || (expectedId && observedId !== expectedId)) return;
        sessionId = observedId;
        captureUsage(message);
        matchedTerminal = nativeTerminal(message, observedId);
        report(
          'runtime_terminal',
          handle?.cleaned ? 'stopped' : 'unknown',
          coversExecution || hostStopped ? 'stopped' : 'unknown',
          'late matched Claude SDK result terminal',
          matchedTerminal,
        );
        observeStop();
      };
      try {
        let options = copyClaudeOptions(initialOptions);
        if (config.extendOptions) {
          const context = Object.freeze({
            input: Object.freeze({
              ...input,
              ...(input.executionBudget
                ? { executionBudget: Object.freeze({ ...input.executionBudget }) }
                : {}),
            }),
            options: Object.freeze(copyClaudeOptions(options)),
          });
          const extension = await withinDeadline(
            Promise.resolve()
              .then(() => config.extendOptions!(context))
              .catch(() => {
                throw new Error('Claude host option extension failed');
              }),
            remainingAcceptance,
            controller.signal,
            'Claude host options',
            !input.executionBudget,
          );
          validateClaudeOptions(extension);
          options = { ...options, ...extension };
        }
        if (input.requestPermission) {
          const hostPermission = (options as Record<string, unknown>).canUseTool;
          options = {
            ...options,
            canUseTool: async (
              name: string,
              args: Record<string, unknown>,
              native: Record<string, unknown>,
            ) => {
              const deny = {
                behavior: 'deny',
                message: 'Permission was not granted for this exact runtime action',
              };
              if (toolsRevoked || input.signal.aborted || typeof native.toolUseID !== 'string')
                return deny;
              if (typeof hostPermission === 'function') {
                const answer = await hostPermission(name, args, native);
                if (record(answer)?.behavior !== 'allow') return answer;
              }
              const allow = await input.requestPermission!({
                requestId: native.toolUseID,
                toolName: name,
                permission: args as Json,
                providerSessionId: sessionId ?? input.providerSessionId,
                ...(nativeCheckpoint ? { providerTurnId: nativeCheckpoint } : {}),
              });
              return allow && !toolsRevoked && !input.signal.aborted
                ? { behavior: 'allow', updatedInput: args }
                : deny;
            },
          };
        }
        if (input.orchestrationTools) {
          // The adapter's own server loads no SDK, so it also serves an injected query (SPEC-0026 Z06).
          const host = options as Record<string, unknown>;
          if (record(host.mcpServers)?.agent_orch !== undefined)
            throw new Error('The agent_orch MCP server name is adapter-owned');
          const bound = input.orchestrationTools;
          const server = await withinDeadline(
            Promise.resolve().then(() =>
              (config.createMcpServer ?? createClaudeMcpServer)({
                definitions: bound.definitions,
                async call(name, args) {
                  if (toolsRevoked || input.signal.aborted)
                    throw Object.assign(new Error('Runtime tool binding has expired'), {
                      code: 'STALE_GRANT',
                    });
                  return bound.call(name, args);
                },
              }),
            ),
            remainingAcceptance,
            controller.signal,
            'Claude MCP preparation',
            !input.executionBudget,
          );
          options = { ...options, mcpServers: { ...record(host.mcpServers), agent_orch: server } };
        }
        request.options = buildClaudeOptions(input, options, request.options, readPolicy);
        if (markers)
          markCommands(markers, input.dispatchId, input.workspace, input.stateDir, request.options);
        if (input.orchestrationTools) {
          request.options.allowedTools = [
            ...new Set([
              ...request.options.allowedTools,
              ...input.orchestrationTools.definitions.map(
                (tool) => `mcp__agent_orch__${tool.name}`,
              ),
            ]),
          ];
        }
        const factory =
          config.query ??
          (await withinDeadline(
            loadDefaultQuery(),
            remainingAcceptance,
            controller.signal,
            'Claude request',
            !input.executionBudget,
          ));
        // This is the last pre-submission check; a cancelled request never calls query().
        if (closed) {
          preSubmission('adapter closed before submission');
          pending = [
            {
              type: 'error',
              message: 'Claude adapter closed before submission',
              outcome: 'failed',
            },
          ];
        } else if (input.signal.aborted || controller.signal.aborted) {
          preSubmission('input cancelled before submission');
          pending = [{ type: 'interrupted' }];
        } else if (remainingAcceptance() <= 0) {
          preSubmission('execution budget expired before submission');
          pending = [
            {
              type: 'error',
              message: 'Claude acceptance timed out before submission',
              outcome: 'failed',
            },
          ];
        } else {
          submitted = true;
          let resolveStopped!: () => void;
          const stopped = new Promise<void>((resolve) => {
            resolveStopped = resolve;
          });
          handle = {
            sessionId: input.sessionId,
            dispatchId: input.dispatchId,
            generation: input.generation ?? 1,
            controller,
            closeInput,
            query: null,
            processes: new Set(),
            spawnObserved: false,
            cleanupRequested: false,
            observationEnded: false,
            stopped,
            resolveStopped,
            iterator: null,
            cleaned: false,
            cleanupPromise: null,
            onCleanupConfirmed: () =>
              report(
                'resource_observation',
                'stopped',
                (matchedTerminal && coversExecution) || hostStopped ? 'stopped' : 'unknown',
                'Claude query cleanup confirmed',
              ),
          };
          active.add(handle);
          const query = factory(request);
          handle.query = query;
          const iterator = query[Symbol.asyncIterator]();
          handle.iterator = iterator;
          while (true) {
            const stage = accepted ? 'Claude terminal' : 'Claude acceptance';
            const step = await withinDeadline(
              Promise.resolve().then(() => iterator.next()),
              remainingObservation,
              controller.signal,
              stage,
              !input.executionBudget,
              observeLateStep,
              input.signal,
            );
            if (step.done) break;
            const message = record(step.value);
            if (!message) continue;
            const observedId =
              typeof message.session_id === 'string' && message.session_id.length > 0
                ? message.session_id
                : null;
            if (observedId && !accepted && (!sessionId || observedId === sessionId)) {
              if (observedId === input.forkSource?.providerSessionId && !input.providerSessionId)
                throw new Error('Claude fork returned its source session identity');
              sessionId = observedId;
              accepted = true;
              yield { type: 'accepted', providerSessionId: observedId };
            }
            if (
              observedId === sessionId &&
              !message.parent_tool_use_id &&
              (message.type === 'assistant' || message.type === 'stream_event')
            ) {
              turnStarted = true;
              if (message.type === 'assistant' && typeof message.uuid === 'string')
                nativeCheckpoint = message.uuid;
              requestInterrupt();
            }
            // SPEC-0053 E03: what the main loop does, for the host to show.
            if (input.reportProgress && observedId === sessionId && !message.parent_tool_use_id)
              for (const progress of observeProgress(message)) input.reportProgress(progress);
            // SPEC-0032 A01: the Claude Code version decides whether this session's totals continue.
            if (
              message.type === 'system' &&
              message.subtype === 'init' &&
              typeof message.claude_code_version === 'string' &&
              (!observedId || observedId === sessionId)
            )
              cliVersion = message.claude_code_version;
            if (
              observedId === sessionId &&
              message.type === 'system' &&
              message.subtype === 'compact_boundary'
            ) {
              compactBoundary = {
                uuid: typeof message.uuid === 'string' ? message.uuid : null,
                metadata: (record(message.compact_metadata) ?? {}) as Json,
              };
              if (typeof message.uuid === 'string') nativeCheckpoint = message.uuid;
            }
            // SPEC-0056 S02: which tool calls of the main loop run now; a held steer goes with the
            // first one that starts.
            if (observedId === sessionId && !message.parent_tool_use_id) {
              const blocks = (message.message as { content?: unknown } | undefined)?.content;
              for (const block of Array.isArray(blocks) ? blocks : []) {
                const {
                  type,
                  id,
                  tool_use_id: answered,
                } = (block ?? {}) as Record<string, unknown>;
                if (message.type === 'assistant' && type === 'tool_use' && typeof id === 'string')
                  turn.outstanding.add(id);
                if (
                  message.type === 'user' &&
                  type === 'tool_result' &&
                  typeof answered === 'string'
                )
                  turn.outstanding.delete(answered);
              }
              if (turn.outstanding.size)
                for (const held of turn.held.splice(0)) {
                  turn.given.add(held.uuid);
                  turn.give(held);
                }
            }
            if (message.type !== 'result') continue;
            // SPEC-0056 S03: no steer is accepted from here on, and each one's outcome is known
            // before the terminal is reported.
            turn.ended = true;
            if (observedId === sessionId && (turn.given.size || turn.held.length)) {
              const consumed = new Set(
                Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [],
              );
              const lost = [...turn.given].filter((id) => !consumed.has(id));
              if (lost.length) {
                // Invariant 1: a steer that Claude Code holds would start a turn outside this
                // dispatch. Cancel it, and let a turn that had started end, before the terminal.
                const bounded = <T>(work: Promise<T>): Promise<T | undefined> =>
                  Promise.race([
                    work.catch(() => undefined),
                    new Promise<undefined>((resolve) => {
                      const timer = setTimeout(() => resolve(undefined), cleanupTimeoutMs);
                      timer.unref?.();
                    }),
                  ]);
                const receipt = record(
                  await bounded(
                    Promise.resolve().then(() =>
                      handle?.query?.interrupt?.({ cancelQueued: true }),
                    ),
                  ),
                );
                const cancelled = new Set(
                  Array.isArray(receipt?.cancelled) ? receipt.cancelled : [],
                );
                if (!lost.every((id) => cancelled.has(id))) {
                  const deadline = performance.now() + cleanupTimeoutMs;
                  while (performance.now() < deadline) {
                    const next = await bounded(Promise.resolve().then(() => iterator.next()));
                    if (!next || next.done) break;
                    const later = record(next.value);
                    if (later?.type !== 'result') continue;
                    // The session's totals are cumulative: the later result holds them.
                    if (later.modelUsage !== undefined) message.modelUsage = later.modelUsage;
                    break;
                  }
                }
              }
              steersSettled = true;
              for (const id of turn.given)
                input.reportSteerOutcome?.({ steerId: id, delivered: consumed.has(id) });
              for (const held of turn.held.splice(0))
                input.reportSteerOutcome?.({ steerId: held.uuid, delivered: false });
            }
            terminal = true;
            if (!sessionId || !observedId || observedId !== sessionId) {
              pending = [
                {
                  type: 'error',
                  message: 'Claude terminal session id mismatch',
                  outcome: 'unknown',
                },
              ];
            } else {
              captureUsage(message);
              let final = nativeTerminal(message, sessionId);
              if (final.type === 'result') {
                if (input.nativeAction === 'compact' && !compactBoundary)
                  final = {
                    type: 'error',
                    outcome: 'unknown',
                    message: 'Claude compaction lacks a native compact boundary',
                  };
                else
                  final = {
                    ...final,
                    ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
                    ...(input.nativeAction === 'compact'
                      ? { compacted: { kind: 'boundary', evidence: compactBoundary! } }
                      : {}),
                  };
              }
              pending = [final];
            }
            if (sessionId && observedId === sessionId) {
              matchedTerminal =
                pending.find(
                  (event): event is RuntimeTerminalEvent =>
                    event.type === 'result' ||
                    event.type === 'error' ||
                    event.type === 'interrupted',
                ) ?? null;
              if (matchedTerminal)
                report(
                  'runtime_terminal',
                  'unknown',
                  coversExecution || hostStopped ? 'stopped' : 'unknown',
                  'matched Claude SDK result terminal',
                  matchedTerminal,
                );
              observeStop();
            }
            break;
          }
          if (!terminal)
            pending = [
              {
                type: 'error',
                message: 'Claude SDK stream ended before terminal result',
                outcome: 'unknown',
              },
            ];
        }
      } catch (error) {
        if (!submitted) preSubmission(`failed before submission: ${errorMessage(error)}`);
        pending =
          !submitted && input.signal.aborted
            ? [{ type: 'interrupted' }]
            : [
                {
                  type: 'error',
                  message: errorMessage(error),
                  outcome: submitted ? 'unknown' : 'failed',
                },
              ];
      } finally {
        toolsRevoked = true;
        // A turn that ended without a result delivers nothing more (SPEC-0056 S03).
        turn.ended = true;
        if (steering.get(input.dispatchId) === turn) steering.delete(input.dispatchId);
        // The turn ended without a result. A steer still held was never given to Claude Code. One
        // that was given may or may not have been read: nothing is reported, and the engine
        // records its outcome as unknown (SPEC-0058 D03).
        if (!steersSettled) {
          steersSettled = true;
          for (const held of turn.held.splice(0))
            input.reportSteerOutcome?.({ steerId: held.uuid, delivered: false });
        }
        closeInput();
        input.signal.removeEventListener('abort', onAbort);
        if (handle) {
          [cleanupConfirmed] = await Promise.all([cleanup(handle), stopObservation]);
          handle.observationEnded = true;
        }
        // SPEC-0034 A03: whatever a dispatch left behind ends with it, proven stopped or not.
        if (markers) await markers.end(input.dispatchId, () => cleanupTimeoutMs);
      }
      // Usage is an observation, independent of business success and resource-stop certainty.
      if (receivedUsage) yield receivedUsage;
      yield* outsideUsageEvents;
      if (!cleanupConfirmed) {
        const reason = pending.find((event) => event.type === 'error');
        yield {
          type: 'error',
          message: `${reason?.message ?? 'Claude SDK execution stopped'}; cleanup unconfirmed`,
          outcome: 'unknown',
        };
        return;
      }
      for (const event of pending) yield event;
    },
  };
}
