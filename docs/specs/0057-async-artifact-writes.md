# SPEC-0057: Artifact files written off the event loop

Date: 2026-10-01. Status: approved by the owner on 2026-10-01 (D-fsync-1 option 1, D-fsync-2 option 1). Release: 0.1.30. Environments: every platform the contract CI runs. Evidence: [TDD-0057](../tdd/0057-async-artifact-writes.md).

## Why

Measured with the fake runtime, a task took 56.5 ms and the event loop's 95th percentile delay was 62.5 ms. SQLite's seven commits took 2.2 ms of it. The rest was three artifacts, each written synchronously inside a transaction: the turn's terminal evidence, its result, and the evidence of its lease's release. An artifact is a journal file and a content file, each written, synced and renamed, with its directory synced: four `fsync` calls, about 16 ms, during which nothing else runs.

## W. Writing before registering

- **W01** `Store.prepareArtifact(text)` writes an artifact's journal and its content file as `Store.artifact(text)` does, in the same order and with the same syncs, through asynchronous file calls. `Store.artifact(text)`, inside a transaction, registers an artifact that was prepared in this process without touching the disk; for any other text it writes as before. A prepared artifact that is never registered is what an interrupted write left before: its journal and file exist, and the next start keeps it as a recovered orphan.
- **W02** The engine prepares, outside any transaction, the three artifacts of a turn's end:
  - the result, after the turn's terminal event and before the transaction that settles the task;
  - the release evidence, whose text it predicts from the dispatch and the time it gives that transaction; when the dispatch changed meanwhile, the prediction misses and the transaction writes as before;
  - the terminal evidence, see W03.
- **W03** Execution evidence that a runtime reports while its turn runs, before the terminal handling has begun, is applied in the order it was reported, each after its artifact is prepared; the terminal handling waits for it. Evidence that arrives later, or for a flight that has ended, is applied at once, as before, so that a close, a reconciliation or a rollover right after it sees it.
- **W04** While a turn's end only waits for its files, a close does not report `SHUTDOWN_INCOMPLETE` for it, and no deadline of the flight expires; the time spent so counts against no deadline. Those writes used to block the event loop, where neither could happen. `close()` waits for the writes in progress before it closes the store.

Preparing is an optimization only: every path is correct when a prepare fails or was skipped, since `artifact()` then writes.

## Timing invariants

1. One dispatch's evidence takes effect in the order it was reported, and the turn's terminal handling waits until every evidence reported before the terminal event has taken effect before it reads the stop proof.
2. After each wait in the terminal handling, the engine checks its deadlines and that the flight is still live before it commits, as it does after verification.
3. A file is on disk, synced, before the transaction that registers it commits (unchanged).
4. A lease's release and its evidence record commit in one transaction (unchanged).
5. A transaction given its time before it begins writes that one time everywhere, as a transaction that reads the clock itself does (SPEC-0030 B01).
6. The time a turn's end waits for its files counts against no deadline, and a close does not time that wait out.

A turn now settles some milliseconds after its runtime's last event, once its files are on disk, instead of within the same turn of the event loop. A caller that read the engine a few ticks after that event must wait for the task's state instead. Tests wait with `artifactWritesSettled()` from `packages/engine/src/store.ts`.

## Acceptance

| ID | Criterion | Test |
| --- | --- | --- |
| 0057-W01 | A prepared artifact registers without a write; another text writes; a prepared one that was not registered is a recovered orphan at the next start | `tests/engine/async-artifacts-0057.test.ts` |
| 0057-W02 | A task's end writes no file inside a transaction | same |
| 0057-W03 | Evidence takes effect in order, and the terminal waits for it | same |
| 0057-T01 | While the files are written: a deadline does not expire the turn, a close waits and keeps the result, and a cancel settles as a cancel during verification does | same |

## Rollback

Reverting restores synchronous writes; files and records are the same either way.
