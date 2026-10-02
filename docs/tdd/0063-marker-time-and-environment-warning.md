# TDD-0063: A stop marker's waits last at least five seconds; a warning before the default environment of checks changes

Specification: [SPEC-0063](../specs/0063-marker-time-and-environment-warning.md).

## The report, before any test

A host sent the record of a dispatch that had ended unproven while its whole test suite ran: `kind: 'dispatch'`, `reason: 'unlisted'`, `holders: 0`, `ended: 0`, `strays: 0`, with `closeTimeoutMs` left at its default. With 5,000 ms, four runs of the suite showed none.

## RED

`tests/contract/marker-time-0063.test.ts`: 4 of 5 failed. With an `lsof` that takes 1.2 seconds longer, put before the real one on `PATH`, the Codex and the Claude dispatch each ended with the host's record: `reason: 'unlisted'`, no holder, no stray. No warning was emitted at start or at a registration. O03, a host's observer gets the configured time, describes what 0.1.33 does and passed.

## GREEN

The file passes, 5 of 5. The two dispatches took 4.2 and 4.7 seconds with 1.2 seconds for each listing, close to the 5 they now have; the tests use 0.7 seconds, which is still more than the configured second for two listings.

## Mutations, each restored from a copy

Each fails a test: the observation with the configured time, on Codex and on Claude (O01); a host's observer given the markers' time (O03); the warning without the check for rules, without the check for the setting, emitted each time, and not emitted at a registration (W01, W02).
