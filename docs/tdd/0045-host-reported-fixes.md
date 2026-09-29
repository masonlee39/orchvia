# TDD-0045: Recorded results in reconciliation, strays of other tools, collection behind a reused session, and complete Codex usage

Specification: [SPEC-0045](../specs/0045-host-reported-fixes.md). Approved by the owner on 2026-09-29.

## G. Collection behind a reused session

- Reproduced first: a task ends, 91 days pass, a second task reuses its session and waits for acceptance. Collection left the event floor at 0 and kept the first task's result; with a fresh second session both were collected. Skipping every reference of a session in `isProtected` made the reproduction pass, which located the cause.
- RED: `tests/engine/gc-protection-0045.test.ts`, 2 of 3 failed (`floor 0 covers the first task's 11`; the first task's result kept).
- GREEN: 3 of 3.
- Mutation: skipping all of a session's references, instead of only those to tasks, failed the test that a session's checkpoint stays protected.

## R. Recorded outcomes in reconciliation

- RED, engine: `tests/engine/reconcile-recorded-0045.test.ts` R01 failed with `result must be a string`, and R02 found no flag. The two cases that give a result, or have none recorded, passed before: regression coverage.
- RED, SDKs: the TypeScript schema refused a completed attestation without `result`, and neither SDK refused to send it to a host without the flag.
- R03 was written before its tests. Its RED was reproduced by taking `recorded` out of the accepted outcomes, which is 0.1.21's behavior: `Invalid reconciliation outcome`. Mapping an interruption to `failed` failed the test.
- GREEN: engine 6 of 6, TypeScript contract 2 of 2, Python 1 of 1.
- The earlier schema test that a completed attestation without `result` is refused now checks that it is accepted, and that `recorded` with a `result` is refused.

## K. Strays of other tools

- Tested with real processes: a shell whose parent is an ordinary process starts `sleep` in the workspace after the dispatch began; a shell whose parent became process 1 does the same; an orphan.
- RED with 0.1.21's stray check: the other tool's process was counted (`another tool's process`), and the orphan's observation named no processes.
- GREEN: 3 of 3, three runs in a row. `countsAsStray` is tested with synthetic rows for the macOS application case (K03) and a helper inside a bundle.
- The process table now carries each process's executable; `ps` gives `lstart` as five fields in the C locale, which the parser reads before the command.

## U. Complete Codex usage

- Measured before the change, with the loopback scripted gateway, synthetic credentials and distinct counts for every request: in `plan`, `default`, `acceptEdits` and `auto`, and for a second dispatch on the same thread, the counts the adapter reported equaled what the gateway served, with Codex 0.157.1 and 0.158.0. A case meant to trigger automatic compaction did not trigger it, so a compaction leaves usage unconfirmed.
- RED: `tests/contract/codex-usage-complete-0045.test.ts`, the new-thread and resumed-thread cases failed; the cases that must stay unconfirmed passed before: regression coverage.
- GREEN: 3 of 3. Mutations: ignoring a compaction, and accepting a first total larger than its request, each failed the test.
- `scripts/native-codex-local-smoke.mjs` U02 passed with Codex 0.157.1 and 0.158.0. With 0.1.21's adapter it failed in all six cases: the counts matched, but no result said usage was complete.
- The Codex adapter test of 0.1.2 now expects `usageComplete: true`: its fixture reports a new thread's first request.

## Checks

- `npm test` 913 of 914 and `npm run test:python` 113 of 114 in the maintainer's checkout; the one failure of each, 0021-N01, came from an ignored `python/src/agent_orch/__pycache__` left there before the rename. In a copy of the tracked files both passed.
- The type check, Prettier and the generated-code check passed.
- Under load, one busy loop per core and six copies at `nice 10`, the new tests and the stop-marker tests of SPEC-0034 and SPEC-0036 passed 38 of 38 in each copy.
- The Python examples leave `__pycache__` beside them; the examples test now ignores it.
