# TDD-0064: Holders that could not be listed again are `unlisted`

Specification: [SPEC-0064](../specs/0064-unlisted-after-signalling.md).

## The report

A host saw `reason: 'holders_left'` with `ended: 0` when the listing after the signals had run out of time.

## RED

`tests/contract/marker-unlisted-0064.test.ts`: 3 of 3 failed. The observation, with a real holder that ignores SIGTERM and an `lsof` on `PATH` that answers once and then takes 30 seconds, recorded `holders: 2, ended: 0, reason: 'holders_left'`. The sweep, with a listing that answers once, said `holders_left`. The synchronous cleanup with a listing that fails returned no `unlisted` and recorded `holders_left` with no holder.

## GREEN

The file passes, 3 of 3.

## Mutations, each restored from a copy

Each fails a test: the observation's reason without the new case, the sweep's reason without it (U01), and the synchronous record's reason always `holders_left` (U02).
