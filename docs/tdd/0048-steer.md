# TDD-0048: Steering a running turn

Specification: [SPEC-0048](../specs/0048-steer.md). Approved by the owner on 2026-09-29, with the integrating host's five refinements.

## Measured first

A JSON-RPC probe of Codex's app-server, with the loopback scripted gateway and a synthetic key, on 0.157.1 and 0.158.0, before any code: `turn/steer` was accepted while a command ran and while a command approval waited, and its text reached the model; after the turn, with another turn's id and with empty input it was refused with `-32600` and a message only. The design classifies refusals by what the adapter observed, not by those messages.

## Engine

- RED: `tests/engine/steer-0048.test.ts`, 7 of 7 failed with `METHOD_NOT_FOUND`.
- The first GREEN run failed three tests that were wrong: they expected an error's details at the top level instead of in `details`, gave the fake runtime a native session id its terminal evidence did not repeat, so the task was blocked, and closed an engine whose runtime ignored the interrupt.
- GREEN: 7 of 7. Mutation: without the 2-second wait for the turn's end, the C02 test failed.

## Codex adapter

- The app-server connection had one reader for everything it received, which a running turn owns; a steer's answer would have been taken by that reader. Answers to `callWhileReading` are now routed to it by id, and a closed connection fails them.
- The adapter was written before `tests/contract/codex-steer-0048.test.ts`; with the adapter of the branch point the test failed 3 of 3, and passes 3 of 3 now.

## SDKs and native

- RED: the TypeScript contract test found no `sessions.steer`; the Python test found no `steer`.
- GREEN: TypeScript 2 of 2, Python 2 of 2, the latter through a real stdio host.
- `scripts/native-codex-local-smoke.mjs` N01 with Codex 0.157.1 and 0.158.0: accepted while a command ran and while an approval waited, the text reached the model both times, and a steer after the turn was refused as ended without a request.
- Not covered by a test: a compaction's steer is refused as not steerable by the adapter, without a request; no fixture runs a compaction turn with a running command.

## Checks

- `npm test` 938 of 939 and `npm run test:python` 115 of 116; the one failure of each is 0021-N01, from an ignored `python/src/agent_orch/__pycache__` left in the maintainer's checkout before the rename (TDD-0045).
- The type check, Prettier and the generated-code check passed.
- `node scripts/stress.mjs --copies 6` over the new tests of SPEC-0046 to SPEC-0048, under 18 busy loops: every copy passed.
