# SPEC-0050: A recoverable reference host

Date: 2026-09-30. Status: approved by the owner on 2026-09-30 (D-road-1 option 1, D-road-2 option 1, D-road-3 option 2; D-0050-1 to D-0050-5 option 1). Release: 0.1.25. Environments: macOS and Linux CI with the fake runtime; no model calls. The only package change is the fake runtime's optional usage (U01). Evidence: [TDD-0050](../tdd/0050-reference-host.md).

## Why

A host that embeds Orchvia must keep its own record of what it submitted, project engine events without applying one twice, and recover after a crash without creating, running or billing anything twice ([design 7.4](../design.md#74-existing-host-execution-and-persistence-responsibilities), [guide 5.1](../guide.md)). Every integrator writes this alone today. The existing examples each show one part (`crash-recovery`, `checks-and-dependencies`, `usage-forwarding`); none shows a whole workflow that survives a crash at every step.

This change adds one reference host that runs a two-step development workflow, "change the code, pass the tests, then an independent review and a human decision", in TypeScript and in Python, with a journal both write in the same format, and a read-only inspector. It also corrects the benchmark so that a paid run cannot lose finished results or overrun its budget, and adds the arm that separates the engine's contribution from parallelism and session reuse.

## Measured engine behavior this design relies on

- `tasks.create` commits its operation and its task in one transaction (`packages/engine/src/index.ts`, `operation()`). An `operations.lookup` of `NOT_FOUND` in the same store therefore means the create did not commit. Resending the same key with the same request returns the original operation; a different request with that key fails with `IDEMPOTENCY_CONFLICT`.
- A collected operation fails `operations.lookup` with `OPERATION_HISTORY_EXPIRED` ("never replay this identity"); a request for another store fails with `STORE_NAMESPACE_MISMATCH`; an event cursor from another store or below the retention floor fails with `CURSOR_EXPIRED` and a `reason`.
- Checks acceptance that still fails after `maxRepairs` leaves the task `blocked` with reason `verification_failed`; it does not fail it. A dependent task waits (`waiting_dependency`) until the dependency completes, and is blocked with `dependency_failed` only when the dependency fails or is cancelled (SPEC-0015: "a dependency that is never accepted keeps its dependents waiting until the host cancels them"). `tasks.resume` of a blocked task fails with `OUTCOME_UNKNOWN`.
- After an engine is killed during a dispatch, a restart blocks the task (`outcome_unknown`), keeps the dispatch quarantined and never resends it; only an owner's `sessions.reconcile` with attestation resolves it.
- `blockedBy` is computed by a running engine; a read-only view returns none.
- The JSON CLI names its providers `fake`, `claude` and `codex` only, and refuses `workspace-write` for Claude and Codex (`packages/cli/src/config.ts`). A Python host, which starts its engine through the CLI, can therefore run a writable step only on the fake runtime, and cannot give two steps of one runtime different permission profiles.
- The fake runtime reports no usage.

## W. The workflow

- **W01** A run is `{ runId, recipeVersion, goal }`. Step `change` creates task A: `acceptance: { mode: 'checks', ruleRefs: [the registered test rule], maxRepairs }`, a writable provider. Step `review` creates task B: `dependencyTaskIds: [A]`, `acceptance: { mode: 'human', criteria }`. The TypeScript host runs B on a second, read-only provider, so its write paths are empty. The Python host runs both on its one fake provider, and its README states why: through the JSON CLI a real runtime is read-only, so a Python host cannot run step A on a real model today (D-0050-4). Both carry `label: 'refhost:<runId>'` and `metadata: { runId, stepId, recipeVersion }`.
- **W02** B starts only after A completes, and receives A's result through the engine's dependency blocks (SPEC-0014 D01).
- **W03** When A is blocked with `verification_failed`, the run needs a person: the host shows "tests failed after N repairs" and offers `abandon`, which cancels A and then B (B blocks with `dependency_failed` first; both end cancelled). The host never retries on its own.
- **W04** When B waits for a decision, the host shows the approval and the person decides `approve`, `deny` or `revise` with a comment. `revise` returns B to the queue.

## U. The fake runtime's usage

- **U01** `createFakeAdapter({ usage })` and the CLI's `providers.fake.usage`, `{ inputTokens, outputTokens }` of non-negative safe integers, make each dispatch that returns a result report one usage observation with those counts (D-0050-5). Without `usage` the fake reports none, as before.

## J. The journal

- **J01** The journal is one SQLite file outside the engine's state directory, opened with `journal_mode=WAL` and `synchronous=FULL`. Its schema is one file, `examples/reference-host/journal.sql`, which both hosts load: `runs`; `steps` (runId, stepId, storeId, idempotencyKey, frozen request, state, taskId, attention); `decisions` and `commands` (the owner's cancel and reconcile), kept the same way; `checkpoint` (storeId, cursor); `projection` (storeId, taskId, status, reason, cursor, and the host's last reading of `blockedBy` with its time); `approvals`; `usage` (storeId, usageRecordId, taskId, dispatchId, token counts, null when unknown); and `notices` for run-level attention.
- **J02** Step states: `intended` (intent committed, no receipt), `submitted` (receipt committed), `attention` (a person must act; with a reason). A step never returns from `attention` without a person's command.

## T. Timing invariants

1. **Intent before send.** A step's row, with its store ID, its key and the exact request, is committed before `tasks.create` is sent. The same holds for a decision before `approvals.decide`.
2. **One key per step, one request per key.** The key is `refhost/<runId>/<stepId>` (a decision: `refhost/<runId>/<approvalId>/decide`). Every send of a step sends the frozen request unchanged.
3. **B after A's receipt.** B's request names A's task ID, so B's intent is written only after A's receipt is committed.
4. **Recovery before new work.** On start, the host resolves every `intended` step and decision before it creates anything: `operations.lookup` in the recorded store; found: commit the receipt, send nothing; `NOT_FOUND`: send the frozen request with the same key; a store ID in the journal that differs from the host's, `OPERATION_HISTORY_EXPIRED`, an operation `outcome_unknown`, `IDEMPOTENCY_CONFLICT`, or another refusal that the same request cannot pass: `attention` with that reason, never sent again. An error that says nothing about the outcome, such as a closed connection, leaves the intent for the next start.
5. **Projection commits with its checkpoint.** Applying events and advancing the checkpoint past them are one journal transaction (a page in TypeScript; one event in Python, whose SDK reads events through an iterator), keyed by `(storeId, cursor)`, so a replay changes nothing. `CURSOR_EXPIRED` puts the run in `attention` with its `reason`; no event is skipped silently.
6. **Unknown stays unknown.** A task blocked with `outcome_unknown` is never resent and never reconciled automatically. The host's `reconcile` command is owner-only, and takes the attestation fields from the person.
7. **Observing never changes anything.** The inspector calls no mutating method.

## F. Injected faults

Each host takes `--fault <point>` for tests and exits at once (`SIGKILL` of its own process group) at that point; a second start on the same journal and state directory recovers. After every fault, the checks are the same: one task per step, no dispatch sent twice, one usage record per dispatch and journal cost equal to the engine's `usage.summary`, and every unknown still unknown.

- **F01** After the intent commits, before the create is sent.
- **F02** After the engine created and started the change, before the receipt commits. The receipt is found, nothing is resent, and the change's dispatch is unknown: an embedded engine dies with its host, so a crash during a dispatch always leaves it for the owner.
- **F03** After reading the events that ask for the review's decision, before projecting them, while nothing runs: the next start projects them once and reaches the review.
- **F04** During A's dispatch (the fake runtime holds it): after the restart A is blocked `outcome_unknown`, the run is in `attention` ("owner reconciliation"), and nothing was resent.
- **F05** After `approvals.decide` was sent, before its receipt commits: one decision, no conflict.
- **F06** Python only: the engine child dies while the Python host lives. The host treats calls in flight as unknown, starts the engine again and runs the same recovery.

## I. The inspector

- **I01** `node examples/reference-host/inspect.ts --journal <file> [--run <runId>] [--json]` shows each run: its steps and tasks with status and reason, the approval waiting and its criteria, `blockedBy` when the engine is reachable, attention reasons, and cost as known cost plus the number of records without one. It reads runs written by either host.
- **I02** The inspector reads the engine's store through `openOrchestratorReadOnly`, which takes no lock, whether or not a host runs, and the journal. `blockedBy` is computed only by a running engine, so each waiting step shows the host's last reading with its time, or "not known while the engine is stopped" when the host recorded none. Cost counts a dispatch without a usage record as unknown.
- **I03** Each state names the next step and who takes it:

| State                              | Next step                                      |
| ---------------------------------- | ---------------------------------------------- |
| B `waiting_approval`               | the reviewer: approve, deny or revise          |
| A blocked `verification_failed`    | a person: abandon the run or start a new one   |
| A or B blocked `outcome_unknown`   | the owner: check, then reconcile; never resend |
| B blocked `dependency_failed`      | a person: the run ended; start a new one       |
| queued or waiting with `blockedBy` | none: waiting for `<reason>`                   |
| step `attention`                   | a person: `<reason>`                           |

- **I04** A cost with any record whose cost is unknown shows "at least $x, n records unknown", never a total.

## B. The benchmark

- **B01** Each finished request is appended to `<out>.rows.jsonl` and synced before the next starts. The report is written in a `finally`, also when a request throws, with `aborted: { message }` when one did.
- **B02** Each request is a row with a `status`. A request that throws or times out is a row with `status: 'error' | 'timeout'` and its message; the rest of its track are rows with `status: 'not_run'`, as are requests the budget refused (`reason: 'budget'`). A row's cost is null when unknown and counts in no total as 0.
- **B03** The arms that run requests in parallel reserve `--reserve-usd` per request before starting it and release the reservation when it settles; a request starts only while spent plus reserved plus its reservation stays within `--budget-usd`. A paid run with a budget requires `--reserve-usd`. This limits what the harness starts; it does not cap the provider's bill.
- **B04** A fourth arm, `parallel`, runs the two tracks at the same time directly on the Agent SDK, each track resuming its own session: the orchvia arm without the engine.
- **B05** Offline flags for the tests: `--fake-throw <requestId>` (a request fails), `--fake-harness-throw <requestId>` (the harness fails before it) and `--fake-cost-usd <n>`.

## D. Documentation

- **D01** `examples/reference-host/README.md` is the only source for running the reference host and its recovery steps. The guide links to it from section 5.1.
- **D02** `docs/design.md` no longer states that the Python package is not on PyPI or that the npm packages are at 0.1.0.
- **D03** The readiness ledger records that a Python host cannot run a writable real runtime through the JSON CLI.

## Acceptance

| ID              | Criterion                                                                                                                                                                                   | Test                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0050-W01        | Both hosts run the workflow to B `waiting_approval`; approve completes it                                                                                                                   | `tests/contract/reference-host-0050.test.ts`, which runs both hosts |
| 0050-W02        | B receives A's result and does not start before A completes                                                                                                                                 | same                                                                |
| 0050-W03        | Failing tests leave A `verification_failed`, B never dispatched; `abandon` ends both cancelled                                                                                              | same                                                                |
| 0050-W04        | `revise` requeues B with the comment; `deny` fails it                                                                                                                                       | same                                                                |
| 0050-U01        | The fake reports its configured usage once per dispatch, in process and through the CLI; an invalid `usage` fails the configuration                                                         | `tests/engine/fake-usage-0050.test.ts`                              |
| 0050-J01        | Both hosts create the journal from `journal.sql`; the inspector reads a Python-written journal                                                                                              | same                                                                |
| 0050-T04        | Each recovery outcome of invariant 4, including `OPERATION_HISTORY_EXPIRED` and a changed store, is taken as specified                                                                      | same, and `python/tests/test_reference_host_0050.py`                |
| 0050-T05        | A replayed page changes no projection row; `CURSOR_EXPIRED` puts the run in attention                                                                                                       | same                                                                |
| 0050-F01 to F05 | Each fault, in both hosts, ends with one task per step, no second dispatch, usage counted once, unknowns kept                                                                               | same                                                                |
| 0050-F06        | The Python host survives its engine child's death and recovers                                                                                                                              | `tests/contract/reference-host-0050.test.ts`                        |
| 0050-I01 to I04 | Every state of the table is shown with its next step; operation and event counts are unchanged by inspecting; an unknown cost is never a total                                              | `tests/contract/reference-host-0050.test.ts`                        |
| 0050-B01 to B05 | Offline: a thrown request keeps earlier rows and the report; errors and not-run rows; reservation stops a start that would exceed the budget; the parallel arm overlaps and reuses sessions | `tests/contract/bench-0050.test.ts`                                 |
| 0050-D03        | The readiness ledger names the Python writable-runtime gap                                                                                                                                  | `tests/contract/docs.test.ts`                                       |
| 0050-D02        | `design.md` names no release state                                                                                                                                                          | `tests/contract/docs.test.ts`                                       |

`format:check` covers `examples/reference-host/*.ts`; the TypeScript files are already type-checked.

## Not in this change

A real model run (separately approved, with its own budget); a writable Claude or Codex in the JSON CLI, and provider names of one's own there (D-0050-4: recorded as a gap in the readiness ledger); a concrete application's runtime adapter (design 7.5 slice 2); an `inspect` command in the CLI package (D-road-2); the compatibility gate and the capacity benchmark (rounds 2 and 3, decided after this release); any engine change.

## Rollback

Reverting removes an example directory, benchmark options, documentation and the fake's `usage` option; no wire behavior changes.
