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
  RuntimeUsageEvent,
} from '../../engine/src/types.ts';
import { observeRuntimeStop, requireStopProof } from '../../engine/src/stop-observation.ts';
import {
  StopMarkers,
  type StopMarkerObservation,
  type StopMarkerSyncResult,
} from '../../engine/src/stop-marker.ts';
import { adapterProviderName } from '../../engine/src/runtime.ts';
import { contains, workspacePath } from '../../engine/src/verification.ts';
import { createToolBridge } from '../../engine/src/tool-bridge.ts';
import { TOOL_NAMES } from '../../engine/src/tools.ts';
import { VERSION } from '../../engine/src/version.ts';
import { AppServerConnection, errorMessage, record, type Message } from './app-server.ts';
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
  hostHookChannel,
  hostHookSetting,
  hostHookTrusted,
  markedCommand,
  markedLoginShell,
  markerStartupFiles,
  type CodexHostHook,
} from './local.ts';
export type {
  CodexClientInfo,
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
  type StopMarkerAcknowledgement,
  type StopMarkerRootSyncResult,
  type StopMarkerDispatch,
  type StopMarkerObservation,
  type StopMarkerReason,
  type StopMarkerSweep,
  type StopMarkerSweepOptions,
  type StopMarkerSyncResult,
} from '../../engine/src/stop-marker.ts';
export { codexConnection, type CodexConnection } from './connection.ts';

/** The real location of a path that may not exist yet, or null when it cannot be resolved. */
function canonicalPath(path: string): string | null {
  const rest: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...rest);
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
}

function timeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function managedHome(stateDir: string): string {
  if (!isAbsolute(stateDir)) throw new Error('Codex stateDir must be absolute');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = realpathSync(stateDir);
  const home = join(state, 'runtime', 'codex');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const actual = realpathSync(home);
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

function defensiveArgs(
  args: string[],
  workspace: string,
  bridge = false,
  host: { entries: string[]; exclude: string[] } = { entries: [], exclude: [] },
  hooks = false,
): string[] {
  // SPEC-0035 G02: the bridge's tools act on the dispatch's own grant, so Codex asks for no
  // approval of them; under `never` it would refuse every call.
  const servers = [
    ...(bridge
      ? [
          `agent_orch={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(fileURLToPath(new URL('../../engine/src/tool-bridge.ts', import.meta.url)))}],env_vars=["AGENT_ORCH_BRIDGE_TOKEN","AGENT_ORCH_BRIDGE_SOCKET"],enabled_tools=${JSON.stringify(TOOL_NAMES)},required=true,default_tools_approval_mode="approve"}`,
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
      executionBudget: { version: 2, acceptanceCapMs, turnCapMs },
      executionEvidence: {
        version: 1,
        terminalCoversExecution: coversExecution || observeExecutionStop !== undefined,
      },
    }),
    hasActiveResources: (sessionId) => prune(sessionId),
    endStopMarkersSync(timeoutMs: number): StopMarkerSyncResult {
      return markers?.endAllSync(timeoutMs) ?? { stopped: true, holders: 0, ended: 0 };
    },
    async inspect(input) {
      if (stopping) throw new Error('Codex adapter is closing');
      const started = performance.now();
      const child = spawn(
        config.command ?? 'codex',
        defensiveArgs(config.args ?? ['app-server'], realpathSync(input.workspace)),
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
      let policy: Required<CodexDispatchPolicy> | null = null;
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
        workspace = realpathSync(input.workspace);
        writePaths = input.writePaths?.map((path) => workspacePath(workspace, path)) ?? [workspace];
        let settings: string[] = [];
        if (local) {
          if (!isAbsolute(input.stateDir)) throw new Error('Codex stateDir must be absolute');
          mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
          const state = realpathSync(input.stateDir);
          if (overlaps(local, [workspace, state]))
            throw new Error(
              coded(
                'CODEX_HOME_OVERLAP',
                'the Codex home overlaps the workspace or state directory',
              ),
            );
          home = local;
          settings = profileSettings({
            write: dispatchProfile === 'workspace-write',
            writePaths,
            // Other instances under a host marker directory stay out of reach (SPEC-0035 B01).
            none: [
              local,
              state,
              ...resolveDenyRead(denyRead, workspace),
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
          settings.push('-c', hostHookSetting());
        }
        if (input.orchestrationTools)
          bridge = await createToolBridge(input.orchestrationTools, input.signal);
        if (local) releaseStart = await startLock(local, remainingAcceptanceMs());
        child = spawn(
          config.command ?? 'codex',
          [
            ...defensiveArgs(
              config.args ?? ['app-server'],
              workspace,
              !!bridge,
              hostMcp,
              !!config.hostHook,
            ),
            '-c',
            `web_search="${webSearch}"`,
            ...settings,
          ],
          {
            cwd: workspace,
            env: {
              ...isolatedEnv(config.env),
              ...hostMcp.env,
              ...markerEnv,
              ...hookChannel?.env,
              CODEX_HOME: home,
              CODEX_SQLITE_HOME: home,
              ...bridge?.env,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
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
      let answer = '';
      let sawUsage = false;
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
                command: [process.execPath, '-e', PROXY_CHECK_SCRIPT, socket.path],
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
            if (!hostHookTrusted(hooks))
              throw new Error(
                coded(
                  'HOST_HOOK_UNTRUSTED',
                  'the host hook is not trusted in the Codex home; call codexConnection().trustHostHook()',
                ),
              );
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
              cwd: input.workspace,
              ...(local ? {} : { sandbox: profile }),
              approvalPolicy: approval,
            },
          );
        let thread: Message;
        try {
          thread = await openThread();
        } catch (error) {
          // SPEC-0035 A03: a sign-in or sign-out on the same home can revoke a starting thread.
          if (!local || !/permission was revoked/i.test(errorMessage(error))) throw error;
          thread = await openThread();
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
                    raw: null,
                  },
                };
                input.reportUsage?.(observation);
                yield observation;
              }
              yield observedTerminal;
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
