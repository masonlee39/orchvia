# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project scope

Orchvia: one Node orchestration engine with thin TypeScript and Python SDKs. The engine exclusively owns SQLite state, scheduling, deadlines, and adapter calls. The SDKs use the shared JSON-RPC contract; they do not implement another scheduler, open the database, or call models themselves.

Implemented scope: SPEC-0001–0011, including B/C retention, archive rollover, routing, accounting, bundled-host delivery and native scripted-gateway verification. SPEC-0012 addresses client-pause precedence, scoped tool queries and the documented logical-session limit. SPEC-0013 lets `sessions.fork` move to another allowed model of the same provider with explicit cache-loss acknowledgment. SPEC-0014 adds host workflow controls: configurable adapter provider names, dependency results in prompts, revise and decision comments, a default read fence, up to eight active sessions, a delegation gate, handoff requests, narrowed write paths, owner-registered rules and task listing. SPEC-0015 times queue waits only while a task is queued, allows waits up to seven days and adds an owner default. SPEC-0016 lets a paused session whose task ended resume to idle, and documents close and crash recovery. SPEC-0017 corrects five audit findings: verification rules no longer block startup, retries do not depend on the host queue-wait default, revise needs a live session, messages to a stopped session expire instead of holding its task, and handoffs expire on time. SPEC-0018 adds an optional SDK routing layer (`@orchvia/sdk/routing`, `orchvia.routing`) whose pluggable judge, such as TypeSafe Jev, proposes declarations inside one group; the engine is unchanged. SPEC-0019 corrects that layer: confirmation uses the judge's own confidence, findings cannot leave the source's group, results over the 32 KiB context limit are left out with a reason, and the Python Jev timeout bounds the whole evaluation. SPEC-0020 adds the read-only `context.checkRefs` method, which reports what task admission would decide for each context reference, and the router uses it to leave out collected or damaged results. SPEC-0021 prepares the project for open source: a README for first-time readers, documentation under `docs/`, the name Orchvia, and publishing to npm and PyPI. SPEC-0022 makes `close({mode:'interrupt'})` wait for interrupted turns before closing the adapters, except after an owner disconnects, and puts why a check failed into the retry prompt and `verification.completed`. SPEC-0024 makes task-filtered `events.read` and the engine's reads of pending approvals, messages and handoffs independent of a store's history, through indexes. SPEC-0025 lets a socket host start over the socket a crashed host left, gives the embedded orchestrator the socket client's error type, and reports a host stopped by an internal failure as `SCHEDULER_FAILED` with the failed step. SPEC-0026 removes Zod: the Claude adapter's MCP server answers MCP itself with the tools' JSON Schemas, as the Codex bridge does, through the shared `engine/src/mcp-server.ts`. SPEC-0027 adds read-only access to a store whose engine is not running (`openOrchestratorReadOnly`, `host --read-only`, sharing `engine/src/reads.ts` and `engine/src/recovery.ts` with the engine), host `label` and `metadata` on tasks and sessions with the task chain in `RuntimeInput`, `onFatal` and the `scheduler.failed` event, `VALIDATION_ERROR` for a caller's cursor mistakes and a reason in `CURSOR_EXPIRED`, typed public results, SDK idempotency keys that a rejected request releases, and adapters that refuse a configuration without proof that execution stopped. SPEC-0028 adds `tasks.list` status and reverse-order filters, `tasks.getMany` and `usage.summary` through the new indexes `tasks_root` and `usage_task`; usage records and `usage.recorded` that carry their session, model, root task and token counts; failed checks' output tails in `verification.completed`; `blockedBy` on waiting tasks, computed from the scheduler's own predicates; `close({mode:'pause'})`, which pauses what it interrupts as `owner_shutdown`; `rules.retire`; and an emergency reserve that `createEngine` writes through `fs.promises` as `emergency.reserve.partial` before renaming it, which `tests/fixtures/reserve-guard.mjs` also guards. SPEC-0029 adds `usage.byTask` for 1 to 100 tasks, `deliveredAt` on task snapshots, reactivation of a retired rule by registering the same content, and `pausedByClose` on tasks that a close paused. SPEC-0030 splits cache writes into `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`, reported by the Claude adapter when they add up and summed in the usage totals; reads the engine clock once per transaction (`Store.wallTime`), so every time written in one transaction is one and none comes from the process clock; and documents that an idempotency key names one request, so a rule change takes a new key. SPEC-0031 makes the Claude adapter report, besides the main loop's `usage`, each model's calls outside the main loop from the result's `modelUsage` (compaction, subagents), lets a usage observation name its `model`, and prices a record of another model at that model's registered price. SPEC-0032 adapts that to Claude Code 2.1.277 and later, where a resumed or forked session's `modelUsage` continues from its earlier dispatches: the adapter reports each dispatch's session totals, the engine keeps them on the dispatch row and hands the next dispatch on the same native session its `usageBaseline`, and without one a resumed dispatch's outside record is unknown; CI pins Claude Agent SDK 0.3.283 and Codex CLI 0.157.1. SPEC-0033 answers issues #43 to #46: cost queries, budget checks and settlement read through indexes (`costs_owner`, `costs_root`, `costs_dispatch`, `costs_overhead`, `costs_currency_units`, `reservations_held`); collection marks collected records in `retention_records.collected` and `storage.status` returns `retention`; pricing may set `cacheWrite5m` and `cacheWrite1h`; the TypeScript client takes `pollIntervalMs`; and #47 types Python results with read-only views that `scripts/generate-python-views.py` writes to `python/src/orchvia/views.py` (`npm run generate:protocol` and `check:generated` include it), checked in CI with pinned mypy by `scripts/check-python-types.py`. Storage schema 3, wire 2.0, event schemaVersion 1. Native-model, actual sandbox, external-application and economic acceptance remain unverified. Git remote: `git@github.com:masonlee39/orchvia.git` (renamed from `Multi-Agent` on 2026-09-23; the old URL redirects). The project is MIT-licensed. Releases are published on npm (the five packages), PyPI (`orchvia`) and GitHub Releases from tags `vX.Y.Z`; GitHub Releases names the latest, and `docs/status.md` records each with its evidence (SPEC-0021 P10, D-rel-3). 0.1.0 was published on npm only, and 0.1.1 was tagged but not published (SPEC-0021 D-rel-2). See SPEC-0009's completion matrix, SPEC-0011's CI evidence and the readiness ledger.

## Common commands

```sh
npm ci --ignore-scripts        # Install locked dependencies; no runtime downloads on startup
npm run typecheck              # tsc --noEmit
npm run format:check           # prettier --check; use npx prettier --write <file> when needed
npm test                       # node:test; engine and protocol contract suites
npm run test:python            # unittest; Python SDK and actual local-host integration
node scripts/set-version.mjs X.Y.Z  # The only way to change the version; writes every copy (SPEC-0021 P08)
```

Run one file or one matching test:

```sh
node --test tests/engine/lifecycle.test.ts
node --test --test-name-pattern "0003-A05" tests/engine/lifecycle.test.ts
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_lifecycle.py' -v
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -k disconnected_mutations -v
```

`npm test` includes only `tests/engine/*.test.ts tests/contract/*.test.ts`. Tests in `tests/e2e/` are not discovered. Put new tests in the configured directories or update the package.json glob.

Shared wire, lifecycle, or scheduling changes require both `npm test` and `npm run test:python`, as specified in CONTRIBUTING.

Runnable examples and CLI:

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
node examples/typescript/local.ts "$WORKSPACE" "$STATE_DIR"  # Existing, separate directories
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

Node 22.18+ / Python 3.11+; recorded verification used Node 24.14.0 and Python 3.14.6. The `node:sqlite` experimental warning on stderr is expected.

## Architecture

**Single writer.** `LocalEngine` in `packages/engine/src/index.ts` owns SQLite, scheduling, deadlines, and adapters. Wire methods are dispatched by the switch in `dispatchCall(method, params, context)`. Adding a method requires a case, validation, specification criteria, and cross-language tests.

**Three entry points, one engine.** In-process `createOrchestrator`; CLI `host --stdio` for a Python-owned child; CLI `host --socket` for a Unix socket. They cannot open the same stateDir concurrently.

**Transport determines ownership.** In `packages/cli/src/host.ts`, stdio connections use `owner=true` and socket connections use `owner=false`. `host.shutdown`, `sessions.reconcile`, and `scheduler.resolveConflict` use this flag to reject ordinary clients with `UNAUTHORIZED`. Permission changes require reviewing both connection construction and the engine's `context.owner` checks.

**Storage.** Business tables in `packages/engine/src/store.ts` use JSON blobs with `(id TEXT PRIMARY KEY, data TEXT)`: tasks, sessions, messages, outbox, approvals, dispatches, artifacts, usage, and execution_conflicts. `operations` adds `UNIQUE(method,scope,key)` for idempotency. Event AUTOINCREMENT rowids become cursors. `BEGIN EXCLUSIVE` on `owner.sqlite` provides the OS-level ownership lock; a second engine receives `HOST_ALREADY_RUNNING`. stateDir must be absolute, mode 0700, and disjoint from workspace after resolving symlinks.

**Durable state changes and events share a transaction.** Use `store.transaction()`. `scheduler()` recomputes A/Q/R from dispatch rows without in-memory counters; do not introduce cached counts. Its canDispatch/reasons also combine this host's closing flag and pendingResourceCleanups memory state (`RESOURCE_CLEANUP_PENDING`). These are not cached A/Q/R counts, and the complete scheduler response is not a pure database snapshot.

**A2 admission.** A counts dispatches holding an execution lease. Q counts dispatches with unknown business outcomes. R reserves capacity for held leases not yet quarantined. Dispatch requires `A < maxActiveSessions` (default 2) and `Q + R < maxQuarantinedDispatches` (default 32). Releasing A does not reduce Q; business reconciliation does. `kick()` scans queued tasks in a microtask. Each in-flight dispatch has an in-memory `Flight` and a durable dispatch row.

**Deadlines.** Dispatch computes a budget from the smaller host timeout and adapter cap. The default total is 1,800 seconds, including initialization and acceptance. Acceptance and output do not extend it. Use monotonic time for enforcement and persisted wall time for diagnostics. `EngineClock` is a test seam accepted only through EngineConfig, not JSON configuration or wire parameters.

**Stop evidence requires special care.** Automatic lease release must pass `stopProof()`: either pre_submission evidence proving no submission, or a terminal certificate plus `terminalCoversExecution` and confirmed local cleanup. Timeout, AbortSignal, interrupt acknowledgement, iterator completion, Promise return, a missing PID, or `hasActiveResources=false` alone are insufficient. Adapters report through `input.reportExecutionEvidence`; cleanup after execute finishes triggers `reevaluateRelease`. A live Flight or true `adapter.hasActiveResources(sessionId)` vetoes automatic release. R04's narrow `prepareUnobservedCleanup` interface handles only an exact target whose observation ended, whose spawn callback is sealed, and for which no process was ever observed. Retire its record only after the attestation transaction commits; do not report fictitious exit evidence. A genuinely live process still rejects owner stop claims. Owner reconcile remains available during incomplete active shutdown, while new work stays closed. Contradictory evidence creates persistent execution_conflicts that block dispatch across restarts.

**Cleanup receipts.** Check the prepare result is a function before committing. After the declaration commits, finalizer failure or failed completion persistence returns RESOURCE_CLEANUP_INCOMPLETE, retaining operationId and a pending receipt and pausing new dispatches on this host. Only an explicit owner retry with the original payload/key continues the original finalizer. If memory cleanup already finished, retry only its durable acknowledgement. A restart that loses the original finalizer retains outcome_unknown; do not prepare again or simulate success. Successful calls return completed, and the resource-completion event is persisted in the acknowledgement transaction.

**Adapter contract.** `RuntimeCapabilities` requires a typed `executionBudget={version:2,...}` with explicit null caps; optional `executionEvidence` is typed version 1. `readRuntimeCapabilities` validates detached immutable JSON snapshots before admission and again before dispatch. Missing/unsupported versions fail with UNSUPPORTED_CAPABILITY; malformed declarations fail with INVALID_RUNTIME_CONTRACT. Each dispatch uses one snapshot, including its permission check and terminal coverage. `execute()` produces RuntimeEvent values. Adapters retaining resources after execute must implement `hasActiveResources()`. Hosted adapters call `requireEngineRuntimeInput` before submission to require the original generation, budget, and evidence callback; standalone `RuntimeInput` stays compatible. This preflight is not authentication. `engine/src/fake.ts` remains the automatic deterministic runtime. Optional `engine/src/testing.ts` and `testing-host.ts` provide controlled-host conformance and an offline example without loading test code into ordinary startup. A passed fixture does not validate a real application's bridge or permission enforcement.

**SDK parity.** TypeScript Orchestrator wraps both the in-process engine and UnixRpcClient with one API. `python/src/orchvia/client.py` mirrors it. Wire fields are camelCase; Python converts only known envelope fields to snake_case. Raw JSON such as operation.result retains camelCase, for example `result["executionReleased"]`. API changes must update both SDKs and `schemas/protocol.schema.json`; `npm run generate:protocol` regenerates the audited wire types and validators.

**Claude interruption.** SPEC-0008 advertises interrupt support and owns one open AsyncIterable user prompt plus partial-message observation. Defer Query.interrupt until matched main-turn activity; call once, keep observing, and classify only structured aborted_streaming/aborted_tools results as interrupted. Receipt, arbitrary error text, EOF, and process exit do not establish an interrupted terminal. Cleanup and extended-host stop proof remain separate. Late evidence cannot undo an expired control. Never change this into immediate SDK-controller abort on an engine cancellation request.

`tests/contract/protocol-schema.test.ts` validates task, approval, message, usage, operation, and related snapshots from an actual Unix host. A Python subprocess reads the same state to verify field mappings and preservation of raw JSON. The helper supports the schema constraints currently used, rejects unsupported assertion keywords and invalid additionalProperties values, and treats format as annotation. The same audited subset is now a production validator in TS/Python, with generated wire types; it is not a complete JSON Schema implementation. Wire extensions require actual payload checks and negative cases, not just assertions that definition names exist.

**Relative cross-package imports.** Use paths such as `../../engine/src/types.ts`, not `@orchvia/*`. npm workspaces create links, but current source imports use relative paths.

## Development constraints

SPEC-0007 adds `adapter-claude/src/options.ts` for typed native options, reserved ownership fields, permission guards, and write sandbox configuration. `engine/src/stop-observation.ts` bounds host full-stop observations for expanded execution; false/missing/late proof cannot bypass local process evidence or business quarantine. The JSON CLI still disallows write/native callbacks. `engine/src/usage.ts` validates bounded JSON observations; `recordUsage` commits rows with `usage.recorded` atomically, rejects ID conflicts, and retains the original dispatch identity for late callbacks. Both SDKs expose exact-record reads. Keep native hooks/options/private objects out of persistence and wire payloads. Fixture policy mapping does not validate native sandbox enforcement or an application's ledger.

- **TDD is required:** specification and numbered criteria, tests with an observed RED, implementation, then RED/GREEN evidence in docs/tdd. Test names reference acceptance IDs such as AC04 or 0003-A05. Regression coverage for already-correct behavior does not need fabricated RED evidence.
- **Erasable TypeScript only:** no enum, namespace, or parameter properties. With verbatimModuleSyntax, use `import type`; imports include `.ts` extensions.
- **Runtime dependencies:** Python uses the standard library. The Claude SDK is an optional peer loaded by native execution and inspection paths, or supplied through host callbacks; the Claude MCP server needs neither it nor Zod, and no package depends on Zod (SPEC-0026). An injected query must never implicitly select another SDK for inspection.
- **Treat unknown conservatively:** no automatic outcome resolution, resend, retry, or unsupported lease release. Missing usage stays null; registered-price cost estimates must preserve unknown coverage and must not be presented as invoices.
- **Reject unsupported capabilities explicitly:** session operations and checks are implemented, but each still requires its exact declared runtime capability/evidence. Never simulate a native fork or compact boundary.
- **No credentials or real models in ordinary tests:** temporary workspace/stateDir, explicit fake provider, and no default fake configuration. Unix-socket EPERM requires a permitted environment and a rerun, not a passing result.
- **4 KiB test reserve:** a test engine passes `storage: { emergencyBytes: 4096 }`, or `"storage": {"emergencyBytes": 4096}` in a CLI configuration. `npm test` and `npm run test:python` load `tests/fixtures/reserve-guard.mjs`, which fails any other process that would write a larger emergency reserve (SPEC-0011 R10). Only the runnable examples keep the 256 MiB production default. A single-file `node --test` run needs `--import ./tests/fixtures/reserve-guard.mjs` to be checked.
- Agents do not commit, push or publish packages without the maintainer's explicit authorization.
- Write documentation, examples, and source comments in English. Keep intentional multilingual fixtures used to test Unicode behavior.

## Documentation authority

Read the relevant specification before changing behavior. Resolve implementation/specification differences and update them together.

| File | Authority |
| --- | --- |
| `docs/specs/0001-foundation.md` | Wire 1.0 method table, AC01–AC12, baseline snapshot fields |
| `docs/specs/0002-runtime-adapters.md` | Claude/Codex adapter boundaries and acceptance evidence |
| `docs/specs/0003-a-lifecycle.md` | Durable deadlines and owner reconciliation; A2 supersedes its 300-second turn default |
| `docs/specs/0003-a2-execution-isolation.md` | **Current authority:** A/Q/R, 1,800-second budget, leases, evidence, and conflicts |
| `docs/specs/0003-policy-retention-deadlines.md` | Lifecycle, retention and declared-routing contracts; implementation evidence in SPEC-0009 |
| `docs/specs/0003-b-archive.md` | Archive and namespace transition; implementation evidence in SPEC-0009 |
| `docs/specs/0004-runtime-reliability.md` | Historical scheduling scans, signal shutdown, TS request deadlines, and Claude exit/cleanup evidence |
| `docs/specs/0005-wire-contract.md` | Client cleanup recovery, real wire snapshots, cross-language mapping, and test-validator boundaries |
| `docs/specs/0006-host-runtime-contract.md` | Typed adapter capabilities, runtime/input preflight, existing-host offline conformance, and process recovery |
| `docs/specs/0007-host-policy-and-usage.md` | Embedded host policy, native options and durable usage replay |
| `docs/specs/0008-claude-interruption.md` | Claude interrupt lifecycle and evidence classification |
| `docs/specs/0009-complete-design.md` | Current wire 2.0/schema 3 feature completion, packages and acceptance matrix |
| `docs/specs/0010-bundled-host-delivery.md` | ESM/CJS host bundling and package delivery |
| `docs/specs/0011-release-readiness.md` | CI, native runtime and local release evidence |
| `docs/specs/0012-tool-control-and-capacity.md` | Client-pause precedence, scoped tool queries and session-capacity disclosure |
| `docs/specs/0013-fork-model-change.md` | Provider model lists and model-changing forks with cache-loss acknowledgment |
| `docs/specs/0014-host-workflow-controls.md` | Host workflow controls for multi-agent hosts (rc.8) |
| `docs/specs/0015-queue-waits.md` | Queue waits: only queued time counts, seven-day maximum and owner default (rc.9) |
| `docs/specs/0016-session-after-task-end.md` | Resuming a session whose task ended; close, crash and reconciliation guide (rc.10) |
| `docs/specs/0017-audit-corrections.md` | Audit corrections: rule paths checked at admission, retry digests, revise and messages on stopped sessions, handoff expiry timer (rc.11) |
| `docs/specs/0018-routing-layer.md` | Optional SDK routing layer: judge interface, Jev adapter, group scope, routing policy and notifications |
| `docs/specs/0019-routing-corrections.md` | Routing layer corrections: judge confidence, group-bound findings, oversized results, one Jev deadline |
| `docs/specs/0020-context-check.md` | The read-only `context.checkRefs` method and the router's use of it |
| `docs/specs/0021-open-source-readiness.md` | Open-source readiness: README, documentation layout, name, publishing, evidence and launch |
| `docs/specs/0022-close-interrupt-and-verification-feedback.md` | Interrupting close waits for interrupted turns; verification retries and events say why a check failed |
| `docs/specs/0023-corrections-before-0.1.2.md` | Corrections before 0.1.2: stdio fixture waits, the Python SDK's host start errors, workflow actions pinned on Node.js 24, the design for process identity in the stop proof, and stop signals while a socket host starts |
| `docs/specs/0024-read-path-performance.md` | Task-filtered event reads through the `(taskId, cursor)` index and partial indexes for pending approvals, messages and handoffs |
| `docs/specs/0025-operability-and-sdk-errors.md` | A crashed socket host's socket, the embedded orchestrator's error type, and `SCHEDULER_FAILED` for a host stopped by a failure |
| `docs/specs/0026-claude-mcp-without-zod.md` | The Claude adapter's own MCP server without Zod, shared MCP answers with the Codex bridge, and no MCP factory required with an injected query |
| `docs/specs/0027-read-only-access-and-host-corrections.md` | Read-only access, host labels and the task chain, `onFatal`, cursor errors, public types, the SDK idempotency cache and adapter stop proof (0.1.4) |
| `docs/specs/0028-host-queries-and-lifecycle.md` | Task queries and token totals, events that carry their content, queue reasons, a pausing close, rule retirement and a non-blocking reserve |
| `docs/specs/0029-usage-by-task-and-close-markers.md` | Usage by task, the time a task delivered, reactivating rules and tasks that a close paused |
| `docs/specs/0030-cache-write-durations-and-commit-time.md` | Cache writes by duration, one time per commit, and keys for rule changes |
| `docs/specs/0031-usage-outside-the-main-loop.md` | Usage outside the main loop: `modelUsage`, a model per observation and its price |
| `docs/specs/0033-cost-retention-pricing-polling.md` | Indexed cost queries, the retention status, cache write prices by duration and the TypeScript polling interval (#43 to #47) |
| `docs/specs/0032-claude-session-totals.md` | Claude session totals that continue across dispatches: `sessionTotals`, `usageBaseline`, and the 0.3.283 / 0.157.1 pins |
| `docs/tdd/*.md` | Observed RED/GREEN evidence for each increment |
| `schemas/protocol.schema.json` | Normative wire data definitions |

`docs/design.md` describes product intent and release gates; `docs/guide.md` documents the current implementation; `docs/reference.md` holds detailed usage, `docs/concepts.md` the terms and `docs/status.md` the verification record. There is no generic auth/gateway JSON abstraction. Do not confuse configured CI, offline native transports, optional native features, or package artifacts with real-model, sandbox or release acceptance.
