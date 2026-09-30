# SPEC-0053: Progress of a running turn

Date: 2026-09-30. Status: approved by the owner on 2026-09-30 (D-prog-1 to D-prog-3 option 1; after the integrating host's review, D-prog-4 to D-prog-6 option 1). Release: 0.1.28. Environments: every platform the contract CI runs; the Claude and Codex paths are checked with offline fixtures, not real models. Evidence: [TDD-0053](../tdd/0053-dispatch-progress.md).

## Why

An integrating host asked to show what a running turn does. Between `dispatch.started` and the task's end it sees nothing: not the tool a turn runs, not what the model writes, and not that the runtime cannot reach the model and is retrying.

The request, as the integrating host put it: show a turn's tool calls, its text and its retries on the task's card. After reviewing this design it added that events be filtered by type in the engine, that a tool's end and a thinking model be shown, and asked whether secrets are masked (F, E05 to E07).

A runtime reports what it does through `RuntimeEvent`s, but the engine takes every event other than `usage` and `accepted` as the end of the turn (`consume` in `packages/engine/src/index.ts`). A new kind of event from an adapter would end the turn in an engine that does not know it. Progress therefore goes through a callback, as execution evidence does.

## A. The callback

- **A01** `RuntimeInput.reportProgress?: (progress: RuntimeProgress) => void`, which the engine passes and an adapter calls only when it is there. `RuntimeProgress` is one of:
  - `{ kind: 'tool_started', tool, command?, paths?, server? }`: a tool call started; `command` for a shell command, `paths` for the files it names, `server` for an MCP tool;
  - `{ kind: 'tool_finished', tool, ok, durationMs, exitCode }`: a tool call ended, and whether it succeeded;
  - `{ kind: 'assistant_text', text }`: text the model wrote, never its thinking;
  - `{ kind: 'thinking' }`: the model thinks; nothing of what it thinks is reported;
  - `{ kind: 'api_retry', attempt, maxRetries, delayMs, status, message }`: a request to the model failed and the runtime will try again; each field may be null.
- **A02** The callback never throws, returns nothing, and changes nothing but the events it writes.

## E. The event

- **E01** The engine writes each progress as the event `dispatch.progress`, with the task and session in its envelope and `DispatchProgressData` as its data: `dispatchId`, `kind`, and by kind:
  - `tool_started`: `tool` (at most 128 characters), `command` (its first 200 characters), `paths` (at most 20, each relative to the workspace when inside it, at most 512 characters), `server` (at most 128 characters); an MCP tool's arguments are left out;
  - `assistant_text`: `text`, the last 280 characters written since the previous text event;
  - `api_retry`: `attempt`, `maxRetries`, `delayMs`, `status` (integers or null) and `message` (its first 300 characters, or null);
  - `tool_finished`: `tool`, `ok`, `durationMs` (the runtime's, or the adapter's time from the start) and `exitCode` (a command's, or null);
  - `thinking`: nothing more;
  - `limit_reached`: `limit`, written once when the dispatch's progress reaches it;
  - `dropped`, when progress was dropped since the previous event because it was malformed.
- **E02** Limits for each dispatch: at most one `assistant_text` event every 5 seconds, by the engine's monotonic clock, and text in between is kept for the next one; at most one `thinking` every 30 seconds; at most 1,000 progress events, then one `limit_reached` and nothing more. Tool starts and ends and retries are not throttled.
- **E07** Before it writes a command or text, the engine masks what looks like a secret with `***`: the value after a name containing `token`, `secret`, `password`, `passwd`, `api_key`, `access_key`, `private_key` or `credential` (`NAME=value`, `name: value`, `--name value`), a `Bearer` or `Basic` credential, and keys shaped like `sk-…`, `ghp_…` and the other GitHub tokens, `xox…-` and `AKIA…`. It is a best effort, not a guarantee. A runtime approval's command is not masked: the person who decides must see it.
- **E03** The Claude adapter reports its main loop's `tool_result` blocks as `tool_finished` (`ok` unless `is_error`, `durationMs` from the call's start, `exitCode` null), a thinking block's start in a partial message and a whole message's thinking block as `thinking`, and its main loop's `tool_use` blocks (`Bash`'s `command`; `file_path`, `path` and `notebook_path` as `paths`; `mcp__<server>__<tool>` as `server` and `tool`), text blocks, and `system` messages of subtype `api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, the error).
- **E04** The Codex adapter reports `item/completed` of an item it saw start as `tool_finished` (`ok` when its status is `completed`, its `durationMs` and `exitCode` when Codex gives them), a `reasoning` item's start and reasoning deltas as `thinking`, and `item/started` of a command (`command`), a file change (its changes' paths), an MCP tool call (`server`, `tool`) and any other item (its type as `tool`), `item/agentMessage/delta`, and an `error` notification with `willRetry: true`: `status` from the error's `httpStatusCode` when it has one, `attempt` and `maxRetries` from a message such as `Reconnecting... 2/5` when it has them, `delayMs` null, since Codex does not say.

## F. Reading events by type

The integrating host pages through a task's events in four places, each with a bound; a turn's progress would push the events it looks for past those bounds.

- **F01** `events.read` takes `types` (1 to 50 event types: only these) or `excludeTypes` (0 to 50: all but these), not both. With neither, `dispatch.progress` is left out, so a reader that does not ask for progress pages as it did before 0.1.28; `excludeTypes: []` reads every event. A read-only store filters alike.
- **F02** A filtered read scans at most 5,000 events. Its cursor moves past every event it scanned, those left out included, so the next read does not scan them again.
- **F03** The TypeScript `events()` and `events.read()` take `types` and `excludeTypes`; the Python `events()` takes `types` and `exclude_types`.

## Timing invariants

1. A progress event is written in a transaction of its own, never with the state of a task, session or dispatch, and does not change deadlines, stop proof, usage or costs.
2. The engine writes progress only while the dispatch's flight is live; what arrives after the turn ended is dropped.
3. The limits are kept in memory for each flight; a restart starts them again.
4. A filtered read's cursor only moves forward, and never past an event the reader asked for that it did not return.

## Acceptance

| ID       | Criterion                                                                                                                                                             | Test                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0053-E01 | A tool start, text and a retry are written as `dispatch.progress` with their bounds, validated against `DispatchProgressData`; a malformed one is dropped and counted | `tests/engine/progress-0053.test.ts`            |
| 0053-E02 | Text is throttled by the monotonic clock and kept; the 1,001st progress writes `limit_reached` once                                                                   | same                                            |
| 0053-E05 | A finished tool is written with its outcome, time and exit code; a malformed one is dropped                                                                           | same                                            |
| 0053-E06 | Thinking is written without content, at most every 30 seconds                                                                                                         | same                                            |
| 0053-E07 | Secrets in a command and in text are masked                                                                                                                           | same                                            |
| 0053-F01 | Progress is left out by default, read when asked for, and filtered with a task; invalid filters are refused                                                           | `tests/engine/events-filter-0053.test.ts`       |
| 0053-F02 | A read scans at most 5,000 events and moves its cursor past them                                                                                                      | same                                            |
| 0053-F03 | Both SDKs pass the filter, and a read-only store filters alike                                                                                                        | same, `python/tests/test_events_filter_0053.py` |
| 0053-A02 | Progress after the turn ended is not written; a malformed progress does not throw                                                                                     | same                                            |
| 0053-E03 | The Claude adapter reports tool starts, text and retries of its main loop, and nothing without the callback                                                           | `tests/contract/claude-progress-0053.test.ts`   |
| 0053-E04 | The Codex adapter reports item starts, message deltas and retrying errors                                                                                             | `tests/contract/codex-progress-0053.test.ts`    |

## Rollback

Reverting removes the events; stores keep the `dispatch.progress` events already written, which older engines read as any other event.
