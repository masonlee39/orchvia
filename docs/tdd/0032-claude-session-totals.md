# TDD-0032: Claude session totals that continue across dispatches

Date: 2026-09-27. Base: `7f5375f` (0.1.8 on `main`). Specification: [SPEC-0032](../specs/0032-claude-session-totals.md).

## Reproduction

Before the specification, the unchanged `scripts/native-usage-smoke.mjs` of 0.1.8 ran with SDK 0.3.283, installed from the local npm cache with `--offline`. Its C01, `sessions.compact` as the session's second dispatch, failed: the compaction's record outside the main loop held 205,000 input, 1,450 output, 5 cache-read and 612 cache-write tokens, the first dispatch's 198,000 / 750 / 5 / 312 plus its own 7,000 / 700 / 0 / 300. The same script passed with SDK 0.3.274.

A scratch script then ran three plain dispatches on 0.3.283: a first one, a resumed second one, and a fork's first one, taken at the first dispatch's checkpoint after the second. Each main loop used 1,000 input tokens. `modelUsage` reported 1,000, 2,000 and 3,000; on 0.3.274 it reported 1,000 each time. The fork therefore continued from its source's latest totals.

## RED

The new tests ran on the base with only the tests added.

- `tests/contract/claude-session-usage.test.ts`: 5 of 6 failed. The adapter subtracted no baseline, reported no totals and never recorded a resumed dispatch as unknown. `0032-A01 an earlier Claude Code keeps per-query totals`, which expects 0.1.8's behaviour, passed.
- `tests/engine/session-usage-baseline.test.ts`: 5 of 5 failed. `usageBaseline` was undefined, the dispatch row kept no totals, and `usageTotals` did not exist.
- The extended `scripts/native-usage-smoke.mjs` on the base with SDK 0.3.283 failed at C03, the plain resumed dispatch: besides its main loop it recorded 198,000 / 750 / 5 / 312 outside it, the whole first dispatch.

## Changes

- **The Claude adapter (A).**
  - It reads `claude_code_version` from `system/init`.
  - The main observation carries the result's per-key totals as `sessionTotals`.
  - For a resumed dispatch or a fork's first one on 2.1.277 or later, it subtracts the engine's `usageBaseline` per key before `outsideUsage` subtracts the main loop. Without a baseline for the same native session, or without a version, the outside record is unknown.
- **The engine (E).**
  - `usageTotals` validates `sessionTotals` as plain JSON of at most 64 KiB; `usageRecord` and it share one bounded copy.
  - `recordUsage` keeps the totals on the dispatch row in the observation's transaction.
  - `usageBaseline` hands a dispatch the totals of the session's most recent other dispatch, or for a fork's first dispatch its source's, unless the source is running.
  - `Store.latestDispatch` reads that dispatch through `dispatches_session`.
- **The real binary (C).**
  - `scripts/native-usage-smoke.mjs` runs five dispatches on one native session: C02, C03, C04, C05, then C01.
  - It takes an optional SDK module path, so CI runs it with 0.3.283 and with 0.3.274.
- **Pins (B04).** The root development dependency, the lockfile's nine SDK entries, `offline.yml`, `scripts/check-native-protocol.mjs` and the native plan template use Claude Agent SDK 0.3.283 and Codex CLI 0.157.1.

Found on the way:

- **The lockfile.** `npm install` rewrote the lockfile and dropped the five workspace link entries. The lockfile was restored from the base and only the nine SDK entries were replaced.
- **The version guard.** `0021-P08`, which keeps package versions out of package source, flagged the comments that name Claude Code 2.1.277. Its list of other software's versions, the zod peer and the Jev model, now includes Claude Code.
- **Engine test E03.** It first forked from an earlier task's artifact, which `sessions.fork` refuses; a fork takes the session's latest completed task's artifact. Its running source first held before reporting usage, so the source's latest dispatch had no totals and the guard for a running source went untested; the source now holds after reporting its totals.
- **Transcripts from before 2.1.277.** The SDK's declaration says a resumed session continues from the totals its transcript saved, "when it has them". A session whose last dispatch ran before the upgrade has a non-cumulative baseline, so its first dispatch after the upgrade is unknown outside its main loop, and the ones after it are exact.
- **The dangerous `rm` (B03).** Measured with the real 2.1.283 binary and a gateway that asked for `rm -rf "$(pwd)"` in a scratch directory:
  - in `default` mode, `canUseTool` received the request and Claude Code waited the 150 seconds the probe held its answer;
  - in `bypassPermissions` mode, the request also reached `canUseTool`, although the SDK warned that the callback would not be consulted;
  - in `auto` mode, a built-in safety check denied it at once without the callback, and emitted `system/permission_denied` and `system/informational`.
  - The scratch directory's file survived every run.

## GREEN

Local, macOS arm64, Node 24.14.0, Python 3.14:

- `tests/contract/claude-session-usage.test.ts` 7 of 7, `tests/engine/session-usage-baseline.test.ts` 6 of 6, `tests/contract/claude-outside-usage.test.ts` 5 of 5.
- Mutations, each reverted after the run: no baseline subtraction, a version threshold of 999, a per-query baseline accepted, a running fork source ignored, no baseline passed, the oldest dispatch taken as the previous one, and no check of repeated totals. The new tests killed all 7. The first run left two alive, the running source and the repeated totals; the stronger E03 and a new E01 case killed them.
- Stability: the two new files passed 24 of 24 parallel runs.
- `npm test` 749 of 749; `npm run test:python` 102 of 102; `npm run typecheck`, `npm run format:check` and `npm run generate:protocol -- --check` pass. The wire schema did not change.
- The real binaries with scripted gateways, no paid models:
  - `scripts/native-usage-smoke.mjs` passed all five cases with SDK 0.3.274 (Claude Code 2.1.274) and with 0.3.283 (2.1.283).
  - With 0.3.283: `scripts/native-gateway-smoke.mjs claude` passed 9 of 9 cases, `scripts/quickstart-claude-smoke.mjs` passed, `bench/run.mjs --gateway --require-pass` passed its three arms, and both Claude fixtures of `check-native-protocol.mjs` passed.
- Codex 0.157.1 was not installed locally; CI's pinned native job checks it.
