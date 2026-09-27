# SPEC-0036: Stop markers across a host restart

Date: 2026-09-27. Status: approved by the owner on 2026-09-27 (D-0036-1 and D-0036-2 option 1), at the request of a downstream host that replaces its own marker observer with `stopMarker`. Release: 0.1.11. Builds on: [SPEC-0034](./0034-background-command-stop-proof.md) B01 and B03. Environments: macOS and Linux; Windows is unsupported. Engine, wire and storage are unchanged. Evidence: [TDD-0036](../tdd/0036-stop-marker-restart.md).

## Why

With `stopMarker: true` the markers live in a random temporary directory and exist only while the host runs. A host that crashes cannot, after it restarts, end what its Claude Code left running, nor show that a dispatch whose outcome is unknown has stopped. A host also needs a bounded cleanup on its synchronous exit path, and the result of each observation for its diagnostics.

## D. A host directory

- **D01** `stopMarker: { directory, onObservation? }`. `directory` is absolute; when missing it is created with mode 0700. It must be a directory, not a symbolic link, owned by the current user and writable by neither group nor others; otherwise `createClaudeAdapter` fails with `INVALID_ADAPTER_CONFIG`. Any other key, or an `onObservation` that is not a function, fails the same way. A dispatch whose workspace or state directory lies inside the directory, or contains it, fails before submission. `stopMarker: true` keeps the behavior of 0.1.10.
- **D02** Each adapter instance works in `<directory>/<pid>-<8 hex digits>` (mode 0700). `instance.json` holds `{version: 1, pid, started}`, `started` being the process's `ps` start time, and is written before the first marker. Each dispatch writes `<id>.json` with `{version: 1, dispatchId, workspace, startedAt}` before its `<id>.tag` and `<id>.sh`. The sandbox's `allowRead` gains the instance directory, not the root. Nothing removes the root.
- **D03** With a host directory, a dispatch's files are removed only once it is proven stopped. Ending a dispatch, or closing the adapter, still ends what holds its marker, but the files of a dispatch not proven stopped stay for a sweep. Closing removes the instance directory only when no marker is left in it.

## S. Sweeping what an earlier instance left

- **S01** `sweepStopMarkers(directory, { timeoutMs = 5000, onObservation })` and `staleStopMarkers(directory, …)`, exported by `@orchvia/adapter-claude`, need no engine. They return `{ stopped, dispatches, liveInstances }`, where each dispatch is `{ dispatchId, instance, workspace, holders, ended, strays, stopped, reason? }` and `stopped` is true when every dispatch found is.
  - An instance is live when the process its record names runs with the recorded start time. A live instance, this process's included, is listed in `liveInstances` and never signalled. A recorded PID that now belongs to a process started at another time is a dead instance.
  - For each marker of a dead instance the sweep ends its holders (SIGTERM, then SIGKILL) and then applies the workspace check of SPEC-0034 B03 to the dispatch's recorded workspace and start (D-0036-1): a process in that workspace, started since the dispatch began, outside this host's process tree, keeps the dispatch unstopped and is not ended. While time remains the sweep looks again every 200 ms, because a killed host's Claude Code stays in the workspace until it notices that its input closed.
  - A dispatch proven stopped loses its three files; a dead instance with no marker left loses its directory.
  - The stale check reports the same without ending, waiting or removing anything.
- **Reasons.** `reason` is `holders_left`, `strays`, `metadata_missing` (no dispatch record; `dispatchId` is null), `instance_unknown` (no valid instance record; nothing is signalled), or `unlisted` (`lsof` failed or ran out of time). A missing directory gives an empty result; one that fails D01's checks, or a process table that cannot be read, throws.

## Y. The synchronous cleanup

- **Y01** `adapter.endStopMarkersSync(timeoutMs)` returns `{ stopped, holders, ended }` within `timeoutMs`, keeping a tenth of it, at least 10 ms, for returning (0.1.12; 10 ms before), and never throws. It lists the holders of this instance's markers among the processes started since the instance began (`ps`, then `lsof -a -p <candidates>`, about 75 ms on macOS), sends SIGTERM and waits at most 40 ms while any runs, sends SIGKILL, and lists again. A holder may start another before it ends, so it repeats SIGKILL and the listing while a listing still fits in the time. `stopped` is true only when the last listing found none. It does not apply the workspace check, and it leaves every file for the next start's sweep. Without `stopMarker` it returns `{ stopped: true, holders: 0, ended: 0 }`.

## O. Observations

- **O01** `onObservation` receives `{ kind, dispatchId, holders, ended, strays, stopped, reason? }` for each observation: `dispatch` at a dispatch's terminal, `sync`, and `sweep` or `stale` for each dispatch examined (the sweep functions take their own `onObservation`). `holders` and `strays` are counts. An exception from the callback is ignored.

## Timing invariants

1. `instance.json` exists before any marker of the instance; a dispatch's record exists before its marker. A dispatch whose files cannot be written does not run.
2. A sweep or stale check never signals the markers' holders of a live instance.
3. A dispatch is reported stopped only when `lsof` showed no holder and, with its record, the workspace check found no process. Anything else is not stopped.
4. The synchronous cleanup returns within its time, never throws, and reports stopped only after a listing that found none.

## Acceptance

| ID       | Criterion                                                                                                                                                                                                                                                                                                                     | Test                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0036-D01 | The directory's checks at creation, the key checks, and a workspace or state directory overlapping it                                                                                                                                                                                                                         | `tests/contract/stop-marker-sweep-0036.test.ts` |
| 0036-D02 | The instance directory, its record, the dispatch record, and `allowRead` of the instance directory only                                                                                                                                                                                                                       | same                                            |
| 0036-D03 | The files of a dispatch not proven stopped stay after the adapter closes                                                                                                                                                                                                                                                      | same                                            |
| 0036-S01 | A sweep ends a dead instance's holder and removes it, keeping the root; the stale check ends nothing                                                                                                                                                                                                                          | same                                            |
| 0036-S02 | Live instances, this process's included, are untouched                                                                                                                                                                                                                                                                        | same                                            |
| 0036-S03 | A reused PID does not keep a dead instance alive                                                                                                                                                                                                                                                                              | same                                            |
| 0036-S04 | After a restart, a process that dropped the marker keeps its dispatch unstopped within the sweep's time, and is not ended                                                                                                                                                                                                     | same                                            |
| 0036-S05 | A marker without its dispatch record is never proven stopped                                                                                                                                                                                                                                                                  | same                                            |
| 0036-Y01 | Within the time, never stopped while a holder runs; with more time, the holder ends; a holder that ignores SIGTERM is killed; not stopped while holders keep starting                                                                                                                                                         | same                                            |
| 0036-O01 | Each observation reaches the host; a failing callback changes nothing                                                                                                                                                                                                                                                         | same                                            |
| 0036-C01 | [Native] Real Claude Code, macOS: a killed host's `nohup sleep 600 &` is ended by one sweep of the next host; the synchronous cleanup ends one within 300 ms, verified in that time on Apple silicon; the slower x86-64 macOS runner may report it unverified. On Linux, where the sandbox ends it with its command, recorded | `scripts/native-stop-restart-smoke.mjs`         |

## Rollback

`stopMarker: true` is unchanged, so a host can return to it; files left under a host directory are then not swept.
