# SPEC-0059: A sweep's time, an application's processes, and retiring a confirmed dispatch

Date: 2026-10-01. Status: implemented at the options recommended to the owner (D-sweep-1 option 1; D-stray-1 option 2, which the reporting host asked for, with the start time of option 1); the owner decides at the merge. Release: 0.1.31. Environments: macOS and Linux. Evidence: [TDD-0059](../tdd/0059-sweep-time-and-retirement.md). Corrects [SPEC-0036](0036-stop-marker-restart.md) S01, extends [SPEC-0045](0045-host-reported-fixes.md) K03 and [SPEC-0037](0037-stop-marker-acknowledgement.md) K03.

## Why

A host reported its start taking 15 seconds, the whole `timeoutMs` of its `sweepStopMarkers`, where `staleStopMarkers` took 0.8 seconds over the same records. Two dead instances had each left one dispatch. In the workspace of the first, the user's own processes ran: shells, an `ssh` shared connection, an application's sessions. The second was clean, and the sweep reported it `unlisted`.

- The sweep looked again every 200 ms for strays to exit, for as long as its time lasted. That wait is for the dead host's own runtime, which exits within a moment. A user's process never exits.
- The time was the whole sweep's, and the dispatches were worked through one after the other, so the first used all of it and the second's listing had none.
- A dispatch that cannot be proven had no way out. After the user confirmed it on the host's task, `acknowledgeStopMarkers` still refused it, and every start looked at it again.

Reproduced with one dispatch that has a stray and one clean, and 6 seconds: the stale check took 0.9 seconds and found the clean one stopped; the sweep took 6.0 seconds, twice, and found it `unlisted`.

## T. A sweep's time

- **T01** A sweep first looks at every dispatch once, without waiting: it ends the marker's holders and applies the workspace check. Each dispatch has, for that, the time left divided by the dispatches still to look at.
- **T02** Then the sweep looks again, every 200 ms, at the dispatches that only their strays keep unstopped, all together, for at most 3 seconds, and stops as soon as none has a stray. A stale check does not wait, as before.
- **T03** A sweep waits for a dispatch once. It records `strayWaitAt` in the dispatch's record, written to a file of its own and renamed, and reports `waited: true` for the dispatch. A later sweep looks at that dispatch once and does not wait. An earlier version reads the record as before.

## A. An application's processes

- **A01** On macOS a process below an application's own executable that launchd started (`*.app/Contents/MacOS/*`, a direct child of process 1) is that application's, whenever the application started. SPEC-0045 K03 said so only for an application that ran before the dispatch began, so a sweep days later counted every session of an application that had been started again. The application itself, when it is in the workspace, is judged as any other process: below nothing but launchd, it counts.
- **A02** Each entry of `strayProcesses` and `foreignProcesses` has `started`, as `ps` reports it, for a host to show its user.

What this does not prove: a dispatch that itself starts an application, through `open` or by running its executable, and whose application then runs a process in the workspace, leaves that process uncounted. SPEC-0045 K03 already left it uncounted when the application was running before the dispatch.

A process that launchd adopted and that started after the dead host exited still counts. Nothing tells it from a process that a dispatch's leftover started before exiting itself, and the instance's record does not hold when the host exited.

## R. Retiring a confirmed dispatch

- **R01** `acknowledgeStopMarkers(directory, dispatchIds, { attested: true })` also removes dispatches that are not proven: the host says that its user confirmed that they stopped. The result's `removed`, `refused` and `missing` are as before.
- **R02** With `attested` a dispatch that is not proven is still refused:
  - `instance_live` when its instance's process runs, or the instance has no record;
  - `holders_left` when a process holds its marker. That process is the dispatch's beyond doubt, and a sweep ends it;
  - `unlisted` when the process table or the holders cannot be listed.
    The call ends no process. Without `attested`, `not_proven` as before.

An acknowledgement removes files only. Reporting the dispatch stopped to the engine is `sessions.reconcile`, whose own rules are unchanged.

## Timing invariants

1. A dispatch is reported stopped only when a listing of its own found no holder and no stray. Waiting, shares and the order of the passes change when a listing runs, never what it needs to show.
2. The wait begins after every dispatch has been looked at once.
3. The sweep ends within `timeoutMs`; the wait within 3 seconds of it.
4. No process is ended that does not hold a marker.

## Compatibility

Additions only: `started` on a stray, `waited` on a swept dispatch, `strayWaitAt` in a dispatch's record, the option `attested` and three refusal reasons that only it produces. A sweep that used to take its whole time takes less. On macOS a dispatch may now be proven stopped where an application's processes kept it unstopped.

## Acceptance

| Id       | Criterion                                                                                                                                                        | Test                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0059-T01 | Dispatches with strays leave the clean ones proven                                                                                                               | `tests/contract/stop-marker-sweep-0059.test.ts` |
| 0059-T02 | The wait ends well before `timeoutMs`; a stray that exits during it leaves the dispatch proven                                                                   | same                                            |
| 0059-T03 | The first sweep waits and records it; the second does not wait; the record keeps its fields                                                                      | same                                            |
| 0059-A01 | A process below an application that started after the dispatch is foreign; a daemon, an orphan, a bundle's helper and the application itself count; not on Linux | same                                            |
| 0059-A02 | Strays name when they started                                                                                                                                    | same                                            |
| 0059-R01 | An attested acknowledgement removes an unproven dispatch and its empty instance, and ends nothing                                                                | same                                            |
| 0059-R02 | A held marker and a live instance refuse it                                                                                                                      | same                                            |

## Rollback

Reverting restores 0.1.30's sweep. Records keep a `strayWaitAt` that it ignores.
