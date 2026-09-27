# Issue #46 TDD evidence: TypeScript `pollIntervalMs` for `events()`

Date: 2026-09-27. Offline contract tests only; no paid models invoked.

## RED → GREEN

| Scope | Observed RED | After implementation |
| --- | --- | --- |
| `pollIntervalMs` validation | New contract test `TS events() rejects a non-positive pollIntervalMs like the Python SDK`: timed out after 60s — invalid values (0, -1, NaN, Infinity) were silently ignored and the iterator polled forever | Rejects with `INVALID_PARAMS` (`pollIntervalMs must be a finite positive number`) before the first poll; test passes in ~1.5s |
| Custom interval accepted | Passed even before the fix (option ignored) | `pollIntervalMs: 5` still streams events; empty pages now sleep the configured interval instead of the hardcoded 50 ms |

## Validation commands

- `node --import ./tests/fixtures/reserve-guard.mjs --test --test-name-pattern="pollIntervalMs" tests/contract/sdk.test.ts`: 2 pass, 0 fail
- `npx tsc --noEmit`: clean
- `npx prettier --check packages/sdk-typescript/src/index.ts tests/contract/sdk.test.ts`: clean

Note: the contract harness needs `TMPDIR` on a filesystem larger than the 512M `/tmp` tmpfs here, otherwise `STORAGE_BACKPRESSURE` fails even unmodified tests (e.g. AC06).

## Unverified boundaries

- Timing precision of the sleep interval under load (only validation + event flow are asserted, not exact millisecond spacing).
- The optional backoff mentioned in the issue is not implemented; this change keeps the fixed-interval behavior with a configurable value.
- Python suite (`npm run test:python`) untouched: the Python SDK already had `poll_interval`; no Python code changed.
