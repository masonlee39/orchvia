# SPEC-0027: Read-only access, task labels and host-facing corrections

Date: 2026-09-26. Status: approved by the owner on 2026-09-26, who chose the recommended option of each of the eleven decisions on the downstream host's report. Release: 0.1.4. Evidence: [TDD-0027](../tdd/0027-read-only-access-and-host-corrections.md).

## Why

A desktop host that embeds the engine in its main process reported seven gaps in 0.1.3. It could work around each only by going around the SDK, or learned of it only when something had already failed.

- **R:** reading tasks, usage and events while the engine was not running needed either a full engine, which runs recovery, starts the scheduler and adapters and writes the emergency reserve, or reading the internal tables of `store.sqlite`.
- **L:** tasks and sessions had no fields of the host's own, and a runtime adapter's `extendOptions` received only the task and session IDs. To know which conversation and agent a delegated child worked for, the host followed `parentTaskId` with `tasks.get` on every dispatch; to group tasks it listed all of them.
- **F:** when the engine stopped accepting work after an internal failure, nothing told an embedding host. It had to poll `scheduler.get`.
- **C:** `events.read` answered `CURSOR_EXPIRED` both for cursors after which the reader must resynchronize and for requests the caller got wrong, such as a cursor other than `0` without its `storeId`. A reader that forgot the `storeId` took it for collected history.
- **T:** the public TypeScript types disagreed with the wire contract. `TaskSpec.contextPlan` required four fields that the engine treats as optional, several results were typed `unknown`, and the SDK's declarations referred to `@orchvia/engine/internal/*`.
- **K:** the SDK remembered each idempotency key's request before sending it and never forgot it. A request that the engine rejected, which the engine does not record, could not be corrected under the same key: the SDK refused the corrected request itself with `IDEMPOTENCY_CONFLICT`.
- **A:** a Claude adapter given `options`, `extendOptions` or the `workspace-write` profile, and no execution-stop observer, was accepted, although none of its dispatches could release its execution lease. A Codex adapter with `workspace-write` and no observer had the same gap. The host learned of it when execution capacity ran out.

## Acceptance criteria

### R: Read-only access

- **R01** `openReadOnlyEngine({ stateDir })` in `@orchvia/engine` and `openOrchestratorReadOnly({ stateDir })` in `@orchvia/sdk` open an existing store without taking its owner lock, running recovery, starting the scheduler, timers or adapters, writing the emergency reserve, creating or changing directories, creating tables or indexes, writing metadata or migrating. A `stateDir` or `store.sqlite` that does not exist fails with `NOT_FOUND`, and nothing is created.
- **R02** Opening, reading and closing leave `store.sqlite`, an existing `store.sqlite-wal`, `owner.sqlite` and every other file under `stateDir` unchanged byte for byte. The only files that may appear are `store.sqlite-shm` and an empty `store.sqlite-wal`, which SQLite creates to read a store in WAL mode.
- **R03** Each call reads one snapshot, in one read transaction. On the same committed state, `tasks.get`, `tasks.list`, `sessions.get`, `usage.get`, `usage.getRecord`, `events.read`, `operations.get`, `operations.lookup`, `approvals.get`, `messages.get`, `handoffs.get`, `handoffs.list`, `costs.get` and `context.checkRefs` return what a running engine returns, through the same code. Nothing expires: approvals, messages and handoffs are returned as they were last written. `rules.list` returns the rules registered at runtime; rules from a configuration are unknown offline.
- **R04** A store with a write-ahead log left by an engine that did not close returns every row that engine committed.
- **R05** `info()` returns `{ storeId, schemaVersion, role, workspace, recoveryPending }`. `recoveryPending` is true exactly when starting an engine would change rows during recovery: a task that is queued, running or verifying; a session with an active dispatch; a pending runtime-permission approval; a persisted operation; a persisted message to a closed session. Recovery and this check use one definition.
- **R06** Every other method, including every write and the reads that need adapters, configuration or a live host (`sessions.inspect`, `capabilities.get`, `context.estimate`, `scheduler.get`, `scheduler.getConflict`, `state.snapshot`, `storage.status`), fails with `READ_ONLY` and changes nothing. The TypeScript `ReadOnlyOrchestrator` has no write methods.
- **R07** A `schemaVersion` other than 3 fails with `SCHEMA_MISMATCH`; for an older store the message says that opening it with a full engine migrates it. Stores of every role can be read: active, standby, retired and archive. `store.sqlite` must be a regular file at its canonical path, or the open fails with `UNTRUSTED_PATH`.
- **R08** An open read-only handle does not keep a full engine from starting on the same `stateDir`, and its next call sees what that engine committed.
- **R09** `orchvia host --read-only --state-dir <absolute path> --stdio` serves the same methods over stdio without a configuration file, and `initialize` lists `readOnly: { version: 1 }` among its capabilities. The Python SDK reads through it; its writes fail with `READ_ONLY`.

### L: Labels and task chains

- **L01** `TaskSpec` and `SessionOpenSpec` accept `label`, a string of 1 to 256 UTF-8 bytes, and `metadata`, a JSON object of at most 4096 bytes when encoded and at most 16 levels deep. Both are part of the request digest. Task snapshots return them in `spec`; session snapshots return them as `label` and `metadata`. `initialize` lists `workflow.labels`, and both SDKs refuse the fields before sending when a host does not list it.
- **L02** What the host creates carries what the host passed: a task from `tasks.create`, including the task a handoff hands over, and a session from `sessions.open`. What the engine creates inherits: a child that `work_delegate` creates takes its parent's `label` and `metadata`, a session that the engine creates for a task takes the task's, and a fork takes its source session's.
- **L03** `tasks.list({ label })` returns the tasks with that label in creation order, through the index `tasks_label`, and pages as the other filters do. At most one of `parentTaskId`, `sessionId` and `label` may be given. The Python SDK's `tasks.list` takes `label`.
- **L04** `RuntimeInput` carries `parentTaskId` (null for a root task), `rootTaskId`, `label`, `metadata`, `sessionLabel` and `sessionMetadata`, each null when absent. The metadata values are deep-frozen copies, so a host that changes them cannot change what is stored.
- **L05** `task.*` events carry the task's `label` in their data when it has one.

### F: Notice of an internal failure

- **F01** `EngineConfig.onFatal(failure)` is called once per engine instance with the `{ step, code, at }` that `HOST_STOPPING` then reports. It runs in a microtask after the engine recorded the failure, so `scheduler.get` already lists `SCHEDULER_FAILED` and writes are refused. It is not called for a requested close. An error it throws is reported with `process.emitWarning` and changes nothing.
- **F02** Before calling it, the engine commits the event `scheduler.failed` with the same data when its store can still be written. When the store is degraded, the callback is still called and no event is written.
- **F03** A failed storage collection and a failed usage write emit a process warning, as the other five steps do. The command-line host writes one line to its error output when the engine stops after a failure.

### C: Event cursor errors

- **C01** `events.read` fails with `VALIDATION_ERROR` when `afterCursor` is not a decimal cursor, and when a cursor other than `0` comes without its `storeId`.
- **C02** `CURSOR_EXPIRED` means that the reader must resynchronize. Its data holds `reason`, `retentionFloorCursor`, `lastCursor` and `currentStoreId`. The reasons are `store_changed`, when `storeId` names another store, as after a rollover or an import; `below_retention_floor`, when events after the cursor were collected; and `ahead_of_store`, when the store has fewer events than the cursor, as after restoring an older copy.

### T: Public types

- **T01** `tasks.create` takes a `TaskSpecInput`, whose `contextPlan` is a `ContextPlanInput`: `requestedMode` and `independent` are required and the other fields are optional, as on the wire. Task snapshots keep `TaskSpec`, whose plan the engine completes.
- **T02** `@orchvia/engine/types` exports the types of the public results, among them `StoragePolicy`, `StorageStatus`, `StateSnapshotPage`, `RolloverRecord`, `CostSummary`, `ContextEstimate` and `ContextEstimateInput`. `costs.get`, `context.estimate`, `storage.status`, `state.snapshot` and the store methods return them, and `sessions.control` takes the action `'pause' | 'resume' | 'stop'`.
- **T03** No declaration file of `@orchvia/sdk` refers to `@orchvia/engine/internal/`.

### K: The SDK's idempotency cache

- **K01** When the engine rejects a mutation whose retry identity this call created, the SDK forgets that identity, unless the error is one that can follow a commit (K04). The same key with a corrected request is then sent.
- **K02** An identity is kept when it existed before the call, when the request failed in the SDK or its transport rather than in the engine (a timeout, a lost or closed connection, an abort, a full request queue, an oversized frame or a malformed response), and for the errors of K04. The same key with another request then still fails locally with `IDEMPOTENCY_CONFLICT`.
- **K03** `forgetIdempotencyKey(key)` in TypeScript and `forget_idempotency_key(key)` in Python remove the identities of that key for every method and scope and return how many they removed. Each client keeps at most 10,000 identities and removes the least recently used first.
- **K04** The engine errors that keep the identity are the ones that can follow a commit, or whose commit is unknown: `RESOURCE_CLEANUP_INCOMPLETE` (owner reconciliation after its audit committed), `ROLLOVER_IN_PROGRESS`, `ROLLOVER_BLOCKED` and `STORE_SWITCH_IN_PROGRESS` (store switches and backups, which commit their records in steps), `SHUTDOWN_INCOMPLETE`, `OUTCOME_UNKNOWN`, `OPERATION_HISTORY_EXPIRED`, `IDEMPOTENCY_CONFLICT` (the key holds another committed request), and `INTERNAL_ERROR`, `STORAGE_DEGRADED` and an error without a code.

  Forgetting cannot duplicate or change work in a store: the engine compares every request under a key with the request it committed. The identity's other role is to send a retry to the store of the original request after a store switch, which matters only for a request that may have committed; those are the errors above.

### A: Proof that execution stopped

- **A01** `createClaudeAdapter` fails with `INVALID_ADAPTER_CONFIG` when it cannot vouch that its terminal event ends execution, because it has `options`, `extendOptions` or the `workspace-write` profile, and no `observeExecutionStop` is given, unless `executionStop: 'owner-reconcile'` is set. The message names both ways out.
- **A02** `executionStop: 'owner-reconcile'` keeps the behavior of 0.1.3: `terminalCoversExecution` is false, and the owner's reconciliation releases the lease. Giving it together with `observeExecutionStop` fails with `INVALID_ADAPTER_CONFIG`.
- **A03** `createCodexAdapter` applies the same rule to the `workspace-write` profile. ([SPEC-0034](./0034-background-command-stop-proof.md) A01 extends it to every Codex profile.)

## Tests

- Engine and SDK: a store written by a running engine, read through a read-only handle while that engine is idle, after it closed, and after its files were copied while it ran; the directory before and after; methods outside R03 and every write; a missing directory, another schema, each role and a store path that is a link; a full engine started while a handle is open (R01 to R08).
- Contract: the command-line host with `--read-only` over stdio, from TypeScript and from Python (R09).
- Engine: label and metadata limits, snapshots and digests; inheritance by delegated children, engine-created sessions and forks, and none for host-created tasks and sessions; `tasks.list({ label })` with its query plan; `RuntimeInput` seen by an adapter and by the Claude adapter's `extendOptions`; task events (L01 to L05).
- Engine: the storage fault of 0025-F01 calls `onFatal` within a second without polling, after `scheduler.failed` was committed; a degraded store calls it without an event; a requested close does not call it; a throwing callback; the two warnings (F01 to F03).
- Engine and SDK: the two validation errors and the three reasons with their data, from both SDKs (C01, C02).
- Typecheck: calls of every public SDK method with realistic values and no casts; the package smoke test reads every declaration file of `@orchvia/sdk` (T01 to T03).
- SDK: a rejected `sessions.open` corrected under the same key, in both SDKs; kept identities after a local failure, after a timeout, before the call and for the errors of K04; `forgetIdempotencyKey`; the limit (K01 to K04).
- Adapters: each combination that lacks proof, the opt-out, and the two options together, for Claude and Codex (A01 to A03).

## Not in this increment

The other requests of the same report are planned for 0.1.5: list filters by status and in reverse order, batch reads and token totals per root task; token counts and the model in `usage.recorded`, and output tails in `verification.completed`; why a queued task waits; a close mode that marks interrupted turns as paused by the shutdown; retiring verification rules; an emergency reserve that does not block the caller's thread.
