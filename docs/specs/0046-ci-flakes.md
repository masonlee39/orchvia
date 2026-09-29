# SPEC-0046: Tests that depend on time, run under load every week

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-flake-1 option 1). Release: 0.1.23. Environments: CI and development machines. The packages are unchanged. Evidence: [TDD-0046](../tdd/0046-ci-flakes.md).

## Why

From 2026-09-20 to 2026-09-29 the contract workflow ran 308 times, and 8 runs passed only on a second attempt. Seven of them were tests that assumed a fast, idle machine: a real-time window of milliseconds, a server used before it was ready, a budget measured on an idle machine. Each was fixed after it failed a pull request or a release. The rule to stress such tests before pushing existed, and was not enough.

## S. Stress

- **S01** `.github/workflows/stress.yml` runs every Monday at 07:00 UTC, after the drift check, and on demand with `copies` (1 to 6, default 3). On Ubuntu with Node 22.18 and 24.14, on macOS 14 and on macOS 15 Intel, it runs `npm test`, then `npm run test:python`, each in that many copies at once under load. Its summary lists each copy's result and the tests that failed, the logs are uploaded, and a failed copy fails the run. It opens no issue and changes no file.
- **S02** `scripts/stress.mjs [--copies N] [--burners N] [--summary FILE] [--logs DIR] [-- command]` keeps every core busy with one loop each, runs the command (default `npm test`) in N copies at once at `nice -n 10`, writes each copy's log, and appends a table of copies and failed tests to the summary. It exits 1 when a copy fails and 2 for invalid arguments; `--copies` is 1 to 6. Developers use the same script before pushing.

## R. Rules

- **R01** CONTRIBUTING's "Tests that depend on time": `EngineClock` instead of a real window under a second; waiting for a condition with a bound of at least 10 seconds instead of a fixed sleep; waiting for readiness; asserting behavior, not milliseconds; stressing before pushing; recording every rerun.

## L. Ledger

- **L01** `docs/ci-flakes.md` lists every run that passed only on a second attempt, with what failed, its cause and its fix, and what the causes have in common. A later rerun adds a row.

## Acceptance

| ID       | Criterion                                                                                | Test                                 |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| 0046-S01 | The workflow's schedule, input, runners, permissions, script and summary                 | `tests/contract/stress-0046.test.ts` |
| 0046-S02 | The script reports passing and failing copies, names failed tests, and bounds its copies | same                                 |
| 0046-R01 | CONTRIBUTING has the rules                                                               | same                                 |
| 0046-L01 | Every rerun of the period is in the ledger                                               | same                                 |
| 0046-S03 | [Manual] The first scheduled or manual run on GitHub, and what it found                  | TDD-0046                             |

## Rollback

Reverting removes the weekly run, the script, the rules and the ledger; nothing else depends on them.
