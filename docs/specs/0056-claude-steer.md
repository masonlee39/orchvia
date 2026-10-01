# SPEC-0056: Steering a Claude member

Date: 2026-10-01. Status: approved by the owner on 2026-10-01 (D-steer-2 option 1, D-steer-3 option 1, D-steer-4 option 1). Release: 0.1.30. Environments: every platform the contract CI runs, with an offline query; the native path is checked with the real Claude binary against a scripted loopback gateway. Evidence: [TDD-0056](../tdd/0056-claude-steer.md).

## Why

`sessions.steer` (SPEC-0048) reaches a Codex member only. A Claude member was refused with `UNSUPPORTED_CAPABILITY`, because nothing was known about what Claude Code does with a user message that arrives while a turn runs.

Measured offline with Claude Agent SDK 0.3.274 and 0.3.283, the real binary against a scripted loopback gateway:

- A user message with priority `next`, or none, that arrives while a tool runs is folded into the running turn with the next tool result; the turn's `result` lists its uuid in `user_message_uuids`, and there is one result.
- The same message, when the model writes its last answer and calls no further tool, waits in the CLI's queue and starts a second turn 5 to 10 ms after the first result, with a result of its own. That turn would run outside any dispatch.
- Priority `now` cuts a streaming answer short and always gives two results; `later` always waits for the turn's end.
- At the first result, `cancelAsyncMessage(uuid)` came too late in 20 of 20 runs. `interrupt({ cancelQueued: true })` stopped the queued turn before its model request in 40 of 40 runs; that turn then ended with `error_during_execution`.

## S. The steer

- **S01** The Claude adapter declares `steer: true`. `steer(target, text, steerId)` answers `accepted` when the dispatch's turn runs, `rejected` with `turnEnded` when it has ended or is unknown, and `rejected` with `notSteerable` for a compaction.
- **S02** An accepted steer is given to Claude Code, as a user message with priority `next` and the steer's id as its uuid, only while a tool call of the main loop has started and not returned. Otherwise the adapter holds it and gives it when the next such tool call starts.
- **S03** At the turn's `result`:
  - a steer whose uuid is in `user_message_uuids` was delivered;
  - a steer still held was not delivered, and nothing waits in Claude Code;
  - a steer given but not listed was not delivered: before the adapter reports the turn's end, it calls `interrupt({ cancelQueued: true })` and waits for the receipt, at most the cleanup time. When the receipt does not list the steer as cancelled, the queued turn had started: the adapter reads on to that turn's result, at most the cleanup time, and takes the session's totals from it.
- **S04** The adapter reports each steer's outcome once through `RuntimeInput.reportSteerOutcome({ steerId, delivered })`, before the turn's terminal event. For a steer that was not delivered the engine sets the steer's message to `expired` and writes the event `session.steer_undelivered` with `dispatchId`, `taskId` and `messageId`. A delivered steer changes nothing: its message is `completed` since the steer was accepted.

[SPEC-0058](0058-steer-outcomes-and-evidence-order.md) extends this: a delivered steer has its own record and event, and a steer whose outcome was never reported ends unknown.

A steer reaches Claude between tool calls only. A turn that calls no further tool cannot be steered; the host then sees `session.steer_undelivered` and can send the line as a new message or task.

## Timing invariants

1. The adapter never reports a turn's end while a steer it gave to Claude Code may still start a turn: it interrupts with `cancelQueued` and waits for the receipt, and for the started turn's result, each bounded by the cleanup time, first.
2. A steer is given to Claude Code only while a main-loop tool call is outstanding; a held steer is dropped at the result.
3. A steer's outcome is reported once, before the terminal event, and the engine applies an outcome that arrives before the steer's own answer is recorded once that answer is.

## Acceptance

| ID       | Criterion                                                                                                                                                                                 | Test                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0056-S01 | The capability; accepted while the turn runs; refused after it, for an unknown dispatch and for a compaction                                                                              | `tests/contract/claude-steer-0056.test.ts` |
| 0056-S02 | A steer is given with priority `next` and its id while a tool call is outstanding, and held until one starts otherwise                                                                    | same                                       |
| 0056-S03 | Delivered when the result lists it; a held one is never given; a given one that is not listed is cancelled by an interrupt before the terminal, and a started turn's result is read first | same                                       |
| 0056-S04 | Outcomes are reported once, before the terminal; the engine expires the message and writes `session.steer_undelivered`                                                                    | same, `tests/engine/steer-0048.test.ts`    |
| 0056-N01 | [Native] The real binary with a scripted gateway: delivered during a tool; not delivered during a last answer, with no second model request                                               | `scripts/native-claude-steer-smoke.mjs`    |

## Rollback

Reverting removes the capability; a Claude member is refused again. Messages marked `expired` and the events stay as written.
