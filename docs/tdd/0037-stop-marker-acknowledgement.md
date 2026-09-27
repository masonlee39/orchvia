# TDD-0037: Kept proofs and one synchronous cleanup per host directory

Date: 2026-09-27. Base: `a21833d` (0.1.11 on `main`). Specification: [SPEC-0037](../specs/0037-stop-marker-acknowledgement.md).

## RED

`tests/contract/stop-marker-ack-0037.test.ts` ran on the base with only the tests added: the file failed to load, `@orchvia/adapter-claude` exporting neither `acknowledgeStopMarkers` nor `endStopMarkersSync`, and a sweep knew no `keepProven`. `tests/fixtures/stop-marker-instance.ts` gained an optional dispatch ID.

## Changes

- `packages/engine/src/stop-marker.ts`: `keepProven` and `.proven` in the sweep; proven dispatches reported at once; `acknowledgeStopMarkers`; the synchronous rounds moved into `endHoldersSync`, shared by `endAllSync` and `StopMarkers.endAllSyncUnder`, with a registry of this process's instances per directory; `endStopMarkersSync(directory, timeoutMs)`.
- `packages/adapter-claude`: the exports and types.
- `scripts/native-stop-restart-smoke.mjs`: the restart case keeps and acknowledges the proof; a case with two adapters under one directory; the gateway waits for as many commands as a case runs.

Found on the way:

- **An acknowledgement removing a live instance's directory.** The first version removed any empty instance directory not of this process, including one of another running host with nothing marked at that moment, whose next dispatch would then have failed. It now removes only instances whose process is gone, and K03 keeps a live, empty instance.
- **Shared workspaces.** K03 first put its proven and its open dispatch in one workspace, and the open dispatch's process that dropped its marker, running in that workspace since the proven dispatch began, rightly kept both unstopped. They now have workspaces of their own.
- **A surviving mutation.** Ignoring the directory in `endStopMarkersSync` survived while Y02's other instance had no host directory at all, and so was never registered; it now has another directory.

## GREEN

- New tests: 5 of 5, with the 13 of SPEC-0036. Under one busy loop per core, the four stop test files in six parallel copies: 31 of 31 each.
- Mutations, each restored from a file copy: 7 of 7 killed (proof ignored, proof not written, plain sweep keeping proofs, unproven acknowledged, live instance directory removed, directory ignored, one listing per instance).
- Native, macOS arm64, Claude Code 2.1.283, loopback gateway, no model calls: the restart case kept the proof and acknowledged it (`removed: ['restart-dispatch']`, nothing left after); two adapters under one directory, each with a background command, were cleaned up by one call in 146 ms (`holders: 2, ended: 2`, verified). Under that load with the Apple-silicon check off, as on the x86-64 runner, two runs passed in 202 to 229 ms.
