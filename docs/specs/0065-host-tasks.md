# SPEC-0065: Tasks that the host completes

Date: 2026-10-04. Status: approved by the owner on 2026-10-04 (D-host-1 option 1, D-host-2 option 1, D-host-3 option 1, D-host-4 option 1, D-host-5 option 1, D-host-6 option 1, D-host-7 option 1). Release: 0.2.0, a minor release, because it changes the type of existing fields. Environments: every host; no runtime is involved. Evidence: [TDD-0065](../tdd/0065-host-tasks.md).

## Why

A host's workflow has steps that no model runs: waiting for a person, calling a connector, waiting for a ticket to change, waiting until a time. They need the same dependency order, idempotency, recovery after a restart and results for later steps as tasks do. Every task needed a runtime and a session, and no method let the host submit a result, so a host kept a second ledger for those steps and recovered both.

The engine does not call connectors, send notifications or receive outside events. It orders the task, records it and takes the result from the host.

## H. Host tasks

- **H01** `tasks.create` accepts `spec.executor: 'host'`. Such a spec has `goal`, and may have `dependencyTaskIds`, `parentTaskId`, `label`, `metadata`, `budget` and `expiresAt`. `runtime`, `acceptance`, `writeScope`, `writePath`, `contextPlan` and `contextEstimate` fail with `VALIDATION_ERROR`. A spec without `executor` needs `runtime` and `acceptance`, as before, and `expiresAt` fails with `VALIDATION_ERROR`.
- **H02** A host task has no session and no dispatch: its snapshot's `sessionId` is `null`, and it holds no execution lease, so it does not count in A, Q or R. It is never `queued`. Its `task.created` event and its status events carry `executor: 'host'`, and their `sessionId` is `null`.
- **H03** While a dependency is unfinished the task is `waiting_dependency`; when a dependency failed or was cancelled it is `blocked` with `dependency_failed`; otherwise it is `waiting_host`, a new task status.
- **H04** `tasks.complete({ taskId, outcome, result?, idempotencyKey })` ends a host task that is `waiting_host`. `outcome` is `'completed'` or `'failed'`. `result` is text of at most 262144 UTF-8 bytes; it is stored as an artifact, the task's `artifactRefs` holds it and `result` holds its preview, as for a runtime's result. A completed task has `reason: null` and `deliveredAt`; a failed one has `reason: 'host_reported_failure'`. The operation's result is `{ taskId, status }`.
- **H05** Tasks that depend on a host task are released or blocked as for any task: a completed host task's result is in their prompt within the bounds of SPEC-0014 D, and `context.checkRefs` and `contextRefs` accept its artifact.
- **H06** `tasks.complete` fails with `VALIDATION_ERROR` for a task that is not a host task, with `TASK_NOT_READY` for a host task that is `waiting_dependency` or `blocked`, with `STALE_TARGET` for one that ended, and with `TASK_EXPIRED` for one that expired (E02). The same key with the same parameters returns the first operation.
- **H07** `tasks.cancel` cancels a host task in any state that is not an end, without reading a session. `tasks.resume` and `messages.send` to a host task fail with `UNSUPPORTED_CAPABILITY`.
- **H08** A host task may be a parent: `tasks.create` with its id as `parentTaskId` makes it the root of those tasks, they inherit its `budget`, and `costs.get` with `scope: 'tree'`, `usage.summary` and `usage.byTask` count them. The host task itself has no cost and no usage. Cancelling or completing it does not change its children.
- **H09** `limits.maxHostTasks` (1 to 10000, default 1000) bounds the host tasks that are `waiting_host`; creating a host task at the bound fails with `QUEUE_CAPACITY_EXHAUSTED`. A host task that waits for a dependency counts in `maxQueuedTasks`, as any task does.
- **H11** `settle()` of both SDKs returns the reason `waiting_host` for a host task that waits for the host, and for a blocked host task it returns no session.
- **H10** `initialize` announces `capabilities.workflow.hostTasks: true`. Both SDKs check it before they send a host task or `tasks.complete`. TypeScript: `orch.tasks.complete(taskId, { outcome, result? }, options?)`. Python: `tasks.complete(task_id, outcome=..., result=None, idempotency_key=None)`.

## E. Expiry

- **E01** `spec.expiresAt` is an ISO 8601 time, later than the time of creation and at most 365 days after it; anything else fails with `VALIDATION_ERROR`. It is stored in its canonical form (`toISOString`). A repeated `tasks.create` with the same key returns the first operation, also after that time.
- **E02** A host task that has not ended at `expiresAt`, in any state, becomes `failed` with `reason: 'host_task_expired'`, and what depends on it becomes `blocked`. A `tasks.complete` whose transaction time is at or after `expiresAt` is refused with `TASK_EXPIRED` and changes nothing, whether or not the timer had fired, also after a restart during which the time passed; the task is then expired by the timer or by the next call, whichever comes first.
- **E03** One timer of the engine's clock wakes the scheduler at the earliest remaining `expiresAt`; the times are compared with the store's wall time. Due tasks are found through the partial index `tasks_host_expiry`.

## R. An older engine

- **R01** The transaction that creates a store's first host task records the store feature `hostTasks` (SPEC-0051 R02). An engine from 0.1.26 to 0.1.33 refuses that store with `STORE_TOO_NEW` instead of reading a task without a session. A store without host tasks opens with those engines as before.

## B. What breaks

- **B01** `TaskSpec.runtime` and `TaskSpec.acceptance` are optional and `TaskSnapshot.sessionId` is `string | null`, in the wire schema, the TypeScript types and the Python views. A host that reads them from a task that may be a host task checks them first. `TaskStatus` has `waiting_host`.
- **B02** A check's command gets the minimal environment by default (`verificationEnvironment: 'minimal'`), as [SPEC-0061](0061-review-second-batch.md) V03 announced for the next minor version. A host whose checks need more of its environment names the variables in `verificationInheritEnv`, or sets `verificationEnvironment: 'inherit'`. The warning of [SPEC-0063](0063-marker-time-and-environment-warning.md) W, which no release contained, is removed with the default it announced.

## Timing invariants

1. **Never dispatched.** After every committed transaction, a host task is not `queued` and has no session row and no dispatch row. The scheduler reads only `queued` tasks, so it cannot dispatch one.
2. **The first commit wins.** `tasks.complete`, expiry and `tasks.cancel` each end the task in one transaction of the single writer. The one that commits first decides; the others find an ended task and change nothing. A second result never replaces the first.
3. **Expiry is decided by transaction time.** Every call, a read included, first expires the host tasks that are due, and the completing transaction compares its own time with `expiresAt`, because writing the result's file takes time. A completion at or after `expiresAt` therefore loses even when the timer is late or the engine was down.
4. **Result and status together.** The artifact's registration, the task's status and its event commit in one transaction. The artifact's file is written before that transaction, off the event loop (SPEC-0057); no reader sees a completed host task without its artifact.
5. **Release without polling.** The scheduler runs after the completing mutation (SPEC-0055) and after an expiry, so what depended on the task is released or blocked, and a released task dispatched, without another call.
6. **A restart changes nothing.** A host task has nothing to reconcile. No scheduler pass runs before the first call after a start; that call, a read included, expires what came due and arms the timer from the stored times.

## Not in this specification

Cascading cancellation of a task's tree, intermediate results of a running task, and results of another engine's store.
