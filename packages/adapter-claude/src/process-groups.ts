import type { ChildProcess } from 'node:child_process';
import type { RuntimeStopContext } from '../../engine/src/types.ts';

let warned = false;
/**
 * SPEC-0023 P03: true only when the context lists at least one process and none of the listed
 * process groups has a member left. Any error other than "no such process group" counts as not
 * stopped. `kill` is replaceable for tests.
 *
 * @deprecated SPEC-0034 A02: only the Claude Code process's own group is checked. Claude Code runs
 * each Bash command in a group of its own, and a backgrounded command outlives it, so this can
 * answer true while such a command runs. Use the adapter's `stopMarker: true` instead.
 */
export function processGroupsStopped(
  context: Pick<RuntimeStopContext, 'processes'>,
  kill: (pid: number, signal: number) => unknown = process.kill,
): boolean {
  if (!warned) {
    warned = true;
    process.emitWarning(
      'processGroupsStopped checks only the Claude Code process group; Bash commands run in their own group and a backgrounded one is not seen. Use stopMarker: true (SPEC-0034).',
      'DeprecationWarning',
    );
  }
  const processes = context.processes ?? [];
  if (processes.length === 0) return false;
  for (const { processGroupId } of processes) {
    // -1 would address every process; no group of ours has an ID below 2.
    if (!Number.isInteger(processGroupId) || processGroupId < 2) return false;
    try {
      kill(-processGroupId, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') return false;
    }
  }
  return true;
}

/** SPEC-0023 P04: signal a process and its descendants, which share its process group (P01). */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined)
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone or cannot be signalled; still try the process itself.
    }
  child.kill(signal);
}

/**
 * SPEC-0023 P04: SIGKILL what is left of a process group. The group is checked first: its ID
 * cannot be reused while a member remains, so the signal cannot reach an unrelated group.
 */
export function killProcessGroup(child: ChildProcess): void {
  if (process.platform === 'win32' || child.pid === undefined) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The last member exited in between.
  }
}
