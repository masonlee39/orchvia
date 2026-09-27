import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

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
          else if (
            line.startsWith('n') &&
            (line.slice(1) === workspace || line.slice(1).startsWith(workspace + sep))
          )
            found.push(pid);
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
async function strays(marker: StopMarker, timeoutMs: number): Promise<number[] | null> {
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
  // lstart has one-second resolution, and Linux derives it from a boot time truncated to the
  // second, so it can read up to a second early: count from the second before the dispatch's.
  const since = Math.floor(marker.startedAt / 1000) * 1000 - 1000;
  return candidates.filter((pid) => {
    const row = byPid.get(pid);
    if (!row) return false; // Gone since lsof listed it.
    const started = Date.parse(row.started);
    return !ownTree(pid) && (!Number.isFinite(started) || started >= since);
  });
}

/**
 * Marker files for the commands a runtime starts (SPEC-0034 B01). Each dispatch gets a marker and
 * a wrapper script; every command started through the wrapper holds the marker open, and so does
 * anything it leaves running in the background, because descriptors are inherited. A dispatch has
 * stopped when nothing holds its marker. macOS and Linux only.
 *
 * The directory is private (0700) and lies outside the state directory, so a sandbox that denies
 * the state directory can still be told to allow it.
 */
export class StopMarkers {
  #directory: string | undefined;
  readonly #markers = new Map<string, StopMarker>();

  /** The directory that holds the markers; commands must be able to read it. */
  get directory(): string {
    if (this.#directory === undefined) {
      const directory = mkdtempSync(join(tmpdir(), 'orchvia-stop-'));
      chmodSync(directory, 0o700);
      this.#directory = directory;
    }
    return this.#directory;
  }

  /**
   * Creates the marker of a dispatch before it starts; throws when that is impossible. The wrapper
   * runs each command with `shell`, which must be the shell the runtime expects.
   */
  prepare(dispatchId: string, shell: string, workspace: string): StopMarker {
    const name = Buffer.from(dispatchId).toString('base64url');
    const path = join(this.directory, `${name}.tag`),
      wrapper = join(this.directory, `${name}.sh`);
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
    const marker = { path, wrapper, workspace: realpathSync(workspace), startedAt: Date.now() };
    this.#markers.set(dispatchId, marker);
    return marker;
  }

  /**
   * Ends whatever still holds the dispatch's marker: SIGTERM, then SIGKILL. True only when nothing
   * holds it within `remainingMs()`; the marker is then removed. False when the holders cannot be
   * listed or outlast the time, and the marker stays.
   */
  async end(dispatchId: string, remainingMs: () => number): Promise<boolean> {
    const marker = this.#markers.get(dispatchId);
    if (!marker || !(await this.#endHolders(marker, remainingMs))) return false;
    this.#retire(dispatchId, marker);
    return true;
  }

  /** SIGTERM, then SIGKILL, what holds the marker; true once nothing does. */
  async #endHolders(marker: StopMarker, remainingMs: () => number): Promise<boolean> {
    let found = await holders(marker.path, remainingMs());
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (found === null) return false;
      if (!found.length) break;
      for (const pid of found)
        try {
          process.kill(pid, signal);
        } catch {
          // Gone already.
        }
      const deadline = performance.now() + (signal === 'SIGTERM' ? remainingMs() / 2 : 0);
      do {
        await wait(Math.min(25, deadline - performance.now()));
        found = await holders(marker.path, remainingMs());
      } while (found?.length && performance.now() < deadline);
    }
    return found !== null && !found.length;
  }

  #retire(dispatchId: string, marker: StopMarker): void {
    this.#markers.delete(dispatchId);
    rmSync(marker.path, { force: true });
    rmSync(marker.wrapper, { force: true });
  }

  /**
   * The stop observer these markers supply: it ends what holds the marker, then vouches only when
   * no process in the workspace could be one that dropped it (B03). Those are not ended.
   */
  readonly observer: RuntimeStopObserver = async (context) => {
    const marker = this.#markers.get(context.target.dispatchId);
    if (!marker || !(await this.#endHolders(marker, context.remainingMs))) return false;
    const left = await strays(marker, context.remainingMs());
    // Otherwise the marker stays, so that a later observation of the dispatch can look again.
    if (left === null || left.length) return false;
    this.#retire(context.target.dispatchId, marker);
    return true;
  };

  /** Ends the holders of every marker left; true when none remains. */
  async endAll(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    const results = await Promise.all(
      [...this.#markers.keys()].map((dispatchId) => this.end(dispatchId, remaining)),
    );
    if (results.every(Boolean) && this.#directory !== undefined) {
      if (existsSync(this.#directory)) rmSync(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
    }
    return results.every(Boolean);
  }
}
