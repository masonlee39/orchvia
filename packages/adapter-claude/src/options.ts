import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { UUID } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  RuntimeInput,
  RuntimeStopObserver,
  RuntimeInspectionInput,
  RuntimeInspection,
} from '../../engine/src/types.ts';
import type { RuntimeTools } from '../../engine/src/tools.ts';
import type { StopMarkerObservation } from '../../engine/src/stop-marker.ts';

export interface ClaudeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}
export interface ClaudePolicyOptions {
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: ('user' | 'project' | 'local')[];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto';
  maxTurns?: number;
}
export type ClaudeOwnedOption =
  | 'model'
  | 'cwd'
  | 'resume'
  | 'prompt'
  | 'abortController'
  | 'spawnClaudeCodeProcess'
  | 'sessionId'
  | 'continue'
  | 'forkSession'
  | 'resumeSessionAt'
  | 'includePartialMessages'
  | 'additionalDirectories';
export type ClaudeHostOptions<Extra extends object = object> = Extra &
  ClaudePolicyOptions & {
    [Key in ClaudeOwnedOption]?: never;
  };
export interface ClaudeQueryBaseOptions {
  model: string;
  cwd: string;
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  settingSources: ('user' | 'project' | 'local')[];
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: NonNullable<ClaudePolicyOptions['permissionMode']>;
  abortController: AbortController;
  includePartialMessages: true;
  spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => ChildProcessWithoutNullStreams;
}
export interface ClaudeUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
  uuid: UUID;
}
export interface ClaudeQueryRequest<Extra extends object = object> {
  prompt: AsyncIterable<ClaudeUserMessage>;
  options: ClaudeQueryBaseOptions & Extra;
}
export type ClaudeQuery = AsyncIterable<unknown> & {
  interrupt?(): Promise<unknown>;
  close?(): void | Promise<void>;
};
export type ClaudeQueryFactory<Extra extends object = object> = (
  request: ClaudeQueryRequest<Extra>,
) => ClaudeQuery;
export interface ClaudeOptionsContext<Extra extends object = object> {
  readonly input: Readonly<RuntimeInput>;
  readonly options: Readonly<ClaudeHostOptions<Extra>>;
}
export interface ClaudeAdapterConfig<Extra extends object = object> {
  /** Engine provider name; defaults to `claude`. Distinct names let one engine run several profiles. */
  provider?: string;
  /** Host injection owns native dependency selection; also supply `inspectSession` when needed. */
  query?: ClaudeQueryFactory<Extra>;
  createMcpServer?: (tools: RuntimeTools) => unknown | Promise<unknown>;
  inspectSession?: (input: RuntimeInspectionInput) => Promise<RuntimeInspection>;
  permissionProfile?: RuntimeInput['permissionProfile'];
  options?: ClaudeHostOptions<Extra>;
  extendOptions?: (
    context: ClaudeOptionsContext<Extra>,
  ) => ClaudeHostOptions<Extra> | Promise<ClaudeHostOptions<Extra>>;
  /**
   * Proves that a dispatch's execution stopped. Required with `options`, `extendOptions` or the
   * `workspace-write` profile, unless `executionStop` is `'owner-reconcile'` (SPEC-0027 A01).
   */
  observeExecutionStop?: RuntimeStopObserver;
  /**
   * `'owner-reconcile'`: without an observer, leases are released only by the owner's
   * reconciliation, as before SPEC-0027. Cannot be combined with `observeExecutionStop` (A02).
   */
  executionStop?: 'owner-reconcile';
  /**
   * macOS and Linux: run every Bash command through a wrapper that holds a per-dispatch marker
   * file open, and prove a stop when nothing holds it; leftovers are ended at the terminal
   * (SPEC-0034 B01). Supplies the stop observer, so it excludes `observeExecutionStop` and
   * `executionStop`, and a host that sets `CLAUDE_CODE_SHELL_PREFIX` cannot use it.
   */
  stopMarker?:
    | boolean
    | {
        /**
         * SPEC-0036: an absolute directory that outlives the host, private to this user and
         * outside every workspace and state directory. Each adapter instance works in a directory
         * of its own under it, whose markers `sweepStopMarkers` can end after a restart.
         */
        directory: string;
        /** Each stop observation's result, for the host's diagnostics; exceptions are ignored. */
        onObservation?: (observation: StopMarkerObservation) => void;
      };
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** Existing absolute directories readable outside the workspace (SPEC-0014 F02). */
  readRoots?: string[];
  /** Absolute or workspace-relative paths that Read, Glob, Grep and sandboxed Bash cannot read. */
  denyRead?: string[];
  /** Set to false to restore reads outside the workspace; defaults to true. */
  readFence?: boolean;
}
export interface ClaudeReadPolicy {
  fence: boolean;
  /** Canonical absolute directories. */
  roots: string[];
  /** Unresolved paths; relative entries resolve against each dispatch's workspace. */
  deny: string[];
}
export function claudeReadPolicy(config: {
  readRoots?: unknown;
  denyRead?: unknown;
  readFence?: unknown;
}): ClaudeReadPolicy {
  if (config.readFence !== undefined && typeof config.readFence !== 'boolean') invalid('readFence');
  const roots = (config.readRoots === undefined ? [] : strings(config.readRoots, 'readRoots')).map(
    (path) => {
      if (!isAbsolute(path)) invalid('readRoots');
      try {
        // SPEC-0054: as the volume names it, so that another spelling compares equal.
        const root = realpathSync.native(path);
        if (!statSync(root).isDirectory()) invalid('readRoots');
        return root;
      } catch {
        invalid('readRoots');
      }
    },
  );
  const deny = config.denyRead === undefined ? [] : strings(config.denyRead, 'denyRead');
  return { fence: config.readFence !== false, roots, deny };
}

const owned = new Set<ClaudeOwnedOption>([
  'model',
  'cwd',
  'resume',
  'prompt',
  'abortController',
  'spawnClaudeCodeProcess',
  'sessionId',
  'continue',
  'forkSession',
  'resumeSessionAt',
  'includePartialMessages',
  'additionalDirectories',
]);
const modes = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'];
const readTools = ['Read', 'Glob', 'Grep'];
const writeTools = ['Edit', 'Write', 'Bash'];
function invalid(field: string): never {
  throw Object.assign(new Error(`Invalid Claude host policy: ${field}`), {
    code: 'INVALID_ADAPTER_CONFIG',
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2048)
  )
    invalid(field);
  return [...value] as string[];
}
export function validateClaudeOptions(value: unknown): void {
  try {
    if (!record(value)) invalid('options');
    for (const key of owned) if (Object.hasOwn(value, key)) invalid('adapter-owned option');
    for (const key of ['tools', 'allowedTools', 'disallowedTools'])
      if (value[key] !== undefined) strings(value[key], key);
    if (
      value.settingSources !== undefined &&
      strings(value.settingSources, 'settingSources').some(
        (source) => !['user', 'project', 'local'].includes(source),
      )
    )
      invalid('settingSources');
    if (value.permissionMode !== undefined && !modes.includes(value.permissionMode as string))
      invalid('permissionMode');
    if (
      value.maxTurns !== undefined &&
      (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1)
    )
      invalid('maxTurns');
    if (value.canUseTool !== undefined && typeof value.canUseTool !== 'function')
      invalid('canUseTool');
    if (value.hooks !== undefined) {
      if (!record(value.hooks)) invalid('hooks');
      for (const matchers of Object.values(value.hooks)) {
        if (
          !Array.isArray(matchers) ||
          matchers.some(
            (matcher) =>
              !record(matcher) ||
              !Array.isArray(matcher.hooks) ||
              matcher.hooks.some((hook: unknown) => typeof hook !== 'function'),
          )
        )
          invalid('hooks');
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'INVALID_ADAPTER_CONFIG')
      throw error;
    invalid('options');
  }
}

/** Clone policy containers; retain host callback/native-server identities. */
export function copyClaudeOptions<Extra extends object>(
  options: ClaudeHostOptions<Extra>,
): ClaudeHostOptions<Extra> {
  try {
    const copy = { ...options } as Record<string, unknown>;
    for (const key of ['tools', 'allowedTools', 'disallowedTools', 'settingSources'])
      if (Array.isArray(copy[key])) copy[key] = [...copy[key]];
    if (record(copy.hooks))
      copy.hooks = Object.fromEntries(
        Object.entries(copy.hooks).map(([key, value]) => [
          key,
          (value as Record<string, unknown>[]).map((matcher) => ({
            ...matcher,
            hooks: [...(matcher.hooks as unknown[])],
          })),
        ]),
      );
    return copy as ClaudeHostOptions<Extra>;
  } catch {
    invalid('options');
  }
}

function canonical(path: string, depth = 0): string {
  if (depth > 64) invalid('path');
  try {
    // SPEC-0054: the case on disk, which the Claude process and the model use.
    return realpathSync.native(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        return canonical(resolve(dirname(path), readlinkSync(path)), depth + 1);
    } catch (statError) {
      if (!['ENOENT', 'ENOTDIR'].includes((statError as NodeJS.ErrnoException).code ?? ''))
        throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonical(parent, depth + 1), basename(path));
  }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function paths(value: unknown, base: string, field: string): string[] {
  try {
    return strings(value, field).map((path) => canonical(resolve(base, path)));
  } catch {
    invalid(field);
  }
}

export function buildClaudeOptions<Extra extends object>(
  input: RuntimeInput,
  supplied: ClaudeHostOptions<Extra>,
  ownedOptions: ClaudeQueryBaseOptions,
  readPolicy: ClaudeReadPolicy = { fence: true, roots: [], deny: [] },
): ClaudeQueryBaseOptions & Extra {
  validateClaudeOptions(supplied);
  const extra = copyClaudeOptions(supplied) as Record<string, unknown>;
  const workspace = canonical(input.workspace),
    state = canonical(input.stateDir);
  const overlapsState = (path: string) => inside(path, state) || inside(state, path);
  const readRoots = readPolicy.roots;
  if (readRoots.some(overlapsState)) invalid('readRoots overlap private state');
  const denyRead = paths(readPolicy.deny, workspace, 'denyRead');
  const readable = (path: string) =>
    !readPolicy.fence || inside(workspace, path) || readRoots.some((root) => inside(root, path));
  const write = input.permissionProfile === 'workspace-write';
  const tools =
    extra.tools === undefined
      ? [...readTools, ...(write ? writeTools : [])]
      : strings(extra.tools, 'tools');
  if (!write && tools.some((tool) => ['Edit', 'Write', 'Bash', 'NotebookEdit'].includes(tool)))
    invalid('read-only tools');
  const registeredWritePaths = input.writePaths?.map((path) => canonical(path)) ?? [workspace];
  if (registeredWritePaths.some((path) => !inside(workspace, path)))
    invalid('registered writable roots');
  let writable = registeredWritePaths;
  if (write) {
    if (extra.sandbox !== undefined && !record(extra.sandbox)) invalid('sandbox');
    const sandbox = { ...(extra.sandbox as Record<string, unknown> | undefined) };
    if (
      sandbox.enabled === false ||
      sandbox.failIfUnavailable === false ||
      sandbox.allowUnsandboxedCommands === true ||
      (sandbox.excludedCommands !== undefined &&
        strings(sandbox.excludedCommands, 'sandbox.excludedCommands').length)
    )
      invalid('sandbox safety');
    if (sandbox.filesystem !== undefined && !record(sandbox.filesystem))
      invalid('sandbox.filesystem');
    const filesystem = { ...(sandbox.filesystem as Record<string, unknown> | undefined) };
    if (filesystem.allowWrite !== undefined)
      writable = paths(filesystem.allowWrite, workspace, 'sandbox.allowWrite');
    if (writable.some((path) => !inside(workspace, path))) invalid('sandbox writable roots');
    if (writable.some((path) => !registeredWritePaths.some((root) => inside(root, path))))
      invalid('sandbox exceeds registered write scope');
    filesystem.allowWrite = writable;
    // allowRead takes precedence over denyRead, so it must never re-open private state.
    const hostAllowRead =
      filesystem.allowRead === undefined
        ? []
        : paths(filesystem.allowRead, workspace, 'sandbox.allowRead');
    if (hostAllowRead.some(overlapsState)) invalid('sandbox.allowRead');
    filesystem.denyRead = [
      ...new Set([
        ...paths(filesystem.denyRead ?? [], workspace, 'sandbox.denyRead'),
        state,
        ...denyRead,
        ...(readPolicy.fence ? [canonical(homedir())] : []),
      ]),
    ];
    const allowRead = [
      ...new Set([...hostAllowRead, ...(readPolicy.fence ? [workspace, ...readRoots] : [])]),
    ];
    if (allowRead.length) filesystem.allowRead = allowRead;
    filesystem.denyWrite = [
      ...new Set([...paths(filesystem.denyWrite ?? [], workspace, 'sandbox.denyWrite'), state]),
    ];
    extra.sandbox = {
      ...sandbox,
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem,
    };
  }
  const guard = async (raw: unknown): Promise<Record<string, unknown>> => {
    const deny = () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Tool call violates the adapter workspace or private-state policy',
      },
    });
    try {
      if (!record(raw) || typeof raw.tool_name !== 'string' || !record(raw.tool_input))
        return deny();
      const tool = raw.tool_name,
        args = raw.tool_input;
      const mutating = ['Write', 'Edit', 'NotebookEdit', 'Bash'].includes(tool);
      if (mutating && !write) return deny();
      if (tool === 'Bash')
        return args.dangerouslyDisableSandbox === true || args.run_in_background === true
          ? deny()
          : {};
      if (!['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(tool)) return {};
      const search = tool === 'Glob' || tool === 'Grep';
      const target = search
        ? (args.path ?? workspace)
        : tool === 'NotebookEdit'
          ? args.notebook_path
          : args.file_path;
      if (typeof target !== 'string' || !target || target.includes('\0')) return deny();
      if (
        tool === 'Glob' &&
        (typeof args.pattern !== 'string' ||
          isAbsolute(args.pattern) ||
          args.pattern.split(/[\\/]/).includes('..'))
      )
        return deny();
      const path = canonical(resolve(workspace, target));
      if (inside(state, path) || (search && inside(path, state))) return deny();
      if (mutating && !writable.some((root) => inside(root, path))) return deny();
      if (
        !mutating &&
        (!readable(path) ||
          denyRead.some((denied) => inside(denied, path) || (search && inside(path, denied))))
      )
        return deny();
      return {};
    } catch {
      return deny();
    }
  };
  const hooks = { ...(extra.hooks as Record<string, unknown> | undefined) };
  hooks.PreToolUse = [{ hooks: [guard] }, ...((hooks.PreToolUse as unknown[] | undefined) ?? [])];
  const hasConfirmation = typeof extra.canUseTool === 'function';
  return {
    ...extra,
    ...ownedOptions,
    tools,
    allowedTools:
      extra.allowedTools === undefined
        ? hasConfirmation
          ? []
          : [...tools]
        : strings(extra.allowedTools, 'allowedTools'),
    disallowedTools:
      extra.disallowedTools === undefined
        ? extra.mcpServers
          ? []
          : ['mcp__*']
        : strings(extra.disallowedTools, 'disallowedTools'),
    settingSources: (extra.settingSources === undefined
      ? []
      : strings(
          extra.settingSources,
          'settingSources',
        )) as ClaudeQueryBaseOptions['settingSources'],
    permissionMode: (extra.permissionMode ??
      (hasConfirmation ? 'default' : 'dontAsk')) as ClaudeQueryBaseOptions['permissionMode'],
    hooks,
  } as unknown as ClaudeQueryBaseOptions & Extra;
}
