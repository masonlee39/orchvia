# SPEC-0033: Cost queries, retention status, cache write prices and polling

Date: 2026-09-27. Status: P, S, C and T approved by the owner on 2026-09-27, with the recommended options (D-43-1, D-44-1 and D-46-1 option 1); Y approved the same day with D-47-1, D-47-2 and D-47-3 option 1. Release: 0.1.9. Issues: [#43](https://github.com/masonlee39/orchvia/issues/43) to [#47](https://github.com/masonlee39/orchvia/issues/47). Evidence: [TDD-0033](../tdd/0033-cost-retention-pricing-polling.md).

## P. Cost queries and budget checks read only their rows (#43)

`costs.get`, the budget checks of task admission and settlement read the whole `costs` table, and the budget checks every `budget_reservations` row, so their time grew with the host's history. Retention does not collect `costs`.

- **P01** Writable opens create expression indexes: `costs_owner` (`costOwnerTaskId`), `costs_root` (`rootTaskId`), `costs_dispatch` (`dispatchId`), the partial `costs_overhead` (`category='host_overhead'`), the covering `costs_currency_units` (`currency`, `amountUnits`), and the partial `reservations_held` (`rootTaskId` where `status='held'`). A read-only open creates none; its queries return the same results more slowly.
- **P02** `costs.get` reads a task's records through `costs_owner`. The `tree` scope finds a task's tree at any depth with a recursive query through `tasks_parent`; `tasks.create` does not bound the depth, so the 32-level `subtreeTasks` is not used. `host_overhead` reads through `costs_overhead`. Held reservations are read through `reservations_held` and ordered by creation in JavaScript: `ORDER BY rowid` makes SQLite scan the table.
- **P03** A root budget check reads through `costs_root`, a child's direct budget through `costs_owner`, settlement through `costs_dispatch`. The host budget sums `amountUnits` from `costs_currency_units` without parsing a record. Amounts are integers of 10^-18 that exceed SQLite's integers, so sums stay in JavaScript `BigInt`. `host_overhead` records still count toward the host budget. No running total is kept (D-43-1).
- **P04** Results are those of 0.1.8: amounts, `unknownRecords`, record order, the 500 and 100 truncation limits and `settlementIncomplete`.

## S. Retention backlog and what stops it (#44)

- **S01** `retention_records` gains `collected INTEGER NOT NULL DEFAULT 0` and the partial index `retention_pending` (`table_name`, `terminal_at` where `collected=0`). Collection sets `collected` in the transaction that collects a record's detail, and excludes collected records from its candidates. Before, a collected record kept its `terminal_at` and was scanned again on every pass: once everything was collected each run collected nothing, and a newly collectable record waited until the scan had passed every older one.
- **S02** A record collected before 0.1.9 is marked the first time a run meets it; there is no migration scan.
- **S03** `StorageGovernance.retentionStatus()` returns:
  - `eventsPastAge` and `eventsPastAgeCapped`: events older than `eventDays` among the oldest 10,001, at most 10,000;
  - `detailPending` and `detailPendingCapped`: records old enough for detail collection and not collected, at most 10,000;
  - `oldestCollectableAt`: the oldest of both, or null;
  - `eventPrefix`: from the oldest 500 events, the event at which the next collection of events stops, with `reason` `age`, `task` (with `taskId`), `operation` (with `operationId`) or `snapshot_lease`; `scan_limit` with the 500th event's cursor when all 500 can go; null without events. It applies the predicates of `collect()`.
- **S04** `storage.status` returns it as `retention`. The scheduler's own storage check, which runs on every scheduling pass, does not compute it. Python names the fields in snake case.
- Collection is not made faster (issue scope). With 200,000 collected records, one run took 7.3 ms and collected a new record at once.

## C. Cache write prices by duration (#45)

- **C01** `perMillion` accepts `cacheWrite5m` and `cacheWrite1h`, validated as the other rates; the schema's `Pricing` has both.
- **C02** A record with `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens` prices each at `cacheWrite5m` or `cacheWrite1h`, else at `cacheWrite`. Its cost record's `tokens` then holds `cacheWrite5m` and `cacheWrite1h`; a record without the split has neither, as before.
- **C03** A record without the split, such as one from before 0.1.7, another runtime, or outside the main loop (SPEC-0031), takes `cacheWrite`. When a cache write needs a rate that is not set while some cache write rate is, the cost is unknown with the reason `cache_write_rate_missing`.
- **C04** In `total` input mode, cache writes leave ordinary input once any cache write rate is set. With none set, pricing is unchanged: in `total` mode every input token is ordinary.

## T. The TypeScript client's polling interval (#46)

- **T01** `connectOrchestrator({..., pollIntervalMs})` and `createOrchestrator(config, { pollIntervalMs })` take an integer from 1 to 60000 milliseconds, 50 by default, as Python's `poll_interval` of 0.05 seconds. Any other value is refused with `INVALID_PARAMS` before an engine starts or a socket opens. `orch.pollIntervalMs` reports it.
- **T02** `events()` waits the interval after an empty page.
- **T03** A task's or operation's `wait()` waits the interval between reads, or the time left.
- No back-off and no shared reads between subscriptions (D-46-1).

## Y. Typed return values in the Python SDK (#47)

Thirty-five methods returned `Snapshot`, a read-only mapping whose attributes are `Any`. The generated `wire_types.py` use the wire's camelCase names, while a `Snapshot` renames known envelope fields and converts only listed nested objects, so they could not type the results.

- **Y01** `scripts/generate-python-views.py` writes `python/src/orchvia/views.py` from the schema: one read-only `Protocol` per result definition and per converted nested object (D-47-1). It names fields and converts nested objects with `orchvia.types`' own maps, loaded without the package, plus the two `totals` that `usage.summary` and `usage.by_task` convert themselves. A field outside `orchvia.types`' conversion is `Mapping[str, Any]`. The file records the schema's SHA-256, `FIELDS` (each view's fields and whether they are required), `NESTED` and `OPEN` (views whose schema allows other fields). `npm run generate:protocol` regenerates it and `npm run check:generated` checks it.
- **Y02** Twenty-five methods return a view through `typing.cast`, and the handles that `tasks.create` and other mutations return are typed by their receipt views; nothing changes at run time. Mutations return receipt views, `TaskReceiptView`, `SessionReceiptView`, `MessageReceiptView` and `OperationReceiptView`, with the receipt fields that `_mutate` adds: `method`, `scope`, `idempotency_key` and `retry_identity`. `TaskHandle` and `OperationHandle` take their receipt view as a base only for type checkers, since a `Protocol` base at run time would hide a `Snapshot`'s fields. `orch.info` is an `InitializeResultView`.
- **Y03** Methods whose results the schema does not define keep `Snapshot` (D-47-3): `costs.get`, `costs.record_overhead`, `context.estimate`, `context.check_refs` (the schema defines its parameters only), `capabilities`, `storage.*`, `stores.*`, `archives.*` and `usage.get`.
- **Y04** Results of a real host hold the fields their views name, and every required one; only `capabilities`, which grows by design, may hold others.
- **Y05** CI installs mypy 2.3.1 only for this check (D-47-2). `scripts/check-python-types.py` requires `mypy --strict` to accept `python/tests/typing/good_usage.py` and to report exactly the error codes marked on the lines of `bad_usage.py`.

## Acceptance

| ID | Criterion | Evidence |
|---|---|---|
| 0033-P01 | Each cost and reservation query uses its index | `tests/engine/cost-queries.test.ts` |
| 0033-P02 | `costs.get` has 0.1.8's results in every scope, on data with a 40-level chain, three currencies and unknown amounts | same |
| 0033-P03 | Budget checks have 0.1.8's decisions, every decision reached | same |
| 0033-S01 | A collected record is not scanned again; a new one is collected in the next run | `tests/engine/retention-backlog.test.ts` |
| 0033-S02 | Records collected before 0.1.9 are marked | same |
| 0033-S03 | The retention status counts, caps and names what stops the events | same |
| 0033-S04 | `storage.status` carries it; the scheduler's check does not | same; `python/tests/test_retention_0033.py` |
| 0033-C01 to C04 | Pricing by duration, fallback and unknown | `tests/engine/cache-write-pricing.test.ts` |
| 0033-T01 to T03 | The interval's validation, `events()` and `wait()` | `tests/contract/sdk-poll-interval.test.ts` |
| 0033-Y01 | `views.py` is what the generator writes from the current schema | `python/tests/test_views_0033.py` |
| 0033-Y02 | Methods name their views | same |
| 0033-Y04 | A real host's results match their views, receipts included | same |
| 0033-Y05 | mypy accepts the typed example and reports each marked mistake | `scripts/check-python-types.py` in CI |
