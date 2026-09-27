# SPEC-0037: Kept proofs and one synchronous cleanup per host directory

Date: 2026-09-27. Status: approved by the owner on 2026-09-27 (D-0037-1 and D-0037-2 option 1), at the request of a downstream host. Release: 0.1.12. Builds on: [SPEC-0036](./0036-stop-marker-restart.md). Environments: macOS and Linux; Windows is unsupported. Engine, wire and storage are unchanged. Evidence: [TDD-0037](../tdd/0037-stop-marker-acknowledgement.md).

## Why

A sweep that proves a dispatch stopped removes its files at once, while the host reports the proof with `sessions.reconcile` only afterwards. A host that crashes between the two finds nothing on its next sweep, so the dispatch stays interrupted until a person acts: safe, but not what the host wants. A host with several adapters under one directory also has to call each adapter's synchronous cleanup on exit, one listing each.

## K. Keeping a proof until the host acknowledges it

- **K01** `sweepStopMarkers(dir, { keepProven: true })`: a dispatch the sweep proves stopped keeps its files, the sweep writes `<id>.proven` (`{version: 1, dispatchId, provenAt}`) after the proof, and it reports `proven: true`. Without `keepProven`, a sweep behaves as in 0.1.11.
- **K02** A later sweep or stale check reports a dispatch with `.proven` and a dispatch record as `stopped: true, proven: true` at once, without the holder listing or the workspace check: every holder was gone when it was proven, and a dead instance's wrapper runs no more commands, so a process started in the workspace since cannot turn it back. A sweep without `keepProven` removes such a dispatch's files, proof included.
- **K03** `acknowledgeStopMarkers(dir, dispatchIds)`, exported by `@orchvia/adapter-claude` and needing no engine, removes the files of each proven dispatch, the marker first and the proof last, and returns `{ removed, refused, missing }`. A dispatch without a proof is refused with `not_proven` and keeps its files (D-0037-2); an ID found nowhere is missing. An instance directory with no marker left is removed when its process is gone; a live instance keeps it for its next dispatch. The root stays. Calling again with the same IDs removes nothing more.

## Y. One synchronous cleanup per directory

- **Y02** `endStopMarkersSync(directory, timeoutMs)`, exported by `@orchvia/adapter-claude`, covers every adapter instance of this process whose `stopMarker.directory` is `directory`: one listing for all of their markers, counting processes from the earliest instance's start, then the SIGTERM, SIGKILL and listing rounds of SPEC-0036 Y01. It returns `{ stopped, holders, ended, instances }`, `instances` naming each instance directory and its number of markers, reports a `sync` observation to each instance's `onObservation`, never throws, and returns `{ stopped: true, holders: 0, ended: 0, instances: [] }` when no instance is under the directory. `adapter.endStopMarkersSync(timeoutMs)` is unchanged.

## Timing invariants

1. `.proven` is written only after the holders are gone and the workspace check passed.
2. An acknowledgement removes the marker, then the dispatch record and wrapper, then the proof. An interrupted one leaves either a proven dispatch or files without a marker, which the next sweep removes; never an unproven dispatch reported as proven.
3. Neither the acknowledgement nor a sweep signals or removes a live instance's markers, and a live instance keeps its directory.

## Acceptance

| ID       | Criterion                                                                                                                                                                                                        | Test                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0037-K01 | `keepProven` keeps the files with a proof; later sweeps and stale checks report it proven, and a process started in the workspace since does not change that                                                     | `tests/contract/stop-marker-ack-0037.test.ts` |
| 0037-K02 | Without `keepProven`, a sweep removes what it proves, a kept proof included                                                                                                                                      | same                                          |
| 0037-K03 | Only proven dispatches are acknowledged; unproven are refused and kept; unknown IDs are missing; an empty dead instance goes, a live one stays; a repeat removes nothing                                         | same                                          |
| 0037-K04 | An acknowledgement cut after the marker leaves files the next sweep removes; a lost proof is examined again, not taken as proven                                                                                 | same                                          |
| 0037-Y02 | One listing covers two instances under a directory, both holders end, an instance under another directory is untouched                                                                                           | same                                          |
| 0037-C01 | [Native] Real Claude Code, macOS: the restart case keeps the proof and acknowledges it; two adapters under one directory are cleaned up by one call within 300 ms, verified on Apple silicon. On Linux, recorded | `scripts/native-stop-restart-smoke.mjs`       |

## Rollback

Both are opt-in; a host that stops using them returns to SPEC-0036's behavior. `.proven` files left by a host that stops using `keepProven` are removed by its next sweep.
