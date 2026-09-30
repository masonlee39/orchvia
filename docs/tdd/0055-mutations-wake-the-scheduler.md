# TDD-0055: Every mutation wakes the scheduler

Specification: [SPEC-0055](../specs/0055-mutations-wake-the-scheduler.md).

- RED: two tests in `tests/engine/queue-reasons.test.ts`, which wait after the cancel without a scheduler pass of their own, failed: the task queued behind the cancelled one on its session stayed `queued`, and the dependant of the cancelled one stayed `waiting_dependency`.
- GREEN: 2 of 2, with one `kick()` after every mutation in `call()`.
- Cost: see SPEC-0055; one capacity benchmark run each way.
