# SPEC-0063: A stop marker's waits last at least fifteen seconds; a warning before the default environment of checks changes

Date: 2026-10-02. Status: approved by the owner on 2026-10-02 (D-obs-1 option 1, D-warn-1 option 1, D-obs-2 option 1: 15 seconds, not 5). Release: the next one; it is not released on its own. Environments: macOS and Linux. Storage schema 3 and wire 2.0 are unchanged. Evidence: [TDD-0063](../tdd/0063-marker-time-and-environment-warning.md). Follows [SPEC-0062](0062-stop-look-order-and-remote-network.md) and [SPEC-0061](0061-review-second-batch.md) V03.

## Why

- **A dispatch ended unproven on a busy machine.** A stop marker's observation lists processes with `lsof`, and its time was the adapter's `closeTimeoutMs` (Codex) or `cleanupTimeoutMs` (Claude), one second by default. A host that ran its whole test suite at once saw a dispatch end with `outcome_unknown: Execution stop or local cleanup is unconfirmed`; the observation's record was `reason: 'unlisted'` with no holder and no stray: `lsof` had not answered within the second. With 5,000 ms it happened less, and under full load a Claude dispatch's stop was still unproven in 2 runs of 4; with 15,000 ms, in none of 4. This project's own tests had long given such observations 15 to 20 seconds.
- **The default environment of checks changes with the next minor version** (SPEC-0061 V03). A host that has checks and never set `verificationEnvironment` would find them failing with no notice.

## O. The time of a marker's waits

- **O01** With `stopMarker`, three waits last the larger of the adapter's configured time and 15,000 ms: the observation after a dispatch's runtime has ended, the end of a dispatch's marker holders, and the end of every marker when the adapter is closed.
- **O02** `closeTimeoutMs` and `cleanupTimeoutMs` keep their default of 1,000 ms and their other uses: the wait for the app-server to exit, for the processes it left, and for the Claude processes' cleanup.
- **O03** An observer the host supplies (`observeExecutionStop`) gets the configured time, as before.
- **O04** `endStopMarkersSync(directory, timeoutMs)` and an adapter's `endStopMarkersSync(timeoutMs)` take their time from the caller, as before.

Invariants:

1. Only limits grow. Each wait returns once it is done, so a dispatch that stops takes no longer.
2. What proves a stop is unchanged: when the time ends, the dispatch is not proven stopped.
3. No lease is released earlier than before.
4. The turn's own deadline is checked after the observation, as before.

Cost: when `lsof` does not answer or a holder does not end, a dispatch ends up to 15 seconds later instead of 1, and so does closing the adapter. A host that set less than 15,000 ms gets 15,000 ms for these three waits.

## W. The warning

- **W01** When an engine starts with verification rules, configured or registered in its store, and `verificationEnvironment` is not set, it emits one process warning with the code `ORCHVIA_VERIFICATION_ENVIRONMENT_DEFAULT`. It says that the checks' commands inherit the host's whole environment, that the default becomes `'minimal'` with the next minor version, and to set `'inherit'` or `'minimal'`.
- **W02** An engine that starts without rules emits it when its first rule is registered.
- **W03** At most once for an engine. A host that set either value is not warned.
- **W04** The warning changes nothing else. A CLI host writes it to standard error.

## Compatibility

No method, field, event or stored value changes. The warning's code is new.

## Acceptance

| Id       | Criterion                                                                                          | Test                                      |
| -------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0063-O01 | With `closeTimeoutMs: 1000` and an `lsof` that takes 3 seconds, a Codex dispatch is proven stopped | `tests/contract/marker-time-0063.test.ts` |
| 0063-O01 | The same for a Claude dispatch with `cleanupTimeoutMs: 1000`                                       | same                                      |
| 0063-O03 | A host's observer gets at most the configured time                                                 | same                                      |
| 0063-W01 | Rules and no setting: one warning at start; `'inherit'`, `'minimal'` or no rules: none             | same                                      |
| 0063-W02 | No rules at start: one warning at the first registered rule, none at the second                    | same                                      |

## Rollback

Reverting restores 0.1.33.
