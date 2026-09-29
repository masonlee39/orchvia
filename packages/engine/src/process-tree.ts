import { execFileSync } from 'node:child_process';

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

/** The process table now; throws when it cannot be read within `timeoutMs`. */
export function processTable(timeoutMs = 5000): ProcessRow[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], {
    encoding: 'utf8',
    timeout: Math.max(1, Math.ceil(timeoutMs)),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
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
 * The descendants of `pid` now, on macOS and Linux (SPEC-0034 A03). A process that already left
 * the tree, as a backgrounded command does when its shell exits, is not among them. Empty when
 * the process table cannot be read, or on Windows.
 */
export function descendantsOf(pid: number): TreeProcess[] {
  if (process.platform === 'win32') return [];
  let rows: ProcessRow[];
  try {
    rows = processTable();
  } catch {
    return [];
  }
  const found: TreeProcess[] = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows)
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
  const current = (): { pid: number; group: boolean }[] => {
    let rows: ProcessRow[];
    try {
      rows = processTable();
    } catch {
      return [];
    }
    const own = rows.find((row) => row.pid === process.pid)?.pgid;
    return processes.flatMap((target) => {
      const row = rows.find((candidate) => candidate.pid === target.pid);
      if (!row || row.started !== target.started || target.pid === process.pid) return [];
      return [{ pid: target.pid, group: row.pgid === target.pid && row.pgid !== own }];
    });
  };
  const signal = (name: NodeJS.Signals) => {
    for (const { pid, group } of current())
      try {
        process.kill(group ? -pid : pid, name);
      } catch {
        // Gone already.
      }
  };
  signal('SIGTERM');
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline && current().length)
    await new Promise((resolve) => setTimeout(resolve, 25));
  signal('SIGKILL');
}
