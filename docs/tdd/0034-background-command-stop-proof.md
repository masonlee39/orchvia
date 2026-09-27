# TDD-0034: Stop proof for commands that outlive their turn

Date: 2026-09-27. Base: `66079e7` (0.1.9 on `main`). Specification: [SPEC-0034](../specs/0034-background-command-stop-proof.md).

## RED

The new tests ran on the base, or on the base plus the parts already implemented, with only the tests added.

- `tests/contract/stop-proof-0034.test.ts` on the base: 3 of 3 failed. A01 found no exception for `createCodexAdapter({})`; A02 found no warning ("one warning per process"); A03 found the fixture's background `sleep` alive after the dispatch ("the backgrounded command was ended with its dispatch").
- The JSON CLI part of A01, with the adapter change and without the configuration change: `loadConfig` accepted a `codex` provider without `executionStop` ("Missing expected rejection").
- `tests/contract/stop-marker-0034.test.ts` before the adapter change: the six adapter tests failed, `stopMarker` being unknown (construction accepted it, no prefix was set, the fixture's command was not wrapped). The two `StopMarkers` unit tests are new code.
- B03, with B01 implemented: 2 of 2 failed. A command that closed descriptor 9 before backgrounding left the dispatch reported `remoteExecution: 'stopped'`, and the observer vouched for a dispatch while an orphan started during it ran in its workspace.

## Changes

- **A01.** `coversExecution` is false in `createCodexAdapter`; the terminal report's detail says the host observer is still required. `packages/cli/src/config.ts` accepts `executionStop` for `codex` and requires `'owner-reconcile'`.
- **A02.** `processGroupsStopped` is marked deprecated and warns once; `requireStopProof` names `stopMarker` for Claude and no longer names `processGroupsStopped`.
- **A03.** `packages/engine/src/process-tree.ts` lists a process's descendants with their start times and ends those that are unchanged; `AppServerConnection.stop()` uses it after stopping the app-server.
- **B01, B03.** `packages/engine/src/stop-marker.ts` (`StopMarkers`: marker, wrapper, `lsof` holders, the workspace check, `observer`, `endAll`); the Claude adapter's `stopMarker` option, `env` and sandbox `allowRead`, the end-of-dispatch sweep and the sweep at close.
- **C01.** `scripts/native-stop-smoke.mjs` and its two CI steps.

Existing tests that encoded the superseded behavior, changed with this increment:

- `0027-A03` asserted that `createCodexAdapter({})` covered execution; it now asserts refusal (superseded by 0034-A01).
- `A2 Codex advertises only explicit provider caps and the read-only terminal coverage contract` became `…and, since 0034-A01, no terminal coverage`; `A2 Codex reports a matching terminal…` now expects the terminal report's `remoteExecution` to be `unknown` and the observer's to be `stopped`.
- 46 other tests built a Codex adapter or a CLI `codex` provider without a stop proof. Those that check evidence or an engine flow through a fixture that runs no command use a test observer; the others use `executionStop: 'owner-reconcile'`. `scripts/native-gateway-smoke.mjs` uses an observer bound to its exact target, as its writable Claude profile already did, and `scripts/package-smoke.mjs` uses owner reconcile.

Found on the way:

- **The first native Claude case proved nothing.** The scripted `sleep … &` was refused: Claude Code refuses a bare `&` in the adapter's `dontAsk` mode, and the adapter's guard refuses `run_in_background`. The smoke now asserts that each scripted command ran, and backgrounds through `sh -c`.
- **Python drops the marker (F3).** A native case with `subprocess.Popen(..., start_new_session=True)` released the lease while the daemon ran, because Python closes inherited descriptors by default. Environment markers cannot be read for system binaries on macOS; working directories can. This led to B03 (D-0034-4).
- **The state directory is denied.** The draft put markers under the state directory; the write sandbox denies it, and `allowRead` there would reopen private state, so the markers live in a private temporary directory that `allowRead` names.
- **Codex ends yielded commands early.** A Codex dispatch closes its own app-server, so A03 ends a yielded `exec_command` when the dispatch finishes, not only when the host closes. A command that `sh … &` backgrounded was gone by the stop on 0.153.4; the smoke records it rather than asserting it.
- **`lstart` resolution.** `ps` start times have one-second resolution, so B03 counts the whole second in which the dispatch began, and `execFile` needs an integer timeout.
- **What the first Linux CI found.** Three failures, none on macOS. (1) The wrapper test got exit 2, not 126: Linux's `/bin/sh` is dash, where a failed `exec` redirection ends the shell with its own status; reproduced locally with `/bin/dash`, now covered by the test, fixed with `command exec`. (2) B03 did not count an orphan started right after `prepare`: Linux derives `ps` start times from a boot time truncated to the second, so they can read up to a second early; the check now counts from the second before. (3) Both native stop smokes failed because bubblewrap could not start on Ubuntu 24.04 (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`), so no sandboxed command ran, for Claude and Codex alike; the first Claude case had passed without running its command. The job now lifts AppArmor's user-namespace restriction, and the smoke fails when a command reports an error or a nonzero exit. The CI's Codex path was relative and the adapter starts Codex in each case's workspace, so it is resolved first.
- **A surviving mutation.** Counting the host's own tree survived the first B03 tests: the fixture's Claude process had exited before the check. The unit test now keeps a child of the host in the workspace.

## GREEN

- `npm test`: 778 of 778 (before the final own-tree assertion); `npm run test:python`: 106 of 106; `npm run typecheck`, `npm run format:check`.
- New tests: `stop-proof-0034` 4 of 4, `stop-marker-0034` 9 of 9, three repeated runs.
- Mutations, each restored from a file copy: 8 of 8 killed (own tree ignored, start time ignored, wrapper without marker, workspace check skipped, Codex coverage restored, no descendant cleanup, CLI without `executionStop`, host prefix accepted).
- Native, macOS arm64, loopback gateway, no model calls: `native-stop-smoke.mjs claude` with Agent SDK 0.3.283 (`sh -c` background ended and lease released; Python daemon left running and lease held; `processGroupsStopped` false while the Claude process lived), `native-stop-smoke.mjs codex` with codex-cli 0.153.4 (yielded command ended with its dispatch, lease held; backgrounded command, lease held), and `native-gateway-smoke.mjs` for both (Codex 6 cases, Claude 9). Linux and Codex 0.157.1 run in CI.
- Codex marker (B02): not implemented; F4.
