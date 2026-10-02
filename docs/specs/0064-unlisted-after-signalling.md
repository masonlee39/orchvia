# SPEC-0064: Holders that could not be listed again are `unlisted`

Date: 2026-10-02. Status: a correction a host reported; no decision was needed. Release: the next one; it is not released on its own. Environments: macOS and Linux. Evidence: [TDD-0064](../tdd/0064-unlisted-after-signalling.md). Corrects [SPEC-0036](0036-stop-marker-restart.md) and follows [SPEC-0063](0063-marker-time-and-environment-warning.md).

## Why

A stop marker's observation lists what holds the marker, signals the holders, and lists them again. When the second listing did not answer within the time, the record said `reason: 'holders_left'` with `ended: 0`: a host read that processes had refused to end, when nothing was known about them. The reason for a listing that cannot be made is `unlisted`, as when the first one fails, and it tells the host to give the wait more time. A synchronous cleanup whose only listing failed said `holders_left` with no holder at all.

## U. The reason

- **U01** When the holders of a marker were signalled and could not be listed again within the time, a dispatch's observation and a sweep say `reason: 'unlisted'`. `holders` is what the first listing found, and `ended` is 0, since no holder is known to have ended.
- **U02** A synchronous cleanup (`endStopMarkersSync`, an adapter's `endStopMarkersSync`) whose holders cannot be listed returns `unlisted: true`, and its record says `reason: 'unlisted'`.
- **U03** `holders_left` keeps its meaning: holders were listed after the signals and some remain.

Nothing else changes: the dispatch is not proven stopped in either case.

## Compatibility

`unlisted` on a synchronous cleanup's result is an addition. A record that said `holders_left` in this case now says `unlisted`; both already were reasons of an unproven stop.

## Acceptance

| Id       | Criterion                                                                                              | Test                                          |
| -------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 0064-U01 | An observation with a holder that ignores SIGTERM and an `lsof` that answers only once says `unlisted` | `tests/contract/marker-unlisted-0064.test.ts` |
| 0064-U01 | A sweep whose second listing gives nothing says `unlisted`, with the holder it had found               | same                                          |
| 0064-U02 | A synchronous cleanup that cannot list says `unlisted`; one that lists nothing is stopped              | same                                          |

## Rollback

Reverting restores the earlier reason.
