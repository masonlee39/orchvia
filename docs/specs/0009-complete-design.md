# SPEC-0009: Complete the remaining orchestration design

Date: 2026-09-20. Status: implementation complete with offline acceptance; real-boundary gates remain explicit below.

## Scope and authority

Implement the outstanding features identified against main `f18906b`: model-facing delegation/message/read/control tools, dependencies and write ownership, session management, declared context routing, verification rules, storage governance and archive rollover, cost accounting and budgets, recovery/loop limits, runtime-permission approval, CLI and distributable artifacts. Preserve SPEC-0001–0008 behavior unless this specification or the already accepted B namespace contract explicitly supersedes it. SPEC-0003-B/C remain normative for retention, namespace identity, accounting, and routing. Record every implemented or unverified acceptance item in a completion matrix; an interface stub is not completion.

Work only in Multi-Agent and task-owned temporary paths. Do not modify another application's files. Use native source search; the user declined CodeGraph initialization. No real login credentials, paid model calls, publication, deployment, or new Git commit/push is authorized by this increment. Build and inspect release artifacts locally; prepare separately invokable native acceptance with explicit runtime versions and spending limits. License selection/publication and real-provider execution remain separate approval boundaries.

## Integrated behavior

### Tasks, routing, sessions, and write ownership

- Extend TaskSpec with explicit dependencies, optional parent identity, declared contextPlan, registered workspace write scope, and budget. Preserve minimal human-acceptance tasks. The host validates existing dependency IDs, self/cyclic dependencies, authorization, profile/model/workspace compatibility, and finite queue deadlines. Waiting tasks consume no execution slot. Failed/cancelled dependencies block dependents; accepted dependencies wake them without model polling.
- Resolve continue, parallel_tools, reuse, fork, and fresh deterministically from explicit intent/capabilities. Never infer independence from prose or create an undeclared fallback. Queue expiry removes the unsubmitted candidate atomically; submission winning the race retains its real/unknown outcome. Persist policy decisions. Context references point to bounded versioned artifacts; unsupported required evidence fails before submission.
- Separate logical session opening from task creation; session ownership, task association, native identity, and generation remain explicit. Safe serial reuse preserves history; fork creates a distinct native identity from an identifiable completed source. Compact requires a native compact boundary or explicit no-op; rotate switches generations only after safe preparation and retains source history. Stop differs from task cancellation and requires resource evidence. Keep each session single-flight and retain all existing unknown quarantine semantics.
- Enforce exclusive overlapping canonical write scopes among active/possibly active dispatches. Release write ownership only with execution release, not timeout. Isolated workspace options must be explicitly registered; do not create or reset user Git worktrees automatically. Persist baseline/artifact identities for verification and handoff.

### Tools, authorization, approvals, and loop controls

- Supply exactly four fixed orchestration tools: work_delegate, work_send, work_read, work_control. Bind trusted session/task/dispatch identity outside model arguments. Allow only the authorized delegated subtree and inherited/narrowed budgets/profile/write scope. No tool may approve tasks/tools, administer storage, configure checks, or shut down the host. Read operations never invoke models.
- Integrate Claude in-process MCP tools and Codex private stdio MCP bridge with the same engine methods and accounting. A bridge token grants only its exact runtime binding and expires/revokes with that dispatch. Keep credentials out of prompts, records and errors. Reject forged actors, stale generations, sibling/parent control, unknown tools, oversized inputs and delegation storms.
- Add configurable finite delegation depth/children, message rate/hop/expiry limits, and repeated identical tool-call detection without new observed state. Preserve max turns and execution deadlines. Expired messages never get delivered after restart. A limit stops or pauses the relevant work with durable evidence, without adding a management LLM.
- Add runtime_permission as a separate approval purpose with exact dispatch/tool target and expiry. Native permission requests wait on the existing event/decision channel; no consumer means no approval. TS/Python parity is required. Cancellation/expiry/late approval cannot authorize a new turn. Existing embedded host callbacks remain supported and do not count as task acceptance.

### Verification, accounting, and recovery

- Registered versioned verificationRules use argv arrays, canonical in-workspace cwd, bounded output/time and exact artifact/workspace baseline. Freeze rule digest at task admission. Run after model output; only successful required checks and dependencies permit completed. No arbitrary model-supplied executable rule. Failed checks retain evidence and obey the configured repair/turn budget. Human acceptance remains unchanged.
- Retain source-scoped usage and normalize token buckets without double counting. Bind costOwnerTaskId/rootTaskId before submission. Price records use explicit currency/version and decimal units; calculations are exact or explicitly unknown. Report direct/tree/host-overhead costs with unique billing identities. Reserve concurrent budget before submission and settle it on received usage; missing usage cannot refund an unknown reservation as zero. Money limits remain bounded scheduling estimates, not a guarantee against upstream overspend.
- Implement per-request context/cost estimates with keep/compact growth, TTL/partial-hit scenarios, uncertainty ranges and explicit unknowns. Do not enable automatic economic selection without measured capability/benefit evidence. Capacity reserve checks use current context estimates, not cumulative billed tokens.
- Expose bounded read-only runtime inspection with original native/dispatch identities. Only conclusive evidence can support existing reconciliation; missing history is not proof of non-execution. Preserve owner attestation for unavailable/ambiguous inspection. Recovery never blindly resends.

### Storage and namespace lifecycle

- Implement SPEC-0003-B01–B18: reference-protected bounded GC, lifetime idempotency tombstones, event retention floor, consistent leased paged snapshots, artifact quarantine/recovery, quota/free-space backpressure, finite settlement reserves, verified backup/import, read-only archive lookup and phased whole-store rollover. Retention and storage administration are owner-only and never run model requests.
- Namespace-aware wire 2.0 binds mutation identity to expectedStoreId across both clients and lost-receipt recovery. Reject old/missing namespace identities before writes. An archive/new-store switch never copies executable tasks or transparently redirects an old mutation. Upgrade and old-writer fencing must be explicit and crash-safe; a fresh namespace cannot bypass unresolved work.
- Inspect actual persistence boundaries in failure tests, including SQLite full/I/O, artifact interruption, migration/backup failures, archive corruption and every rollover phase. A complete backup includes retained artifacts and managed native history. Never delete actual user data during ordinary verification.

### Delivery and acceptance

- Implement CLI run, attach, control and tool-bridge using public engine/client paths; extend doctor with offline dependency/runtime-version/permissions checks. Missing dependencies are actionable failures, not network/model acceptance. Interactive exit never silently approves/cancels shared work.
- Keep TS/Python schema and public API parity. Produce generated schema types/validation where applicable and locally installable npm tarballs plus Python wheel/sdist. Test clean offline installs and single-provider optional dependencies. Prepare exact-version macOS/Linux/runtime CI matrices and a bounded capacity benchmark; report measured environments separately from configured jobs.
- Correct stale design statements about Claude string input and unsupported interruption. Publish a precise completion matrix and evidence. Native-model, actual OS sandbox, external host integration, release publication and economic benefit remain unverified until their separate real-boundary tests pass.

## Acceptance criteria

| ID | Observable acceptance |
| --- | --- |
| AC-F01 | Dependency admission rejects invalid/cyclic graphs; readiness/failure/restart and zero-slot waiting behave consistently through both clients. |
| AC-F02 | Explicit routing produces one authorized candidate, stable queue deadlines and no hidden fallback/late dispatch. Reuse preserves correct task/native identity. |
| AC-F03 | Open/fork/compact/rotate/stop have persisted receipts, exact targets, bounded failure paths, native evidence, and single-flight/resource ownership. |
| AC-F04 | Overlapping canonical write scopes cannot execute concurrently, including unknown/late-cleanup cases; unrelated scopes can proceed. |
| AC-F05 | All four tools execute through a private bound identity; malicious targets/actors, stale grants, storms, and forbidden administrative calls fail before mutation. |
| AC-F06 | Actual offline Claude MCP and Codex stdio bridge subprocess paths create/delegate/message/read/control without extra schedulers or model polling. |
| AC-F07 | Runtime approval is streamed/read/decided by real TS/Python clients; absence, expiry, cancellation, replay and stale target never grant permission. |
| AC-F08 | Verification executes only frozen registered rules, captures bounded real subprocess evidence, detects changed baselines and never completes failed/unknown work. |
| AC-F09 | Message expiry/hops/rate, delegation limits and repeated-tool detection survive replay/restart and preserve evidence. |
| AC-F10 | Exact money normalization, concurrent reservations, late/missing usage, tree deduplication and cost ownership satisfy C03/C04 without fabricated precision. |
| AC-F11 | Runtime inspection correlates original identity, never treats missing data as non-execution, and retains existing owner-only reconciliation semantics. |
| AC-F12 | B01–B07 GC, tombstones, snapshots, capacity, artifact recovery and backup identity pass deterministic time plus real storage-fault tests. |
| AC-F13 | B08–B18 namespace-bound TS/Python retries, settled rollover, verified archive reads, writer fencing and every crash phase pass real subprocess tests. |
| AC-F14 | New CLI commands use the same public contracts; doctor independently proves only the checks it actually performs. |
| AC-F15 | npm and wheel/sdist artifacts build, install and run from clean temporary environments; generated wire checks and examples agree in both languages. |
| AC-F16 | Full Node/Python/type/format checks pass; measured capacity and supported environments are recorded without claiming unexecuted matrix cells. |
| AC-F17 | Opt-in native acceptance prepares version/identity/budget/evidence handling without reading credentials or invoking models before separate authorization. |

## Verification sequence

Implement dependency/routing and verification/accounting primitives first, then their engine lifecycle integration. Complete private tools/approvals and native session operations against owned protocol children. Implement storage and namespace migration with fault tests before exposing rollover to clients. Finish CLI, generated contract/package artifacts, cross-language integration, bounded capacity measurement and documentation. Each slice records actual RED before GREEN; already-correct behavior receives regression evidence. No acceptance row may be marked complete solely because a capability field or mock returned success.

## Completion matrix

Status updated 2026-09-21. **All authorized implementation rows are implemented and accepted at the offline boundary below.** Native-model, actual sandbox/history, external application, remote CI execution and public release gates remain unaccepted. The opt-in preparation row does not authorize those operations. Economic automatic selection remains intentionally disabled under SPEC-0003-C.

| ID | Implemented behavior and concrete evidence | Boundary still requiring separate evidence |
| --- | --- | --- |
| F01 | Dependencies, acceptance wakeup/failure and no-slot waiting: design-completion engine tests; actual Python Node-host F01/F08 round trip | Real model task quality |
| F02 | Explicit routing, finite stable queue deadlines, no hidden fallback and safe reuse: session-routing tests | Real cache reuse/benefit |
| F03 | Open/fork/compact/rotate/stop: logical routing suite and six actual owned native-protocol subprocess cases | Real-binary saved-history/fork/compact now verified with scripted responses in SPEC-0011; semantic quality still needs model evidence |
| F04 | Canonical overlapping write ownership, retained unknown leases and pre-dispatch scope revalidation: design-completion plus execution-isolation tests | Actual OS/tool sandbox enforcement and adversarial native filesystem races |
| F05 | Bound four-tool engine surface, narrower grants, subtree/idempotency/stale/loop refusal: runtime-tools tests | Arbitrary shell cannot be claimed restricted solely by these tool grants |
| F06 | Codex actual stdio/private MCP child and installed Claude SDK 0.3.274 MCP transport both invoke the four tools on the actual engine; delegated child pauses before model execution | SPEC-0011 verifies real native inventory and bound calls with scripted responses; model choice and adversarial shell isolation remain separate |
| F07 | Exact expiring runtime_permission approval, cancellation/replay/absence; Node native peer and actual Python managed-host tests | Native permission coverage for the selected production profile |
| F08 | Frozen registered checks, real processes, bounded output/cleanup, workspace mutation failure and retained unknown cleanup: design-completion tests | Trusted local executable verification is not a separate OS sandbox |
| F09 | Durable rate/TTL/hop limits including restart; child-depth/count and repeated-read limits: message-limits/runtime-tools tests; depth, child and per-dispatch call limits: delegation-limits-0043 (SPEC-0043 E01) | Workload-specific policy tuning |
| F10 | Exact money/cache normalization, reservations, missing/late usage, serial-reuse ownership, tree/overhead deduplication: accounting tests | Provider invoices, complete per-native-request telemetry and measured savings |
| F11 | Bounded original-identity inspection via actual Codex thread/read child and timeout cases; owner reconciliation remains explicit | Missing native history can never establish non-execution |
| F12 | B01–B07 reference protection, tombstones, monotonic leases/cursor floors, quota/settlement, artifact journals, complete migration backup; actual SQLite-full/crash and degraded shutdown tests | Large-scale/long-lived production storage; oversized GC candidates are retained and reported |
| F13 | Wire 2.0 / schema 3, both-client immutable retry identity, verified archive/import, writer fencing and 18 actual rollover crash points | Managed native files only; no cross-store semantic deduplication or credential backup |
| F14 | run/attach/control, explicit TTY review and offline doctor: actual CLI/host tests | Native authentication and application-specific UI |
| F15 | Generated TS/Python schema/types/validator checks; five npm artifacts plus wheel/sdist clean-install smoke; matching checks/dependency/snapshot examples | Registry publication; MIT was selected after this increment |
| F16 | Full Node/Python/type/format/generated checks; measured 1k/10k/50k retained-task capacity under an explicit 100,000-session limit; finite host/session/queue limits | SPEC-0012 implementation `9ce65e4` and test-harness follow-ups through `4ff806c` passed a ten-sample Ubuntu Node 24 stability check: 10/10 target jobs and 60/60 workflow jobs, each target log with 442 Node, 49 Python and nine package modes. [Exact CI evidence](../tdd/0012-ci.json) and scoped tool-call measurements are recorded. This bounded sample is not an SLO, and the programmatic 10,000-session default is not a 50k production capacity claim |
| F17 | Reviewable native plan, digest/version/one-turn/budget gates, TS/Python harness and evidence handling prepared with no credentials/models | User selects provider/model/identity source/pricing and authorizes each concrete native run |

The current RuntimeAdapter keeps one execution path: fork uses frozen forkSource, compact uses nativeAction, inspection is a bounded read method, and ordinary controls use existing signals/evidence. No additional speculative facade or management LLM is required. APIs and current commands are in [the wiring guide](../guide.md); final counts and package evidence are in [TDD evidence](../tdd/0009-complete-design.md).
