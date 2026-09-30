# SPEC-0055: Every mutation wakes the scheduler

Date: 2026-10-01. Status: approved by the owner on 2026-10-01 (D-kick-1 option 1, D-kick-2 option 1). Release: 0.1.29, with SPEC-0054. Environments: every platform the contract CI runs. Evidence: [TDD-0055](../tdd/0055-mutations-wake-the-scheduler.md).

## Why

An integrating host cancelled a task that did not run: a task that verification had blocked, which held its session. The task became `cancelled` and its session `idle`, but the task queued behind it on that session stayed `queued`. `tasks.cancel`, unlike `tasks.resume`, did not wake the scheduler when it changed a task that did not run, so nothing looked at the queue until another call happened to. A task that depended on the cancelled one stayed `waiting_dependency` the same way. The host worked around it by calling `tasks.resume` on the queued task, a no-op that wakes the scheduler.

Thirteen places woke the scheduler, each added where its need was found. Other mutations change what the scheduler decides too: `storage.configure` and `storage.gc` can lift backpressure, `handoffs.resolve` can end a request that held work.

## C. The scheduler after a mutation

- **C01** After every mutation (the methods of `MUTATIONS`), whether it succeeded or failed, the engine asks the scheduler for one pass. The pass runs in a microtask after the call's transactions have committed, reads the committed state, and does nothing when nothing changed; passes asked for before one runs are one pass.

## Timing invariants

1. The pass that a mutation asks for runs after the mutation's commit, never inside its transaction.
2. A closing or closed engine runs no pass (unchanged: `kick()` returns).

## Cost

The capacity benchmark (`1000,10000 100 --readers 2`) before and after, one run each: 18.6 and 18.7 dispatches per second before, 18.4 and 17.8 after; admission's 95th percentile 3.39 and 3.36 ms before, 4.51 and 3.57 ms after. The event loop's 95th percentile varied more between runs (65 and 61 ms before, 62 and 88 ms after) than between the two builds in the first row.

## Acceptance

| ID       | Criterion                                                                                                                             | Test                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 0055-C01 | Cancelling a task that does not run lets the task queued behind it on its session run, and fails its dependants, without another call | `tests/engine/queue-reasons.test.ts` |

## Rollback

Reverting restores the thirteen places; nothing is stored.
