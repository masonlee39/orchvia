# TDD-0065: Tasks that the host completes

Specification: [SPEC-0065](../specs/0065-host-tasks.md).

## The request

A host asked for workflow steps that no model runs, with the engine's dependency order, idempotency, recovery and results, ended by the host. Before the change, `tasks.create` required a configured provider and selected a session for every task, and no method took a result from the host.

## RED

- `tests/engine/host-tasks.test.ts`: 15 of 15 failed. `tasks.create` with `executor: 'host'` was refused with `VALIDATION_ERROR` (unknown field), and `tasks.complete` was an unknown method.
- Added after the first GREEN, each seen failing first: `tasks.list({ status: ['waiting_host'] })` was refused with `Unknown task status`; a read after a restart showed a due task still `waiting_host`.
- `tests/engine/review-second-batch-0061.test.ts` and `tests/contract/marker-time-0063.test.ts`, the four tests named `0065-B02`: 4 of 4 failed. With no `verificationEnvironment` the command's environment was the host's own, and an engine with rules warned.
- `tests/contract/host-tasks-sdk-0065.test.ts` and `python/tests/test_host_tasks_0065.py` were written after the engine change; they are the cross-language coverage of H10 and H11 and have no RED of their own beyond the SDK methods that did not exist.

## GREEN

- `tests/engine/host-tasks.test.ts`: 15 of 15.
- `tests/contract/host-tasks-sdk-0065.test.ts`: 3 of 3, over a Unix socket host, with the payloads checked against the schema and six negative cases.
- `python/tests/test_host_tasks_0065.py`: 3 of 3, with a stdio host.
- The four `0065-B02` tests pass.

## What the type change touched

`TaskSnapshot.sessionId` became `string | null` and `TaskSpec.runtime` and `acceptance` optional. The compiler then reported 201 places: 22 in the engine, 7 in its conformance fixture, 4 in the cost ledger, 1 each in recovery and the TypeScript SDK, 5 in the examples and the rest in tests. The engine reads a task's session through `sessionIdOf`, which fails with `UNSUPPORTED_CAPABILITY` for a host task; start-up recovery and `recoveryPending` skip a task without a session; tests and examples that create a task for a runtime assert the session with `!`.

## The compatibility gate

The surface baseline of 0.1.33 holds `TaskSpec.runtime`, `TaskSpec.acceptance`, `TaskSnapshot.sessionId` and the required Python parameters, so the change is a breaking one and the version is 0.2.0 (SPEC-0051 G02). `node scripts/set-version.mjs 0.2.0` accepted it and wrote the new baseline.

## Mutations, each restored from a copy

Each of these fails `tests/engine/host-tasks.test.ts`:

- `dependencyState` returns `queued` for a host task (invariant 1): 12 of 15 fail.
- `tasks.cancel` without its branch for a task without a session (H07): 2 fail.
- No `recordFeature('hostTasks')` (R01): 1 fails.
- No expiry before a call (invariant 6): 1 fails.
- The completing transaction does not compare its time with `expiresAt` (invariant 3): 1 fails, the case where the time passes while the result's file is written.

Two mutations survived and their code was removed: a second expiry pass at the start of `tasks.complete`, which the pass before every call already makes, and one after a `TASK_EXPIRED` refusal, which the next call or the timer makes.

## Full runs

- The first full run failed 5 tests, each a place the change had missed: the list of workflow flags in `0014-X02`, `ACTIVE_TASK_STATUSES` and the `tasks.list` statuses without `waiting_host` (`AC-0052-P02`), a version written in two source comments and the changelog heading (`0021-P08`), and a link to this file (`0021-R04`).
- The second failed 2 (`0028-P04`, `0029-A02`): the expiry query before every call scanned the partial index. It now searches it for the due times and for the earliest later one, so those tests also guard E03.
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` pass. `npm test`: 1118 of 1118. `npm run test:python`: 127 of 127. Node 24.14.0 on macOS.
- Not run here: `scripts/compat-rollback.mjs` and `scripts/compat-python.mjs`, which need the registries, and `scripts/check-python-types.py`, which needs mypy. CI runs them.
