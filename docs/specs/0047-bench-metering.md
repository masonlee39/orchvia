# SPEC-0047: The benchmark counts every arm the same way

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-bench-1 option 1). Release: 0.1.23. Environments: the benchmark harness; the packages are unchanged. Evidence: [TDD-0047](../tdd/0047-bench-metering.md).

## Why

A paid run of the benchmark would compare arms counted differently:

1. The single and fresh arms count only the main loop (`result.usage`); the orchvia arm adds every usage record of the engine, including the calls outside the main loop that Claude Code makes by itself, such as subagents and compactions (SPEC-0031). The orchvia arm looks more expensive for that alone.
2. Every model is priced as Claude Sonnet 5, so a subagent of another model is priced wrongly.
3. Every cache write is priced at the 5-minute rate, although the engine records the 1-hour ones apart since SPEC-0030.
4. A missing count is added as 0, so an unknown cost reads as none.

## M. Metering

- **M01** `bench/meter.mjs` meters one request of every arm into `{ main, outside, total }`, each part `{ model, input, output, cacheRead, cacheWrite, cacheWrite5m?, cacheWrite1h? }`, a count null when unknown:
  - the direct arms: `main` from the result's `usage`, with its 5-minute and 1-hour split when the two add up; `outside` from the result's `modelUsage`, per model, minus the main loop for the main model, and, when the session was resumed, minus its totals after the previous request if Claude Code continued them. It decides that from the bundled Claude Code's version with the Claude adapter's rule (2.1.277 and later, SPEC-0032 A01); for an unreadable version the calls outside the main loop of a resumed session are unknown. A count that would come out negative is unknown;
  - the orchvia arm: the engine's records of the task, `:outside:` ones in `outside` and the rest in `main`.
- **M02** Metering the same calls through either path gives the same parts.

## P. Prices

- **P01** Prices are per model, with a 5-minute and a 1-hour cache-write rate; a model is matched exactly or by its name before a date suffix. A cache write without a split takes the 5-minute rate, and the report marks such a request. A part of a model without a price, or with an unknown count, has an unknown cost (`costUsd: null`); a request's cost is known only when every part's is. The budget counts the known part.

## R. Report

- **R01** Each request of the report carries `usage: { main, outside, total }`, `costUsd` (null when unknown) and `unpricedParts`; each run's totals keep main and outside apart. The report records the price table. The README describes the metering.

## Acceptance

| ID       | Criterion                                                                                                                                    | Test                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0047-M01 | Direct metering splits main and outside, subtracts a resumed session's totals only where Claude Code continues them, and keeps unknowns null | `tests/contract/bench-metering-0047.test.ts` |
| 0047-M02 | The same calls meter the same through the direct and the engine path                                                                         | same                                         |
| 0047-P01 | Per-model prices, the 1-hour rate, and unknown costs                                                                                         | same                                         |
| 0047-R01 | A fake run's report has the parts and the price table                                                                                        | same                                         |

## Not in this change

A paid run, and the pre-registration of hypotheses and thresholds, which the owner sets before one.

## Rollback

Reverting restores the old counting; no package depends on it.
