# Changelog

All notable changes to Orchvia are recorded here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may change the API.

## [0.1.26] - 2026-09-30

A compatibility gate: the public surface checked against the previous release, a rollback to it tested in both directions, and the Python SDK and the host tested across releases (SPEC-0051).

### Added

- `schemas/compat-baseline.json`, the public surface of the previous release, and a contract test that fails when a patch release removes something from it or makes an input required. `node scripts/set-version.mjs` checks the same before it changes the version.
- `STORE_TOO_NEW`: an engine refuses a store that records data it cannot read, writable or read-only, before anything changes. Engines record their version in the store as `lastEngineVersion`. No release records such data yet.
- `scripts/compat-rollback.mjs` and `scripts/compat-python.mjs`, run by CI: the previous release opens a store of this one and reads every record as written, this release reads the previous one's, and each release's Python SDK runs a task with the other's host.

### Fixed

- The `orchvia` command that npm installs, a symbolic link to the CLI, did nothing and exited 0, so `npx orchvia host` started no host. The CLI now runs through a link.

## [0.1.25] - 2026-09-30

A reference host that recovers from a crash at every step, and a benchmark that keeps what it measured (SPEC-0050).

### Added

- `examples/reference-host/`: a host in TypeScript and in Python that runs "change the code until the tests pass, then a review that a person decides". Its journal records each request before sending it and recovers through `operations.lookup`, its projection commits with its checkpoint, and `inspect.ts` shows why a run stopped and who acts next. Tests kill both hosts at each submission and projection step and check that nothing is created, run or counted twice.
- The fake runtime's optional `usage` (`createFakeAdapter({ usage })`, and `providers.fake.usage` in the CLI configuration): each dispatch that returns a result reports those counts.
- The benchmark's `parallel` arm, both tracks at once directly on the Agent SDK with each track resuming its own session; `--reserve-usd`, which a paid run requires, reserved before each request starts; each finished request saved to `<out>.rows.jsonl`; rows for requests that failed or did not run; and the report written when the harness itself fails.

### Fixed

- `docs/design.md` no longer states an old release state.

## [0.1.24] - 2026-09-30

A correction to steering (SPEC-0048).

### Fixed

- `sessions.steer` reaches a turn that waits for its runtime's permission. With 0.1.23 the engine refused it with `STEER_TURN_ENDED`, because the permission request puts the task in `waiting_approval`; the approval still waits for the person.

## [0.1.23] - 2026-09-29

Steering a running turn, a benchmark that counts every arm alike, and tests run under load every week (SPEC-0046 to SPEC-0049).

### Added

- `sessions.steer(target, text)` in both SDKs, where `initialize` lists `workflow.steer`: adds a line from the user to the turn a Codex member is running, without interrupting it. It targets one dispatch, is recorded as a message of kind `steer` before it is sent, is sent once, and ends accepted (event `session.steered`) or with `STEER_TURN_ENDED`, `STEER_NOT_STEERABLE`, `STEER_REJECTED` or `STEER_OUTCOME_UNKNOWN`. Codex adapters declare `steer: true`; a Claude member is refused with `UNSUPPORTED_CAPABILITY`. An operation's error may carry `data`.
- A weekly stress workflow and `scripts/stress.mjs`, which run the tests in several copies while every core is busy; rules in CONTRIBUTING for tests that depend on time, and `docs/ci-flakes.md`, a ledger of every CI run that passed only when run again.

### Fixed

- A Claude dispatch that ends with a model API error, which the Agent SDK reports as a success with `is_error`, now fails with the error's own text, such as `API Error: Connection lost mid-response`, instead of `success` (SPEC-0049).
- The benchmark counts the calls outside the main loop in every arm, subtracts a resumed session's totals only where Claude Code continues them, prices each model at its own rate and each cache write at its own duration's, and reports an unknown count as unknown instead of 0.

## [0.1.22] - 2026-09-29

Corrections an integrating host reported, and two found in review (SPEC-0045).

### Added

- `sessions.reconcile` may take a dispatch's recorded terminal: `outcome: "completed"` without `result` uses the recorded result's text, and `outcome: "recorded"` takes the recorded outcome (completed, interrupted or failed). `initialize` lists `workflow.reconcileRecordedResult`, and both SDKs check it.
- Stop observations and sweeps list the processes they counted as `strayProcesses` and the ones they left out as `foreignProcesses`, each with its nearest earlier ancestor.
- A local Codex dispatch whose counts are all differences of Codex's cumulative totals from a known start reports `usageComplete`, so its budget reservation is settled.

### Fixed

- A process in a dispatch's workspace that another running tool started, such as another terminal or agent, no longer keeps the dispatch from being proven stopped. Orphans and programs started through daemons still do; on macOS an application's own executable counts as an ordinary process.
- A later task on a session no longer keeps the session's earlier tasks, and with them every later event, from being collected.

## [0.1.21] - 2026-09-29

A stability policy, settling a task that waits on a person, and examples that run (SPEC-0044).

### Added

- [Stability](docs/stability.md): from 0.1.21 on, a patch release never breaks a public export, a wire method or field, an event, an error code, a configuration field or a CLI flag; a change that does bumps the minor version, with a "Breaking" section and migration notes. A test checks this changelog for it.
- `task.settle({ onApproval?, timeoutMs?, signal? })`, and `settle(on_approval=None, timeout=None)` in Python: returns as soon as a task ends, waits for an approval that no handler decided, is paused or is blocked, with the reason, the approval or the blocked task's session. It decides nothing by itself.
- `createRuleJudge()` in `@orchvia/sdk/routing`, and `RuleJudge()` in `orchvia.routing`: a judge without a model or a key, for trying the routing layer. Its confidence stays at or below 0.6, so proposals among existing agents ask for confirmation.
- Offline examples of crash recovery and of a team that shares a mailbox and hands work over, in TypeScript and Python, and a custom stdio host with writable Claude and Codex members for a Python owner. A test runs every example that needs no person and no model.

### Changed

- The quickstarts and the design document use `settle()`. The offline quickstart no longer asks for `npm ci`; the Claude quickstart still does.
- `examples/python/fake_roundtrip.py` takes `--emergency-bytes`.

## [0.1.20] - 2026-09-29

A weekly check of new upstream versions, models Codex does not list, and documentation that matches the facts (SPEC-0043).

### Added

- A workflow that runs every Monday, and on demand, with the newest Claude Agent SDK and Codex CLI against the native smokes on Linux, Apple silicon and Intel macOS. It reports each smoke's result and opens nothing.
- `TESTED_CODEX_VERSIONS` from `@orchvia/adapter-codex`: the Codex versions CI runs (0.153.4, 0.157.1 and 0.158.0). `codexConnection().probe()` and `orchvia doctor` report `tested`; an untested version is reported, not refused.
- `allowUnlistedModel` on `createCodexAdapter`, for a host whose models Codex does not list.

### Changed

- A local Codex dispatch whose model Codex's model list does not name ends before its thread with `CODEX_MODEL_UNLISTED`. Codex gives such a model a reduced tool set without `apply_patch`, so the member could not edit files. A list that cannot be read, or that names no model, lets the dispatch proceed as before.

### Fixed

- `docs/status.md` and the readiness ledger match the facts, and documentation tests keep them so.
- The delegation and tool-call limits have tests that name their codes.

## [0.1.19] - 2026-09-29

Reasoning effort for each local Codex dispatch (SPEC-0042).

### Added

- `effort` in `CodexDispatchPolicy`: Codex's reasoning effort for that dispatch, a string such as `low` or `xhigh`. The adapter checks it against Codex's model list, hidden models and every page included, and refuses an effort the model does not list with `CODEX_EFFORT_UNSUPPORTED` before any thread or model request. Codex itself sends such an effort on unchanged, except `ultra`, which it lowers. Left out, the model's default applies, as before.
- Each usage record of a local Codex dispatch carries `raw._reasoningEffort: { requested, effective, source }`, and `usage.byTask` lists each task's `reasoningEfforts` (Python `reasoning_efforts`); `initialize` lists `workflow.reasoningEfforts`.

### Changed

- The inline preview of a large result ends with an English note, `[Preview truncated; the full result is in artifact <ref>]`.
- A tool bridge that Codex cannot start ends the dispatch with `CODEX_TOOL_BRIDGE_UNAVAILABLE`.

### Fixed

- The native local smoke repeats a tool search until the host's MCP server lists the tool.

## [0.1.18] - 2026-09-28

A proxy check the sandbox cannot read is named (SPEC-0041).

### Changed

- The proxy check runs inside the command sandbox, so its program and runtime must be where the member's commands can read them. A networked Codex dispatch whose check lies under `denyRead`, the Codex home or the state directory now fails before its app-server with `CODEX_NETWORK_PROXY_UNAVAILABLE`, naming the path, instead of `the check printed no result` (SPEC-0041 C01).

### Fixed

- The release workflow's registry check retries `npm install`, which can fail for minutes after `npm view` already shows a new version.

## [0.1.17] - 2026-09-28

The host's own proxy check command for the local Codex member (SPEC-0040).

### Added

- `proxyCheck: { command, args?, env? }` on `createCodexAdapter` with `connection`: how the proxy check runs before a networked dispatch, for a host whose `process.execPath` is not Node. Its `env` reaches that one check only, through Codex's `command/exec`, and cannot name a proxy variable. `proxyCheckProgram()` and `@orchvia/adapter-codex/proxy-check.mjs` give the check as one module to copy.

### Fixed

- A Python test connected to the host's socket as soon as the file appeared, which macOS creates before the socket accepts connections.
- The release workflow's registry check waits up to 25 minutes for PyPI, whose index once took longer than 10 minutes to list a new release.

## [0.1.16] - 2026-09-28

The host's own hook and tool bridge commands, hooks that fail open, and member instructions for the local Codex member (SPEC-0039).

### Added

- `hostHookCommand` on `createCodexAdapter` and `codexConnection`: the command Codex runs as the host hook, for a host whose `process.execPath` is not Node, such as an Electron application. `hostHookCommandFor({ runtime, program, env })` builds it with a variable prefix that applies to the hook process alone, such as `ELECTRON_RUN_AS_NODE=1`.
- `hostHookProgram()` and the package export `@orchvia/adapter-codex/hook.mjs`: the hook program as one module that runs wherever a host copies it.
- `codexConnection().hostHookTrust()`: whether the home trusts the hook, its hash, and whether its command runs, without writing anything.
- `toolBridge: { command, args?, env? }` on `createCodexAdapter`: how Codex starts the orchestration tool bridge, for the same hosts; `toolBridgeProgram()` and `@orchvia/adapter-codex/tool-bridge.mjs` give the bridge as one module to copy (SPEC-0039 B).
- `instructions(input)` on `createCodexAdapter`: text given to Codex as developer instructions when a dispatch starts a new thread, outside the task's goal and events. Codex keeps a thread's first instructions: a resumed or forked thread does not ask again (SPEC-0039 D).

### Fixed

- Codex runs a tool whose hook does not answer: a hook command that is missing, fails or prints nothing let every call through unasked. Each dispatch with `hostHook` now runs its hook command first, as Codex would, and refuses to start with `HOST_HOOK_UNAVAILABLE` when it does not answer. A command or file change that starts without the host's permission interrupts the turn and ends the dispatch with `HOST_HOOK_BYPASSED`.

### Changed

- A `clientInfo` without `version` fails `createCodexAdapter` and `codexConnection` with `INVALID_ADAPTER_CONFIG`; Codex refused it at `initialize` (SPEC-0039 K01).

### Documented

- Claude and Codex members may share one `stopMarker.directory`: `sweepStopMarkers` and `endStopMarkersSync` from either package cover both (SPEC-0039 M).

## [0.1.15] - 2026-09-28

The host's own command rules and stop markers for the local Codex member (SPEC-0035, second part).

### Added

- `hostHook(event) => { allow } | { allow: false, reason }` on `createCodexAdapter` with `connection`: each command, file change and tool call reaches the host before it runs, in every mode, through Codex's `PreToolUse` hook; a dispatch whose hook the home does not trust is refused with `HOST_HOOK_UNTRUSTED` (SPEC-0035 R).
- `codexConnection().trustHostHook()`, which trusts that hook through Codex's own configuration API, and `models()`, Codex's model list (SPEC-0035 C08, C09).
- `stopMarker: true | { directory, onObservation? }` for Codex, as for Claude: each zsh and bash command holds a marker, the dispatch is proven stopped when nothing holds it, and `executionStop` is no longer needed. `STOP_MARKER_UNSUPPORTED_SHELL` refuses a dispatch whose login shell is neither; a command the model runs with `/bin/sh` ends the turn with `STOP_MARKER_BYPASSED` and keeps the lease. `adapter.endStopMarkersSync(timeoutMs)`, and the sweep, acknowledgement and synchronous cleanup functions from `@orchvia/adapter-codex` (SPEC-0035 I).

## [0.1.14] - 2026-09-28

The user's own Codex CLI as a member (SPEC-0035, first part).

### Added

- `createCodexAdapter({ connection: { home } })`: the user's Codex home and sign-in. Each dispatch runs under a named permission profile that keeps commands out of the home, the state directory and `denyRead`, with `policy(input) => { mode, network }` choosing `plan`, `default`, `acceptEdits` or `auto` and no network, direct network through Codex's network proxy, or a domain list. App-servers on one home start one at a time. A dispatch is refused before its thread with `CODEX_NOT_FOUND`, `CODEX_VERSION_UNSUPPORTED` (older than 0.153.4), `CODEX_POLICY_INVALID`, `CODEX_HOME_OVERLAP`, `CODEX_START_LOCK_TIMEOUT` or `CODEX_NETWORK_PROXY_UNAVAILABLE`, which a network dispatch gets when Codex's proxy is not in force (SPEC-0035 A, B, E, F).
- `codexConnection({ home })` from `@orchvia/adapter-codex`, without an engine: probe, account, sign-in with an API key, a browser or a device code, waiting, cancelling, sign-out and rate limits (SPEC-0035 C).
- MCP tool approvals reach the host's `requestPermission`; `hostMcpServers` adds the host's MCP servers by command or URL and token; `clientInfo` names the host to Codex (SPEC-0035 G, H, C06).

### Fixed

- The orchestration tools (`work_delegate`, `work_send`, `work_read`, `work_control`) failed for a Codex member without an approval callback: Codex's `never` policy refused every MCP tool call, and the bridge's server asked for approval. It now needs none; its tools act on the dispatch's own grant (SPEC-0035 G02).
- A Codex compaction on a resumed thread counted the thread's previous request again. Codex usage events carry the thread's totals as `sessionTotals`, which the next dispatch uses as its baseline (SPEC-0035 J01).

### Changed

- Codex commands no longer get `SSH_AUTH_SOCK` (SPEC-0035 B04).

## [0.1.13] - 2026-09-28

Codex file changes stay inside the write paths, and commands no longer see credentials.

### Fixed

- The Codex adapter declines a file change approval whose paths are not all inside the workspace or `writePaths`, resolving symbolic links, without asking the host; before, the request named no paths and an approved patch was written anywhere, outside the command sandbox. The host's `permission` payload now carries `changes: [{ path, kind, movePath? }]` (SPEC-0038 P01).
- Codex commands no longer see the orchestration bridge's token or the app-server's credentials: Codex's shell snapshot had made every environment exclude ineffective, so with `networkAccess: true` a command could call an orchestration tool itself. Codex now starts with `features.shell_snapshot=false` and `shell_environment_policy.ignore_default_excludes=false` (SPEC-0038 P02).

### Changed

- Codex commands no longer get variables whose names contain `KEY`, `SECRET` or `TOKEN` from the host's environment, such as `GITHUB_TOKEN` (SPEC-0038 P02).

## [0.1.12] - 2026-09-28

Stop marker proofs kept until the host acknowledges them, and one synchronous cleanup per host directory.

### Added

- `sweepStopMarkers(directory, { keepProven: true })` keeps a proven dispatch's files with a `.proven` record, and later sweeps report it `proven` at once; `acknowledgeStopMarkers(directory, dispatchIds)` removes proven dispatches after the host has reconciled them and refuses unproven ones (SPEC-0037 K).
- `endStopMarkersSync(directory, timeoutMs)` from `@orchvia/adapter-claude`: the synchronous cleanup of every adapter of this process under a host directory, with one listing (SPEC-0037 Y02).

### Changed

- The synchronous cleanups keep a tenth of their time, at least 10 ms, for returning, instead of 10 ms, so that a loaded machine still returns within the time (SPEC-0036 Y01).

## [0.1.11] - 2026-09-27

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
