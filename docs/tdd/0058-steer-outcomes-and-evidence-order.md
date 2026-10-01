# TDD-0058: Every steer's outcome, and evidence before its terminal

Specification: [SPEC-0058](../specs/0058-steer-outcomes-and-evidence-order.md).

- Reproduction of the report, one script against two checkouts: at `v0.1.29` a dispatch whose runtime reported `runtime_terminal` evidence and then ended kept `terminal_error` or `terminal_result`; at `v0.1.30` it kept `runtime_terminal` in both cases.
- RED, 7 of 8 new tests failed: both E01 tests on the `lastEvidence` value; D01 and D02 for the missing `steerDelivery` and events; both D03 tests, where a steer whose turn ended stayed `completed`; D04. D05, which describes what a steer without `outcomePending` already did, passed.
- GREEN: the terminal waits for the queued evidence before it is recorded; a pending marker on the message, `settleSteer`, the turn-end settlement and the one at a start. D04's test starts a second engine on a copy of the state directory taken while the turn runs, which is what a crash leaves.
- The Claude adapter: its answer carries `outcomePending`, and at a turn that ends without a result it reports the steers it still held and not those it had given. With the earlier reporting restored, the new adapter test fails.
- O01, measured before it was written down: after `tasks.cancel`, and after `sessions.control` with a draining or an interrupting pause, no event of the task is written while the turn runs; `session.pausing` is a session's event. Once the turn ends, `session.steer_undelivered` comes first, then `task.cancelled`, `task.waiting_approval` or `task.paused`, then `execution.released`. Five tests hold that order: the turn's end, a checked task's `task.verifying`, a cancel, both pauses, and a start.
- Mutations, each restored from a copy: settling at a start after recovery rewrote the tasks fails D04; settling at a turn's end after the task entered verification fails the checked task's O01 test, which was added because the first run of this mutation passed.
- SPEC-0057's three tests of a deadline, a close and a cancel during the file writes hold their gate at the first write, which is now the evidence before the terminal: they cover the wait's new place, and pass.
