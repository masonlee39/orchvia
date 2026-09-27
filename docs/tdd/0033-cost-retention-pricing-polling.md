# TDD-0033: Cost queries, retention status, cache write prices and polling

Date: 2026-09-27. Base: `e21c1ac` (SPEC-0032 on `main`). Specification: [SPEC-0033](../specs/0033-cost-retention-pricing-polling.md).

## RED

The new tests ran on the base with only the tests added.

- `tests/engine/cost-queries.test.ts`: P01 failed, every query planned as `SCAN costs`. P02 and P03 compare with 0.1.8's functions and passed on the base as regression coverage.
- `tests/engine/retention-backlog.test.ts`: 5 of 5 failed. In S01 the new record was not collected in the next run; S02 failed on the missing column; S03 and S04 found no `retentionStatus` or `retention`.
- `python/tests/test_retention_0033.py`: failed; `retention` was a plain dictionary without snake-case names.
- `tests/engine/cache-write-pricing.test.ts`: 4 of 4 failed with `Unknown field: cacheWrite5m`.
- `tests/contract/sdk-poll-interval.test.ts`: 3 of 3 failed. An invalid interval was accepted and `pollIntervalMs` was undefined.
- `python/tests/test_views_0033.py`: 3 of 3 failed; there was no generator, no `views.py` and no annotated method. `mypy --strict` on `bad_usage.py` reported "no issues found": every result was `Any`.

## Changes

- **P.** Six indexes in `store.ts`; `cost-ledger.ts` reads through them with `costRows` and `heldReservations`, and `costSummary` walks the tree with a recursive query.
- **S.** The `collected` column and `retention_pending` index; `collect()` marks and skips collected records; `retentionStatus()` and `eventPrefix()`; `storage.status` adds `retention`; the Python names.
- **C.** `validatePricing` accepts the two rates; `priceUsage` prices each duration and names the missing rate; the schema's `Pricing` and the generated types.
- **T.** `ClientOptions.pollIntervalMs`, validated before an engine or socket opens, used by `events()` and `waitFor`.
- **Y.** The view generator, `views.py`, the annotations in `client.py`, the typed examples, `check-python-types.py`, the CI step and the `generate:protocol` and `check:generated` scripts.

Found on the way:

- **`ORDER BY rowid` on a partial index.** The first `heldReservations` ordered by `rowid`, and without table statistics SQLite then scanned `budget_reservations` instead of using `reservations_held`. The synthetic benchmark stayed linear, 13 ms at 50,000 records, until the rows were ordered in JavaScript.
- **Duration tokens.** The first `priceUsage` added `cacheWrite5m: null` and `cacheWrite1h: null` to every cost record's `tokens`, which changed `AC-C03/F10`'s expected shape. As usage records do (SPEC-0030), the fields now appear only for a record with the split.
- **Collection is time-bounded.** S01 and S02 first ran a fixed number of collections to set up; under the full parallel suite a 50 ms run handled fewer records and the setup did not finish. They now collect until done.
- **What the real host found (Y04).** `capabilities` held seven fields its schema does not name; capabilities grow by design, so only they may. Results of mutations held `method`, `scope`, `idempotency_key` and `retry_identity`, which the Python client adds to every receipt; they became the receipt views. The generator first imported `orchvia.types` through the package, whose client imports the views it writes, so it now loads `types.py` alone; and receipt views first came before their bases in the file.
- **P03's data.** The first data reached only two of the three decisions; the host budget now varies separately from the task budget.

## GREEN

Local, macOS arm64, Node 24.14.0:

- The new files: cost queries 4/4, retention 5/5, pricing 4/4, polling 3/3; Python retention 1/1.
- Stability: the four new TypeScript files passed 16 of 16 parallel runs.
- Mutations, each reverted after the run: no `collected` filter, no mark when a detail is collected, no five-minute rate, a generic unknown reason, a fixed 50 ms in `events()`, a fixed 50 ms in `wait()`, a root check that ignores the currency, and a root check that counts every root's held reservations. The tests killed 7 of 8 at first; the last one survived because the random data never turned a decision on another root's reservation, and a new P03 case now kills it.
- `npm test` 765 of 765; `npm run test:python` 106 of 106; `npm run check:generated`; `npm run test:packages` 9 of 9, the wheel with `views.py` and `py.typed`.
- `scripts/check-python-types.py` with mypy 2.3.1: the typed example passed, and `bad_usage.py` reported its three marked errors, two `assignment` and one `attr-defined`.
- Synthetic benchmark, a probe task without costs and N records of another task, median of 25 calls:

| Records | `costs.get` before | after | root budget check before | after |
|---:|---:|---:|---:|---:|
| 1,000 | 1.22 ms | 0.01 ms | 1.22 ms | 0.02 ms |
| 10,000 | 12.28 ms | 0.01 ms | 12.59 ms | 0.02 ms |
| 50,000 | 68.23 ms | 0.01 ms | 67.22 ms | 0.02 ms |

- The host-wide total through the covering index: 8.3 ms at 50,000 records and 36 ms at 200,000, against 45 ms and 225 ms reading every record.
- Collection with 200,000 collected records: one run 7.3 ms, and a new record collected in that run; `retentionStatus()` 0.1 ms.
