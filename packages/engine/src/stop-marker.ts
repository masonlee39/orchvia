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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { processTable, type ProcessRow } from './process-tree.ts';
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
  stopped: boolean;
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
  stopped: boolean;
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

export interface StopMarkersOptions {
  /** A host directory that outlives the host; each instance works in a directory of its own. */
  root?: string;
  onObservation?: (observation: StopMarkerObservation) => void;
  /**
   * Test seam for `endAllSync`: lists what holds `paths` among the processes started since
   * `since`, within `timeoutMs`, or null when that cannot be shown. Hosts leave it out.
   */
  listHolders?: (paths: string[], since: number, timeoutMs: number) => number[] | null;
}

export interface StopMarkerSweepOptions {
  /**
   * The whole sweep's time; 5,000 ms by default. A sweep that finds a process that may have
   * dropped a marker looks again every 200 ms while this lasts.
   */
  timeoutMs?: number;
  onObservation?: (observation: StopMarkerObservation) => void;
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

/**
 * SPEC-0034 B03: processes that may be what a dispatch left behind without its marker. A program
 * that closes inherited descriptors, as Python's subprocess does by default, drops the marker, but
 * what it starts keeps the working directory. Counted: a process in the workspace, started during
 * the dispatch, outside this host's own process tree (the runtimes of every session, and this
 * check's own lsof). Null when that cannot be shown.
 */
async function strays(
  marker: Pick<StopMarker, 'workspace' | 'startedAt'>,
  timeoutMs: number,
): Promise<number[] | null> {
  const candidates = await inWorkspace(marker.workspace, timeoutMs);
  if (candidates === null) return null;
  if (!candidates.length) return [];
  let rows: ProcessRow[];
  try {
    rows = processTable();
  } catch {
    return null;
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ownTree = (pid: number): boolean => {
    for (let row = byPid.get(pid), steps = 0; row && steps < 4096; steps++) {
      if (row.pid === process.pid) return true;
      if (row.ppid === row.pid || row.ppid <= 0) return false;
      row = byPid.get(row.ppid);
    }
    return false;
  };
  const since = earliest(marker.startedAt);
  return candidates.filter((pid) => {
    const row = byPid.get(pid);
    if (!row) return false; // Gone since lsof listed it.
    const started = Date.parse(row.started);
    return !ownTree(pid) && (!Number.isFinite(started) || started >= since);
  });
}

/** SIGTERM, then SIGKILL, what holds `path`; `stopped` once nothing does within the time. */
async function endHolders(
  path: string,
  remainingMs: () => number,
  end: boolean,
): Promise<{ holders: number[] | null; ended: number; stopped: boolean }> {
  const initial = await holders(path, remainingMs());
  if (initial === null) return { holders: null, ended: 0, stopped: false };
  if (!initial.length || !end) return { holders: initial, ended: 0, stopped: !initial.length };
  let found: number[] | null = initial;
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    if (found === null || !found.length) break;
    signal(found, name);
    const deadline = performance.now() + (name === 'SIGTERM' ? remainingMs() / 2 : 0);
    do {
      await wait(Math.min(25, deadline - performance.now()));
      found = await holders(path, remainingMs());
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
  #directory: string | undefined;
  #startedAt = 0;
  readonly #markers = new Map<string, StopMarker>();

  constructor(options: StopMarkersOptions = {}) {
    this.#root = options.root === undefined ? undefined : checkStopMarkerRoot(options.root);
    this.#notify = options.onObservation;
    this.#listHolders = options.listHolders ?? listHoldersSync;
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
        if (inside(this.#root, other) || inside(other, this.#root))
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
    const marker = this.#markers.get(dispatchId);
    if (!marker) return false;
    const held = await endHolders(marker.path, context.remainingMs, true);
    const left = held.stopped ? await strays(marker, context.remainingMs()) : [];
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
      stopped,
      ...(reason ? { reason } : {}),
    });
    // Otherwise the marker stays, so that a later observation of the dispatch can look again.
    if (stopped) this.#retire(dispatchId, marker);
    return stopped;
  };

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
    // A little of the time is kept for returning, so that the call ends within `timeoutMs`.
    const deadline = performance.now() + timeoutMs - 10;
    const remaining = () => deadline - performance.now();
    const paths = [...this.#markers.values()].map((marker) => marker.path);
    const finish = (result: StopMarkerSyncResult) => {
      report(this.#notify, {
        kind: 'sync',
        dispatchId: null,
        holders: result.holders,
        ended: result.ended,
        strays: 0,
        stopped: result.stopped,
        ...(result.stopped ? {} : { reason: 'holders_left' as const }),
      });
      return result;
    };
    if (!paths.length) return finish({ stopped: true, holders: 0, ended: 0 });
    const since = earliest(this.#startedAt);
    const find = (): number[] | null => {
      if (remaining() < 5) return null;
      try {
        return this.#listHolders(paths, since, remaining());
      } catch {
        return null;
      }
    };
    const listing = performance.now();
    const found = find();
    // What one listing costs; a round starts only when a listing still fits after it.
    const cost = performance.now() - listing;
    if (found === null) return finish({ stopped: false, holders: 0, ended: 0 });
    if (!found.length) return finish({ stopped: true, holders: 0, ended: 0 });
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
    return finish({
      stopped: left !== null && !left.length,
      holders: found.length,
      ended: Math.min(found.length, gone.filter((pid) => found.includes(pid)).length),
    });
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
}
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
  const rows = new Map(processTable().map((row) => [row.pid, row]));
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
      const found: StopMarkerDispatch = {
        dispatchId: meta?.dispatchId ?? null,
        instance,
        workspace: meta?.workspace ?? null,
        holders: [],
        ended: 0,
        strays: [],
        stopped: false,
      };
      // Without its record an instance may be one being created now: never signalled.
      if (!record) found.reason = 'instance_unknown';
      else {
        const held = await endHolders(join(instance, tag), remaining, end);
        let left = held.stopped && meta ? await strays(meta, remaining()) : [];
        // The dead host's own runtime, such as Claude Code, can take a moment to notice that its
        // input closed; a sweep looks again while its time lasts. A stale check does not wait.
        while (end && meta && left?.length && remaining() > 400) {
          await wait(200);
          // A look that fails keeps what the last one found: still not stopped, and still named.
          const again = await strays(meta, remaining());
          if (again === null) break;
          left = again;
        }
        found.holders = held.holders ?? [];
        found.ended = held.ended;
        found.strays = left ?? [];
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
        if (end && found.stopped)
          for (const file of [tag, `${base}.sh`, `${base}.json`])
            rmSync(join(instance, file), { force: true });
      }
      result.dispatches.push(found);
      report(options.onObservation, {
        kind: end ? 'sweep' : 'stale',
        dispatchId: found.dispatchId,
        holders: found.holders.length,
        ended: found.ended,
        strays: found.strays.length,
        stopped: found.stopped,
        ...(found.reason ? { reason: found.reason } : {}),
      });
    }
    // A record or wrapper without its marker never ran a command: the marker is written first.
    if (end && record && !readdirSync(instance).some((file) => file.endsWith('.tag')))
      rmSync(instance, { recursive: true, force: true });
  }
  result.stopped = result.dispatches.every((dispatch) => dispatch.stopped);
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
