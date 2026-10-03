# SPEC-0066: Raising a root task's budget

Date: 2026-10-04. Status: approved by the owner on 2026-10-04 (D-bud-1 option 1, D-bud-2 option 1, D-bud-3 option 1). Release: 0.2.1. Environments: every host; no runtime is involved. Evidence: [TDD-0066](../tdd/0066-raise-budget.md).

## Why

A run reaches its budget and the user adds money to go on. A task's budget was written at creation and no method changed it, so a host created another root with a new budget and put the later tasks under it, and the run's costs were split between two roots.

A child without a budget takes a copy of its parent's (SPEC-0009), and that copy bounds the child's own costs. Raising only the root would leave a run of one large step stopped by the step's copy.

## B. The method

- **B01** `tasks.raiseBudget({ taskId, maxCost, idempotencyKey })` sets the `maxCost` of a root task's budget. The task may be a runtime task or a host task, ended or not. The currency and `reservePerDispatch` do not change. Dispatches admitted after the operation count against the new amount; a task that was paused with `TASK_BUDGET_EXHAUSTED` can then be resumed and dispatched.
- **B02** It only raises: a `maxCost` that is not greater than the current one fails with `VALIDATION_ERROR`, as does a task that is not a root or has no budget, and a `maxCost` that is not a decimal amount. An unknown task fails with `NOT_FOUND`.
- **B03** In the same transaction, every task of the root's tree that has not ended and whose budget has the root's previous `maxCost` gets the new one: those are the copies the children took. A child whose budget has another amount keeps it, and so does a task that ended. A host that gave a child the root's amount on purpose finds it raised too.
- **B04** The same key with the same parameters returns the first operation; with another amount it fails with `IDEMPOTENCY_CONFLICT`.
- **B05** The operation's result is `{ taskId, previousMaxCost, maxCost, pausedTaskIds }`: `pausedTaskIds` are the tasks of the tree that are paused with `TASK_BUDGET_EXHAUSTED`, in creation order. The engine does not resume them; the host calls `tasks.resume` for the ones that should go on. The root's event `task.budget_raised` carries `previousMaxCost`, `maxCost`, `currency` and `raisedTaskIds`, the children of B03.
- **B06** `initialize` announces `capabilities.workflow.budgetRaise: true`, and both SDKs check it before sending. TypeScript: `orch.tasks.raiseBudget(taskId, maxCost, options?)`. Python: `tasks.raise_budget(task_id, max_cost, idempotency_key=None)`.
- **B07** The new amounts are stored with the tasks and hold after a restart.

## Timing invariants

1. The single writer runs the raise and every admission one after the other. A dispatch admitted before the raise committed was admitted under the old amount; one admitted after it, under the new one.
2. Costs already recorded and reservations already held are not changed.
3. The root and the copies of B03 change in one transaction, so no admission sees a raised root with an old copy.

## Not in this specification

Lowering a budget, changing its currency or its reserve, the host's own budget (`EngineConfig.budget`), and resuming tasks.
