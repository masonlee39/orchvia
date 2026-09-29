# TDD-0042: Reasoning effort for the local Codex member, and three corrections

Specification: [SPEC-0042](../specs/0042-codex-reasoning-effort.md). Approved by the owner on 2026-09-29 (D-42-1, D-42-2, D-42-3, option 1 each).

## Measured before the design

With Codex CLI 0.153.4 and 0.157.1, a scratch home, a synthetic key and the loopback scripted gateway, reading the `reasoning.effort` of each model request:

| Model (listed efforts)                           | Given   | Sent                  |
| ------------------------------------------------ | ------- | --------------------- |
| gpt-5.5 (low to xhigh)                           | `xhigh` | `xhigh`               |
| gpt-5.5                                          | `max`   | `max`, unchanged      |
| gpt-5.5                                          | `ultra` | `xhigh`               |
| gpt-5.5                                          | `bogus` | `bogus`, unchanged    |
| gpt-5.5                                          | none    | `medium`, its default |
| gpt-6-luna (low to max)                          | `ultra` | `max`                 |
| a thread started with `high`, resumed with `max` | `max`   | `max`                 |
| a thread resumed with none, after `low`          | none    | none: the default     |

- No turn event and no thread field reported the effort.
- `model/list` without `includeHidden` listed 7 models, and with it 10 (0.153.4) or 11 (0.157.1), including `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` and `codex-auto-review`. With `limit: 2` it paged through `nextCursor`.
- `usage.byTask` returns totals per model, not records, so a record's `raw` cannot be read from it (`reads.ts`); hence E05.

## RED

- `tests/contract/codex-effort-0042.test.ts`, 5 of 5 failed:
  - E01: a malformed effort was not refused;
  - E02: no `CODEX_EFFORT_UNSUPPORTED`;
  - E03: `turn/start` had no `effort`;
  - E04: the records had no `_reasoningEffort`;
  - C02: Codex's own message.
- `tests/engine/reasoning-efforts-0042.test.ts`: `workflow.reasoningEfforts` was undefined.
- `python/tests/test_usage_by_task_0029.py`: no `reasoning_efforts`.
- `tests/engine/foundation.test.ts` AC11: the note was in Chinese.

## Changes

- `local.ts`: `effort` in the policy, checked as an open string; `resolveEffort`.
- `index.ts`:
  - the model list is read after the hook check and before the thread, hidden models and every page included;
  - the effort goes on `turn/start`;
  - `_reasoningEffort` goes in each usage record's `raw`, the missing-usage record included;
  - `CODEX_TOOL_BRIDGE_UNAVAILABLE`.
- Engine:
  - `usage.byTask` adds `reasoningEfforts`;
  - `workflow.reasoningEfforts`, online and read-only;
  - the English preview note.
- The schema, the generated types and views, and the Python field mapping.
- The Codex fixture gains `FIXTURE_MODELS`, `FIXTURE_MODELS_ERROR` and `FIXTURE_USAGE`.
- The native smoke: the effort case, and a search repeated until the tool is listed (C03).

## GREEN

- The new tests pass, 6 of 6 in Node, and the Python test passes.
- Native (0042-N01), local:
  - with the op agent project's Codex 0.157.1, every case passed;
  - `high` reached the request, and its record said `requested`;
  - `max` on gpt-5.5 was refused before any model request (`CODEX_EFFORT_UNSUPPORTED: gpt-5.5 supports low, medium, high, xhigh; max was requested`);
  - no effort sent `medium`, and its record said `modelDefault`;
  - the host MCP case passed.
- The same effort cases passed with Codex 0.158.0, which the standalone installer had placed in `~/.local/bin` on 2026-09-29, replacing 0.153.4. That version is newer than any CI pins.
- Other cases failed with 0.158.0, and this change does not explain them. The scripted gateway's patch and bridge calls got `unsupported custom tool call: apply_patch` and `unsupported call: work_read`. The likely cause is that 0.158.0 changed how these tools are offered, so the gateway's old call shapes no longer match. That is not verified, so these failures are recorded here, not fixed.
- A second 0.157.1 build, shipped inside a desktop application, lacked `codex-code-mode-host`. Its code-mode case failed because code mode could not start (`failed to spawn code-mode host`), not because a check was bypassed.

  0.153.4 is no longer installed on this Mac; CI runs it on macOS.

## Codex 0.158.0, after the release

The failures with 0.158.0 recorded above were the smokes', not the adapter's.

- 0.158.0 no longer lists `gpt-5.4`, the model the smokes asked for. Codex gives a model it does not list another tool set: without `apply_patch` and tool search, with the MCP tools offered directly, and only a `Model metadata for gpt-5.4 not found` warning. 0.157.1 lists `gpt-5.4` as hidden.
- With `gpt-5.5`, which both versions list, 0.158.0 offered the same tools as 0.157.1. The local-member, security, gateway (with its Python client) and stop smokes all passed on this Mac.
- The four smokes now ask for `gpt-5.5`. CI runs the local-member and security smokes with 0.158.0 as well, and the native job's limit goes from 35 to 45 minutes.

A host that names a model Codex does not list gets the reduced tools without an error. How the adapter should tell the host is left for a later change.
