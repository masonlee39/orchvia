import type { RuntimeStopContext, RuntimeStopObserver } from './types.ts';

/** Bound the initial wait while retaining a late positive observation for its original target. */
export async function observeRuntimeStop(
  observer: RuntimeStopObserver | undefined,
  context: Omit<RuntimeStopContext, 'signal' | 'remainingMs'>,
  timeoutMs: number,
  onStopped: () => void,
): Promise<boolean> {
  if (!observer) return false;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observation = Promise.resolve()
    .then(() =>
      observer(
        Object.freeze({
          target: Object.freeze({ ...context.target }),
          terminal: Object.freeze({ ...context.terminal }),
          ...(context.processes
            ? {
                processes: Object.freeze(
                  context.processes.map((item) => Object.freeze({ ...item })),
                ),
              }
            : {}),
          signal: controller.signal,
          remainingMs: () => Math.max(0, deadline - performance.now()),
        }),
      ),
    )
    .then(
      (stopped) => {
        if (stopped !== true) return false;
        onStopped();
        return true;
      },
      () => false,
    )
    .catch(() => false);
  try {
    return await Promise.race([
      observation,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * SPEC-0027 A01 to A03: an adapter that cannot vouch that its terminal event ends execution needs
 * an observer that proves it, or the explicit choice of owner reconciliation. Otherwise no dispatch
 * could release its execution lease.
 */
export function requireStopProof(
  adapter: string,
  coversExecution: boolean,
  config: { observeExecutionStop?: unknown; executionStop?: unknown },
): void {
  const invalid = (message: string) =>
    Object.assign(new Error(message), { code: 'INVALID_ADAPTER_CONFIG' });
  if (config.executionStop !== undefined && config.executionStop !== 'owner-reconcile')
    throw invalid(`${adapter}: executionStop must be 'owner-reconcile'`);
  if (config.executionStop !== undefined && config.observeExecutionStop !== undefined)
    throw invalid(
      `${adapter}: give observeExecutionStop or executionStop: 'owner-reconcile', not both`,
    );
  if (!coversExecution && config.observeExecutionStop === undefined && !config.executionStop)
    throw invalid(
      `${adapter}: this configuration cannot prove that a dispatch stopped, so no execution lease could be released. Give observeExecutionStop${/claude/i.test(adapter) ? ' (on macOS and Linux, stopMarker: true supplies one)' : ''}, or set executionStop: 'owner-reconcile' to release leases by owner reconciliation`,
    );
}
