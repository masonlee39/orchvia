# SPEC-0058: Every steer's outcome, and evidence before its terminal

Date: 2026-10-01. Status: approved by the owner on 2026-10-01 (D-ev-1 option 1, D-steer-5 option 1, D-steer-6 option 1). Release: the next one; it is not released on its own. Environments: every platform the contract CI runs. Evidence: [TDD-0058](../tdd/0058-steer-outcomes-and-evidence-order.md). Corrects [SPEC-0056](0056-claude-steer.md) S04 and [SPEC-0057](0057-async-artifact-writes.md) W03.

## Why

A host that upgraded to 0.1.30 reported three things.

1. A dispatch's `lastEvidence`, which `scheduler.get` shows for each occupant, had changed. A runtime that reports evidence and then ends its turn left `terminal_error` or `terminal_result` before; with SPEC-0057 it left `runtime_terminal`, because the evidence waited for its file while the engine recorded the terminal at once. The engine decides nothing from this field, but SPEC-0057 said that the order of what is written does not change.
2. A steer to a Claude member whose outcome arrives when the engine has closed keeps the status `completed`, with no event.
3. So does one whose host crashed before the adapter could report.

The second and third have one cause: SPEC-0056 recorded only that a steer was not delivered. A delivered steer left no record, so a lost outcome and a delivery looked the same.

## E. Evidence order

- **E01** When a turn's terminal event arrives, the engine first waits until every evidence report queued before it has been applied, and then records the terminal. A dispatch whose runtime reported evidence and then ended keeps `terminal_<type>` as its `lastEvidence`, as before 0.1.30. The wait is the one SPEC-0057 W04 describes: it counts against no deadline, and a close waits for it.

## D. A steer's outcome

- **D01** A runtime that learns only later whether its turn takes a steer answers `{ status: 'accepted', outcomePending: true }`. The Claude adapter does. The engine then records the steer's message with `steerDelivery: 'pending'`; its status is `completed`, as before. A steer accepted without `outcomePending`, as Codex's, has no `steerDelivery`: its acceptance is its delivery.
- **D02** `reportSteerOutcome({ steerId, delivered })` settles a pending steer once; later reports for it change nothing.
  - Delivered: `steerDelivery` becomes `delivered`, and the event `session.steer_delivered` carries `dispatchId`, `taskId` and `messageId`.
  - Not delivered: the status becomes `expired`, `steerDelivery` becomes `not_taken`, and the event `session.steer_undelivered` carries `dispatchId`, `taskId`, `messageId` and `reason: 'not_taken'`.
- **D03** When a turn's runtime has finished, each of its steers that is still pending becomes unknown: the status `expired`, `steerDelivery: 'unknown'`, and `session.steer_undelivered` with `reason: 'unknown'`. A steer whose answer the engine records after that becomes unknown at once. The Claude adapter reports a steer that it still held, and never gave to Claude Code, as not delivered; for one that it had given when the turn ended without a result it reports nothing, since nothing says whether the model read it.
- **D04** At a start, each steer that is still pending becomes unknown in the same way. This covers a host that crashed, and a close that ended before the turn did.
- **D05** A runtime written for SPEC-0056, which answers without `outcomePending` and reports only steers that were not delivered, behaves as it did, except that its event carries `reason: 'not_taken'`.

A steer with the reason `unknown` may have reached the model. A host that sends the line again may repeat it.

## O. Order of events

- **O01** A steer's outcome event precedes every event of its task that is written after the turn's runtime finished: the task's change of status, a verification, the lease's release. The engine settles the pending steers in a transaction of its own before it handles the turn's end. A cancel or a pause changes the task only once the turn has ended, so the same holds after them. At a start, the outcomes of D04 are written before recovery rewrites any task.

A host should read each steer's own event. The order is a further guarantee, not the way to learn an outcome.

## Timing invariants

1. Evidence and terminals take effect in the order in which the runtime reported and yielded them.
2. After the turn's runtime has finished, none of its steers is pending; after a start, no steer is.
3. A steer is settled once: one of `session.steer_delivered` and `session.steer_undelivered`, never both and never twice.
4. An outcome reported before the steer's own answer is recorded applies when the answer is (SPEC-0056 invariant 3), for both outcomes.

## Compatibility

Additions only: the message field `steerDelivery`, the event `session.steer_delivered`, the field `reason` in `session.steer_undelivered`, and `outcomePending` in a runtime's answer. No status value is new. A store written by this version opens in 0.1.30, which ignores the field; a steer left pending there stays `completed`.

## Acceptance

| Id       | Criterion                                                                                                                           | Test                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0058-E01 | A dispatch whose runtime reported evidence and ended with an error or a result keeps `terminal_error` or `terminal_result`          | `tests/engine/async-artifacts-0057.test.ts`                                   |
| 0058-D01 | A steer accepted with `outcomePending` is `completed` and `pending`                                                                 | `tests/engine/steer-0048.test.ts`, `tests/contract/claude-steer-0056.test.ts` |
| 0058-D02 | Each outcome is recorded once, with its event and its reason                                                                        | `tests/engine/steer-0048.test.ts`                                             |
| 0058-D03 | A turn that ends leaves its pending steers unknown; the adapter reports a held steer and not a given one                            | same, `tests/contract/claude-steer-0056.test.ts`                              |
| 0058-D04 | A start leaves pending steers unknown                                                                                               | `tests/engine/steer-0048.test.ts`                                             |
| 0058-D05 | A steer accepted without `outcomePending` has no delivery field and no delivery event                                               | same                                                                          |
| 0058-O01 | The outcome precedes the task's next event: at the turn's end, before a verification, after a cancel, after a pause, and at a start | same                                                                          |

## Rollback

Reverting the commit restores 0.1.30's behavior. Messages keep a `steerDelivery` that 0.1.30 ignores.
