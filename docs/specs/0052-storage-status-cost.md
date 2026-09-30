# SPEC-0052: The storage check without a scan

Date: 2026-09-30. Status: approved by the owner on 2026-09-30 (D-perf-1 option 1, D-perf-2 option 1, D-perf-3 option 1). Release: 0.1.27. Environments: every platform the contract CI runs; no network. Evidence: [TDD-0052](../tdd/0052-storage-status-cost.md).

## Why

`StorageGovernance.status()` decides backpressure. The engine calls it four times for each task: admission, settlement and two scheduler checks. Each call walked the whole state directory synchronously (`readdirSync` and `lstatSync` of every file) and counted active tasks by parsing the JSON of every task row. Each task's result is its own artifact file, kept for at least `detailDays` (90 by default), so the walk grows with the history. Measured on one machine:

| State | One call | Per task |
| --- | --- | --- |
| 1,000 artifact files | 2.4 ms | 9.7 ms |
| 10,000 artifact files | 27 ms | 108 ms |
| 50,000 artifact files | 136 ms | 543 ms |
| 50,000 tasks, few files | 2.0 ms (1.9 ms the task scan) | 12.6 ms |

The event loop is blocked for that time: deadlines, timers and every connection wait. The capacity benchmark did not show it, because every fixture result was the same text and so one file.

## P. The check

- **P01** `status().bytes` is the size of the SQLite files (`store.sqlite`, its `-wal` and `-shm`, `owner.sqlite`), read on each call, and a kept total of every other file under the state directory:
  - the engine adds the size of each file it writes there (an artifact and its commit journal) to the total before the transaction that records it commits;
  - the total is measured by walking the directory: once when the engine opens the store, and in the background with asynchronous file calls after each collection and when the last walk is older than 60 seconds, which a call to `status()` notices;
  - a walk that ends sets the total to what it found plus what the engine wrote while it ran;
  - the walk checks for symbolic links as the old check did; once it has found one, `status()` fails with `UNTRUSTED_PATH` until a walk finds none.
- **P02** Active tasks are counted with the index `tasks_status`, as the tasks whose status is one of the statuses that are not terminal, `ACTIVE_TASK_STATUSES`. The terminal statuses and these are together the `TaskStatus` of the schema.
- **P03** `scripts/capacity-benchmark.ts` measures mixed load: `--artifacts` artifact files already in the store, a different result for each dispatch, and `--readers` clients that read `tasks.list`, `events.read` and `usage.byTask` while tasks run. It reports each method's 95th percentile and the event loop's longest delay. `docs/status.md` records the numbers before and after.

## Timing invariants

1. The size of a file the engine writes is in the total before the transaction that refers to it commits, so the next admission sees it.
2. A walk never lowers the total below the files it found plus what the engine wrote while it ran: the total may count a file twice until the next walk, never miss one.
3. A file that something other than the engine puts under the state directory, and a symbolic link, count at most 60 seconds after the next call to `status()`, or at the next collection.

## Not changed

Collection's `isProtected` query per event, and the retention part of the `storage.status` method, run only for maintenance and stay as they are. The paid benchmark on a real repository waits for a budget (D-perf-3).

## Acceptance

| ID | Criterion | Test |
| --- | --- | --- |
| 0052-P01 | A file put under the state directory behind the engine is not counted until a walk, and is after one; an artifact the engine writes is counted at once; a write during a walk is not lost; a symbolic link is refused after a walk | `tests/engine/storage-status-0052.test.ts` |
| 0052-P02 | The indexed count equals the scan for every status; the statuses are the schema's; the query uses `tasks_status` | same |
| 0052-P03 | The benchmark's new options run and report their fields | `tests/contract/capacity-benchmark-0052.test.ts` |

## Rollback

Reverting restores the walk and the scan; no stored data changes.
