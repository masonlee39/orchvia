import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import os, { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInput } from '../../engine/src/types.ts';
import { contains } from '../../engine/src/verification.ts';

// SPEC-0035: the local Codex CLI as a member. What the adapter needs besides the app-server
// connection: the connection home, the start lock, versions, the dispatch policy, the settings
// that carry them, and the network proxy check.

export type CodexMode = 'plan' | 'default' | 'acceptEdits' | 'auto';
export type CodexNetwork = 'off' | 'direct' | { domains: string[] };
export interface CodexDispatchPolicy {
  mode: CodexMode;
  network?: CodexNetwork;
}
export type CodexHostMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string>; approval?: 'ask' | 'approve' }
  | { url: string; token?: string; approval?: 'ask' | 'approve' };
export interface CodexClientInfo {
  name: string;
  title?: string;
  version?: string;
}

/** The oldest Codex CLI verified with these settings (SPEC-0035 E01). */
export const MIN_CODEX_VERSION = [0, 153, 4] as const;

export function invalidConfig(what: string): never {
  throw Object.assign(new Error(`Invalid Codex adapter configuration: ${what}`), {
    code: 'INVALID_ADAPTER_CONFIG',
  });
}

/** A2-style failure text: the code first, so hosts can match it without a new event field. */
export function coded(code: string, detail: string): string {
  return `${code}: ${detail}`;
}

/** SPEC-0035 A01: an existing absolute directory, by its real path. */
export function connectionHome(home: unknown): string {
  if (typeof home !== 'string' || !isAbsolute(home))
    invalidConfig('connection.home must be absolute');
  let real: string;
  try {
    real = realpathSync(home);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    invalidConfig('connection.home must be an existing directory');
  }
  return real;
}

/** A01: the home may neither contain nor lie inside a workspace or state directory. */
export function overlaps(home: string, others: readonly string[]): boolean {
  return others.some((other) => contains(home, other) || contains(other, home));
}

export function clientInfo(value: unknown): CodexClientInfo | undefined {
  if (value === undefined) return undefined;
  const info = value as CodexClientInfo;
  if (
    !info ||
    typeof info !== 'object' ||
    typeof info.name !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(info.name) ||
    (info.title !== undefined && typeof info.title !== 'string') ||
    (info.version !== undefined && typeof info.version !== 'string')
  )
    invalidConfig('clientInfo');
  return {
    name: info.name,
    ...(info.title ? { title: info.title } : {}),
    ...(info.version ? { version: info.version } : {}),
  };
}

// A02: app-servers on one home start one at a time, in this process and across processes.
const chains = new Map<string, Promise<void>>();

function lockPath(home: string): string {
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 24);
  return join(tmpdir(), `orchvia-codex-${digest}.lock`);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
/** Takes the file lock, removing one whose process is gone; false when `deadline` passes. */
async function takeFileLock(path: string, deadline: number): Promise<boolean> {
  while (true) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) {
        unlinkSync(path);
        continue;
      }
    } catch {
      continue; // removed meanwhile
    }
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Takes the home's start lock and returns its release; rejects with CODEX_START_LOCK_TIMEOUT when
 * the lock is not free within `timeoutMs`. A release is harmless to call twice.
 */
export async function startLock(home: string, timeoutMs: number): Promise<() => void> {
  const deadline = performance.now() + timeoutMs;
  const previous = chains.get(home) ?? Promise.resolve();
  let releaseChain!: () => void;
  const mine = new Promise<void>((resolve) => (releaseChain = resolve));
  const chain = previous.then(() => mine);
  chains.set(home, chain);
  const releaseInProcess = () => {
    releaseChain();
    if (chains.get(home) === chain) chains.delete(home);
  };
  const path = lockPath(home);
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      previous,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                coded('CODEX_START_LOCK_TIMEOUT', 'another start on this home did not finish'),
              ),
            ),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (!(await takeFileLock(path, deadline)))
      throw new Error(
        coded('CODEX_START_LOCK_TIMEOUT', 'another process is starting Codex on this home'),
      );
  } catch (error) {
    releaseInProcess();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    releaseInProcess();
  };
}

/** Runs `start` holding the home's start lock until it settles. */
export async function withStartLock<T>(
  home: string,
  timeoutMs: number,
  start: () => Promise<T>,
): Promise<T> {
  const release = await startLock(home, timeoutMs);
  try {
    return await start();
  } finally {
    release();
  }
}

/** E01: the version in `initialize`'s `userAgent` (`<client>/<version> (…)`). */
export function codexVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null;
  return /^[^/\s]+\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? null;
}
export function supportedVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > MIN_CODEX_VERSION[i]!) return true;
    if (parts[i]! < MIN_CODEX_VERSION[i]!) return false;
  }
  return true;
}

const DOMAIN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

/**
 * F01 to F03: the dispatch's mode and network, checked against its permission profile and the
 * host's approval callback; a string is the reason it is refused (CODEX_POLICY_INVALID).
 */
export function checkPolicy(
  value: unknown,
  input: Pick<RuntimeInput, 'permissionProfile' | 'requestPermission'>,
): Required<CodexDispatchPolicy> | string {
  const policy = value as CodexDispatchPolicy;
  if (!policy || typeof policy !== 'object') return 'the policy is not an object';
  const { mode } = policy;
  const network = policy.network ?? 'off';
  if (!['plan', 'default', 'acceptEdits', 'auto'].includes(mode))
    return `mode ${JSON.stringify(mode)} is not supported`;
  if ((mode === 'plan') !== (input.permissionProfile === 'read-only'))
    return `mode ${mode} does not fit the ${input.permissionProfile} profile`;
  if ((mode === 'default' || mode === 'acceptEdits') && !input.requestPermission)
    return `mode ${mode} asks the host, and the dispatch has no approval callback`;
  if (network !== 'off' && network !== 'direct') {
    const domains = (network as { domains?: unknown })?.domains;
    if (
      !Array.isArray(domains) ||
      !domains.length ||
      domains.length > 256 ||
      domains.some(
        (domain) => typeof domain !== 'string' || domain.length > 253 || !DOMAIN.test(domain),
      )
    )
      return 'network must be off, direct or { domains } with valid domain names';
  }
  if (mode === 'plan' && network !== 'off') return 'mode plan has no network';
  return { mode, network };
}

export function approvalPolicy(mode: CodexMode, asks: boolean): string {
  if (mode === 'plan') return 'never';
  if (mode === 'default' || mode === 'acceptEdits') return 'untrusted';
  return asks ? 'on-request' : 'never';
}

const toml = (value: string) => JSON.stringify(value);

/**
 * B01, F03: the named permission profile and its network, as `-c` settings. `none` wins over the
 * readable root and, for a path inside the workspace, over the workspace's write access.
 */
export function profileSettings(options: {
  write: boolean;
  writePaths: readonly string[];
  none: readonly string[];
  /** Readable even inside a writable directory: the stop marker instance (SPEC-0035 I02). */
  read?: readonly string[];
  network: CodexNetwork;
}): string[] {
  const filesystem: string[] = ['":root"="read"'];
  if (options.write) {
    for (const path of options.writePaths) filesystem.push(`${toml(path)}="write"`);
    filesystem.push('":tmpdir"="write"');
  }
  for (const path of options.read ?? []) filesystem.push(`${toml(path)}="read"`);
  for (const path of options.none) filesystem.push(`${toml(path)}="none"`);
  let network = '';
  if (options.network === 'direct')
    network = ',network={enabled=true,mode="full",allow_local_binding=true,domains={"*"="allow"}}';
  else if (options.network !== 'off')
    network = `,network={enabled=true,mode="full",domains={${options.network.domains.map((domain) => `${toml(domain)}="allow"`).join(',')}}}`;
  return [
    '-c',
    'default_permissions="orchvia"',
    '-c',
    `permissions.orchvia={filesystem={${filesystem.join(',')}}${network}}`,
    ...(options.network === 'off' ? [] : ['-c', 'features.network_proxy=true']),
  ];
}

/**
 * H01: host MCP servers as `mcp_servers` entries, and the environment that carries their secrets;
 * the names in `exclude` never reach commands.
 */
export function hostMcpEntries(servers: Record<string, CodexHostMcpServer> | undefined): {
  entries: string[];
  env: Record<string, string>;
  exclude: string[];
} {
  const entries: string[] = [],
    env: Record<string, string> = {},
    exclude: string[] = [];
  let index = 0;
  for (const [name, server] of Object.entries(servers ?? {})) {
    const approval = server.approval === 'approve' ? 'approve' : 'prompt';
    if ('url' in server) {
      let fields = `url=${toml(server.url)}`;
      if (server.token !== undefined) {
        const variable = `ORCHVIA_HOST_MCP_TOKEN_${index++}`;
        env[variable] = server.token;
        exclude.push(variable);
        fields += `,bearer_token_env_var=${toml(variable)}`;
      }
      entries.push(`${toml(name)}={${fields},default_tools_approval_mode="${approval}"}`);
    } else {
      const names = Object.keys(server.env ?? {});
      Object.assign(env, server.env);
      exclude.push(...names);
      entries.push(
        `${toml(name)}={command=${toml(server.command)},args=[${(server.args ?? []).map(toml).join(',')}]${names.length ? `,env_vars=[${names.map(toml).join(',')}]` : ''},default_tools_approval_mode="${approval}"}`,
      );
    }
  }
  return { entries, env, exclude };
}

export function checkHostMcpServers(
  value: unknown,
): Record<string, CodexHostMcpServer> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidConfig('hostMcpServers');
  const variables = new Set<string>();
  for (const [name, server] of Object.entries(value as Record<string, unknown>)) {
    const entry = server as Record<string, unknown>;
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      name === 'agent_orch' ||
      !entry ||
      typeof entry !== 'object'
    )
      invalidConfig(`hostMcpServers.${name}`);
    if (entry.approval !== undefined && entry.approval !== 'ask' && entry.approval !== 'approve')
      invalidConfig(`hostMcpServers.${name}.approval`);
    if ('url' in entry) {
      let url: URL;
      try {
        url = new URL(String(entry.url));
      } catch {
        invalidConfig(`hostMcpServers.${name}.url`);
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        (entry.token !== undefined && typeof entry.token !== 'string')
      )
        invalidConfig(`hostMcpServers.${name}`);
    } else {
      if (typeof entry.command !== 'string' || !entry.command)
        invalidConfig(`hostMcpServers.${name}.command`);
      if (
        entry.args !== undefined &&
        (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))
      )
        invalidConfig(`hostMcpServers.${name}.args`);
      const env = entry.env as Record<string, unknown> | undefined;
      if (env !== undefined) {
        if (!env || typeof env !== 'object') invalidConfig(`hostMcpServers.${name}.env`);
        for (const [key, text] of Object.entries(env)) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof text !== 'string' ||
            variables.has(key)
          )
            invalidConfig(`hostMcpServers.${name}.env.${key}`);
          variables.add(key);
        }
      }
    }
  }
  return value as Record<string, CodexHostMcpServer>;
}

/** B02: `denyRead` as the Claude adapter takes it: absolute or workspace-relative paths. */
export function checkDenyRead(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string' || !path))
    invalidConfig('denyRead');
  return value as string[];
}
export function resolveDenyRead(paths: readonly string[], workspace: string): string[] {
  return paths.map((path) => {
    const absolute = resolve(workspace, path);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  });
}

/**
 * F04: what a command sees when Codex's network proxy is in force, run with `command/exec` under
 * the dispatch's profile before its turn: the proxy variables, a refused Unix socket, and a refused
 * direct connection (to TEST-NET-1, which nothing answers).
 */
export const PROXY_CHECK_SCRIPT = `
const net = require('node:net');
const result = { proxy: !!(process.env.HTTPS_PROXY || process.env.https_proxy) };
const attempt = (options) => new Promise((done) => {
  const socket = net.connect(options);
  const timer = setTimeout(() => { socket.destroy(); done('timeout'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); done('connected'); });
  socket.on('error', (error) => { clearTimeout(timer); done(error.code || 'error'); });
});
(async () => {
  result.unix = await attempt({ path: process.argv[1] });
  // TEST-NET-1: an address nothing answers, reached only by a direct connection.
  result.outside = await attempt({ host: [192, 0, 2, 1].join('.'), port: 80 });
  process.stdout.write(JSON.stringify(result));
})();
`;

/** The Unix socket the check tries to reach; the caller closes it. */
export async function proxyCheckSocket(): Promise<{ path: string; close: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), 'orchvia-proxy-'));
  const path = join(directory, 's');
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    path,
    close: () => {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Whether the check's output shows the proxy in force; otherwise why not. */
export function proxyInForce(output: unknown): true | string {
  let result: { proxy?: unknown; unix?: unknown; outside?: unknown };
  try {
    result = JSON.parse(String(output));
  } catch {
    return 'the check printed no result';
  }
  if (result.proxy !== true) return 'commands have no proxy';
  // Seatbelt refuses with EPERM (EACCES on some systems); Linux's sandbox leaves a command no
  // route but the proxy's, so a direct connection is unreachable. Network without the proxy
  // connects or times out instead, and shows no proxy variables.
  const refused = (code: unknown) =>
    code === 'EPERM' || code === 'EACCES' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH';
  if (!refused(result.unix))
    return `a Unix socket connection was ${String(result.unix)}, not refused`;
  if (!refused(result.outside))
    return `a direct connection was ${String(result.outside)}, not refused`;
  return true;
}

// ---- SPEC-0035 R: the host's hook ----

/** What the host's hook sees of a tool call before it runs. */
export interface CodexHookEvent {
  /** A command, a file change, or another tool. */
  kind: 'command' | 'fileChange' | 'tool';
  /** Codex's name for the tool: `Bash`, `apply_patch`, an MCP tool. */
  tool: string;
  command?: string;
  patch?: string;
  input?: unknown;
  taskId: string;
  sessionId: string;
  dispatchId: string;
}
export type CodexHookDecision = { allow: true } | { allow: false; reason?: string };
export type CodexHostHook = (
  event: CodexHookEvent,
) => CodexHookDecision | Promise<CodexHookDecision>;

/** The key Codex gives the one hook Orchvia passes on the command line. */
export const HOST_HOOK_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';

const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The hook command of SPEC-0035, and still the default: this Node running the adapter's hook
 * program. Codex trusts a hook by a hash of its definition, so a dispatch and `trustHostHook` must
 * pass the same command.
 */
export function hostHookCommand(command?: string): string {
  if (command !== undefined) return command;
  const program = fileURLToPath(new URL('./hook.ts', import.meta.url));
  return `${quoteShell(process.execPath)} ${quoteShell(program)}`;
}
export function hostHookSetting(command?: string): string {
  return `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(hostHookCommand(command))},async=false,timeoutSec=600}]}]`;
}

/** SPEC-0039 H01: a host's own hook command. */
export function checkHostHookCommand(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value))
    invalidConfig('hostHookCommand must be one line of at most 4096 characters');
  return value;
}

/**
 * SPEC-0039 H02: the command that runs `program` with `runtime`, with `env` as a prefix that
 * applies to the hook process alone, each part quoted for a POSIX shell, which Codex runs it with.
 */
export function hostHookCommandFor(options: {
  runtime: string;
  program: string;
  env?: Record<string, string>;
}): string {
  const { runtime, program, env = {} } = options ?? ({} as never);
  if (typeof runtime !== 'string' || !isAbsolute(runtime))
    invalidConfig('hostHookCommandFor needs an absolute runtime');
  if (typeof program !== 'string' || !isAbsolute(program))
    invalidConfig('hostHookCommandFor needs an absolute program');
  if (typeof env !== 'object' || env === null || Array.isArray(env))
    invalidConfig('hostHookCommandFor env must be an object');
  const prefix = Object.entries(env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      invalidConfig(`hostHookCommandFor env has an invalid name ${JSON.stringify(name)}`);
    if (typeof value !== 'string' || /[\0\r\n]/.test(value))
      invalidConfig(`hostHookCommandFor env ${name} must be one line of text`);
    return `${name}=${quoteShell(value)}`;
  });
  return [...prefix, quoteShell(runtime), quoteShell(program)].join(' ');
}

/**
 * SPEC-0039 H03: the hook program a host copies beside its own files: the package's `hook.mjs`,
 * which runs with no package beside it, or the source's `hook.ts` in the repository.
 */
export function hostHookProgram(): string {
  const built = fileURLToPath(new URL('./hook.mjs', import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL('./hook.ts', import.meta.url));
}

/** The hook `hooks/list` shows for `command`, if any. */
export function listedHostHook(list: unknown, command?: string): Record<string, unknown> | null {
  const data = (list as { data?: { hooks?: Record<string, unknown>[] }[] })?.data ?? [];
  const wanted = hostHookCommand(command);
  for (const entry of data)
    for (const hook of entry.hooks ?? [])
      if (hook.key === HOST_HOOK_KEY && hook.command === wanted) return hook;
  return null;
}

/** Whether `hooks/list` shows Orchvia's hook trusted. */
export function hostHookTrusted(list: unknown, command?: string): boolean {
  const hook = listedHostHook(list, command);
  return hook?.trustStatus === 'trusted' || hook?.trustStatus === 'managed';
}

function hookEvent(
  input: Record<string, unknown>,
  ids: Pick<CodexHookEvent, 'taskId' | 'sessionId' | 'dispatchId'>,
): CodexHookEvent {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const text = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
  if (tool === 'Bash') return { kind: 'command', tool, command: text, ...ids };
  if (tool === 'apply_patch') return { kind: 'fileChange', tool, patch: text, ...ids };
  return { kind: 'tool', tool, input: toolInput, ...ids };
}

/** What the channel gives a dispatch: the hook's environment, the calls allowed, and the probe. */
export interface HostHookChannel {
  env: Record<string, string>;
  /** SPEC-0039 H06: the `tool_use_id` of each call the host allowed. */
  allowed: ReadonlySet<string>;
  /**
   * SPEC-0039 H05: runs `command` as Codex would, with a probe the channel refuses without asking
   * the host; true when the probe came through and the command printed a denial Codex can read.
   */
  probe(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<true | string>;
  close(): Promise<void>;
}

/** The shell Codex runs hook commands with: the account's login shell. */
function hookShell(): string {
  const shell = os.userInfo().shell;
  return shell && isAbsolute(shell) ? shell : '/bin/sh';
}

/**
 * The dispatch's private channel from the hook to the host: a Unix socket in a 0700 directory and
 * a token, given to Codex's environment in names that commands never see (ORCHVIA_HOOK_*).
 */
export async function hostHookChannel(
  hook: CodexHostHook,
  ids: Pick<CodexHookEvent, 'taskId' | 'sessionId' | 'dispatchId'>,
): Promise<HostHookChannel> {
  // A short path: Unix socket paths are limited to about 104 bytes on macOS.
  const directory = mkdtempSync('/tmp/orchvia-hook-');
  chmodSync(directory, 0o700);
  const path = join(directory, 's');
  const token = randomBytes(32).toString('hex');
  const allowed = new Set<string>();
  const probes = new Set<string>();
  const probed = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      buffer += data;
      if (buffer.length > 1_048_576) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = '';
      void (async () => {
        let answer: CodexHookDecision = { allow: false, reason: 'The host refused' };
        try {
          const message = JSON.parse(line) as { token?: unknown; event?: unknown };
          if (
            typeof message.token !== 'string' ||
            message.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))
          )
            throw new Error('unauthorized');
          const event = (message.event ?? {}) as Record<string, unknown>;
          const id = typeof event.tool_use_id === 'string' ? event.tool_use_id : null;
          if (id !== null && probes.has(id)) {
            probed.add(id);
            answer = { allow: false, reason: 'Orchvia checks that the hook runs' };
          } else {
            const decision = await hook(hookEvent(event, ids));
            answer =
              decision?.allow === true
                ? { allow: true }
                : {
                    allow: false,
                    reason: (decision as { reason?: string })?.reason ?? 'The host refused',
                  };
            // H06: recorded before the hook program has the answer, so before Codex starts it.
            if (answer.allow && id !== null) allowed.add(id);
          }
        } catch (error) {
          answer = {
            allow: false,
            reason: `The host's hook failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        socket.end(JSON.stringify(answer) + '\n');
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  const env = { ORCHVIA_HOOK_SOCKET: path, ORCHVIA_HOOK_TOKEN: token };
  return {
    env,
    allowed,
    async probe(command, probeEnv, timeoutMs) {
      const id = `orchvia-probe-${randomBytes(16).toString('hex')}`;
      probes.add(id);
      const child = spawn(hookShell(), ['-c', command], {
        env: { ...probeEnv, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        if (stdout.length < 65_536) stdout += data;
      });
      child.stderr.setEncoding('utf8').on('data', (data: string) => {
        if (stderr.length < 4096) stderr += data;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'orchvia_probe',
          tool_use_id: id,
          tool_input: {},
        }),
      );
      const exit = await new Promise<{ code: number | null; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          resolve({ code: null, error: `it did not finish within ${timeoutMs} ms` });
        }, timeoutMs);
        child.once('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, error: error.message });
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code });
        });
      });
      probes.delete(id);
      const detail = stderr.trim() ? ` (${stderr.trim().split('\n').at(-1)!.slice(0, 200)})` : '';
      if (exit.error) return `the hook command failed: ${exit.error}`;
      if (!probed.has(id)) return `the hook command never reached the host${detail}`;
      if (exit.code !== 0) return `the hook command exited with ${exit.code}${detail}`;
      let printed: unknown;
      try {
        printed = JSON.parse(stdout);
      } catch {
        return 'the hook command printed something besides its answer';
      }
      const decision = (printed as { hookSpecificOutput?: { permissionDecision?: unknown } })
        ?.hookSpecificOutput?.permissionDecision;
      return decision === 'deny' ? true : 'the hook command did not print its denial';
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// ---- SPEC-0035 I: stop markers for Codex's commands ----

/** I03: the account's login shell, which Codex runs commands with, when it is zsh or bash. */
export function markedLoginShell(): string | null {
  const shell = os.userInfo().shell ?? '';
  return /(^|\/)(zsh|bash)$/.test(shell) ? shell : null;
}

/** I04: whether a command item ran under a shell that opens the marker (zsh or bash). */
export function markedCommand(command: unknown): boolean {
  return typeof command === 'string' && /^(\S*\/)?(zsh|bash) /.test(command);
}

/**
 * I02: the startup files that open a dispatch's marker as descriptor 9 in every zsh and bash
 * command, then run the user's own, in `directory` (the stop marker instance). A marker that cannot
 * be opened stops the command, as the Claude wrapper does.
 */
export function markerStartupFiles(directory: string): { zdotdir: string; bashEnv: string } {
  const zdotdir = join(directory, 'zdotdir');
  const bashEnv = join(directory, 'bash-env.sh');
  mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
  const open =
    'if [ -n "$ORCHVIA_STOP_MARKER" ]; then exec 9<"$ORCHVIA_STOP_MARKER" || exit 126; fi\n';
  writeFileSync(
    join(zdotdir, '.zshenv'),
    open +
      'if [ -n "${ORCHVIA_USER_ZDOTDIR+x}" ]; then ZDOTDIR="$ORCHVIA_USER_ZDOTDIR"; else unset ZDOTDIR; fi\n' +
      '[ -f "${ZDOTDIR:-$HOME}/.zshenv" ] && . "${ZDOTDIR:-$HOME}/.zshenv"\n',
    { mode: 0o600 },
  );
  writeFileSync(
    bashEnv,
    open +
      'if [ -n "$ORCHVIA_USER_BASH_ENV" ] && [ -f "$ORCHVIA_USER_BASH_ENV" ]; then . "$ORCHVIA_USER_BASH_ENV"; fi\n',
    { mode: 0o600 },
  );
  return { zdotdir, bashEnv };
}
