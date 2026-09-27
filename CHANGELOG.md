# Changelog

All notable changes to Orchvia are recorded here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may change the API.

## [Unreleased]

Stop markers that survive a host restart.

### Added

- `stopMarker: { directory, onObservation? }`: markers under a host directory that outlives the host, one directory per adapter instance, with each dispatch's workspace recorded; the files of a dispatch not proven stopped stay after the host exits (SPEC-0036 D).
- `sweepStopMarkers(directory)` and `staleStopMarkers(directory)` from `@orchvia/adapter-claude`, without an engine: after a restart, end what earlier instances' commands left running and prove each dispatch stopped, with the workspace check of SPEC-0034; or only report it (SPEC-0036 S).
- `adapter.endStopMarkersSync(timeoutMs)`: a bounded synchronous cleanup for a host's exit path that never throws (SPEC-0036 Y).
- `onObservation`: each stop observation's holders, ended processes, workspace strays and result, for the host's diagnostics (SPEC-0036 O).

## [0.1.10] - 2026-09-27

Commands that Claude Code or Codex leave running after a turn no longer let a dispatch release its execution lease.

### Fixed

- A command that Codex runs can outlive its turn: one that `exec_command` returns from early, or that a shell backgrounds, runs in a process group of its own and survives `turn/completed` and a stop of the app-server's group. The read-only Codex profile nevertheless claimed that its terminal ended execution, so its dispatches released their leases while such commands ran. No Codex profile claims that any more, and each dispatch ends what is left of its app-server's process tree (SPEC-0034 A01, A03).
- `processGroupsStopped` checks only the Claude Code process's group, but Claude Code runs each Bash command in a group of its own and hands backgrounded ones to the init process, so it cannot see them. It is deprecated, warns once, and the error for a missing stop proof no longer suggests it (SPEC-0034 A02).

### Added

- `createClaudeAdapter({ stopMarker: true })` on macOS and Linux: every Bash command of a dispatch runs through a wrapper that holds a marker file open, and the observer ends what still holds it and releases the lease only when nothing does. A process in the workspace started during the dispatch outside the host's process tree, such as a daemon started by Python, which drops the marker, keeps the lease held and is left running. Linux needs `lsof` (SPEC-0034 B).

### Breaking

- Every `createCodexAdapter` now needs `observeExecutionStop` or `executionStop: 'owner-reconcile'`; read-only ones without either fail with `INVALID_ADAPTER_CONFIG`. A JSON CLI `codex` provider must set `"executionStop": "owner-reconcile"`, and its tasks then wait blocked for `sessions.reconcile`. Hosts that use `processGroupsStopped` should move to `stopMarker: true` or their own observer; a host that sets `CLAUDE_CODE_SHELL_PREFIX` itself cannot use `stopMarker` (SPEC-0034).

## [0.1.9] - 2026-09-27

Usage of resumed and forked Claude sessions on Claude Agent SDK 0.3.277 and later, indexed cost queries, the retention status, cache write prices by duration, the TypeScript polling interval and typed Python results.

### Fixed

- From Claude Agent SDK 0.3.277 (Claude Code 2.1.277) on, a resumed or forked session's `modelUsage` continues from its earlier dispatches, so 0.1.8 recorded every earlier dispatch again in the records outside the main loop of a session's second and later dispatches and of a fork's first dispatch. The adapter now reports each dispatch's session totals with its main observation, the engine keeps them with the dispatch and hands them to the next dispatch on the same native session, and the adapter subtracts them. Without such totals, or without Claude Code's version, what a resumed dispatch ran outside its main loop is recorded as unknown. Records already written are not changed (SPEC-0032).

- Automatic collection scanned the records whose detail it had already collected again on every pass, so after everything was collected each run collected nothing, and a newly collectable record waited until the scan had passed every older one. A collected record now leaves the candidates; records collected before 0.1.9 are marked the first time a run meets them (SPEC-0033 S01, [#44](https://github.com/masonlee39/orchvia/issues/44)).

### Added

- `costs.get`, budget checks and settlement read only the records they concern, through new indexes, instead of whole tables; with 50,000 records each, a task's costs and a root budget check went from about 65 ms to under 0.1 ms in a synthetic benchmark. Results are unchanged (SPEC-0033 P, [#43](https://github.com/masonlee39/orchvia/issues/43)).
- `storage.status` returns `retention`: what collection has left and where the collection of events stops, and why (SPEC-0033 S, [#44](https://github.com/masonlee39/orchvia/issues/44)).
- Pricing may set `cacheWrite5m` and `cacheWrite1h`, the prices of cache writes that live five minutes and one hour (SPEC-0033 C, [#45](https://github.com/masonlee39/orchvia/issues/45)).
- The TypeScript client takes `pollIntervalMs` for `events()` and `wait()`, as Python's `poll_interval` (SPEC-0033 T, [#46](https://github.com/masonlee39/orchvia/issues/46)).
- Python results are typed: `orchvia.views` holds read-only views generated from the schema; 25 methods and the handles of mutations return them, mutations with their receipt fields. Results are still `Snapshot`s at run time. CI checks the types with mypy (SPEC-0033 Y, [#47](https://github.com/masonlee39/orchvia/issues/47)).

### Changed

- CI and the development dependencies use Claude Agent SDK 0.3.283 and Codex CLI 0.157.1. The usage check with the real Claude binary also runs with SDK 0.3.274 (SPEC-0032 B04, C06).

## [0.1.8] - 2026-09-27

The usage and cost of what Claude Code runs outside a dispatch's main loop, such as a compaction.

### Fixed

- The Claude adapter recorded only a dispatch's main loop, so the calls outside it, such as the compaction that Claude Code runs by itself when a context fills, a `sessions.compact` dispatch, or a Task subagent, were missing from the usage records, the totals and the cost ledger. It now also reports, from the result's `modelUsage`, each model's calls outside the main loop as a further record: the main model's under the dispatch's model, another model's under its canonical name. The record of the main loop is unchanged (SPEC-0031 A).

### Added

- A usage observation may name its `model`; the record holds it instead of the session's model, and a repeated observation must resolve to the same model. The cost ledger prices a record of another model at that model's registered price in the dispatch's currency, or leaves its cost unknown (SPEC-0031 B).

### Documentation

- The documents no longer name the latest release; GitHub Releases does. Each release pull request records the release before it in `docs/status.md` and TDD-0021, so a release needs no pull request of its own afterwards (SPEC-0021 P10, D-rel-3).

## [0.1.7] - 2026-09-26

What a host needs to price cache writes and to trust the times it shows.

### Added

- Usage records, `usage.recorded` and the totals of `usage.summary` and `usage.byTask` hold `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`, the cache writes that live five minutes and one hour, where a runtime splits them. The Claude adapter reports them from Claude's `cache_creation` when they add up to its cache writes. `cacheWriteInputTokens` minus both is the cache writes without a split, such as those recorded before this version (SPEC-0030 A).

### Fixed

- The engine reads its clock once for each transaction. A task's `deliveredAt` and `updatedAt` now equal the `occurredAt` of the event of the same change; before, they could differ by a millisecond. A task's `updatedAt` and a dispatch's `createdAt` no longer come from the process clock, so a clock passed in `EngineConfig` governs them too. A handoff request's `createdAt` equals the `occurredAt` of its `handoff.requested` event (SPEC-0030 B).

### Documentation

- The guide and the concepts say that an idempotency key names one request: sent again after a rule was retired or reactivated, it returns the first result and changes nothing, so reactivating or retiring a rule again takes a new key (SPEC-0030 C).

## [0.1.6] - 2026-09-26

What a host's usage page and its restart need: token totals for many tasks in one call, the time each task delivered, rules that can be reactivated, and which paused tasks a close interrupted.

### Added

- `usage.byTask({ taskIds })` returns the token totals of 1 to 100 tasks per provider and model, each task's own records counted as `usage.summary` counts a tree, in the order asked, with the IDs that name no task in `missing`. It reads the records of all the tasks in one indexed statement, and a read-only view answers it too. `initialize` lists `workflow.usageByTask` (SPEC-0029 A).
- Task snapshots hold `deliveredAt`, the time the task last delivered a result: each review of its result for human acceptance, or its completion when its checks passed. A runtime permission's review does not change it (SPEC-0029 B).
- A task that a close paused holds `pausedByClose: { operationId, wasRunning }` until it leaves `paused`, so a host can resume the turns that were running before the tasks that were queued (SPEC-0029 D).

### Changed

- `rules.register` of a retired rule version with the same content reactivates it, with the event `rule.reactivated`; other content still fails with `RULE_RETIRED`. Before, the same content was refused too, so a host whose versions are hashes of their content could not retire rules (SPEC-0029 C, superseding part of SPEC-0028 U03).

## [0.1.5] - 2026-09-26

For hosts that show many tasks at once or run on a desktop: queries that answer from indexes, events that carry what a host shows, why a task waits, a close that marks what it paused, rules that can be retired, and an engine start that does not block its thread.

### Added

- `tasks.list` takes `status`, 1 to 10 task statuses, alone or with one of `parentTaskId`, `sessionId` and `label`, and `order: 'desc'`, which starts with the newest task. `tasks.getMany({ taskIds })` reads up to 100 tasks in one call, in the order asked, and names the IDs it did not find. `usage.summary({ rootTaskId })` totals the token counts of a root task and every task under it, per provider and model. `initialize` lists `workflow.taskQueries`, and both SDKs have the methods (SPEC-0028 P).
- `tasks.get`, `tasks.list` and `tasks.getMany` return `blockedBy` on a queued task and on a task that waits for its dependencies: the first condition that keeps the scheduler from dispatching it, such as `capacity`, `session_busy`, `write_conflict` or `storage`, and the tasks or session it waits for. It is computed from the scheduler's own checks when the task is read, and never stored. `initialize` lists `workflow.queueReasons` (SPEC-0028 B).
- `close({ mode: 'pause' })` in both SDKs, `host.shutdown` with `mode: 'pause'`, and `"shutdown": {"mode": "pause"}` in the command-line configuration close as `interrupt` does, and pause the turns they interrupted with `owner_shutdown` instead of `runtime_interrupted`, as they pause queued tasks. `initialize` lists `workflow.pauseClose` (SPEC-0028 S).
- `rules.retire({ id, version })`, for the owner, retires a rule registered at runtime: a task admitted afterwards that names it fails with `RULE_RETIRED`, and it no longer counts toward the 1000 effective rules. Tasks admitted before keep their copy of the rule, for verification and repair retries. A retired version cannot be registered again, and a rule of the configuration cannot be retired. `rules.list({ includeRetired: true })` lists the retired rules too, with `retiredAt`. `initialize` lists `workflow.ruleRetirement` (SPEC-0028 U).
- A usage record written from this version on holds its `sessionId`, `model`, `rootTaskId` and `recordedAt`, and the event `usage.recorded` carries the four token counts, `model` and `rootTaskId`, but not `raw` (SPEC-0028 E01, E02).
- The guide's section on desktop hosts recommends storage limits, a queue wait and the Claude adapter's cleanup timeout for a host that runs on a user's machine (SPEC-0028 W04).

### Changed

- `verification.completed` carries each failed rule's `outputTail`, the end of its output that the retry prompt shows, at most 4 KiB for a rule and 16 KiB for the event; a rule that does not fit has `outputOmitted: 'limit'`. The event therefore contains what a check printed, which can include paths or secrets from the workspace (SPEC-0028 E03, superseding SPEC-0022 V04).
- `createEngine` writes the emergency reserve through `fs.promises` in chunks of 1 MiB, so the event loop keeps running while it writes, and it still resolves only once the reserve is complete and synced. The reserve is written as `emergency.reserve.partial` and renamed when complete, so `emergency.reserve` is never partial; `storage.configure` and store switches write a missing reserve the same way before they return (SPEC-0028 W01, W02).
- `usage.get` reads a task's records through the new index `usage_task` instead of reading the whole usage table. The first start of this version creates the indexes `usage_task` and `tasks_root` (SPEC-0028 P04).
- `storage.configure` starts a scheduler pass, so a task that waited for storage runs when a new policy ends the backpressure (SPEC-0028 B02).

### Fixed

- The guide no longer recommends pausing each running session and then closing with `drain` to stop all work before a shutdown. A queued task could start as soon as a paused turn freed its execution slot or write paths, and the drain then waited for that task. `close({ mode: 'interrupt' })` and `close({ mode: 'pause' })` stop dispatch before they interrupt a turn, and the guide now recommends them.

## [0.1.4] - 2026-09-26

For hosts that embed the engine: reading a store while its engine is stopped, the host's own labels on tasks and sessions, and an immediate notice when an internal failure stops the engine.

### Added

- `openOrchestratorReadOnly({ stateDir })` in `@orchvia/sdk`, `openReadOnlyEngine` in `@orchvia/engine`, and `orchvia host --read-only --state-dir DIR --stdio` read tasks, sessions, usage, events, operations, approvals, messages, handoffs, costs, context checks and runtime rules of a store whose engine is not running. They take no lock, run no recovery, start no scheduler or adapter and write nothing; SQLite may create or update only its WAL index. A log left by an engine that did not close is read in full, `info().recoveryPending` says whether a start would recover rows, and other methods fail with `READ_ONLY` (SPEC-0027 R).
- `label` and `metadata` on `TaskSpec` and `SessionOpenSpec`, returned in snapshots. A child that `work_delegate` creates, a session the engine opens for a task and a fork inherit them. `tasks.list({ label })` lists a label's tasks through an index, `task.*` events carry the label, and each dispatch's `RuntimeInput` carries `parentTaskId`, `rootTaskId`, `label`, `metadata`, `sessionLabel` and `sessionMetadata`, so a Claude adapter's `extendOptions` sees them. `initialize` lists `workflow.labels` (SPEC-0027 L).
- `EngineConfig.onFatal(failure)`, called once in a microtask when an internal failure stops the engine, after the event `scheduler.failed` with the same `{ step, code, at }` was committed where the store could still be written. `orchvia host` writes one line when this happens, and a failed storage collection or usage write now also emits a process warning (SPEC-0027 F).
- `forgetIdempotencyKey(key)` in the TypeScript SDK and `forget_idempotency_key(key)` in Python (SPEC-0027 K03).
- Public types for the results that were `unknown` or internal: `TaskSpecInput` and `ContextPlanInput` for `tasks.create`, `CostSummary`, `ContextEstimateInput`, `ContextEstimateResult`, `StorageStatus`, `StateSnapshotPage`, `StoragePolicy`, `RolloverRecord` and `SessionControlCommand`, all from `@orchvia/engine/types` and `@orchvia/sdk` (SPEC-0027 T).

### Changed

- `events.read` answers a caller's mistake, a cursor other than `0` without its `storeId` or a cursor that is not decimal, with `VALIDATION_ERROR` instead of `CURSOR_EXPIRED`. `CURSOR_EXPIRED` now means that the reader must resynchronize, and its data holds `reason` (`store_changed`, `below_retention_floor` or `ahead_of_store`), `retentionFloorCursor`, `lastCursor` and `currentStoreId` (SPEC-0027 C).
- `createClaudeAdapter` with `options`, `extendOptions` or `permissionProfile: 'workspace-write'`, and `createCodexAdapter` with `workspace-write`, fail with `INVALID_ADAPTER_CONFIG` unless the host gives `observeExecutionStop` or sets `executionStop: 'owner-reconcile'`. Before, such an adapter was accepted although none of its dispatches could release its execution lease, and the engine stopped dispatching when capacity ran out (SPEC-0027 A).
- `sessions.control` takes the action `'pause' | 'resume' | 'stop'` in TypeScript, and `tasks.create` takes a `TaskSpecInput`, whose plan fields are optional as on the wire (SPEC-0027 T).

### Fixed

- A request that the engine rejected can be corrected under the same idempotency key. The SDKs had kept every key's first request and refused the corrected one themselves with `IDEMPOTENCY_CONFLICT`, although the engine records nothing for a rejected request. They now forget the key when the engine rejected the call that claimed it, keep it after transport failures and after the errors that can follow a commit, and keep at most 10,000 keys (SPEC-0027 K).
- The declarations of `@orchvia/sdk` refer to `@orchvia/engine`, `@orchvia/engine/types` and no internal module; the build had given every cross-package import an `internal` path (SPEC-0027 T03).

## [0.1.3] - 2026-09-25

Corrections from a review of 0.1.2: the Claude adapter installs next to any Zod, reads stay fast on a store with a long history, and a socket host starts again after a crash.

### Fixed

- `events.read` with `taskId`, which `events({ taskId })` uses in both SDKs, reads only that task's events, through its index, and a page that is not full moves the cursor to the store's last event. On a store with a long history a new task's first event had reached the iterator seconds late: 5 seconds behind 10,000 events of other tasks, 25 seconds behind 50,000 (SPEC-0024 E).
- The engine finds pending approvals, persisted messages and pending handoffs through partial indexes instead of reading those whole tables before every call, in every scheduler pass and dispatch, and when a task is cancelled. Each call had cost about 22 ms more with 10,000 finished approvals and messages and 140 ms more with 50,000, and one idle event subscriber had kept the engine's thread up to 88% busy (SPEC-0024 X).
- `orchvia host --socket` starts after a host that ended without closing, such as after SIGKILL: it removes the socket file it finds when no process accepts connections on it. It had refused with `SOCKET_IN_USE` until someone removed the file. Another process listening on the path, or a path that is not a socket, is still refused, now with a message that says which (SPEC-0025 S).
- The embedded orchestrator of `createOrchestrator` rejects failed reads with `OrchestratorError`, whose details are in `data`, as a socket client does. It had rejected them with the engine's own error class (SPEC-0025 E).
- `@orchvia/adapter-claude` no longer depends on Zod, so it installs next to any Zod, or none. Its optional `zod: 4.4.3` peer had made npm refuse an application with another Zod, such as 4.6.5, with `ERESOLVE`. The pin had been needed because the Claude Agent SDK converted the adapter's Zod schemas with the Zod bundled in each SDK release, and with SDK 0.3.274 or 0.3.281 and Zod 4.6.5 `tools/list` failed and the model got none of the four orchestration tools. The adapter's `agent_orch` MCP server now answers MCP itself, as the Codex bridge does (SPEC-0026).

### Changed

- After an internal failure stopped the host, `scheduler.get` lists `SCHEDULER_FAILED` besides `HOST_STOPPING`, and a refused write's `HOST_STOPPING` error names the failed step and holds `failure: {step, code, at}` in its data. A stop on request is unchanged (SPEC-0025 F).
- Claude's model sees the same tool schemas as Codex's, with the description of the fields that each tool's `request` takes; Zod's conversion had dropped it. A host that supplies `query` no longer has to supply `createMcpServer` for orchestration tools, and `createClaudeMcpServer(tools)` ignores the `{ sdk, zod }` it took before. As with Codex, a tool call's arguments must be exactly one object `request`; other arguments are answered `INVALID_REQUEST`, where Zod had dropped extra keys (SPEC-0026).
- The orchestration MCP servers of both adapters keep the protocol version 2025-11-25 when a client asks for it, and answer the latest version they know, instead of 2024-11-05, to a version they do not know (SPEC-0026 Z04).

## [0.1.2] - 2026-09-24

The first release on PyPI and on GitHub Releases. It carries the changes of 0.1.1, which was tagged but not published.

### Fixed

- `close({mode:'interrupt'})` now waits for interrupted turns, at most `timeouts.interruptMs` and half of `timeoutMs`, before it closes the adapters. A Claude turn that reports its interruption in that time is paused with reason `runtime_interrupted`, as documented, instead of ending `outcome_unknown` and quarantined. The cleanup after a stdio host's owner disconnects still closes the adapters at once (SPEC-0022 C).
- The engine's `engineVersion`, the `sdkVersion` that both SDKs send, and the versions that the MCP servers and the Codex client report now follow the release. The builds had rewritten only the package manifests, so these stayed at 0.1.0 (SPEC-0021 P08, P09).
- When the host that the Python SDK started ends before it answers, the error ends with the host's error output, which `error.data["stderrTail"]` holds in full, instead of only `CONNECTION_CLOSED` (SPEC-0023 E01, E02).
- The Python SDK notices that its host exited even while a process the host left behind keeps its output open: pending requests fail within about a second with `CONNECTION_CLOSED` instead of waiting for their timeout, and the SDK closes its ends of the host's pipes (SPEC-0023 E03).
- `orchvia host --socket` handles SIGTERM, SIGINT and SIGHUP before its socket accepts connections, and writes `orchvia listening on` only after that. A signal sent as soon as that line appeared, or while the host was still starting, could end the host at once instead of shutting it down in order (SPEC-0023 S).

### Added

- `orchvia --version` prints the version of the installed `@orchvia/cli` package (#12).
- A task dispatched again after a failed check sees the failed rule's command, exit status and the end of its output, and `verification.completed` summarizes every rule that ran (SPEC-0022 V).
- `processGroupsStopped(context)` in `@orchvia/adapter-claude`, and the `processes` of a stop observer's context, let a host prove that a dispatch's processes and their descendants ended (SPEC-0023 P).

### Changed

- On macOS and Linux each Claude Code process leads its own process group. A forced cleanup signals the whole group, SIGTERM first and SIGKILL when the cleanup window ends, and `orchvia host` shuts down in order on SIGHUP (SPEC-0023 P).

### Release process

- The release workflow's dry run skips a version that is already on npm, as its npm job does. The tagged release of 0.1.0 had stopped there, because its npm packages had been published by hand first.
- The CI and release workflows name every action by its commit, at versions that run on Node.js 24 (SPEC-0023 W).
- The version lives in one place. `node scripts/set-version.mjs X.Y.Z` writes it to every copy, a test checks that the copies agree, and the release workflow stops unless the tag equals it, the changelog has its section and the tagged commit is on `main` (SPEC-0021 P08, P09).

## [0.1.1] - 2026-09-23

Tagged but not published. Its packages would have reported 0.1.0 in eight places, such as the engine's `engineVersion`, so its release was rejected before publishing (SPEC-0021 D-rel-2). Its changes are listed under the next version.

## [0.1.0] - 2026-09-23

First public release, on npm as `@orchvia/*`. Its tagged release stopped in the dry run, before PyPI and GitHub Releases, so `orchvia` starts on PyPI with the next release.

### Added

- One local engine for Node.js 22.18 and later. SQLite stores tasks, sessions, messages, approvals, events and usage records.
- A TypeScript SDK (`@orchvia/sdk`) and a Python SDK (`orchvia`) with the same API, over an in-process engine, a child process or a Unix socket.
- Runtime adapters for Claude Code (`@orchvia/adapter-claude`) and Codex (`@orchvia/adapter-codex`), and a host with commands (`@orchvia/cli`).
- Sessions that stay warm across tasks: reuse, fork (also to another model of the same provider), compaction, pause, resume and stop.
- Scheduling with dependencies, queues, capacity limits and exclusive write scopes; acceptance by a person or by registered checks; approval of delegations and handoffs; token records per task.
- An optional routing layer with pluggable judges, and `context.checkRefs` to check context references before submitting.

### Changed

- The packages were renamed from the unpublished `@agent-orch/*` and the Python module `agent_orch`, with no aliases. Protocol identifiers did not change: the `agent_orch` MCP server name and its tool names, request digests, and the schema identifier.

Local release candidates 0.1.0-rc.1 to 0.1.0-rc.14 preceded this release; [docs/status.md](docs/status.md#candidate-builds) lists them.
