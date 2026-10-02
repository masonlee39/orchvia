import { insidePath } from './paths.ts';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { processTable, processTableAsync, type ProcessRow } from './process-tree.ts';
import type { RuntimeStopObserver } from './types.ts';

/** The files that mark one dispatch's commands (SPEC-0034 B01). */
export interface StopMarker {
  /** Every command of the dispatch holds this file open while it runs. */
  path: string;
  /** Command prefix: opens the marker as descriptor 9, then runs its one argument with `shell`. */
  wrapper: string;
  /** Canonical workspace of the dispatch. */
  workspace: string;
  /** Wall time just before the dispatch's first command could start. */
  startedAt: number;
}

/** Why a dispatch is not proven stopped (SPEC-0036). */
export type StopMarkerReason =
  | 'unlisted'
  | 'holders_left'
  | 'strays'
  | 'metadata_missing'
  | 'instance_unknown';

/** A process in a dispatch's workspace that started during it (SPEC-0045 K02). */
export interface StrayProcess {
  pid: number;
  command: string;
  /** When it started, as `ps` reports it (SPEC-0059 A02). */
  started: string;
  /**
   * Its nearest ancestor that started before the dispatch, or the application below which it runs
   * (SPEC-0059 A01); null when none could be found.
   */
  ancestor: { pid: number; command: string } | null;
}

/** One stop observation, reported to the host's `onObservation` (SPEC-0036 O01). */
export interface StopMarkerObservation {
  kind: 'dispatch' | 'sweep' | 'stale' | 'sync';
  dispatchId: string | null;
  /** Processes that held the marker when the observation began. */
  holders: number;
  /** Of those, the ones that were ended and are gone. */
  ended: number;
  /** Processes in the workspace that may have dropped the marker (SPEC-0034 B03). */
  strays: number;
  /** SPEC-0045 K02: those processes, when there are any. */
  strayProcesses?: StrayProcess[];
  /** SPEC-0045 K01: processes left out because they belong to something already running. */
  foreignProcesses?: StrayProcess[];
  stopped: boolean;
  /** SPEC-0062 S02: a dispatch's observation looked more than once for its strays to end. */
  waited?: true;
  reason?: StopMarkerReason;
}

/** What a sweep found for one dispatch of an earlier instance (SPEC-0036 S). */
export interface StopMarkerDispatch {
  dispatchId: string | null;
  instance: string;
  workspace: string | null;
  holders: number[];
  ended: number;
  strays: number[];
  /** SPEC-0045 K02: the strays, and the processes left out as another tool's, when any. */
  strayProcesses?: StrayProcess[];
  foreignProcesses?: StrayProcess[];
  stopped: boolean;
  /** SPEC-0037 K: proven stopped by this or an earlier sweep with `keepProven`, and kept. */
  proven?: true;
  /** SPEC-0059 T03: this sweep waited for the dispatch's strays to exit; a later one does not. */
  waited?: true;
  reason?: StopMarkerReason;
}

export interface StopMarkerSweep {
  /** True when every dispatch found is proven stopped. */
  stopped: boolean;
  dispatches: StopMarkerDispatch[];
  /** Instance directories of processes still running, this one included; left untouched. */
  liveInstances: string[];
}

export interface StopMarkerSyncResult {
  stopped: boolean;
  holders: number;
  ended: number;
}

/** SPEC-0037 Y02: a synchronous cleanup of every instance of this process under a root. */
export interface StopMarkerRootSyncResult extends StopMarkerSyncResult {
  /** The instances covered, with how many markers each had. */
  instances: { instance: string; markers: number }[];
}

/** SPEC-0037 K03: what `acknowledgeStopMarkers` did with each dispatch it was given. */
export interface StopMarkerAcknowledgement {
  removed: string[];
  refused: {
    dispatchId: string;
    /**
     * All but the first only with `attested` (SPEC-0059 R02); `dispatch_running` only from an
     * adapter's own `acknowledgeStopMarkers` (R03).
     */
    reason: 'not_proven' | 'instance_live' | 'holders_left' | 'unlisted' | 'dispatch_running';
  }[];
  missing: string[];
}

export interface StopMarkerAcknowledgeOptions {
  /**
   * SPEC-0059 R01: the host's user confirmed that these dispatches stopped. Their records are
   * removed without a proof, unless their instance still runs or a process still holds the marker.
   */
  attested?: boolean;
}

export interface StopMarkersOptions {
  /** A host directory that outlives the host; each instance works in a directory of its own. */
  root?: string;
  onObservation?: (observation: StopMarkerObservation) => void;
  /**
   * Test seam for `endAllSync`: lists what holds `paths` among the processes started since
   * `since`, within `timeoutMs`, or null when that cannot be shown. Hosts leave it out.
   */
  listHolders?: (paths: string[], since: number, timeoutMs: number) => number[] | null;
  /**
   * Test seam for an observation: the processes in `workspace` that count as strays of a dispatch
   * started at `startedAt`, within `timeoutMs`, or null when that cannot be shown. Hosts leave it
   * out.
   */
  listStrays?: (
    marker: { workspace: string; startedAt: number },
    timeoutMs: number,
  ) => Promise<{ counted: StrayProcess[]; foreign: StrayProcess[] } | null>;
}

export interface StopMarkerSweepOptions {
  /**
   * SPEC-0037 K01: keep the files of a dispatch the sweep proves stopped, with a `.proven`
   * record, until `acknowledgeStopMarkers` removes them. Later sweeps report it proven at once.
   */
  keepProven?: boolean;
  /**
   * The whole sweep's time; 5,000 ms by default. Each dispatch is looked at once within its share
   * of it. Then a sweep that found processes that may have dropped a marker looks again every
   * 200 ms, for at most three seconds, and only the first time for a dispatch (SPEC-0059 T).
   */
  timeoutMs?: number;
  onObservation?: (observation: StopMarkerObservation) => void;
  /**
   * Test seam: lists what holds a marker within `timeoutMs`, or null when that cannot be shown.
   * Hosts leave it out.
   */
  listHolders?: (path: string, timeoutMs: number) => Promise<number[] | null>;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const sleepSync = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const inside = (parent: string, path: string) =>
  path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const report = (
  notify: StopMarkersOptions['onObservation'],
  observation: StopMarkerObservation,
): void => {
  try {
    notify?.(observation);
  } catch {
    // A host's diagnostics never change a stop proof.
  }
};
const signal = (pids: number[], name: NodeJS.Signals) => {
  for (const pid of pids)
    try {
      process.kill(pid, name);
    } catch {
      // Gone already.
    }
};
// lstart has one-second resolution, and Linux derives it from a boot time truncated to the
// second, so it can read up to a second early: count from the second before.
const earliest = (wallTime: number) => Math.floor(wallTime / 1000) * 1000 - 1000;

/** PIDs holding `path` open; null when that cannot be shown, which counts as not stopped. */
function holders(path: string, timeoutMs: number): Promise<number[] | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-t', '-w', '--', path],
      { encoding: 'utf8', timeout: Math.ceil(timeoutMs) },
      (error, stdout, stderr) => {
        const pids = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => Number(line));
        if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return resolve(null);
        if (!error) return resolve(pids);
        // lsof exits 1 with no output and no complaint when nothing holds the file.
        const status: unknown = (error as { code?: unknown }).code;
        resolve(status === 1 && !pids.length && !stderr.trim() ? [] : null);
      },
    );
  });
}

/** PIDs whose working directory is `workspace` or inside it; null when that cannot be shown. */
function inWorkspace(workspace: string, timeoutMs: number): Promise<number[] | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-a', '-d', 'cwd', '-w', '-Fpn'],
      { encoding: 'utf8', timeout: Math.ceil(timeoutMs), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const found: number[] = [];
        let pid = 0;
        for (const line of stdout.split('\n'))
          if (line.startsWith('p')) pid = Number(line.slice(1));
          else if (line.startsWith('n') && inside(workspace, line.slice(1))) found.push(pid);
        resolve(found.every((value) => Number.isSafeInteger(value) && value > 0) ? found : null);
      },
    );
  });
}

interface Strays {
  counted: StrayProcess[];
  foreign: StrayProcess[];
}

/**
 * SPEC-0045 K01, K03: whether a candidate whose nearest ancestor from before the dispatch is
 * `ancestor` still counts as a stray. It does without such an ancestor, and when the ancestor is
 * process 1 or a direct child of it (an orphan's adopter or a daemon), except, on macOS, an
 * application's own executable (`*.app/Contents/MacOS/*`), which launchd starts for each running
 * application. Exported for tests.
 */
export function countsAsStray(
  ancestor: Pick<ProcessRow, 'pid' | 'ppid' | 'command'> | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!ancestor || ancestor.pid === 1) return true;
  if (ancestor.ppid !== 1) return false;
  return !(platform === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(ancestor.command));
}
const detail = (list: StrayProcess[], key: 'strayProcesses' | 'foreignProcesses') =>
  list.length ? { [key]: list } : {};

/**
 * SPEC-0034 B03: processes that may be what a dispatch left behind without its marker. A program
 * that closes inherited descriptors, as Python's subprocess does by default, drops the marker, but
 * what it starts keeps the working directory. Candidates: a process in the workspace, started during
 * the dispatch, outside this host's own process tree (the runtimes of every session, and this
 * check's own lsof). SPEC-0045 K01: a candidate whose nearest ancestor from before the dispatch is
 * an ordinary running process belongs to something already running, such as another terminal or
 * agent, and is left out; one whose ancestor is process 1 or a direct child of it (an orphan, a
 * per-user service manager, a daemon such as a tmux server), or has none, is counted. Null when
 * that cannot be shown.
 */
async function strays(
  marker: Pick<StopMarker, 'workspace' | 'startedAt'>,
  timeoutMs: number,
): Promise<Strays | null> {
  const candidates = await inWorkspace(marker.workspace, timeoutMs);
  if (candidates === null) return null;
  if (!candidates.length) return { counted: [], foreign: [] };
  let rows: ProcessRow[];
  try {
    // SPEC-0061 T01: without holding the thread, as the listing of the workspace above.
    rows = await processTableAsync();
  } catch {
    return null;
  }
  return sortStrays(candidates, rows, earliest(marker.startedAt), process.pid, process.platform);
}

/** On macOS, an application's own executable that launchd started (SPEC-0045 K03). */
const launchdApplication = (row: Pick<ProcessRow, 'ppid' | 'command'>, platform: NodeJS.Platform) =>
  platform === 'darwin' && row.ppid === 1 && /\.app\/Contents\/MacOS\/[^/]+$/.test(row.command);

/**
 * Which of `candidates` count as strays of a dispatch that began at `since`, and which are another
 * tool's (SPEC-0045 K01). SPEC-0059 A01: a candidate below an application that launchd started is
 * that application's, whenever the application started; the application itself, when it is a
 * candidate, is judged as any other process. Exported for tests.
 */
export function sortStrays(
  candidates: number[],
  rows: ProcessRow[],
  since: number,
  self: number,
  platform: NodeJS.Platform,
): Strays {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ownTree = (pid: number): boolean => {
    for (let row = byPid.get(pid), steps = 0; row && steps < 4096; steps++) {
      if (row.pid === self) return true;
      if (row.ppid === row.pid || row.ppid <= 0) return false;
      row = byPid.get(row.ppid);
    }
    return false;
  };
  // Invariant 2: only a process that started more than lstart's second before the dispatch.
  const before = (row: ProcessRow) => {
    const started = Date.parse(row.started);
    return Number.isFinite(started) && started < since;
  };
  const found: Strays = { counted: [], foreign: [] };
  for (const pid of candidates) {
    const row = byPid.get(pid);
    if (!row || before(row) || ownTree(pid)) continue; // Gone since lsof listed it, or not new.
    let ancestor: ProcessRow | undefined;
    let application = false;
    for (let up = byPid.get(row.ppid), steps = 0; up && steps < 4096; steps++) {
      if (launchdApplication(up, platform)) {
        ancestor = up;
        application = true;
        break;
      }
      if (before(up)) {
        ancestor = up;
        break;
      }
      if (up.ppid === up.pid || up.ppid <= 0) break;
      up = byPid.get(up.ppid);
    }
    const item: StrayProcess = {
      pid,
      command: row.command,
      started: row.started,
      ancestor: ancestor ? { pid: ancestor.pid, command: ancestor.command } : null,
    };
    // Invariant 1: an ancestor that exited leaves its children to process 1, so they count.
    (!application && countsAsStray(ancestor, platform) ? found.counted : found.foreign).push(item);
  }
  return found;
}

/** SIGTERM, then SIGKILL, what holds `path`; `stopped` once nothing does within the time. */
async function endHolders(
  path: string,
  remainingMs: () => number,
  end: boolean,
  list: (path: string, timeoutMs: number) => Promise<number[] | null> = holders,
): Promise<{ holders: number[] | null; ended: number; stopped: boolean }> {
  const initial = await list(path, remainingMs());
  if (initial === null) return { holders: null, ended: 0, stopped: false };
  if (!initial.length || !end) return { holders: initial, ended: 0, stopped: !initial.length };
  let found: number[] | null = initial;
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    if (found === null || !found.length) break;
    signal(found, name);
    const deadline = performance.now() + (name === 'SIGTERM' ? remainingMs() / 2 : 0);
    do {
      await wait(Math.min(25, deadline - performance.now()));
      found = await list(path, remainingMs());
    } while (found?.length && performance.now() < deadline);
  }
  const left = found ?? initial;
  return {
    holders: initial,
    ended: initial.filter((pid) => !left.includes(pid)).length,
    stopped: found !== null && !found.length,
  };
}

/**
 * SPEC-0036 Y01: synchronously, what holds any of `paths` among the processes started since
 * `since` (`ps`, then `lsof -a -p` over those alone, which is several times faster than over every
 * process), within `timeoutMs`; null when that cannot be shown.
 */
function listHoldersSync(paths: string[], since: number, timeoutMs: number): number[] | null {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => deadline - performance.now();
  const candidates = processTable(remaining())
    .filter((row) => {
      const started = Date.parse(row.started);
      return row.pid !== process.pid && (!Number.isFinite(started) || started >= since);
    })
    .map((row) => row.pid);
  if (!candidates.length) return [];
  if (remaining() < 5) return null;
  let out: string;
  try {
    out = execFileSync('lsof', ['-a', '-p', candidates.join(','), '-t', '-w', '--', ...paths], {
      encoding: 'utf8',
      timeout: Math.ceil(remaining()),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    // Exit 1 without a complaint: some candidate or file had nothing open.
    if (failure.status !== 1 || String(failure.stderr ?? '').trim()) return null;
    out = String(failure.stdout ?? '');
  }
  const pids = [...new Set(out.split('\n').filter(Boolean).map(Number))];
  return pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) ? pids : null;
}

/**
 * SPEC-0036 Y01: within `timeoutMs`, lists what holds any of `paths` among the processes started
 * since `since`, sends SIGTERM, then SIGKILL, and lists again; `stopped` only when that last
 * listing found none. Never throws.
 */
function endHoldersSync(
  paths: string[],
  since: number,
  timeoutMs: number,
  list: (paths: string[], since: number, timeoutMs: number) => number[] | null,
): StopMarkerSyncResult {
  // A tenth of the time, at least 10 ms, is kept for returning: a child process killed at its
  // timeout still takes a moment to be reaped, more so on a loaded machine.
  const deadline = performance.now() + timeoutMs - Math.max(10, timeoutMs * 0.1);
  const remaining = () => deadline - performance.now();
  if (!paths.length) return { stopped: true, holders: 0, ended: 0 };
  const find = (): number[] | null => {
    if (remaining() < 5) return null;
    try {
      return list(paths, since, remaining());
    } catch {
      return null;
    }
  };
  const listing = performance.now();
  const found = find();
  // What one listing costs; a round starts only when a listing still fits after it.
  const cost = performance.now() - listing;
  if (found === null) return { stopped: false, holders: 0, ended: 0 };
  if (!found.length) return { stopped: true, holders: 0, ended: 0 };
  const running = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  // Wait only as long as something still runs.
  const settle = (pids: number[], ms: number) => {
    const until = Math.min(deadline, performance.now() + ms);
    while (pids.some(running) && performance.now() < until) sleepSync(5);
  };
  const seen = new Set(found);
  let left: number[] | null = found;
  // A holder may start another before it ends, so list again until none is left or time is up.
  for (let round = 0; left?.length; round++) {
    if (round === 0) {
      // An exit path: a short grace for SIGTERM, then SIGKILL.
      signal(left, 'SIGTERM');
      settle(left, Math.min(40, (remaining() - 2 * cost) / 3));
    }
    signal(left.filter(running), 'SIGKILL');
    settle(left, Math.min(20, (remaining() - cost) / 3));
    if (remaining() < cost + 5) {
      // No time to list again: not verified. What is left of the time goes to seeing the
      // signalled processes exit, so that `ended` counts them.
      settle(left, remaining() - 2);
      left = null;
      break;
    }
    left = find();
    for (const pid of left ?? []) seen.add(pid);
  }
  const gone = [...seen].filter((pid) => !running(pid) || (left !== null && !left.includes(pid)));
  return {
    stopped: left !== null && !left.length,
    holders: found.length,
    ended: Math.min(found.length, gone.filter((pid) => found.includes(pid)).length),
  };
}

/**
 * SPEC-0036 D01: a host's marker directory, created private when missing. It must be absolute,
 * a directory and not a symbolic link, owned by this user and writable by no one else. Returns
 * its canonical path; throws otherwise.
 */
export function checkStopMarkerRoot(root: unknown): string {
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new Error('stopMarker.directory must be an absolute path');
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('stopMarker.directory must be a directory, not a symbolic link');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error('stopMarker.directory must belong to this user');
  if (stat.mode & 0o022)
    throw new Error('stopMarker.directory must not be writable by group or others');
  return realpathSync(root);
}

/**
 * Marker files for the commands a runtime starts (SPEC-0034 B01). Each dispatch gets a marker and
 * a wrapper script; every command started through the wrapper holds the marker open, and so does
 * anything it leaves running in the background, because descriptors are inherited. A dispatch has
 * stopped when nothing holds its marker. macOS and Linux only.
 *
 * The directory is private (0700) and lies outside the state directory, so a sandbox that denies
 * the state directory can still be told to allow it. With a host `root` (SPEC-0036) it is
 * `<root>/<pid>-<random>`, with `instance.json` recording this process, and each dispatch has a
 * `.json` record of its workspace; the markers of a dispatch that is not proven stopped stay
 * there after the host exits, for `sweepStopMarkers`.
 */
export class StopMarkers {
  readonly #root: string | undefined;
  readonly #notify: StopMarkersOptions['onObservation'];
  readonly #listHolders: NonNullable<StopMarkersOptions['listHolders']>;
  readonly #listStrays: NonNullable<StopMarkersOptions['listStrays']>;
  #directory: string | undefined;
  #startedAt = 0;
  readonly #markers = new Map<string, StopMarker>();
  /** Dispatches whose runtime has finished: `end` or the observer was asked about them. */
  readonly #ended = new Set<string>();

  constructor(options: StopMarkersOptions = {}) {
    this.#root = options.root === undefined ? undefined : checkStopMarkerRoot(options.root);
    this.#notify = options.onObservation;
    this.#listHolders = options.listHolders ?? listHoldersSync;
    this.#listStrays = options.listStrays ?? strays;
  }

  /** The directory that holds the markers; commands must be able to read it. */
  get directory(): string {
    if (this.#directory === undefined) {
      this.#startedAt = Date.now();
      let directory: string;
      if (this.#root === undefined) {
        directory = realpathSync(mkdtempSync(join(tmpdir(), 'orchvia-stop-')));
        chmodSync(directory, 0o700);
      } else {
        const own = processTable().find((row) => row.pid === process.pid);
        if (!own) throw new Error('stopMarker cannot find this process in the process table');
        directory = join(this.#root, `${process.pid}-${randomBytes(4).toString('hex')}`);
        mkdirSync(directory, { mode: 0o700 });
        // Invariant 1: the instance record exists before any marker.
        writeFileSync(
          join(directory, 'instance.json'),
          JSON.stringify({ version: 1, pid: process.pid, started: own.started }) + '\n',
          { mode: 0o600 },
        );
        const members = StopMarkers.#byRoot.get(this.#root) ?? new Set<StopMarkers>();
        members.add(this);
        StopMarkers.#byRoot.set(this.#root, members);
      }
      this.#directory = directory;
    }
    return this.#directory;
  }

  /**
   * Creates the marker of a dispatch before it starts; throws when that is impossible. The wrapper
   * runs each command with `shell`, which must be the shell the runtime expects. With a host root,
   * the workspace and state directory must lie outside it and it outside them (SPEC-0036 D01).
   */
  prepare(dispatchId: string, shell: string, workspace: string, stateDir?: string): StopMarker {
    const canonical = realpathSync(workspace);
    if (this.#root !== undefined)
      for (const other of [canonical, ...(stateDir ? [realpathSync(stateDir)] : [])])
        if (
          inside(this.#root, other) ||
          inside(other, this.#root) ||
          // SPEC-0054: another spelling of the same place overlaps too.
          insidePath(this.#root, other) ||
          insidePath(other, this.#root)
        )
          throw new Error(
            'stopMarker.directory must lie outside the workspace and the state directory',
          );
    const name = Buffer.from(dispatchId).toString('base64url');
    const path = join(this.directory, `${name}.tag`),
      wrapper = join(this.directory, `${name}.sh`);
    const marker = { path, wrapper, workspace: canonical, startedAt: Date.now() };
    if (this.#root !== undefined)
      writeFileSync(
        join(this.directory, `${name}.json`),
        JSON.stringify({
          version: 1,
          dispatchId,
          workspace: canonical,
          startedAt: marker.startedAt,
        }) + '\n',
        { mode: 0o600 },
      );
    writeFileSync(path, '', { mode: 0o600 });
    // A command that cannot hold the marker does not run (exit 126).
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        '[ "$#" -eq 1 ] || exit 126',
        // `command` keeps a failed redirection from ending the shell with its own status (dash).
        `command exec 9<${quote(path)} || exit 126`,
        `exec ${quote(shell)} -c "$1"`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    this.#markers.set(dispatchId, marker);
    return marker;
  }

  /**
   * Ends whatever still holds the dispatch's marker: SIGTERM, then SIGKILL. True only when nothing
   * holds it within `remainingMs()`. False when the holders cannot be listed or outlast the time.
   * Without a host root the marker is then removed; with one it stays unless the observer proved
   * the dispatch stopped, so that a later sweep can still prove it.
   */
  async end(dispatchId: string, remainingMs: () => number): Promise<boolean> {
    this.#ended.add(dispatchId);
    const marker = this.#markers.get(dispatchId);
    if (!marker) return false;
    const { stopped } = await endHolders(marker.path, remainingMs, true);
    if (!stopped) return false;
    if (this.#root === undefined) this.#retire(dispatchId, marker);
    else this.#markers.delete(dispatchId);
    return true;
  }

  #retire(dispatchId: string, marker: StopMarker): void {
    this.#markers.delete(dispatchId);
    rmSync(marker.path, { force: true });
    rmSync(marker.wrapper, { force: true });
    rmSync(marker.path.replace(/\.tag$/, '.json'), { force: true });
  }

  /**
   * The stop observer these markers supply: it ends what holds the marker, then vouches only when
   * no process in the workspace could be one that dropped it (B03). Those are not ended.
   */
  readonly observer: RuntimeStopObserver = async (context) => {
    const dispatchId = context.target.dispatchId;
    this.#ended.add(dispatchId);
    const marker = this.#markers.get(dispatchId);
    if (!marker) return false;
    const held = await endHolders(marker.path, context.remainingMs, true);
    let looked = held.stopped ? await this.#listStrays(marker, context.remainingMs()) : null;
    // SPEC-0062 S02: a process that is ending is no stray. Only a look that finds none vouches
    // (invariant 2), so the last look's strays stand when the time ends.
    // A process that stays is a stray: the looks end after STRAY_WAIT_MS, as a sweep's wait does.
    let waited = false;
    const until = performance.now() + STRAY_WAIT_MS;
    while (
      looked?.counted.length &&
      performance.now() < until &&
      context.remainingMs() > STRAY_LOOK_MS
    ) {
      await wait(STRAY_LOOK_MS);
      const again = await this.#listStrays(marker, context.remainingMs());
      if (again === null) break; // The time ended during the look: the earlier strays stand.
      looked = again;
      waited = true;
    }
    const left = held.stopped ? (looked?.counted ?? null) : [];
    const stopped = held.stopped && left !== null && !left.length;
    const reason: StopMarkerReason | undefined = stopped
      ? undefined
      : held.holders === null || left === null
        ? 'unlisted'
        : !held.stopped
          ? 'holders_left'
          : 'strays';
    report(this.#notify, {
      kind: 'dispatch',
      dispatchId,
      holders: held.holders?.length ?? 0,
      ended: held.ended,
      strays: left?.length ?? 0,
      ...detail(left ?? [], 'strayProcesses'),
      ...detail(looked?.foreign ?? [], 'foreignProcesses'),
      stopped,
      ...(waited ? { waited } : {}),
      ...(reason ? { reason } : {}),
    });
    // Otherwise the marker stays, so that a later observation of the dispatch can look again.
    if (stopped) this.#retire(dispatchId, marker);
    return stopped;
  };

  /**
   * SPEC-0059 R03: retires dispatches of this instance that are not proven stopped, once the
   * host's user confirmed that they stopped, without waiting for the next start's sweep. Only with
   * `attested`, only with a host root, and only a dispatch that has ended. A process that holds
   * the marker refuses it, as in `acknowledgeStopMarkers`. Ends nothing and never throws.
   */
  acknowledge(
    dispatchIds: string[],
    options: StopMarkerAcknowledgeOptions = {},
  ): StopMarkerAcknowledgement {
    const result: StopMarkerAcknowledgement = { removed: [], refused: [], missing: [] };
    for (const dispatchId of dispatchIds) {
      const base =
        this.#root === undefined || this.#directory === undefined || typeof dispatchId !== 'string'
          ? undefined
          : join(this.#directory, Buffer.from(dispatchId).toString('base64url'));
      if (!base || !existsSync(`${base}.tag`)) {
        result.missing.push(dispatchId);
        continue;
      }
      let reason: StopMarkerAcknowledgement['refused'][number]['reason'] | null = null;
      if (options.attested !== true) reason = 'not_proven';
      else if (!this.#ended.has(dispatchId)) reason = 'dispatch_running';
      else {
        let holding: number[] | null;
        try {
          holding = this.#listHolders([`${base}.tag`], earliest(this.#startedAt), 5000);
        } catch {
          holding = null;
        }
        reason = holding === null ? 'unlisted' : holding.length ? 'holders_left' : null;
      }
      if (reason) {
        result.refused.push({ dispatchId, reason });
        continue;
      }
      try {
        // The marker first, as in an acknowledgement after a sweep (SPEC-0037 invariant 2).
        for (const suffix of ['.tag', '.json', '.sh', '.proven'])
          rmSync(base + suffix, { force: true });
        this.#markers.delete(dispatchId);
        this.#ended.delete(dispatchId);
        result.removed.push(dispatchId);
      } catch {
        result.refused.push({ dispatchId, reason: 'unlisted' });
      }
    }
    return result;
  }

  /** Ends the holders of every marker left; true when none remains. */
  async endAll(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    const results = await Promise.all(
      [...this.#markers.keys()].map((dispatchId) => this.end(dispatchId, remaining)),
    );
    if (results.every(Boolean) && this.#directory !== undefined) {
      // With a host root, markers of dispatches not proven stopped stay for a later sweep.
      const kept =
        this.#root !== undefined &&
        existsSync(this.#directory) &&
        readdirSync(this.#directory).some((file) => file.endsWith('.tag'));
      if (!kept) {
        if (existsSync(this.#directory)) rmSync(this.#directory, { recursive: true, force: true });
        this.#directory = undefined;
        if (this.#root !== undefined) StopMarkers.#byRoot.get(this.#root)?.delete(this);
      }
    }
    return results.every(Boolean);
  }

  /**
   * SPEC-0036 Y01: for a host's synchronous exit path. Within `timeoutMs`, lists what holds this
   * instance's markers among the processes started since it began, sends SIGTERM, then SIGKILL,
   * and lists again. `stopped` only when that last listing found none; never throws. The markers
   * stay, so that the next start's sweep can prove each dispatch, workspace check included.
   */
  endAllSync(timeoutMs: number): StopMarkerSyncResult {
    const paths = [...this.#markers.values()].map((marker) => marker.path);
    const result = endHoldersSync(paths, earliest(this.#startedAt), timeoutMs, this.#listHolders);
    this.#reportSync(result);
    return result;
  }

  #reportSync(result: StopMarkerSyncResult): void {
    report(this.#notify, {
      kind: 'sync',
      dispatchId: null,
      holders: result.holders,
      ended: result.ended,
      strays: 0,
      stopped: result.stopped,
      ...(result.stopped ? {} : { reason: 'holders_left' as const }),
    });
  }

  /** The default lister of `endAllSync`, for a test seam that wraps it. */
  static readonly listHolders = listHoldersSync;

  static readonly #byRoot = new Map<string, Set<StopMarkers>>();

  /**
   * SPEC-0037 Y02: `endAllSync` for every instance of this process under `root`, with one listing
   * for all of their markers. Never throws.
   */
  static endAllSyncUnder(root: string, timeoutMs: number): StopMarkerRootSyncResult {
    const none = { stopped: true, holders: 0, ended: 0, instances: [] };
    let canonical: string;
    try {
      if (typeof root !== 'string' || !isAbsolute(root) || !existsSync(root)) return none;
      canonical = realpathSync(root);
    } catch {
      return { ...none, stopped: false };
    }
    const members = [...(StopMarkers.#byRoot.get(canonical) ?? [])].filter(
      (markers) => markers.#directory !== undefined,
    );
    if (!members.length) return none;
    const paths = members.flatMap((markers) =>
      [...markers.#markers.values()].map((marker) => marker.path),
    );
    const since = Math.min(...members.map((markers) => earliest(markers.#startedAt)));
    const result = endHoldersSync(paths, since, timeoutMs, members[0]!.#listHolders);
    for (const markers of members) markers.#reportSync(result);
    return {
      ...result,
      instances: members.map((markers) => ({
        instance: markers.#directory!,
        markers: markers.#markers.size,
      })),
    };
  }
}

interface InstanceRecord {
  pid: number;
  started: string;
}
interface DispatchRecord {
  dispatchId: string;
  workspace: string;
  startedAt: number;
  /** SPEC-0059 T03: when a sweep waited for this dispatch's strays; no later sweep waits again. */
  strayWaitAt?: string;
}
/** The longest a sweep waits for strays to exit, over all its dispatches (SPEC-0059 T02). */
const STRAY_WAIT_MS = 3000;
/** SPEC-0062 S02: the time between two looks of a dispatch's observation for its strays. */
const STRAY_LOOK_MS = 200;
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const instanceRecord = (value: unknown): InstanceRecord | undefined => {
  const record = value as Partial<InstanceRecord> | undefined;
  return record &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.started === 'string'
    ? (record as InstanceRecord)
    : undefined;
};
const dispatchRecord = (value: unknown): DispatchRecord | undefined => {
  const record = value as Partial<DispatchRecord> | undefined;
  return record &&
    typeof record.dispatchId === 'string' &&
    typeof record.workspace === 'string' &&
    isAbsolute(record.workspace) &&
    Number.isFinite(record.startedAt)
    ? (record as DispatchRecord)
    : undefined;
};

/** One dispatch of a dead instance, as a sweep or a stale check works through it. */
interface Examined {
  found: StopMarkerDispatch;
  meta: DispatchRecord | undefined;
  marker: string;
  record: string;
  proof: string;
  files: string[];
  /** False when the dispatch needs no listing: proven before, or of an unknown instance. */
  look: boolean;
  held?: Awaited<ReturnType<typeof endHolders>>;
  looked?: Strays | null;
}

async function examine(
  directory: string,
  end: boolean,
  options: StopMarkerSweepOptions,
): Promise<StopMarkerSweep> {
  const result: StopMarkerSweep = { stopped: true, dispatches: [], liveInstances: [] };
  if (typeof directory !== 'string' || !isAbsolute(directory))
    throw new Error('The stop marker directory must be an absolute path');
  if (!existsSync(directory)) return result;
  const root = checkStopMarkerRoot(directory);
  const deadline = performance.now() + (options.timeoutMs ?? 5000);
  const remaining = () => Math.max(0, deadline - performance.now());
  // Throws when the process table cannot be read: without it no instance can be told dead.
  const rows = new Map((await processTableAsync()).map((row) => [row.pid, row]));
  const examined: Examined[] = [];
  const dead: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const instance = join(root, entry.name);
    const record = instanceRecord(readJson(join(instance, 'instance.json')));
    // Invariant 2: a live instance, this process's included, is never signalled. A recorded PID
    // that now belongs to a process started at another time is a dead instance.
    if (record && rows.get(record.pid)?.started === record.started) {
      result.liveInstances.push(instance);
      continue;
    }
    for (const tag of readdirSync(instance).filter((file) => file.endsWith('.tag'))) {
      const base = tag.slice(0, -'.tag'.length);
      const meta = dispatchRecord(readJson(join(instance, `${base}.json`)));
      const proof = join(instance, `${base}.proven`);
      const found: StopMarkerDispatch = {
        dispatchId: meta?.dispatchId ?? null,
        instance,
        workspace: meta?.workspace ?? null,
        holders: [],
        ended: 0,
        strays: [],
        stopped: false,
      };
      const item: Examined = {
        found,
        meta,
        marker: join(instance, tag),
        record: join(instance, `${base}.json`),
        proof,
        files: [tag, `${base}.sh`, `${base}.json`, `${base}.proven`].map((file) =>
          join(instance, file),
        ),
        look: false,
      };
      // Without its record an instance may be one being created now: never signalled.
      if (!record) found.reason = 'instance_unknown';
      else if (meta && existsSync(proof)) {
        // SPEC-0037 K02: proven before; nothing held it then, and no one can take it up now.
        found.stopped = true;
        found.proven = true;
        if (end && !options.keepProven)
          for (const file of item.files) rmSync(file, { force: true });
      } else item.look = true;
      examined.push(item);
    }
    if (record) dead.push(instance);
  }
  // SPEC-0059 T01: every dispatch is looked at once, within its share of the time that is left, and
  // nothing waits. A dispatch whose listing is slow, or whose strays stay, takes no other's time.
  const looking = examined.filter((item) => item.look);
  for (const [index, item] of looking.entries()) {
    const until = performance.now() + remaining() / (looking.length - index);
    const share = () => Math.max(0, Math.min(until, deadline) - performance.now());
    item.held = await endHolders(item.marker, share, end, options.listHolders);
    item.looked =
      item.held.stopped && item.meta
        ? await strays(item.meta, share())
        : { counted: [], foreign: [] };
  }
  // SPEC-0059 T02, T03: then the dispatches that only their strays keep unstopped are looked at
  // again, together. The dead host's own runtime, such as Claude Code, can take a moment to notice
  // that its input closed. A stray that is the user's own process never exits, so the wait is
  // bounded, and a dispatch is waited for by one sweep only. A stale check does not wait.
  let waiting = looking.filter(
    (item) => end && item.meta && !item.meta.strayWaitAt && item.looked?.counted.length,
  );
  const waitUntil = performance.now() + Math.min(STRAY_WAIT_MS, remaining() - 400);
  const waitLeft = () => Math.max(0, Math.min(waitUntil, deadline) - performance.now());
  for (const item of waiting) item.found.waited = true;
  while (waiting.length && waitLeft() > 0) {
    await wait(Math.min(200, waitLeft()));
    const still: Examined[] = [];
    for (const item of waiting) {
      // A look that fails keeps what the last one found: still not stopped, and still named.
      const again = await strays(item.meta!, remaining());
      if (again === null) continue;
      item.looked = again;
      if (again.counted.length) still.push(item);
    }
    waiting = still;
  }
  for (const item of examined) {
    const { found, meta } = item;
    if (item.look) {
      const held = item.held!;
      const looked = item.looked ?? null;
      const left = looked ? looked.counted.map((stray) => stray.pid) : null;
      found.holders = held.holders ?? [];
      found.ended = held.ended;
      found.strays = left ?? [];
      Object.assign(
        found,
        detail(looked?.counted ?? [], 'strayProcesses'),
        detail(looked?.foreign ?? [], 'foreignProcesses'),
      );
      found.stopped = held.stopped && meta !== undefined && left !== null && !left.length;
      if (!found.stopped)
        found.reason =
          held.holders === null || left === null
            ? 'unlisted'
            : !held.stopped
              ? 'holders_left'
              : !meta
                ? 'metadata_missing'
                : 'strays';
      if (end && found.stopped && options.keepProven) {
        // Invariant 1 (SPEC-0037): the proof is written only once the dispatch is proven.
        writeFileSync(
          item.proof,
          JSON.stringify({
            version: 1,
            dispatchId: meta!.dispatchId,
            provenAt: new Date().toISOString(),
          }) + '\n',
          { mode: 0o600 },
        );
        found.proven = true;
      } else if (end && found.stopped) for (const file of item.files) rmSync(file, { force: true });
      else if (found.waited && meta) {
        // Renamed into place: a record cut short would leave the dispatch without its metadata.
        try {
          const partial = `${item.record}.partial`;
          writeFileSync(
            partial,
            JSON.stringify({ ...meta, strayWaitAt: new Date().toISOString() }) + '\n',
            { mode: 0o600 },
          );
          renameSync(partial, item.record);
        } catch {
          // Not recorded: the next sweep waits once more.
        }
      }
    }
    result.dispatches.push(found);
    report(options.onObservation, {
      kind: end ? 'sweep' : 'stale',
      dispatchId: found.dispatchId,
      holders: found.holders.length,
      ended: found.ended,
      strays: found.strays.length,
      ...detail(found.strayProcesses ?? [], 'strayProcesses'),
      ...detail(found.foreignProcesses ?? [], 'foreignProcesses'),
      stopped: found.stopped,
      ...(found.reason ? { reason: found.reason } : {}),
    });
  }
  // A record or wrapper without its marker never ran a command: the marker is written first.
  if (end)
    for (const instance of dead)
      if (!readdirSync(instance).some((file) => file.endsWith('.tag')))
        rmSync(instance, { recursive: true, force: true });
  result.stopped = result.dispatches.every((dispatch) => dispatch.stopped);
  return result;
}

/**
 * SPEC-0037 K03: removes the files of dispatches that a sweep with `keepProven` proved stopped,
 * once the host has acted on the proof, and the instance directory when nothing is left in it.
 * A dispatch not proven is refused, unless the host passes `attested` (SPEC-0059 R01); one not
 * found is missing. Removing the marker first means an
 * interrupted call leaves either a proven dispatch or files without a marker, which the next
 * sweep removes. Repeating a call changes nothing more. Needs no engine; never touches the root.
 */
/**
 * SPEC-0059 R02: why a dispatch that is not proven cannot be retired on the host's word, or null.
 * A user's confirmation answers for processes that may have dropped the marker. It does not
 * answer for a host that still runs, or for a process that holds the marker: that one is the
 * dispatch's beyond doubt, and a sweep ends it.
 */
function attestable(
  instance: string,
  tag: string,
  meta: DispatchRecord,
  rows: Map<number, ProcessRow> | undefined,
): 'instance_live' | 'holders_left' | 'unlisted' | null {
  const record = instanceRecord(readJson(join(instance, 'instance.json')));
  if (!rows) return 'unlisted';
  if (!record || rows.get(record.pid)?.started === record.started) return 'instance_live';
  let holding: number[] | null;
  try {
    holding = listHoldersSync([join(instance, tag)], earliest(meta.startedAt), 5000);
  } catch {
    holding = null;
  }
  return holding === null ? 'unlisted' : holding.length ? 'holders_left' : null;
}

export function acknowledgeStopMarkers(
  directory: string,
  dispatchIds: string[],
  options: StopMarkerAcknowledgeOptions = {},
): StopMarkerAcknowledgement {
  const result: StopMarkerAcknowledgement = { removed: [], refused: [], missing: [] };
  const wanted = new Set(dispatchIds);
  const seen = new Set<string>();
  if (typeof directory !== 'string' || !isAbsolute(directory))
    throw new Error('The stop marker directory must be an absolute path');
  if (existsSync(directory)) {
    const root = checkStopMarkerRoot(directory);
    let rows: Map<number, ProcessRow> | undefined;
    try {
      rows = new Map(processTable().map((row) => [row.pid, row]));
    } catch {
      rows = undefined; // Without it no instance is told dead, so none loses its directory.
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const instance = join(root, entry.name);
      for (const tag of readdirSync(instance).filter((file) => file.endsWith('.tag'))) {
        const base = tag.slice(0, -'.tag'.length);
        const meta = dispatchRecord(readJson(join(instance, `${base}.json`)));
        if (!meta || !wanted.has(meta.dispatchId)) continue;
        seen.add(meta.dispatchId);
        if (!existsSync(join(instance, `${base}.proven`))) {
          const refusal =
            options.attested === true ? attestable(instance, tag, meta, rows) : 'not_proven';
          if (refusal) {
            result.refused.push({ dispatchId: meta.dispatchId, reason: refusal });
            continue;
          }
        }
        // Invariant 2 (SPEC-0037): the marker first, the proof last.
        for (const file of [tag, `${base}.json`, `${base}.sh`, `${base}.proven`])
          rmSync(join(instance, file), { force: true });
        result.removed.push(meta.dispatchId);
      }
      const record = instanceRecord(readJson(join(instance, 'instance.json')));
      // Only a dead instance loses its directory: a live one may mark its next dispatch there.
      if (
        record &&
        rows &&
        rows.get(record.pid)?.started !== record.started &&
        !readdirSync(instance).some((file) => file.endsWith('.tag'))
      )
        rmSync(instance, { recursive: true, force: true });
    }
  }
  result.missing = dispatchIds.filter((id) => !seen.has(id));
  return result;
}

/**
 * SPEC-0036 S01: for the markers that earlier instances left under a host root, ends whatever
 * still holds them (SIGTERM, then SIGKILL), and proves each dispatch stopped when nothing holds
 * its marker and no process may have dropped it (B03). Instances of running processes, this one
 * included, are left alone. A dispatch proven stopped loses its files, and an instance with none
 * left loses its directory; the root stays. Needs no engine.
 */
export function sweepStopMarkers(
  directory: string,
  options: StopMarkerSweepOptions = {},
): Promise<StopMarkerSweep> {
  return examine(directory, true, options);
}

/** SPEC-0036 S01: what `sweepStopMarkers` would find, without ending or removing anything. */
export function staleStopMarkers(
  directory: string,
  options: StopMarkerSweepOptions = {},
): Promise<StopMarkerSweep> {
  return examine(directory, false, options);
}

/**
 * SPEC-0037 Y02: for a host's synchronous exit path, `endStopMarkersSync` of every adapter of
 * this process whose `stopMarker.directory` is `directory`, with one listing for all of them,
 * within `timeoutMs`. Never throws.
 */
export function endStopMarkersSync(directory: string, timeoutMs: number): StopMarkerRootSyncResult {
  return StopMarkers.endAllSyncUnder(directory, timeoutMs);
}
