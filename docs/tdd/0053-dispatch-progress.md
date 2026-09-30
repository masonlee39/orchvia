# TDD-0053: Progress of a running turn

Specification: [SPEC-0053](../specs/0053-dispatch-progress.md).

- Facts before the design: the engine's `consume` takes every runtime event other than `usage` and `accepted` as the turn's end, so progress is a callback, not a `RuntimeEvent`. The Claude Agent SDK's `SDKAPIRetryMessage` has `attempt`, `max_retries`, `retry_delay_ms` and `error_status`; Codex 0.157.1's `ErrorNotification` (from `codex app-server generate-ts`) has `willRetry` and a `TurnError` whose `codexErrorInfo` may hold `httpStatusCode`, and its retry count only in the message text.
- E01, E02, A02 RED: `tests/engine/progress-0053.test.ts` failed 5 of 5: `input.reportProgress is not a function`. GREEN: 5 of 5.
- E03 RED: `tests/contract/claude-progress-0053.test.ts` reported nothing (`actual: []`); the turn without the callback already ran: regression coverage. GREEN: 2 of 2.
- E04 RED: `tests/contract/codex-progress-0053.test.ts`, with the fixture's new `FIXTURE_NOTIFICATIONS`, reported nothing (`actual: []`). GREEN: 2 of 2.
- Mutations, each restored from a copy: the engine keeping only the latest text instead of what was written since the last text event fails the throttle test; the Codex adapter reporting an `error` that will not be retried fails E04.
- After the integrating host's review (D-prog-4 to D-prog-6):
  - E02, E05 to E07 RED: the 1,001st progress was not written (limit 500), and `tool_finished`, `thinking` and masking did not exist: 4 of 8 failed. GREEN: 8 of 8.
  - E03, E04 RED: neither adapter reported `tool_finished` or `thinking`. GREEN: 2 of 2 each. The duration an adapter measures is checked as a whole number of milliseconds, not a value.
  - F RED: `tests/engine/events-filter-0053.test.ts` failed 3 of 4 (`types` and `excludeTypes` were unknown parameters, so the invalid filters were already refused, for another reason); `python/tests/test_events_filter_0053.py` failed against `main`'s client with `unexpected keyword argument 'types'`. GREEN: 4 of 4 and 1 of 1.
  - Mutations, each restored from a copy: no default exclusion fails F01, F02 and F03; a scan limit of 50,000 fails F02.

