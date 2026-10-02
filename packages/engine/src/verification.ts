import { insidePath, rebasePath } from './paths.ts';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fail, OrchestrationError } from './errors.ts';
import { digest, fields, integer, object, string, strings } from './validation.ts';
import type { FrozenVerificationRule, VerificationRule } from './types.ts';

export function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function workspacePath(workspace: string, path: string): string {
  const canonical = realpathSync(resolve(workspace, path));
  const root = realpathSync(workspace);
  if (contains(root, canonical)) return canonical;
  // SPEC-0054: another spelling of a path inside the workspace, on a case-insensitive volume, is
  // inside it; it is recorded in the workspace's own spelling.
  if (!insidePath(root, canonical))
    fail('INVALID_WORKSPACE_SCOPE', 'Path leaves the registered workspace');
  return rebasePath(root, canonical);
}

/** Checks that a rule's paths resolve inside the workspace now (SPEC-0017 A01). */
export function checkRulePaths(workspace: string, rule: VerificationRule): void {
  for (const path of new Set([rule.cwdRelative, ...(rule.baselinePaths ?? [])]))
    try {
      workspacePath(workspace, path);
    } catch (error) {
      if (error instanceof OrchestrationError) throw error;
      const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
      fail(
        'INVALID_WORKSPACE_SCOPE',
        `Verification rule ${ruleKey(rule.id, rule.version)} path ${JSON.stringify(path)} is unavailable (${code})`,
      );
    }
}

/**
 * Validates rule definitions. Startup, store switches and configuration loading check only the
 * shape, so a directory removed later never blocks the host; registration and task admission also
 * check the paths (SPEC-0017 A01).
 */
export function normalizeRules(
  workspace: string,
  input: VerificationRule[] = [],
  options: { checkPaths?: boolean } = {},
): FrozenVerificationRule[] {
  if (!Array.isArray(input) || input.length > 100)
    fail('VALIDATION_ERROR', 'At most 100 verification rules may be registered');
  const seen = new Set<string>();
  return input.map((value) => {
    const rule = object(value, 'verificationRule');
    fields(rule, [
      'id',
      'version',
      'argv',
      'cwdRelative',
      'timeoutMs',
      'permissionProfile',
      'success',
      'maxOutputBytes',
      'baselinePaths',
    ]);
    const success = object(rule.success, 'success');
    fields(success, ['exitCode']);
    const cwdRelative = string(rule.cwdRelative, 'cwdRelative', 4096);
    if (isAbsolute(cwdRelative)) fail('VALIDATION_ERROR', 'cwdRelative must be relative');
    const argv = strings(rule.argv, 'argv', 1, 100);
    if (!isAbsolute(argv[0]))
      fail('VALIDATION_ERROR', 'Verification executable must be an absolute path');
    if (!['read-only', 'workspace-write'].includes(rule.permissionProfile as string))
      fail('VALIDATION_ERROR', 'Invalid verification permissionProfile');
    const normalized: VerificationRule = {
      id: string(rule.id, 'rule.id', 128),
      version: string(rule.version, 'rule.version', 128),
      argv,
      cwdRelative,
      timeoutMs: integer(rule.timeoutMs, 'timeoutMs', 1, 3600000),
      permissionProfile: rule.permissionProfile as VerificationRule['permissionProfile'],
      success: { exitCode: integer(success.exitCode, 'exitCode', 0, 255) },
      maxOutputBytes: integer(rule.maxOutputBytes ?? 65536, 'maxOutputBytes', 1, 262144),
      baselinePaths:
        rule.baselinePaths === undefined
          ? [cwdRelative]
          : strings(rule.baselinePaths, 'baselinePaths', 1),
    };
    // By name only: a path must not leave the workspace; symlinks are checked with the paths.
    for (const path of [cwdRelative, ...normalized.baselinePaths!])
      if (!contains(resolve(workspace), resolve(workspace, path)))
        fail('INVALID_WORKSPACE_SCOPE', 'Path leaves the registered workspace');
    if (options.checkPaths !== false) checkRulePaths(workspace, normalized);
    const key = ruleKey(normalized.id, normalized.version);
    if (seen.has(key)) fail('VALIDATION_ERROR', 'Duplicate verification rule id/version');
    seen.add(key);
    return { ...normalized, digest: digest(normalized) };
  });
}

/** Unambiguous key of a rule version; `id` and `version` may both contain `@` (SPEC-0014 W05). */
export function ruleKey(id: string, version: string): string {
  return JSON.stringify([id, version]);
}

/** A registered rule that its owner retired (SPEC-0028 U01), as its row stores it. */
export type RetiredVerificationRule = FrozenVerificationRule & { retiredAt: string };

/**
 * Configured rules plus a store's registered rules (SPEC-0014 W03–W05). Identity comes from each
 * row's content, so rows written under rc.8's `id@version` keys load unchanged. A registered rule
 * whose identity is already effective with other content fails with VALIDATION_ERROR. A retired
 * row is set aside before any check: it is not effective, so it neither conflicts nor keeps a host
 * from starting (SPEC-0028 U04).
 */
export function effectiveRules(
  workspace: string,
  configured: VerificationRule[] | undefined,
  stored: unknown[],
): {
  rules: FrozenVerificationRule[];
  runtime: Set<string>;
  retired: RetiredVerificationRule[];
} {
  const rules = normalizeRules(workspace, configured, { checkPaths: false });
  const runtime = new Set<string>();
  const retired: RetiredVerificationRule[] = [];
  for (const row of stored) {
    if (typeof (row as { retiredAt?: unknown }).retiredAt === 'string') {
      retired.push(row as RetiredVerificationRule);
      continue;
    }
    const { digest: _digest, ...value } = row as FrozenVerificationRule;
    const [rule] = normalizeRules(workspace, [value], { checkPaths: false });
    const key = ruleKey(rule.id, rule.version);
    const existing = rules.find((r) => r.id === rule.id && r.version === rule.version);
    if (existing) {
      if (existing.digest !== rule.digest)
        fail('VALIDATION_ERROR', `Verification rule ${key} has conflicting definitions`);
      continue;
    }
    rules.push(rule);
    runtime.add(key);
  }
  // In the order they were retired, as a running engine lists them.
  retired.sort((a, b) => a.retiredAt.localeCompare(b.retiredAt));
  return { rules, runtime, retired };
}

/** The largest part of a file that is read and hashed at once (SPEC-0061 B01). */
const BASELINE_PART_BYTES = 1024 * 1024;
/**
 * A bounded content baseline. Excludes Git internals; source/untracked files remain included.
 * SPEC-0061 B: computed with asynchronous file calls, a file at a time in sorted order and a large
 * file in parts, so that the engine's thread is not held; a `signal` that is aborted stops it
 * between two entries.
 */
export async function workspaceBaseline(
  workspace: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const seen = new Set<string>();
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    if (seen.size > 20000)
      fail(
        'BASELINE_LIMIT',
        'Verification baseline exceeds 20000 entries; register narrower baselinePaths',
      );
    // Never leaves verifyRule, which reports a cancelled verification itself: no error code.
    if (signal?.aborted) throw new Error('Verification cancelled during its baseline');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = workspacePath(workspace, path);
      hash.update(`link:${relative(workspace, path)}:${target}\n`);
      await visit(target);
    } else if (stat.isDirectory()) {
      hash.update(`directory:${relative(workspace, path)}\n`);
      for (const child of (await readdir(path)).sort()) {
        if (child !== '.git') await visit(resolve(path, child));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024)
        fail(
          'BASELINE_LIMIT',
          'Verification baseline exceeds 64 MiB; register narrower baselinePaths',
        );
      hash.update(`file:${relative(workspace, path)}:${stat.mode}:`);
      const file = await open(path, 'r');
      try {
        const part = Buffer.allocUnsafe(Math.max(1, Math.min(BASELINE_PART_BYTES, stat.size)));
        for (;;) {
          const { bytesRead } = await file.read(part, 0, part.length, null);
          if (!bytesRead) break;
          hash.update(part.subarray(0, bytesRead));
        }
      } finally {
        await file.close();
      }
    } else fail('INVALID_WORKSPACE_SCOPE', 'Verification baseline contains a special file');
  };
  for (const path of [...paths].sort()) await visit(workspacePath(workspace, path));
  return hash.digest('hex');
}

/** What every check's command gets of the host's environment with `'minimal'` (SPEC-0061 V01). */
const MINIMAL_ENVIRONMENT = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
];
const MINIMAL_ENVIRONMENT_WINDOWS = ['SystemRoot', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE'];
/**
 * SPEC-0061 V01, V02: the environment of a check's command, or undefined for the host's own. A
 * check runs outside every sandbox on what a member changed, so with `'minimal'` it gets only the
 * variables above and the ones the host names. Throws VALIDATION_ERROR for another mode or name.
 */
export function verificationEnvironment(
  mode: unknown,
  names: unknown,
  host: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv | undefined {
  if (mode !== undefined && mode !== 'inherit' && mode !== 'minimal')
    fail('VALIDATION_ERROR', "verificationEnvironment must be 'inherit' or 'minimal'");
  const named = names === undefined ? [] : strings(names, 'verificationInheritEnv', 0, 64);
  if (named.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    fail('VALIDATION_ERROR', 'verificationInheritEnv takes the names of environment variables');
  if (mode !== 'minimal') return undefined;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    ...MINIMAL_ENVIRONMENT,
    ...(platform === 'win32' ? MINIMAL_ENVIRONMENT_WINDOWS : []),
    ...named,
  ])
    if (host[name] !== undefined) environment[name] = host[name];
  return environment;
}

export interface VerificationEvidence {
  ruleId: string;
  ruleVersion: string;
  ruleDigest: string;
  argv: string[];
  cwd: string;
  before: string | null;
  after: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
  passed: boolean;
  resourcesStopped: boolean;
  error?: string;
}

export async function verifyRule(
  workspace: string,
  rule: FrozenVerificationRule,
  signal: AbortSignal,
  /** The command's environment; left out, the host's own (SPEC-0061 V01). */
  environment?: NodeJS.ProcessEnv,
): Promise<VerificationEvidence> {
  const result: VerificationEvidence = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleDigest: rule.digest,
    argv: rule.argv,
    cwd: '',
    before: null,
    after: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    output: '',
    outputTruncated: false,
    passed: false,
    resourcesStopped: true,
  };
  try {
    const { digest: frozen, ...normalized } = rule;
    if (digest(normalized) !== frozen)
      fail('VERIFICATION_RULE_CHANGED', 'Frozen rule digest does not match');
    result.cwd = workspacePath(workspace, rule.cwdRelative);
    try {
      result.before = await workspaceBaseline(workspace, rule.baselinePaths!, signal);
    } catch (error) {
      // SPEC-0061 B03: a cancellation stops the baseline between two entries.
      if (!signal.aborted) throw error;
    }
    if (signal.aborted) return { ...result, error: 'Verification cancelled before submission' };
    await new Promise<void>((resolveDone) => {
      const child = spawn(rule.argv[0], rule.argv.slice(1), {
        cwd: result.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(environment ? { env: environment } : {}),
      });
      result.resourcesStopped = false;
      const chunks: Buffer[] = [];
      let finished = false;
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      let length = 0;
      const consume = (chunk: Buffer) => {
        const remaining = Math.max(0, rule.maxOutputBytes! - length);
        if (chunk.length > remaining) result.outputTruncated = true;
        if (remaining) {
          chunks.push(chunk.subarray(0, remaining));
          length += Math.min(chunk.length, remaining);
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      const finish = (stopped: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (cleanup) clearTimeout(cleanup);
        signal.removeEventListener('abort', kill);
        result.resourcesStopped = stopped;
        if (!stopped)
          result.error = 'Verification cleanup is unconfirmed; owner reconciliation is required';
        result.output = Buffer.concat(chunks).toString('utf8');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolveDone();
      };
      const kill = () => {
        cleanup ??= setTimeout(() => finish(false), 500);
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* The owned process may already have exited. */
        }
      };
      const timeout = setTimeout(() => {
        result.timedOut = true;
        kill();
      }, rule.timeoutMs);
      signal.addEventListener('abort', kill, { once: true });
      if (signal.aborted) kill();
      child.once('error', (error) => {
        result.error = error.message;
      });
      child.once('close', (code, exitSignal) => {
        result.exitCode = code;
        result.signal = exitSignal;
        // A closed pipe alone does not prove that members of the owned process group stopped.
        const groupAlive = () => {
          if (process.platform === 'win32' || !child.pid) return false;
          try {
            process.kill(-child.pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        };
        if (!groupAlive()) {
          finish(true);
          return;
        }
        kill();
        const poll = () => {
          if (finished) return;
          if (!groupAlive()) finish(true);
          else setTimeout(poll, 10);
        };
        poll();
      });
    });
    // Not cancelled: the evidence says what the command left, also for a cancelled verification.
    result.after = await workspaceBaseline(workspace, rule.baselinePaths!);
    result.passed =
      result.resourcesStopped &&
      !result.error &&
      !signal.aborted &&
      !result.timedOut &&
      result.signal === null &&
      result.exitCode === rule.success.exitCode &&
      result.before === result.after;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Verification failed';
  }
  return result;
}
