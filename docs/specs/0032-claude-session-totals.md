# SPEC-0032: Claude session totals that continue across dispatches

Date: 2026-09-27. Status: approved by the owner on 2026-09-27, who chose every recommended option of the 0.1.9 design. Release: 0.1.9. Supersedes the part of [SPEC-0031](./0031-usage-outside-the-main-loop.md)'s timing invariant A02 that says the SDK starts `modelUsage` at zero for a resumed session. Evidence: [TDD-0032](../tdd/0032-claude-session-totals.md).

## Problem

From Claude Agent SDK 0.3.277 (Claude Code 2.1.277) on, a resumed or forked session's `total_cost_usd`, `modelUsage` and `get_usage` continue from the totals its transcript saved instead of starting at zero. The SDK's own declaration now says so: "a resumed or forked session continues from the totals its transcript saved, when it has them (so the first result already carries the earlier turns)".

The Claude adapter resumes the same native session on every dispatch after the first, and SPEC-0031 records each model's calls outside the main loop as that result's `modelUsage` minus its `usage`. On 0.3.283 the second dispatch of a session therefore recorded every earlier dispatch again. A downstream host that upgraded to 0.3.283 could not release until this was fixed.

Reproduced offline with the real binaries and the scripted gateway of `scripts/native-usage-smoke.mjs`. Counts are input / output / cache read / cache write:

| Same native session | SDK 0.3.274 `modelUsage` | SDK 0.3.283 `modelUsage` | `usage` (both) |
|---|---|---|---|
| First dispatch, compacting in the middle | 198000 / 750 / 5 / 312 | 198000 / 750 / 5 / 312 | 191000 / 50 / 5 / 12 |
| Second dispatch, resumed, `sessions.compact` | 7000 / 700 / 0 / 300 | **205000 / 1450 / 5 / 612** | 0 / 0 / 0 / 0 |

`usage` still covers one dispatch on both versions. A fork's first dispatch on 0.3.283 continued from its source's latest totals, not from the totals at the fork's checkpoint: after two source dispatches of 1000 input tokens each, a fork taken at the first one's checkpoint reported 3000 for its first dispatch.

## Design

### A. The Claude adapter

- **A01** The adapter reads `claude_code_version` from the dispatch's `system/init` message. From 2.1.277 on, a resumed or forked session's totals continue; before it, each query's totals start at zero, and the adapter behaves as in 0.1.8. Without a version it cannot tell.
- **A02** With a result's `modelUsage` complete (four safe integer counts for every key, at most 64 keys) and a known version, the main observation carries `sessionTotals`: `{version: 1, sessionId, cumulative, models: {key: [input, cacheRead, cacheWrite, output]}}`, keyed by the SDK's raw model keys, with `sessionId` the native session the result names.
- **A03** For a resumed dispatch or a fork's first dispatch on a Claude Code whose totals continue, the adapter subtracts the `usageBaseline` the engine supplies before it subtracts the main loop. It uses a baseline only when it is version 1, cumulative, and names the native session that this dispatch continues: the resumed session, or the fork's source. Without such a baseline, or without a version, what this dispatch alone ran outside its main loop is unknown: one record `…:outside:unknown` with null counts and the result's `modelUsage` as raw.
- **A04** A key absent from the baseline starts at zero. A key whose count fell below its baseline is unknown, as a negative remainder already is. The first dispatch of a new native session needs no baseline on any version.
- **A05** A fork's first dispatch subtracts its source's latest totals (see the reproduction above).
- The raw JSON of an outside record stays the SDK's `modelUsage` entry, which from 2.1.277 on is the session's running total; its counts are this dispatch's.

### E. The engine

- **E01** When a usage observation carries `sessionTotals`, the engine keeps a detached copy on the dispatch row, in the transaction that records the observation. A repeated observation must carry the same totals, or it is refused with `IDEMPOTENCY_CONFLICT`.
- **E02** A dispatch's `RuntimeInput.usageBaseline` is `{dispatchId, totals}` of the dispatch just before it on the same native session, or null. For a session that has a native session, that is the session's own most recent other dispatch. The engine never skips over a dispatch that kept no totals, such as one without a matched result, to an older one.
- **E03** For a fork's first dispatch, it is the source session's most recent dispatch, unless the source is running or holds an active dispatch; then which totals the fork continues from is unknown, and the baseline is null.
- **E04** The totals stay inside the engine: they are not part of a usage record, event, snapshot or wire result. `state.snapshot` covers tasks, sessions and approvals only.
- **E05** `sessionTotals` must be plain JSON of at most 64 KiB, like `raw`; otherwise the observation is refused with `INVALID_RUNTIME_CONTRACT`.

### Timing invariants

1. A dispatch still runs one `query()` with one user message.
2. The baseline is the totals of the dispatch just before this one on the same native session, fixed when this dispatch starts, before it submits.
3. The totals are kept in the transaction that records that dispatch's usage observation.
4. A dispatch without a matched result keeps no totals, so the dispatch after it has no baseline.
5. The totals come from the first matching result, as `usage` and `modelUsage` do (SPEC-0031).

### Records already written

The engine cannot tell afterwards which records 0.1.8 wrote on SDK 0.3.277 or later, so it changes none. On those versions, the `…:outside:…` records of a native session's second and later dispatches, and of a fork's first dispatch, include the earlier dispatches.

### B. Other changes in Claude Agent SDK 0.3.275 to 0.3.283 and Codex 0.154 to 0.157

| Change | Finding | In 0.1.9 |
|---|---|---|
| Notices during a turn arrive as `system/informational` (0.3.283) | The adapter acts only on `result`, main-session `assistant` and `stream_event`, and `compact_boundary`; it ignores other messages | **B01** The adapter tests send an informational message before the result |
| Hosts may set `CLAUDE_CODE_AUTO_MODE_SERVER=0` | `env` is not an adapter-owned option; the adapter sets none, so the SDK uses the process environment or the host's `env` | **B02** A test pins that the host's `env` reaches the query unchanged |
| A subagent's result has a heading and indentation (2.1.277) | The adapter does not parse subagent text; its default tools exclude Task | None |
| A dangerous `rm` asks for permission in full-access and auto modes (2.1.281) | Measured on 2.1.283: in `default` mode `canUseTool` received `rm -rf "$(pwd)"` and Claude Code waited 150 seconds for the answer, with no two-minute denial; in `bypassPermissions` mode the request also reached `canUseTool`; in `auto` mode a built-in safety check denied it at once, without the callback, and emitted `system/permission_denied` and `system/informational` | **B03** The guide documents it; the runtime approval time limit is unchanged |
| `set_max_thinking_tokens` without a value leaves it unchanged (0.3.283) | The adapter does not send it | None |
| Callbacks and control requests after `close()` (0.3.281) | Fixes in the SDK | None |
| `initialize` may wait up to 250 ms for in-process MCP servers (0.3.281) | Within the 1,800-second budget | None |
| `codex mcp-server` removed (Codex 0.154) | The Codex adapter runs `codex app-server` only | None |
| Background server and daemon changes (Codex 0.155 to 0.157) | The adapter starts `codex app-server` over stdio | **B04** CI's pinned native job runs Codex 0.157.1 |

The SDK's declarations from 0.3.274 to 0.3.283 differ in 565 lines. None changes the result subtypes the adapter classifies, its query options, `spawnClaudeCodeProcess` or the session fields it reads.

### Pins

- The root development dependency and CI's pinned native job use Claude Agent SDK 0.3.283 and Codex CLI 0.157.1; `scripts/check-native-protocol.mjs` checks both.
- The adapter's peer range stays `>=0.3.241 <1`.

## Acceptance

| ID | Criterion | Evidence |
|---|---|---|
| 0032-A01 | A resumed dispatch on 2.1.277 or later subtracts the baseline; an earlier version keeps per-query totals and ignores a baseline | `tests/contract/claude-session-usage.test.ts` |
| 0032-A02 | The main observation carries the session's totals, cumulative or not; incomplete counts carry none | same |
| 0032-A03 | A resumed cumulative dispatch without a usable baseline, or without a version, is unknown outside its main loop | same |
| 0032-A04 | A key below its baseline is unknown; a new session needs no baseline | same |
| 0032-A05 | A fork's first dispatch subtracts its source's totals, and its totals name the fork | same |
| 0032-B01 | An informational system message does not change the result | same (every case) |
| 0032-B02 | The host's `env` reaches the query unchanged; the adapter sets none | same |
| 0032-E01 | The engine keeps a dispatch's totals and hands them to the next dispatch of the session; a repeated observation must carry the same totals | `tests/engine/session-usage-baseline.test.ts` |
| 0032-E02 | A previous dispatch without totals leaves no baseline | same |
| 0032-E03 | A fork's first dispatch receives its source's latest totals, unless the source is running | same |
| 0032-E04 | The totals appear in no snapshot, event or usage record | same |
| 0032-E05 | Invalid or oversized totals are refused | same |
| 0032-C03 | Real binary: a plain resumed dispatch records only its own calls | `scripts/native-usage-smoke.mjs` |
| 0032-C04 | Real binary: a resumed dispatch that compacts records only its own compaction | same |
| 0032-C05 | Real binary: a fork's first dispatch records only its own calls | same |
| 0032-C06 | Real binary: the records of all five dispatches are the same on SDK 0.3.274 and 0.3.283 | CI runs the smoke with both |

## Not in 0.1.9

Issues [#43](https://github.com/masonlee39/orchvia/issues/43) to [#46](https://github.com/masonlee39/orchvia/issues/46) are designed for 0.1.10 and [#47](https://github.com/masonlee39/orchvia/issues/47) for 0.1.11.
