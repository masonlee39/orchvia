# TDD-0036: Stop markers across a host restart

Date: 2026-09-27. Base: `c3c4799` (0.1.10 on `main`). Specification: [SPEC-0036](../specs/0036-stop-marker-restart.md).

## RED

`tests/contract/stop-marker-sweep-0036.test.ts` and `tests/fixtures/stop-marker-instance.ts` ran on the base with only the tests added: the file failed to load, `@orchvia/adapter-claude` exporting neither `sweepStopMarkers` nor `staleStopMarkers`, and `stopMarker` accepted only a boolean.

## Changes

- `packages/engine/src/stop-marker.ts`: `checkStopMarkerRoot`; `StopMarkers({ root, onObservation })` with the instance directory, `instance.json` and the dispatch records; files kept until a dispatch is proven stopped; `endAllSync`; `sweepStopMarkers` and `staleStopMarkers`.
- `packages/engine/src/process-tree.ts`: `processTable(timeoutMs)`.
- `packages/adapter-claude`: `stopMarker: { directory, onObservation? }`, `endStopMarkersSync`, the exports and types, the state directory passed to `prepare`.
- `scripts/native-stop-restart-smoke.mjs` and its CI step.

Found on the way:

- **The synchronous cleanup's time.** One `lsof` over every process takes about 200 ms on macOS; restricted with `-a -p` to the processes started since the instance began, about 50 ms, and `ps` about 25 ms. The first version waited a fixed 100 ms after SIGTERM and took about 265 ms; waiting only while a holder runs brought it to about 160 ms.
- **A holder that starts another.** A loop that ignores SIGTERM kept a `sleep 1` holding the marker after the loop was killed, so one listing and one SIGKILL were not enough: the cleanup now repeats SIGKILL and the listing while a listing, whose cost it measures first, still fits. It then took about 260 ms.
- **Load.** Six parallel runs of the file failed Y01 and hung: the test waited only 2 s for the fixture's command and released the fixture's dispatch only on success. The test now waits up to 10 s and releases it in `t.after`, and asserts the bound and never stopped while a holder runs at 300 ms, and the holder's end with 2 s; the 300 ms effect is the native case's criterion. The cleanup keeps 10 ms of its time for returning.
- **The killed host's Claude Code.** On macOS the first sweep after the host was killed ended `sleep 600` but found the killed host's Claude Code still in the workspace, a stray, until it saw its input close, under a second later. The sweep now looks again every 200 ms within its time, so one sweep proves the dispatch.
- **Two surviving mutations** (a host directory retiring unproven markers, and an unverified synchronous `stopped`) needed D03 and a holder that keeps starting others.

## GREEN

- New tests: 13 of 13; six parallel runs of the file, 11 of 11 each (before D03 and the last Y01 were added).
- Mutations, each restored from a file copy: 12 of 12 killed (live instance swept, reused PID taken as live, strays ignored, missing record passing, stale ending holders, root removed, unproven markers retired, group-writable root accepted, overlap accepted, no SIGKILL, unverified synchronous stop, no dispatch observation).
- Native, macOS arm64, Claude Agent SDK 0.3.283 (Claude Code 2.1.283), loopback gateway, no model calls, `canUseTool` allowing the command: host A ran `nohup sleep 600 &` and was killed with SIGKILL; host B's single sweep ended it (`holders: 1, ended: 1, strays: 0, stopped: true`), after its stale check had listed it without ending it. The synchronous cleanup of a live host ended one in 146 to 156 ms over five runs. Linux runs in CI and is recorded only.
