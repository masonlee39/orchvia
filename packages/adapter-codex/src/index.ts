import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExecutionEvidence,
  Json,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  RuntimeTerminalEvent,
  RuntimeStopObserver,
  RuntimeProgress,
  RuntimeUsageEvent,
} from '../../engine/src/types.ts';
import { observeRuntimeStop, requireStopProof } from '../../engine/src/stop-observation.ts';
import {
  StopMarkers,
  type StopMarkerObservation,
  type StopMarkerAcknowledgeOptions,
  type StopMarkerAcknowledgement,
  type StopMarkerSyncResult,
} from '../../engine/src/stop-marker.ts';
import { adapterProviderName } from '../../engine/src/runtime.ts';
import { contains, workspacePath } from '../../engine/src/verification.ts';
import { createToolBridge } from '../../engine/src/tool-bridge.ts';
import { TOOL_NAMES } from '../../engine/src/tools.ts';
import { VERSION } from '../../engine/src/version.ts';
import {
  AppServerConnection,
  AppServerRequestError,
  errorMessage,
  record,
  type Message,
} from './app-server.ts';
import {
  approvalPolicy,
  checkDenyRead,
  checkHostMcpServers,
  checkPolicy,
  clientInfo as checkClientInfo,
  coded,
  codexVersion,
  connectionHome,
  hostMcpEntries,
  invalidConfig,
  overlaps,
  profileSettings,
  PROXY_CHECK_SCRIPT,
  proxyCheckSocket,
  proxyInForce,
  resolveDenyRead,
  supportedVersion,
  startLock,
  type CodexClientInfo,
  type CodexDispatchPolicy,
  type CodexHostMcpServer,
  MIN_CODEX_VERSION,
  checkHostHookCommand,
  checkProxyCheck,
  resolveEffort,
  type CodexReasoningEffort,
  deniedCheckPath,
  checkToolBridge,
  type CodexToolBridge,
  hostHookChannel,
  hostHookCommand,
  hostHookSetting,
  hostHookTrusted,
  markedCommand,
  markedLoginShell,
  markerStartupFiles,
  type CodexHostHook,
} from './local.ts';
export type {
  CodexClientInfo,
  CodexReasoningEffort,
  CodexToolBridge,
  CodexDispatchPolicy,
  CodexHookDecision,
  CodexHookEvent,
  CodexHostHook,
  CodexHostMcpServer,
  CodexMode,
  CodexNetwork,
} from './local.ts';
// SPEC-0035 I01: the same stop marker functions as the Claude adapter's, for one host directory.
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
export {
  codexConnection,
  type CodexConnection,
  type CodexConnectionConfig,
  type CodexHostHookTrust,
} from './connection.ts';
export {
  TESTED_CODEX_VERSIONS,
  hostHookCommandFor,
  hostHookProgram,
  proxyCheckProgram,
  toolBridgeProgram,
} from './local.ts';

/** The real location of a path that may not exist yet, or null when it cannot be resolved. */
function canonicalPath(path: string): string | null {
  const rest: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      // SPEC-0054: the case on disk, as Codex names the files it changes.
      return join(realpathSync.native(current), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      try {
        lstatSync(current);
        return null; // a dangling symbolic link
      } catch {
        /* missing: look at the parent */
      }
    }
    if (dirname(current) === current) return null;
    rest.unshift(basename(current));
  }
}

/**
 * SPEC-0038 P01: the paths a file change item names, resolved, when every one of them lies inside
 * a write path; null otherwise, and when the item is missing or malformed.
 */
function checkedChanges(item: unknown, cwd: string, roots: readonly string[]): Json[] | null {
  const changes = record(item)?.changes;
  if (!Array.isArray(changes) || !changes.length) return null;
  const inside = (path: unknown): string | null => {
    if (typeof path !== 'string' || !path) return null;
    const target = canonicalPath(resolve(cwd, path));
    return target && roots.some((root) => contains(root, target)) ? target : null;
  };
  const checked: Json[] = [];
  for (const value of changes) {
    const change = record(value);
    const kind = record(change?.kind);
    const type = kind?.type;
    const path = inside(change?.path);
    if (!path || (type !== 'add' && type !== 'delete' && type !== 'update')) return null;
    const entry: { [key: string]: Json } = { path, kind: type };
    if (type === 'update' && kind!.move_path != null) {
      const moved = inside(kind!.move_path);
      if (!moved) return null;
      entry.movePath = moved;
    }
    checked.push(entry);
  }
  return checked;
}
function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface CodexAdapterConfig {
  /** Engine provider name; defaults to `codex`. */
  provider?: string;
  permissionProfile?: RuntimeInput['permissionProfile'];
  networkAccess?: boolean;
  webSearch?: 'disabled' | 'cached' | 'live';
  /** Required with `workspace-write`, unless `executionStop` is `'owner-reconcile'` (SPEC-0027 A03). */
  observeExecutionStop?: RuntimeStopObserver;
  /** Release leases by owner reconciliation only; excludes `observeExecutionStop` (SPEC-0027 A02). */
  executionStop?: 'owner-reconcile';
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
  /**
   * The user's Codex home, which holds their sign-in (SPEC-0035 A01). With it, each dispatch runs
   * under a named permission profile and `policy`, and Orchvia writes nothing to the home.
   */
  connection?: { home: string };
  /** Each dispatch's mode and network; with `connection` only (SPEC-0035 F01). */
  policy?: (input: RuntimeInput) => CodexDispatchPolicy | Promise<CodexDispatchPolicy>;
  /** Paths commands can neither read nor write, as the Claude adapter's; with `connection` (B02). */
  denyRead?: string[];
  /** MCP servers of the host, run outside the command sandbox (SPEC-0035 H01). */
  hostMcpServers?: Record<string, CodexHostMcpServer>;
  /** Passed to Codex's `initialize` (SPEC-0035 C06); defaults to `agent_orch`. */
  clientInfo?: CodexClientInfo;
  /**
   * Asked before each command, file change and tool call runs, in every mode; needs `connection`
   * and the hook trusted in it with `codexConnection().trustHostHook()` (SPEC-0035 R01, R02).
   */
  hostHook?: CodexHostHook;
  /**
   * The command Codex runs as the hook, which must be the one trusted with `trustHostHook`; by
   * default this Node running the package's hook program. Build it with `hostHookCommandFor` and
   * `hostHookProgram` (SPEC-0039 H01).
   */
  hostHookCommand?: string;
  /**
   * How Codex starts the orchestration tool bridge, instead of this Node running the engine's
   * module: for a host whose `process.execPath` is not Node, with `toolBridgeProgram()` copied
   * beside its files (SPEC-0039 B01).
   */
  toolBridge?: CodexToolBridge;
  /**
   * Lets a dispatch run a model that Codex's model list does not name, such as a custom
   * provider's; with `connection` (SPEC-0043 M02). Otherwise such a model is refused before the
   * thread, since Codex gives it a reduced tool set without `apply_patch`.
   */
  allowUnlistedModel?: boolean;
  /**
   * How the proxy check runs before a networked dispatch, instead of this Node with the built-in
   * check: `[command, ...args, <socket>]`, with `env` for that process alone, and
   * `proxyCheckProgram()` copied beside the host's files; with `connection` (SPEC-0040 P01).
   */
  proxyCheck?: CodexToolBridge;
  /**
   * Instructions for the member, given to Codex as developer instructions when a dispatch starts
   * a new thread; a resumed or forked thread keeps the ones it started with (SPEC-0039 D).
   */
  instructions?: (input: RuntimeInput) => string | undefined | Promise<string | undefined>;
  /**
   * Marks each zsh and bash command so that a dispatch is proven stopped when nothing holds its
   * marker, as the Claude adapter's `stopMarker`; replaces `executionStop` and the observer
   * (SPEC-0035 I).
   */
  stopMarker?: true | { directory: string; onObservation?: (item: StopMarkerObservation) => void };
}

/** The Codex adapter, with the stop markers' synchronous cleanup (SPEC-0035 I01). */
export interface CodexRuntimeAdapter extends RuntimeAdapter {
  /** Ends what holds this adapter's markers within `timeoutMs`; never throws. */
  endStopMarkersSync(timeoutMs: number): StopMarkerSyncResult;
  /**
   * SPEC-0059 R03: with `{ attested: true }`, retires dispatches of this adapter that were not
   * proven stopped, once the host's user confirmed that they stopped.
   */
  acknowledgeStopMarkers(
    dispatchIds: string[],
    options?: StopMarkerAcknowledgeOptions,
  ): StopMarkerAcknowledgement;
}

/** SPEC-0039 H05: the time a hook command has to answer its probe before a dispatch. */
const HOOK_PROBE_MS = 15_000;
/** SPEC-0039 D03. */
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

function timeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function managedHome(stateDir: string): string {
  if (!isAbsolute(stateDir)) throw new Error('Codex stateDir must be absolute');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = realpathSync.native(stateDir);
  const home = join(state, 'runtime', 'codex');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const actual = realpathSync.native(home);
  if (!actual.startsWith(state + sep)) throw new Error('Codex managed home escapes stateDir');
  chmodSync(home, 0o700);
  const configPath = join(actual, 'config.toml');
  const config =
    'mcp_servers = {}\n[agents]\nenabled = false\n[features]\nmulti_agent = false\nmulti_agent_v2 = false\napps = false\nplugins = false\nremote_plugin = false\nbrowser_use = false\ncomputer_use = false\nimage_generation = false\nhooks = false\n';
  try {
    writeFileSync(configPath, config, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!lstatSync(configPath).isFile() || readFileSync(configPath, 'utf8') !== config) {
      throw new Error('Codex managed config differs from expected read-only profile');
    }
  }
  return actual;
}

function isolatedEnv(configured?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const supplied = configured ?? {};
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...supplied,
  };
}

/** The bridge's default: this Node running the engine's module. */
function defaultToolBridge(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../../engine/src/tool-bridge.ts', import.meta.url))],
    env: {},
  };
}

function defensiveArgs(
  args: string[],
  workspace: string,
  bridge?: { command: string; args: string[]; env: Record<string, string> },
  host: { entries: string[]; exclude: string[] } = { entries: [], exclude: [] },
  hooks = false,
): string[] {
  // SPEC-0035 G02: the bridge's tools act on the dispatch's own grant, so Codex asks for no
  // approval of them; under `never` it would refuse every call.
  const servers = [
    ...(bridge
      ? [
          `agent_orch={command=${JSON.stringify(bridge.command)},args=[${bridge.args.map((arg) => JSON.stringify(arg)).join(',')}],${
            Object.keys(bridge.env).length
              ? `env={${Object.entries(bridge.env)
                  .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
                  .join(',')}},`
              : ''
          }env_vars=["AGENT_ORCH_BRIDGE_TOKEN","AGENT_ORCH_BRIDGE_SOCKET"],enabled_tools=${JSON.stringify(TOOL_NAMES)},required=true,default_tools_approval_mode="approve"}`,
        ]
      : []),
    ...host.entries,
  ];
  // SPEC-0035 B04: an agent socket and the host's MCP secrets stay out of commands too.
  const exclude = ['AGENT_ORCH_BRIDGE_*', 'ORCHVIA_HOOK_*', 'SSH_AUTH_SOCK', ...host.exclude];
  const untrustedProjects: string[] = [];
  for (let path = workspace; ; path = dirname(path)) {
    untrustedProjects.push('-c', `projects.${JSON.stringify(path)}.trust_level="untrusted"`);
    if (dirname(path) === path) break;
  }
  return [
    ...args,
    '--disable',
    'multi_agent',
    '--disable',
    'multi_agent_v2',
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'remote_plugin',
    '--disable',
    'browser_use',
    '--disable',
    'browser_use_external',
    '--disable',
    'browser_use_full_cdp_access',
    '--disable',
    'computer_use',
    '--disable',
    'image_generation',
    // Hooks run outside the sandbox; only the host's own, through Orchvia, when it has one.
    ...(hooks ? [] : ['--disable', 'hooks']),
    '-c',
    'agents.enabled=false',
    '-c',
    `mcp_servers={${servers.join(',')}}`,
    '-c',
    `shell_environment_policy.exclude=${JSON.stringify(exclude)}`,
    // SPEC-0038 P02: the shell snapshot re-exports the whole environment and so defeats the
    // excludes; without it Codex also drops names containing KEY, SECRET or TOKEN.
    '-c',
    'features.shell_snapshot=false',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '-c',
    'project_root_markers=[]',
    ...untrustedProjects,
  ];
}

/** SPEC-0035 I01: the markers `stopMarker` asks for, as the Claude adapter's, or undefined. */
function codexStopMarkers(config: CodexAdapterConfig): StopMarkers | undefined {
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
      invalidConfig('stopMarker must be true or { directory, onObservation? }');
    host = value as typeof host;
  }
  if (process.platform === 'win32') invalidConfig('stopMarker needs macOS or Linux');
  if (config.observeExecutionStop !== undefined || config.executionStop !== undefined)
    invalidConfig(
      'stopMarker supplies the stop observer; leave out observeExecutionStop and executionStop',
    );
  try {
    return new StopMarkers(host ? { root: host.directory, onObservation: host.onObservation } : {});
  } catch (error) {
    invalidConfig(errorMessage(error));
  }
}

/** Items that are no tool call: their start is not progress (SPEC-0053 E04). */
const NOT_TOOLS = new Set([
  'agentMessage',
  'reasoning',
  'userMessage',
  'plan',
  'contextCompaction',
]);
/**
 * SPEC-0053 E04: reads the progress in each notification of the turn. It remembers each item from
 * its start, to report its end with its time when Codex gives none.
 */
function codexProgress(): (method: string, params: Record<string, unknown>) => RuntimeProgress[] {
  const items = new Map<string, { tool: string; at: number }>();
  const toolOf = (item: Record<string, unknown>) =>
    item.type === 'mcpToolCall' && typeof item.tool === 'string' ? item.tool : String(item.type);
  return (method, params) => {
    const item = params.item as Record<string, unknown> | undefined;
    if (method === 'item/started' && item?.type === 'reasoning') return [{ kind: 'thinking' }];
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta')
      return [{ kind: 'thinking' }];
    if (method === 'item/started') {
      if (!item || typeof item.type !== 'string' || NOT_TOOLS.has(item.type)) return [];
      if (typeof item.id === 'string')
        items.set(item.id, { tool: toolOf(item), at: performance.now() });
      if (item.type === 'mcpToolCall' && typeof item.tool === 'string')
        return [
          {
            kind: 'tool_started',
            tool: item.tool,
            ...(typeof item.server === 'string' ? { server: item.server } : {}),
          },
        ];
      const paths = Array.isArray(item.changes)
        ? item.changes
            .map((change) => (change as { path?: unknown } | null)?.path)
            .filter((path): path is string => typeof path === 'string' && path.length > 0)
        : [];
      return [
        {
          kind: 'tool_started',
          tool: item.type,
          ...(typeof item.command === 'string' ? { command: item.command } : {}),
          ...(paths.length ? { paths } : {}),
        },
      ];
    }
    if (method === 'item/completed' && item && typeof item.id === 'string') {
      const started = items.get(item.id);
      if (!started) return [];
      items.delete(item.id);
      return [
        {
          kind: 'tool_finished',
          tool: started.tool,
          ok: item.status === 'completed',
          durationMs:
            typeof item.durationMs === 'number'
              ? item.durationMs
              : Math.max(0, Math.round(performance.now() - started.at)),
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        },
      ];
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta)
      return [{ kind: 'assistant_text', text: params.delta }];
    if (method === 'error' && params.willRetry === true) {
      const error = (params.error ?? {}) as Record<string, unknown>;
      const message = typeof error.message === 'string' ? error.message : null;
      // Codex says how many times only in its message, "Reconnecting... 2/5", and never how long.
      const counted = message ? /(\d+)\/(\d+)/.exec(message) : null;
      const info = error.codexErrorInfo;
      const detail =
        info && typeof info === 'object'
          ? (Object.values(info)[0] as Record<string, unknown>)
          : null;
      const status =
        detail && typeof detail.httpStatusCode === 'number' ? detail.httpStatusCode : null;
      return [
        {
          kind: 'api_retry',
          attempt: counted ? Number(counted[1]) : null,
          maxRetries: counted ? Number(counted[2]) : null,
          delayMs: null,
          status,
          message,
        },
      ];
    }
    return [];
  };
}

export function createCodexAdapter(config: CodexAdapterConfig = {}): CodexRuntimeAdapter {
  const providerName = adapterProviderName(config.provider, 'codex');
  const profile = config.permissionProfile ?? 'read-only';
  const networkAccess = config.networkAccess ?? false;
  const webSearch = config.webSearch ?? 'disabled';
  if (
    !['read-only', 'workspace-write'].includes(profile) ||
    typeof networkAccess !== 'boolean' ||
    !['disabled', 'cached', 'live'].includes(webSearch) ||
    (config.observeExecutionStop !== undefined && typeof config.observeExecutionStop !== 'function')
  )
    throw Object.assign(new Error('Invalid Codex host policy configuration'), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  // SPEC-0034 A01: a command can outlive the turn and the app-server in either profile, so the
  // terminal never shows that execution stopped.
  const coversExecution = false;
  const markers = codexStopMarkers(config);
  let startup: ReturnType<typeof markerStartupFiles> | undefined;
  const observeExecutionStop = markers?.observer ?? config.observeExecutionStop;
  requireStopProof('Codex adapter', coversExecution, { ...config, observeExecutionStop });
  // SPEC-0035: with the user's connection, each dispatch picks its profile, mode and network.
  const local = config.connection !== undefined ? connectionHome(config.connection?.home) : null;
  if (!local && (config.policy !== undefined || config.denyRead !== undefined))
    invalidConfig('policy and denyRead need connection');
  if (config.policy !== undefined && typeof config.policy !== 'function') invalidConfig('policy');
  if (config.hostHook !== undefined && (!local || typeof config.hostHook !== 'function'))
    invalidConfig('hostHook must be a function, with connection');
  if (config.hostHookCommand !== undefined && config.hostHook === undefined)
    invalidConfig('hostHookCommand needs hostHook');
  const hookCommand = checkHostHookCommand(config.hostHookCommand);
  const toolBridge = checkToolBridge(config.toolBridge) ?? defaultToolBridge();
  const proxyCheck = checkProxyCheck(config.proxyCheck);
  if (proxyCheck && !local) invalidConfig('proxyCheck needs connection');
  if (
    config.allowUnlistedModel !== undefined &&
    (typeof config.allowUnlistedModel !== 'boolean' || !local)
  )
    invalidConfig('allowUnlistedModel must be true or false, with connection');
  if (config.instructions !== undefined && typeof config.instructions !== 'function')
    invalidConfig('instructions must be a function');
  if (local && config.networkAccess !== undefined)
    invalidConfig('with connection, the policy sets the network, not networkAccess');
  const denyRead = checkDenyRead(config.denyRead);
  const hostMcp = hostMcpEntries(checkHostMcpServers(config.hostMcpServers));
  const info = checkClientInfo(config.clientInfo) ?? {
    name: 'agent_orch',
    title: 'Agent Orchestration',
    version: VERSION,
  };
  const profiles: RuntimeInput['permissionProfile'][] =
    local && !config.permissionProfile ? ['read-only', 'workspace-write'] : [profile];
  const acceptanceCapMs = timeout(config.requestTimeoutMs, 0) || null;
  const turnCapMs = timeout(config.turnTimeoutMs, 0) || null;
  const owned = new Map<string, Set<AppServerConnection>>();
  let stopping = false;
  // SPEC-0048 C01: each dispatch's running turn, for steers.
  const turns = new Map<
    string,
    {
      connection: AppServerConnection;
      threadId: string;
      turnId: string;
      compact: boolean;
      ended: boolean;
    }
  >();
  const prune = (sessionId: string) => {
    const connections = owned.get(sessionId);
    if (!connections) return false;
    for (const connection of connections) {
      if (!connection.hasActiveResources()) connections.delete(connection);
    }
    if (!connections.size) owned.delete(sessionId);
    return connections.size > 0;
  };
  return {
    provider: providerName,
    capabilities: () => ({
      provider: providerName,
      resume: true,
      interrupt: true,
      permissionProfiles: profiles,
      fork: true,
      // Model-changing forks stay disabled until separate native evidence exists.
      forkModelChange: false,
      // The Codex sandbox restricts writes and network, not reads.
      readFence: false,
      compact: true,
      toolBridge: true,
      inspect: true,
      steer: true,
      executionBudget: { version: 2, acceptanceCapMs, turnCapMs },
      executionEvidence: {
        version: 1,
        terminalCoversExecution: coversExecution || observeExecutionStop !== undefined,
      },
    }),
    hasActiveResources: (sessionId) => prune(sessionId),
    async steer(target, text, steerId) {
      const turn = turns.get(target.dispatchId);
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
      try {
        await turn.connection.callWhileReading(
          'turn/steer',
          {
            threadId: turn.threadId,
            expectedTurnId: turn.turnId,
            input: [{ type: 'text', text, text_elements: [] }],
            clientUserMessageId: steerId,
          },
          Math.max(1000, timeout(config.requestTimeoutMs, 30_000)),
        );
        return { status: 'accepted' };
      } catch (error) {
        // Only an error answer is a refusal; anything else may have reached Codex (S04).
        if (!(error instanceof AppServerRequestError)) throw error;
        const info = JSON.stringify(error.data ?? null);
        return {
          status: 'rejected',
          turnEnded: turn.ended,
          notSteerable: /activeTurnNotSteerable/.test(info),
          message: error.message,
        };
      }
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
    async inspect(input) {
      if (stopping) throw new Error('Codex adapter is closing');
      const started = performance.now();
      const child = spawn(
        config.command ?? 'codex',
        defensiveArgs(config.args ?? ['app-server'], realpathSync.native(input.workspace)),
        {
          cwd: input.workspace,
          env: {
            ...isolatedEnv(config.env),
            CODEX_HOME: local ?? managedHome(input.stateDir),
            CODEX_SQLITE_HOME: local ?? managedHome(input.stateDir),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const connection = new AppServerConnection(
        child,
        {
          remainingRequestMs: () =>
            input.signal.aborted ? 0 : input.timeoutMs - (performance.now() - started),
          closeTimeoutMs: timeout(config.closeTimeoutMs, 1000),
        },
        () => {},
      );
      const connections = owned.get(input.sessionId) ?? new Set<AppServerConnection>();
      connections.add(connection);
      owned.set(input.sessionId, connections);
      const abort = () => {
        void connection.close();
      };
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        await connection.request('initialize', {
          clientInfo: { name: 'agent_orch_inspect', version: VERSION },
        });
        connection.notify('initialized');
        const response = await connection.request('thread/read', {
          threadId: input.providerSessionId,
          includeTurns: true,
        });
        const thread = record(response.thread);
        if (thread?.id !== input.providerSessionId)
          return {
            status: 'mismatch',
            providerSessionId: input.providerSessionId,
            records: [],
            truncated: false,
            execution: 'unknown',
            detail: 'Native identity does not match original binding',
          };
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const records: Json[] = [];
        let bytes = 0;
        for (const turn of turns.slice(-input.limit)) {
          bytes += Buffer.byteLength(JSON.stringify(turn));
          if (bytes > 65536) break;
          records.push(turn as Json);
        }
        return {
          status: 'found',
          providerSessionId: input.providerSessionId,
          records,
          truncated: records.length < turns.length,
          execution: 'unknown',
          detail: 'Read-only native thread history; no resume or model request was issued',
        };
      } finally {
        input.signal.removeEventListener('abort', abort);
        await connection.close();
        prune(input.sessionId);
      }
    },
    async close() {
      stopping = true;
      const results = await Promise.allSettled(
        [...owned.values()].flatMap((connections) =>
          [...connections].map((connection) => connection.close()),
        ),
      );
      for (const sessionId of owned.keys()) prune(sessionId);
      const markersEnded = markers
        ? await markers.endAll(timeout(config.closeTimeoutMs, 1000))
        : true;
      if (!markersEnded || owned.size || results.some((result) => result.status === 'rejected')) {
        throw Object.assign(new Error('Codex owned app-server resources have not all exited'), {
          code: 'SHUTDOWN_INCOMPLETE',
        });
      }
    },
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      const started = performance.now();
      const budget = input.executionBudget;
      const reporter = input.reportExecutionEvidence;
      let sequence = 0;
      let turnSent = false;
      let threadId = input.providerSessionId;
      let turnId: string | null = null;
      let compactBoundary: Json | undefined;
      let observedTerminal: RuntimeTerminalEvent | undefined;
      let hostStopped = false;
      const report = (
        source: ExecutionEvidence['source'],
        localResources: ExecutionEvidence['localResources'],
        detail: string,
        terminal = observedTerminal,
      ) => {
        if (!reporter) return;
        const evidence: ExecutionEvidence = {
          version: 1,
          sequence: ++sequence,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider: providerName,
          providerSessionId: threadId,
          providerTurnId: turnId,
          source,
          observedAt: new Date().toISOString(),
          localResources,
          remoteExecution:
            !turnSent || (observedTerminal && coversExecution) || hostStopped
              ? 'stopped'
              : 'unknown',
          detail,
          ...(terminal ? { terminal } : {}),
        };
        try {
          reporter(evidence);
        } catch (error) {
          process.emitWarning(`Codex execution evidence callback failed: ${errorMessage(error)}`);
        }
      };
      const remaining = (value: number) => {
        if (!Number.isFinite(value)) throw new Error('Codex execution budget must be finite');
        return value;
      };
      const remainingTurnMs = () =>
        remaining(
          budget
            ? budget.remainingTurnMs()
            : (turnCapMs ?? 1800000) - (performance.now() - started),
        );
      const remainingAcceptanceMs = () =>
        Math.min(
          remainingTurnMs(),
          remaining(
            budget
              ? budget.remainingAcceptanceMs()
              : (acceptanceCapMs ?? 30000) - (performance.now() - started),
          ),
        );
      const preSubmission = (event: RuntimeTerminalEvent) => {
        report(
          'pre_submission',
          'stopped',
          'No business turn was submitted and no local resources were acquired',
          event,
        );
        return event;
      };
      if (stopping) {
        yield preSubmission({
          type: 'error',
          message: 'Codex adapter is closing',
          outcome: 'failed',
        });
        return;
      }
      if (!profiles.includes(input.permissionProfile)) {
        yield preSubmission({
          type: 'error',
          message: `Codex adapter supports ${profiles.join(' and ')} only`,
          outcome: 'failed',
        });
        return;
      }
      const dispatchProfile = input.permissionProfile;
      // SPEC-0035 F01 to F03: the host's choice for this dispatch, checked before anything starts.
      let policy: Exclude<ReturnType<typeof checkPolicy>, string> | null = null;
      // SPEC-0042 E04: the effort this dispatch runs with, decided before its thread.
      let reasoningEffort: CodexReasoningEffort | undefined;
      if (local) {
        let decided: unknown;
        try {
          decided = config.policy
            ? await config.policy(input)
            : { mode: dispatchProfile === 'read-only' ? 'plan' : 'auto', network: 'off' };
        } catch (error) {
          decided = `the policy callback failed: ${errorMessage(error)}`;
        }
        const checked = typeof decided === 'string' ? decided : checkPolicy(decided, input);
        if (typeof checked === 'string') {
          yield preSubmission({
            type: 'error',
            message: coded('CODEX_POLICY_INVALID', checked),
            outcome: 'failed',
          });
          return;
        }
        policy = checked;
      }
      // SPEC-0039 D01: a new thread takes the member's instructions; Codex keeps them after that.
      let developerInstructions: string | undefined;
      if (config.instructions && !input.providerSessionId && !input.forkSource) {
        let text: unknown;
        try {
          text = await config.instructions(input);
        } catch (error) {
          yield preSubmission({
            type: 'error',
            message: coded(
              'CODEX_INSTRUCTIONS_INVALID',
              `instructions failed: ${errorMessage(error)}`,
            ),
            outcome: 'failed',
          });
          return;
        }
        if (
          text !== undefined &&
          (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES)
        ) {
          yield preSubmission({
            type: 'error',
            message: coded(
              'CODEX_INSTRUCTIONS_INVALID',
              'instructions must return text of at most 256 KiB, or undefined',
            ),
            outcome: 'failed',
          });
          return;
        }
        if (text) developerInstructions = text;
      }
      // SPEC-0035 I03: commands are marked through zsh's and bash's startup files only.
      const loginShell = markers ? markedLoginShell() : null;
      if (markers && !loginShell) {
        yield preSubmission({
          type: 'error',
          message: coded(
            'STOP_MARKER_UNSUPPORTED_SHELL',
            'the login shell, which Codex runs commands with, is neither zsh nor bash',
          ),
          outcome: 'failed',
        });
        return;
      }
      if (input.signal.aborted) {
        yield preSubmission({ type: 'interrupted' });
        return;
      }
      if (budget && budget.policyVersion !== 2) {
        yield preSubmission({
          type: 'error',
          message: 'Codex execution budget policy is unsupported',
          outcome: 'failed',
        });
        return;
      }
      let home: string;
      let workspace: string;
      let writePaths: string[];
      let child: ChildProcessWithoutNullStreams;
      let bridge: Awaited<ReturnType<typeof createToolBridge>> | undefined;
      // SPEC-0035 A02: held from the app-server's start until its thread is open.
      let releaseStart = () => {};
      let hookChannel: Awaited<ReturnType<typeof hostHookChannel>> | undefined;
      let markerEnv: Record<string, string> = {};
      try {
        if (remainingAcceptanceMs() <= 0)
          throw new Error('Codex execution budget expired before startup');
        workspace = realpathSync.native(input.workspace);
        writePaths = input.writePaths?.map((path) => workspacePath(workspace, path)) ?? [workspace];
        let settings: string[] = [];
        if (local) {
          if (!isAbsolute(input.stateDir)) throw new Error('Codex stateDir must be absolute');
          mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
          const state = realpathSync.native(input.stateDir);
          if (overlaps(local, [workspace, state]))
            throw new Error(
              coded(
                'CODEX_HOME_OVERLAP',
                'the Codex home overlaps the workspace or state directory',
              ),
            );
          home = local;
          const denied = [local, state, ...resolveDenyRead(denyRead, workspace)];
          // SPEC-0041 C01: the proxy check runs in the sandbox, so it must be able to read itself.
          if (policy!.network !== 'off') {
            const blocked = deniedCheckPath(
              proxyCheck ? [proxyCheck.command, ...proxyCheck.args] : [process.execPath],
              denied,
            );
            if (blocked)
              throw new Error(
                coded(
                  'CODEX_NETWORK_PROXY_UNAVAILABLE',
                  `the proxy check needs ${blocked.path}, which lies in ${blocked.under}, a directory commands cannot read; put the check where commands can read it`,
                ),
              );
          }
          settings = profileSettings({
            write: dispatchProfile === 'workspace-write',
            writePaths,
            // Other instances under a host marker directory stay out of reach (SPEC-0035 B01).
            none: [
              ...denied,
              ...(markers && typeof config.stopMarker === 'object'
                ? [dirname(markers.directory)]
                : []),
            ],
            read: markers ? [markers.directory] : [],
            network: policy!.network,
          });
        } else home = managedHome(input.stateDir);
        if (markers) {
          // SPEC-0035 I02: every zsh and bash command opens the marker, then the user's own files.
          const marker = markers.prepare(input.dispatchId, loginShell!, workspace, input.stateDir);
          startup ??= markerStartupFiles(markers.directory);
          const host = isolatedEnv(config.env);
          markerEnv = {
            ORCHVIA_STOP_MARKER: marker.path,
            ZDOTDIR: startup.zdotdir,
            BASH_ENV: startup.bashEnv,
            ...(host.ZDOTDIR !== undefined ? { ORCHVIA_USER_ZDOTDIR: host.ZDOTDIR } : {}),
            ...(host.BASH_ENV !== undefined ? { ORCHVIA_USER_BASH_ENV: host.BASH_ENV } : {}),
          };
        }
        if (config.hostHook) {
          hookChannel = await hostHookChannel(config.hostHook, {
            taskId: input.taskId,
            sessionId: input.sessionId,
            dispatchId: input.dispatchId,
          });
          settings.push('-c', hostHookSetting(hookCommand));
        }
        if (input.orchestrationTools)
          bridge = await createToolBridge(input.orchestrationTools, input.signal);
        const env = {
          ...isolatedEnv(config.env),
          ...hostMcp.env,
          ...markerEnv,
          ...hookChannel?.env,
          CODEX_HOME: home,
          CODEX_SQLITE_HOME: home,
          ...bridge?.env,
        };
        // SPEC-0039 H05: Codex runs a tool whose hook does not answer, so the hook must work first.
        if (hookChannel) {
          const works = await hookChannel.probe(
            hostHookCommand(hookCommand),
            env,
            Math.max(1, Math.min(HOOK_PROBE_MS, remainingAcceptanceMs())),
          );
          if (works !== true) throw new Error(coded('HOST_HOOK_UNAVAILABLE', works));
        }
        if (local) releaseStart = await startLock(local, remainingAcceptanceMs());
        child = spawn(
          config.command ?? 'codex',
          [
            ...defensiveArgs(
              config.args ?? ['app-server'],
              workspace,
              bridge ? toolBridge : undefined,
              hostMcp,
              !!config.hostHook,
            ),
            '-c',
            `web_search="${webSearch}"`,
            ...settings,
          ],
          { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (error) {
        releaseStart();
        await bridge?.close();
        await hookChannel?.close();
        if (markers) await markers.end(input.dispatchId, () => 1000).catch(() => false);
        yield preSubmission({ type: 'error', message: errorMessage(error), outcome: 'failed' });
        return;
      }
      const connection = new AppServerConnection(
        child,
        {
          remainingRequestMs: remainingAcceptanceMs,
          closeTimeoutMs: timeout(config.closeTimeoutMs, 1_000),
        },
        () =>
          report(
            turnSent ? 'resource_observation' : 'pre_submission',
            'stopped',
            turnSent
              ? 'The owned app-server child exited; remote stopping requires a matching terminal'
              : 'The owned app-server child exited before any business turn was submitted',
          ),
      );
      const connections = owned.get(input.sessionId) ?? new Set<AppServerConnection>();
      connections.add(connection);
      owned.set(input.sessionId, connections);
      let terminal = false;
      let interruptSent = false;
      let bypassed = false;
      let hookBypassed = false;
      let answer = '';
      let sawUsage = false;
      // SPEC-0045 U01: whether every count so far is exact, so the result can say usage is complete.
      let usageExact = true;
      const seenUsage = new Set<string>();
      let previousUsageTotal: Message | null = null;
      // SPEC-0035 J01: each observation goes out when the next one arrives or the turn ends, so the
      // last one can carry the thread's totals, which the engine keeps once per dispatch.
      let held: RuntimeUsageEvent | null = null;
      // SPEC-0035 J01: Codex sends a resumed thread's previous usage again, and a compaction does
      // so under its own turn, so the totals the last dispatch reported count as already seen.
      const baseline = input.providerSessionId
        ? record(record(input.usageBaseline?.totals)?.codexThreadTotal)
        : null;
      if (baseline) {
        previousUsageTotal = baseline;
        seenUsage.add(JSON.stringify(baseline));
      }
      const permissionRequests = new Set<string>();
      // SPEC-0038 P01: a file change approval names only its item, which arrives first.
      const fileChanges = new Map<string, unknown>();
      const observeProgress = codexProgress();
      const requestInterrupt = (): void => {
        if (!input.signal.aborted || !threadId || !turnId || interruptSent) return;
        interruptSent = true;
        try {
          connection.send('turn/interrupt', { threadId, turnId });
        } catch {
          /* disconnect is reported as unknown below */
        }
      };
      input.signal.addEventListener('abort', requestInterrupt);
      try {
        let initialized: Message;
        try {
          initialized = await connection.request('initialize', { clientInfo: info });
        } catch (error) {
          // SPEC-0035 E01: a binary that cannot run is named as such.
          if (local && /ENOENT/.test(errorMessage(error)))
            throw new Error(coded('CODEX_NOT_FOUND', `${config.command ?? 'codex'} cannot be run`));
          throw error;
        }
        connection.notify('initialized');
        if (local) {
          const version = codexVersion(initialized.userAgent);
          if (!supportedVersion(version))
            throw new Error(
              coded(
                'CODEX_VERSION_UNSUPPORTED',
                `Codex ${version ?? 'of unknown version'} is older than ${MIN_CODEX_VERSION.join('.')}`,
              ),
            );
          if (policy!.network !== 'off') {
            // SPEC-0035 F04: the proxy is checked before the turn; nothing falls back without it.
            const socket = await proxyCheckSocket();
            let verdict: true | string;
            try {
              const check = await connection.request('command/exec', {
                // SPEC-0040 P02: the host's program, with its variables for this process alone.
                command: proxyCheck
                  ? [proxyCheck.command, ...proxyCheck.args, socket.path]
                  : [process.execPath, '-e', PROXY_CHECK_SCRIPT, socket.path],
                ...(proxyCheck && Object.keys(proxyCheck.env).length
                  ? { env: proxyCheck.env }
                  : {}),
                cwd: workspace,
                timeoutMs: 10_000,
              });
              verdict = proxyInForce(check.stdout);
            } catch (error) {
              verdict = `the check could not run: ${errorMessage(error)}`;
            } finally {
              socket.close();
            }
            if (verdict !== true)
              throw new Error(coded('CODEX_NETWORK_PROXY_UNAVAILABLE', verdict));
          }
          // SPEC-0035 R02: a hook Codex would not run leaves the host unasked.
          if (config.hostHook) {
            const hooks = await connection.request('hooks/list', { cwds: [workspace] });
            if (!hostHookTrusted(hooks, hookCommand))
              throw new Error(
                coded(
                  'HOST_HOOK_UNTRUSTED',
                  'the host hook is not trusted in the Codex home; call codexConnection().trustHostHook()',
                ),
              );
          }
          // SPEC-0042 E02: the model's efforts, hidden models and every page included.
          if (input.nativeAction !== 'compact') {
            let models: Record<string, unknown>[] | null = [];
            try {
              let cursor: string | null = null;
              for (let page = 0; page < 50; page++) {
                const listed: Message = await connection.request('model/list', {
                  includeHidden: true,
                  ...(cursor ? { cursor } : {}),
                });
                models.push(...((listed.data as Record<string, unknown>[] | undefined) ?? []));
                cursor = typeof listed.nextCursor === 'string' ? listed.nextCursor : null;
                if (!cursor) break;
              }
            } catch {
              models = null;
            }
            // SPEC-0043 M01: a model Codex does not name gets reduced tools; an empty list tells nothing.
            if (
              models?.length &&
              !config.allowUnlistedModel &&
              !models.some((item) => item.id === input.model || item.model === input.model)
            )
              throw new Error(
                coded(
                  'CODEX_MODEL_UNLISTED',
                  `${input.model} is not among Codex's models: ${models
                    .slice(0, 20)
                    .map((item) => String(item.id ?? item.model))
                    .join(', ')}`,
                ),
              );
            const resolved = resolveEffort(models, input.model, policy!.effort);
            if (typeof resolved === 'string')
              throw new Error(coded('CODEX_EFFORT_UNSUPPORTED', resolved));
            reasoningEffort = resolved;
          }
        }
        const approval = policy
          ? approvalPolicy(policy.mode, !!input.requestPermission)
          : input.requestPermission
            ? 'on-request'
            : 'never';
        const openThread = () =>
          connection.request(
            input.providerSessionId
              ? 'thread/resume'
              : input.forkSource
                ? 'thread/fork'
                : 'thread/start',
            {
              ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
              ...(!input.providerSessionId && input.forkSource
                ? {
                    threadId: input.forkSource.providerSessionId,
                    lastTurnId: input.forkSource.nativeCheckpoint,
                  }
                : {}),
              model: input.model,
              ...(developerInstructions ? { developerInstructions } : {}),
              cwd: input.workspace,
              ...(local ? {} : { sandbox: profile }),
              approvalPolicy: approval,
            },
          );
        let thread: Message;
        try {
          try {
            thread = await openThread();
          } catch (error) {
            // SPEC-0035 A03: a sign-in or sign-out on the same home can revoke a starting thread.
            if (!local || !/permission was revoked/i.test(errorMessage(error))) throw error;
            thread = await openThread();
          }
        } catch (error) {
          // SPEC-0042 C02: a bridge that does not start is named as the hook and the check are.
          if (/required MCP servers failed to initialize: agent_orch/.test(errorMessage(error)))
            throw new Error(coded('CODEX_TOOL_BRIDGE_UNAVAILABLE', errorMessage(error)));
          throw error;
        }
        releaseStart();
        threadId =
          typeof record(thread.thread)?.id === 'string'
            ? (record(thread.thread)!.id as string)
            : null;
        if (!threadId) throw new Error('Codex thread response lacks id');
        if (!input.providerSessionId && threadId === input.forkSource?.providerSessionId)
          throw new Error('Codex fork returned the source thread identity');
        if (input.signal.aborted) {
          yield { type: 'interrupted' };
          return;
        }
        const turn =
          input.nativeAction === 'compact'
            ? await connection.request('thread/compact/start', { threadId }, () => {
                turnSent = true;
              })
            : await connection.request(
                'turn/start',
                {
                  threadId,
                  input: [{ type: 'text', text: input.prompt }],
                  ...(policy?.effort !== undefined ? { effort: policy.effort } : {}),
                  cwd: input.workspace,
                  approvalPolicy: approval,
                  // With a connection, the named profile of the command line applies instead.
                  ...(local
                    ? {}
                    : {
                        sandboxPolicy:
                          profile === 'read-only'
                            ? { type: 'readOnly', networkAccess }
                            : {
                                type: 'workspaceWrite',
                                writableRoots: writePaths,
                                networkAccess,
                                excludeTmpdirEnvVar: true,
                                excludeSlashTmp: true,
                              },
                      }),
                },
                () => {
                  turnSent = true;
                },
              );
        turnId =
          typeof record(turn.turn)?.id === 'string' ? (record(turn.turn)!.id as string) : null;
        if (!turnId && input.nativeAction !== 'compact')
          throw new Error('Codex turn response lacks id');
        if (turnId)
          turns.set(input.dispatchId, {
            connection,
            threadId,
            turnId,
            compact: input.nativeAction === 'compact',
            ended: false,
          });
        yield { type: 'accepted', providerSessionId: threadId };
        requestInterrupt();
        while (true) {
          const message = await connection.next(remainingTurnMs);
          if (!message)
            throw new Error(
              connection.failure() ?? 'Codex app-server disconnected before turn completion',
            );
          const params = record(message.params);
          if (message.id !== undefined && typeof message.method === 'string') {
            const method = message.method;
            const key = `${typeof message.id}:${message.id}`;
            if (permissionRequests.has(key)) continue;
            permissionRequests.add(key);
            // SPEC-0035 G01: MCP tool approvals come as elicitations, answered with an action.
            const elicitation = method === 'mcpServer/elicitation/request';
            const decline = () =>
              connection.respond(
                message.id,
                elicitation ? { action: 'decline', content: {} } : { decision: 'decline' },
              );
            const supported = [
              'item/commandExecution/requestApproval',
              'item/fileChange/requestApproval',
              'mcpServer/elicitation/request',
            ].includes(method);
            const meta = record(params?._meta);
            if (
              !supported ||
              !params ||
              !turnId ||
              !input.requestPermission ||
              (elicitation
                ? meta?.codex_approval_kind !== 'mcp_tool_call' ||
                  (params.threadId !== undefined && params.threadId !== threadId)
                : params.threadId !== threadId || params.turnId !== turnId) ||
              (method === 'item/fileChange/requestApproval' &&
                dispatchProfile !== 'workspace-write')
            ) {
              decline();
              continue;
            }
            let permission = params as Json;
            if (method === 'item/fileChange/requestApproval') {
              const changes = checkedChanges(
                typeof params.itemId === 'string' ? fileChanges.get(params.itemId) : undefined,
                workspace,
                writePaths,
              );
              if (!changes) {
                decline();
                continue;
              }
              // SPEC-0035 D-35-3: acceptEdits takes a change inside the write paths itself.
              if (policy?.mode === 'acceptEdits') {
                connection.respond(message.id, { decision: 'accept' });
                continue;
              }
              permission = { ...(params as { [key: string]: Json }), changes };
            }
            const capturedTurn = turnId;
            void input
              .requestPermission({
                requestId: `${params.approvalId ?? params.itemId ?? key}:${key}`,
                toolName: method,
                permission,
                providerSessionId: threadId,
                providerTurnId: capturedTurn,
              })
              .then(
                (allow) =>
                  allow && !terminal && !input.signal.aborted && turnId === capturedTurn
                    ? connection.respond(
                        message.id,
                        elicitation ? { action: 'accept', content: {} } : { decision: 'accept' },
                      )
                    : decline(),
                () => decline(),
              );
            continue;
          }
          if (!params || params.threadId !== threadId) continue;
          if (input.nativeAction === 'compact' && !turnId && message.method === 'turn/started') {
            const started = record(params.turn);
            if (typeof started?.id === 'string') {
              turnId = started.id;
              requestInterrupt();
            }
          }
          if (!turnId) continue;
          if (params.turnId && params.turnId !== turnId) continue;
          // SPEC-0053 E04: what the turn does, for the host to show.
          if (input.reportProgress && typeof message.method === 'string')
            for (const progress of observeProgress(message.method, params))
              input.reportProgress(progress);
          if (message.method === 'item/started') {
            const item = record(params.item);
            // SPEC-0035 I04: a command under another shell holds no marker; the turn stops here.
            if (
              markers &&
              !bypassed &&
              item?.type === 'commandExecution' &&
              !markedCommand(item.command)
            ) {
              bypassed = true;
              try {
                connection.send('turn/interrupt', { threadId, turnId });
              } catch {
                /* a closed connection is reported below */
              }
            }
            // SPEC-0039 H06: Codex runs a call whose hook failed; the host never saw this one.
            if (
              hookChannel &&
              !hookBypassed &&
              (item?.type === 'commandExecution' || item?.type === 'fileChange') &&
              !(typeof item.id === 'string' && hookChannel.allowed.has(item.id))
            ) {
              hookBypassed = true;
              try {
                connection.send('turn/interrupt', { threadId, turnId });
              } catch {
                /* a closed connection is reported below */
              }
            }
            if (item?.type === 'fileChange' && typeof item.id === 'string')
              fileChanges.set(item.id, item);
          }
          if (message.method === 'item/completed') {
            const item = record(params.item);
            if (item?.type === 'contextCompaction') compactBoundary = item as Json;
            if (item?.type === 'agentMessage' && typeof item.text === 'string') answer = item.text;
          } else if (message.method === 'thread/tokenUsage/updated') {
            const tokenUsage = record(params.tokenUsage);
            const last = record(tokenUsage?.last);
            const total = record(tokenUsage?.total);
            if (!last) continue;
            const signature = total ? JSON.stringify(total) : JSON.stringify(last);
            if (seenUsage.has(signature)) continue;
            seenUsage.add(signature);
            sawUsage = true;
            const totalCount = nonnegativeInt(total?.totalTokens);
            const tokenDelta = (key: string): number | null => {
              if (!total) return null;
              if (!previousUsageTotal) return nonnegativeInt(last[key]);
              const current = nonnegativeInt(total[key]),
                previous = nonnegativeInt(previousUsageTotal[key]);
              return current === null || previous === null || current < previous
                ? null
                : current - previous;
            };
            const counted = ['inputTokens', 'cachedInputTokens', 'outputTokens'];
            // Without a starting total the first count is the last request alone, which is the
            // whole of it only on a thread this dispatch started, and only if the total says so.
            const exact =
              !!total &&
              counted.every((key) => tokenDelta(key) !== null) &&
              (previousUsageTotal !== null ||
                (!input.providerSessionId &&
                  !input.forkSource &&
                  counted.every(
                    (key) =>
                      nonnegativeInt(total[key]) !== null &&
                      nonnegativeInt(total[key]) === nonnegativeInt(last[key]),
                  )));
            if (!exact) usageExact = false;
            const observation: RuntimeUsageEvent = {
              type: 'usage',
              usageId: `${turnId}:total:${totalCount ?? 'unknown'}:${seenUsage.size}`,
              usage: {
                inputTokens: tokenDelta('inputTokens'),
                cachedInputTokens: tokenDelta('cachedInputTokens'),
                cacheWriteInputTokens: tokenDelta('cacheWriteInputTokens'),
                outputTokens: tokenDelta('outputTokens'),
                raw: {
                  ...(last as Record<string, Json>),
                  _cumulative: total as Json,
                  _basis: previousUsageTotal
                    ? 'cumulative_delta'
                    : total
                      ? 'last_observed_request'
                      : 'unknown_source_scope',
                  ...(reasoningEffort ? { _reasoningEffort: { ...reasoningEffort } } : {}),
                },
              },
            };
            previousUsageTotal = total;
            if (held) {
              input.reportUsage?.(held);
              yield held;
            }
            held = observation;
          } else if (message.method === 'turn/completed') {
            const completed = record(params.turn);
            if (completed?.id !== turnId) continue;
            terminal = true;
            const running = turns.get(input.dispatchId);
            if (running) running.ended = true;
            if (completed.status === 'interrupted') observedTerminal = { type: 'interrupted' };
            else if (completed.status === 'failed')
              observedTerminal = {
                type: 'error',
                message:
                  typeof record(completed.error)?.message === 'string'
                    ? (record(completed.error)!.message as string)
                    : 'Codex turn failed',
                outcome: 'failed',
              };
            else if (completed.status === 'completed')
              observedTerminal =
                input.nativeAction === 'compact' && !compactBoundary
                  ? {
                      type: 'error',
                      outcome: 'unknown',
                      message: 'Codex compaction lacks a completed contextCompaction item',
                    }
                  : {
                      type: 'result',
                      text: answer,
                      providerSessionId: threadId,
                      nativeCheckpoint: turnId,
                      ...(input.nativeAction === 'compact'
                        ? { compacted: { kind: 'boundary', evidence: compactBoundary! } }
                        : {}),
                    };
            // SPEC-0035 I04: without the marker nothing proves the command stopped.
            if (bypassed)
              observedTerminal = {
                type: 'error',
                outcome: 'unknown',
                message: coded(
                  'STOP_MARKER_BYPASSED',
                  'a command ran with a shell that does not open the stop marker; the owner reconciles the dispatch',
                ),
              };
            if (hookBypassed)
              observedTerminal = {
                type: 'error',
                outcome: 'unknown',
                message: coded(
                  'HOST_HOOK_BYPASSED',
                  'Codex started a command or file change that the host hook did not allow; the owner reconciles the dispatch',
                ),
              };
            if (observedTerminal)
              report(
                'runtime_terminal',
                connection.hasActiveResources() ? 'unknown' : 'stopped',
                'Matching native terminal; execution still requires the host stop observer',
              );
            const stopObservation =
              !coversExecution && observedTerminal && !bypassed
                ? observeRuntimeStop(
                    observeExecutionStop,
                    {
                      target: {
                        taskId: input.taskId,
                        sessionId: input.sessionId,
                        dispatchId: input.dispatchId,
                        generation: input.generation ?? 1,
                        provider: providerName,
                        providerSessionId: threadId,
                        providerTurnId: turnId,
                      },
                      terminal: observedTerminal,
                    },
                    timeout(config.closeTimeoutMs, 1000),
                    () => {
                      hostStopped = true;
                      report(
                        'resource_observation',
                        connection.hasActiveResources() ? 'unknown' : 'stopped',
                        'Host observed full Codex execution stop for this dispatch',
                      );
                    },
                  )
                : Promise.resolve(true);
            if (held) {
              const last: RuntimeUsageEvent = previousUsageTotal
                ? { ...held, sessionTotals: { codexThreadTotal: previousUsageTotal as Json } }
                : held;
              held = null;
              input.reportUsage?.(last);
              yield last;
            }
            const [exited] = await Promise.all([connection.close(), stopObservation]);
            if (!exited) {
              yield {
                type: 'error',
                message: 'Codex app-server process did not exit after SIGKILL',
                outcome: 'unknown',
              };
              return;
            }
            if (remainingTurnMs() <= 0) {
              yield {
                type: 'error',
                message: 'Codex app-server turn terminal timed out',
                outcome: 'unknown',
              };
            } else if (observedTerminal?.type === 'result') {
              if (!sawUsage) {
                const observation: RuntimeUsageEvent = {
                  type: 'usage',
                  usageId: `${turnId}:missing`,
                  usage: {
                    inputTokens: null,
                    cachedInputTokens: null,
                    cacheWriteInputTokens: null,
                    outputTokens: null,
                    raw: reasoningEffort ? { _reasoningEffort: { ...reasoningEffort } } : null,
                  },
                };
                input.reportUsage?.(observation);
                yield observation;
              }
              // SPEC-0045 U01, invariant 3: decided after the turn's last usage observation.
              const usageComplete =
                sawUsage && usageExact && !compactBoundary && input.nativeAction !== 'compact';
              yield usageComplete ? { ...observedTerminal, usageComplete: true } : observedTerminal;
            } else if (observedTerminal) {
              yield observedTerminal;
            } else {
              yield {
                type: 'error',
                message: 'Codex turn ended with invalid status',
                outcome: 'unknown',
              };
            }
            return;
          }
        }
      } catch (error) {
        if (held) {
          input.reportUsage?.(held);
          yield held;
          held = null;
        }
        if (!terminal) {
          const exited = await connection.close();
          if (!exited)
            report(
              turnSent ? 'resource_observation' : 'pre_submission',
              'unknown',
              'Owned app-server cleanup has not confirmed process exit',
            );
          yield {
            type: 'error',
            message: exited
              ? errorMessage(error)
              : 'Codex app-server process did not exit after SIGKILL',
            outcome: turnSent || !exited ? 'unknown' : 'failed',
          };
        }
      } finally {
        turns.delete(input.dispatchId);
        releaseStart();
        input.signal.removeEventListener('abort', requestInterrupt);
        await bridge?.close();
        await hookChannel?.close();
        await connection.close();
        // SPEC-0034 A03: whatever a dispatch left behind ends with it, proven stopped or not.
        if (markers)
          await markers.end(input.dispatchId, () => timeout(config.closeTimeoutMs, 1000));
        prune(input.sessionId);
      }
    },
  };
}
