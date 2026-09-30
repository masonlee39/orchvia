# TDD-0052: The storage check without a scan

Specification: [SPEC-0052](../specs/0052-storage-status-cost.md).

- Measurement before the change, on an Apple M-series laptop with Node 24.14: `storage.status()` ran 4 times per task; at 50,000 tasks it cost 12.6 ms per task against 2.7 ms at 1,000, almost all of it the JSON scan of every task (1.9 ms per call). With 10,000 and 50,000 artifact files one call took 27 ms and 136 ms, 108 ms and 543 ms per task, all of it the synchronous walk.
- P01, P02 RED: `tests/engine/storage-status-0052.test.ts` failed to load, since `storage.ts` exported no `ACTIVE_TASKS_SQL`. With the constants and stub methods in place, 3 of 5 failed:
  - a file put under the state directory behind the engine counted at once (`counted without a walk: the call walked the directory`);
  - no walk reached the artifacts directory (`no walk reached artifacts`);
  - `status()` prepared the count with `NOT IN`, the scan, instead of `ACTIVE_TASKS_SQL`.
  - An artifact the engine writes, and a symbolic link found by a walk, were already handled by the walk on every call: regression coverage.
  - GREEN: 5 of 5.
- Mutations, each restored from a copy: the walk's total without what was written while it ran fails "a write during a walk is not lost"; `Store.artifact` without reporting the artifact's size fails that test and "an artifact the engine writes counts at once".
- `0011-R08` (`tests/engine/storage-governance.test.ts`) counted a Codex helper link, and refused an unexpected link, at the next call. The Codex CLI, not the engine, writes those links, so they count after the next walk (invariant 3); the test now lets a minute pass and waits for the walk.
- P03 RED: the benchmark of `main` ignored `--artifacts 0,40 --readers 1` (one row, without `artifactFiles` or `readP95Ms`) and accepted `--readers 17`. `tests/contract/capacity-benchmark-0052.test.ts`: GREEN 2 of 2.
- Before and after, the same benchmark (`1000 100 --artifacts 0,10000,50000 --readers 2`), `main` at `4f532a2` against this change:

  | Artifact files | Dispatches/s | Admission p95 | Event loop p95 | Event loop max |
  | --- | --- | --- | --- | --- |
  | 0, before | 16.9 | 9.3 ms | 72 ms | 113 ms |
  | 0, after | 18.3 | 3.2 ms | 62 ms | 90 ms |
  | 10,000, before | 4.9 | 137 ms | 227 ms | 281 ms |
  | 10,000, after | 18.3 | 3.2 ms | 61 ms | 108 ms |
  | 50,000, before | 1.3 | 623 ms | 843 ms | 871 ms |
  | 50,000, after | 18.0 | 3.2 ms | 78 ms | 145 ms |

  The readers' `tasks.list`, `events.read` and `usage.byTask` stayed at or below 0.3 ms p95 in every row. The event loop's remaining delay of about 60 ms at the 95th percentile is present without any artifact file; the profile attributes the largest share to synchronous `fsync`, which this change does not touch.
