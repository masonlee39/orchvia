import { execFile, execFileSync } from 'node:child_process';

/** One process of a tree, with the start time that tells it apart from a later reuse of its PID. */
export interface TreeProcess {
  pid: number;
  processGroupId: number;
  started: string;
}

/** One row of the process table; `started` is `ps` lstart, with one-second resolution. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
  /** The executable, as `ps` names it: a path on macOS, a short name on Linux. */
  command: string;
}

const PS_ARGUMENTS = ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='];
const psOptions = (timeoutMs: number) => ({
  encoding: 'utf8' as const,
  timeout: Math.max(1, Math.ceil(timeoutMs)),
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C' },
});
function rows(out: string): ProcessRow[] {
  return (
    out
      .split('\n')
      // lstart is five fields in the C locale, such as `Mon Sep 29 10:00:00 2026`.
      .map((line) =>
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*(.*?)\s*$/.exec(line),
      )
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        started: match[4],
        command: match[5],
      }))
  );
}

/**
 * The process table now; throws when it cannot be read within `timeoutMs`. It holds the thread
 * while `ps` runs, some tens of milliseconds: for a path that cannot wait (SPEC-0061 T02).
 */
export function processTable(timeoutMs = 5000): ProcessRow[] {
  return rows(execFileSync('ps', PS_ARGUMENTS, psOptions(timeoutMs)));
}
/** SPEC-0061 T01: the process table now, read without holding the thread; rejects as above. */
export function processTableAsync(timeoutMs = 5000): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) =>
    execFile('ps', PS_ARGUMENTS, psOptions(timeoutMs), (error, stdout) =>
      error ? reject(error) : resolve(rows(stdout)),
    ),
  );
}

/**
 * The descendants of `pid` now, on macOS and Linux (SPEC-0034 A03). A process that already left
 * the tree, as a backgrounded command does when its shell exits, is not among them. Empty when
 * the process table cannot be read, or on Windows. SPEC-0061 T01: listed without holding the thread.
 */
export async function descendantsOf(pid: number): Promise<TreeProcess[]> {
  if (process.platform === 'win32') return [];
  try {
    return descendants(pid, await processTableAsync());
  } catch {
    return [];
  }
}
function descendants(pid: number, table: ProcessRow[]): TreeProcess[] {
  const found: TreeProcess[] = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of table)
      if (row.ppid === parent && !seen.has(row.pid)) {
        seen.add(row.pid);
        queue.push(row.pid);
        found.push({ pid: row.pid, processGroupId: row.pgid, started: row.started });
      }
  }
  return found;
}

/**
 * Ends the listed processes that are still the same processes: SIGTERM, then after `graceMs`
 * SIGKILL (SPEC-0034 A03). A process that leads its own group is signalled with its group; any
 * other only by itself, so the host's own group is never signalled.
 */
export async function endProcesses(processes: TreeProcess[], graceMs: number): Promise<void> {
  if (!processes.length || process.platform === 'win32') return;
  // SPEC-0061 T01: listed without holding the thread, each time.
  const current = async (): Promise<{ pid: number; group: boolean }[]> => {
    let table: ProcessRow[];
    try {
      table = await processTableAsync();
    } catch {
      return [];
    }
    const own = table.find((row) => row.pid === process.pid)?.pgid;
    return processes.flatMap((target) => {
      const row = table.find((candidate) => candidate.pid === target.pid);
      if (!row || row.started !== target.started || target.pid === process.pid) return [];
      return [{ pid: target.pid, group: row.pgid === target.pid && row.pgid !== own }];
    });
  };
  // Invariant: a listing's processes are signalled in the turn in which it was read.
  const signal = async (name: NodeJS.Signals) => {
    for (const { pid, group } of await current())
      try {
        process.kill(group ? -pid : pid, name);
      } catch {
        // Gone already.
      }
  };
  await signal('SIGTERM');
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline && (await current()).length)
    await new Promise((resolve) => setTimeout(resolve, 25));
  await signal('SIGKILL');
}
