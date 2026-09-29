# SPEC-0042: Reasoning effort for the local Codex member, and three corrections

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-42-1, D-42-2 and D-42-3, option 1 each). Release: 0.1.19. Extends: SPEC-0035 F01 and C09, SPEC-0029 A. Environments: macOS and Linux. Storage is unchanged. The wire adds one field and one capability flag. Evidence: [TDD-0042](../tdd/0042-codex-reasoning-effort.md).

## Why

A host runs several local Codex members and wants each to choose its reasoning effort. The adapter's `args` are one for every dispatch, so they cannot. Codex's `turn/start` takes `effort`.

Measured with Codex CLI 0.153.4 and 0.157.1 behind the loopback scripted gateway, reading the effort each model request carried:

- `effort` is a string, "a non-empty reasoning effort value advertised by the model", not a closed set; `model/list` gives each model's `supportedReasoningEfforts` and `defaultReasoningEffort`.
- An effort given on a resumed thread reached the next request. A dispatch that gave none sent the model's default, not the effort of the dispatch before, since each dispatch starts its own app-server.
- Codex refuses no effort. `ultra` on a model without it was lowered to the model's highest effort (`xhigh` for gpt-5.5, `max` for gpt-6-luna). `max` on gpt-5.5, which lists up to `xhigh`, and an invented value were sent to the model unchanged.
- No turn event or thread field reports the effort in force.
- `model/list` without `includeHidden` leaves out three or four models (for example `gpt-daybreak-blue-latest` and `codex-auto-review`); it pages by `nextCursor`.

## E. Reasoning effort

- **E01** `CodexDispatchPolicy` takes an optional `effort`: a string of 1 to 64 letters, digits, `.`, `_` or `-`, not a closed set, so that a new Codex effort needs no new Orchvia. Anything else ends the dispatch with `CODEX_POLICY_INVALID`.
- **E02** A dispatch with `connection` lists Codex's models with `includeHidden: true`, following `nextCursor` to the last page (at most 50 pages), after `initialize` and before its thread. The dispatch's model is the entry whose `id` or `model` equals it.
  - If the model is listed and `effort` is not among its `supportedReasoningEfforts`, the dispatch ends before its thread with `CODEX_EFFORT_UNSUPPORTED: <model> supports <efforts>; <effort> was requested`, outcome `failed`. No thread is opened and no model request is made, as for `HOST_HOOK_UNTRUSTED`.
  - If the model is not listed, or the list cannot be read, the effort is passed on unchecked.
- **E03** A given effort goes on that dispatch's `turn/start` as `effort`. Without one, `turn/start` is unchanged. A compaction dispatch sends no effort.
- **E04** Each usage record of the dispatch carries `raw._reasoningEffort: { requested, effective, source }`:
  - `source` is `requested` when a listed model supports the given effort, and `effective` equals it;
  - `source` is `modelDefault` when none was given and the model is listed, and `effective` is its `defaultReasoningEffort`;
  - `source` is `unverified` when the model is not listed or the list could not be read, and `effective` is the given effort or null.
- **E05** Each task of `usage.byTask` carries `reasoningEfforts`: the distinct non-null `raw._reasoningEffort.effective` of the task's own records, in the order they were first recorded. It is empty when there is none, for example for a Claude task. `initialize` lists `workflow.reasoningEfforts`. The Python SDK names it `reasoning_efforts`.

## C. Corrections

- **C01** The inline preview of a large result ends with an English note, `[Preview truncated; the full result is in artifact <ref>]`. It was the only Chinese text the engine returned.
- **C02** A thread that Codex refuses because a required MCP server failed to start (`required MCP servers failed to initialize: agent_orch`) ends with `CODEX_TOOL_BRIDGE_UNAVAILABLE: <Codex's message>`, outcome `failed`, as the hook (`HOST_HOOK_UNAVAILABLE`) and the proxy check (`CODEX_NETWORK_PROXY_UNAVAILABLE`) do.
- **C03** The native local smoke's host MCP case searched once and called the tool. On a slow runner the host's MCP server was not ready by then, and the search found nothing (`unsupported call: host_echo`, macOS Intel, 2026-09-28). The case now repeats the search, up to 20 times, until the tool is listed.

## Timing invariants

1. The model list is read after `initialize` and before `thread/start`; a refused effort opens no thread and sends no turn.
2. The effort in the usage records is the one decided before the turn, so a record written after the turn cannot report another.

## Acceptance

| ID       | Criterion                                                                                                                                                                            | Test                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 0042-E01 | A malformed effort is refused with `CODEX_POLICY_INVALID`; an open string such as a future effort is accepted                                                                        | `tests/contract/codex-effort-0042.test.ts`     |
| 0042-E02 | The model list is read with hidden models and every page; an unsupported effort of a listed model ends with `CODEX_EFFORT_UNSUPPORTED`, naming the supported ones, before any thread | same                                           |
| 0042-E03 | A given effort reaches `turn/start`; none leaves it out                                                                                                                              | same                                           |
| 0042-E04 | Usage records carry `raw._reasoningEffort` with `requested`, `modelDefault` and `unverified`                                                                                         | same                                           |
| 0042-E05 | `usage.byTask` lists each task's efforts, in both SDKs; `initialize` lists `workflow.reasoningEfforts`                                                                               | same, and `python/tests/test_usage_efforts.py` |
| 0042-C01 | The preview note is English                                                                                                                                                          | `tests/engine/foundation.test.ts` (AC11)       |
| 0042-C02 | A bridge Codex cannot start ends with `CODEX_TOOL_BRIDGE_UNAVAILABLE`                                                                                                                | `tests/contract/codex-effort-0042.test.ts`     |
| 0042-N01 | [Native] Real Codex: a requested effort reaches the model request; an unsupported one is refused before the thread; none sends the model's default, as the record says               | `scripts/native-codex-local-smoke.mjs`         |

## Rollback

Reverting restores 0.1.18: every dispatch uses the adapter's or the model's effort, and `usage.byTask` has no `reasoningEfforts`.
