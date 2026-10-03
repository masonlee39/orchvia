# TDD-0066: Raising a root task's budget

Specification: [SPEC-0066](../specs/0066-raise-budget.md).

## The request

A host's run reached its budget and the user wanted to add money. No method changed a task's budget, so the host created a second root and the run's costs were split.

## RED

`tests/engine/raise-budget-0066.test.ts`: 4 of 4 failed with `Unknown method: tasks.raiseBudget`. Each test reached that call, so the states before it are real: with a budget of 0.15 and dispatches of 0.1, the second step and a revised only step were paused with `TASK_BUDGET_EXHAUSTED`, and resuming one paused it again.

## GREEN

- `tests/engine/raise-budget-0066.test.ts`: 4 of 4.
- `tests/contract/raise-budget-sdk-0066.test.ts`: 2 of 2, over a Unix socket host, with the payloads checked against the schema and four negative cases.
- `python/tests/test_host_tasks_0065.py`: the two `0066` tests pass, with a stdio host.

## Mutations, each restored from a copy

Each fails `tests/engine/raise-budget-0066.test.ts`: the children's copies are not raised (2 fail, among them the run of one step, B03); a lower amount is accepted (B02); tasks that ended are raised too (B03); a child is accepted as the target (B02).

## Full runs

`npm run typecheck`, `npm run format:check` and `npm run check:generated` pass. `npm test`: 1126 of 1126. `npm run test:python`: 129 of 129. Node 24.14.0 on macOS. `node scripts/set-version.mjs 0.2.1` found no breaking change against the baseline of 0.2.0. Not run here: the rollback and cross-version Python checks and the Python type check, which CI runs.
