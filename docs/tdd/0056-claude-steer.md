# TDD-0056: Steering a Claude member

Specification: [SPEC-0056](../specs/0056-claude-steer.md).

- Measurements before the design, offline, with the real Claude Code binary of Agent SDK 0.3.274 and 0.3.283 against a scripted loopback gateway, a synthetic key and a private home: see SPEC-0056 "Why". The same eight cases behaved alike on both versions. `interrupt({ cancelQueued: true })` at the first result stopped the queued turn before its model request in 40 of 40 runs; `cancelAsyncMessage` at that moment came too late in 20 of 20.
- S01 to S03 RED: `tests/contract/claude-steer-0056.test.ts` failed 5 of 5: the adapter had no `steer` and declared no capability. A first version of the tests waited without a bound and held the run; each dispatch now ends within 5 seconds or fails. GREEN: 5 of 5.
- S04 RED: two tests added to `tests/engine/steer-0048.test.ts` failed: `RuntimeInput` had no `reportSteerOutcome`. GREEN: 10 of 10 in that file.
- Mutations, each restored from a copy:
  - a steer given at once without a running tool call fails S01 and "held, given when one starts, or dropped";
  - no interrupt for a given steer the result does not list fails both S03 tests;
  - an outcome that arrives before the steer's answer is recorded and is dropped fails "an outcome that arrives before the steer is recorded applies once it is".
- N01: `node scripts/native-claude-steer-smoke.mjs` passed with 0.3.274 and with 0.3.283: in the tool case the outcome was delivered and one model request carried the steer; in the text case the outcome was not delivered, no model request carried the steer and there was one model request in all.
