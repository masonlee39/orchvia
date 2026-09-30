# SPEC-0048: Steering a running turn

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-steer-1 option 1), with the integrating host's five refinements. Release: 0.1.23. Environments: macOS and Linux; the local Codex member. The wire adds one method, one message kind and one event; `initialize` adds one workflow flag. Evidence: [TDD-0048](../tdd/0048-steer.md).

## Why

A person who sees a member go wrong can wait for its turn to end and then ask for a revision, after the wrong files were changed, or interrupt it and lose the turn's work. An integrating host asked for a third way: add a line to the turn while it runs. It wants it from the user only, never from another member, for Codex first, and an error, not a queued message, when the turn has ended, since a correction to an ended turn may no longer apply.

## Measured

With Codex 0.157.1 and 0.158.0, the loopback scripted gateway and synthetic credentials, `turn/steer { threadId, expectedTurnId, input, clientUserMessageId? }`:

- while a command ran: answered `{ turnId }`, and the text reached the model's next request of the same turn;
- while the turn waited for a command approval: answered `{ turnId }`; the approval stayed pending until answered, and the text then reached the model;
- after the turn ended, with another turn's id, or with empty input: a JSON-RPC error `-32600` whose only content is a message (`no active turn to steer`, `expected active turn id … but found …`, `input must not be empty`). Codex also declares `activeTurnNotSteerable` as structured error information for a turn it cannot steer.

## S. The method

- **S01** `sessions.steer({ target: { sessionId, expectedGeneration, expectedDispatchId, expectedRevision? }, text, idempotencyKey })` adds `text`, 1 to 16,384 UTF-8 bytes, to the running turn of that dispatch. A runtime's own tools cannot call it (`UNAUTHORIZED`); any client can. `initialize` lists `workflow.steer`, and both SDKs check it. It returns an operation, which ends as follows.
- **S02** Refused before anything is recorded:
  - `UNSUPPORTED_CAPABILITY` when the session's runtime does not declare `steer: true`;
  - `STALE_TARGET` when the generation, or a given `expectedRevision`, is not the session's;
  - `SESSION_CLOSED` for a stopped session;
  - `STEER_TURN_ENDED` when `expectedDispatchId` is not the session's running dispatch; a dispatch whose task waits for that dispatch's runtime permission (`waiting_approval` with a pending `runtime_permission` approval) is still running (invariant 3; corrected in 0.1.24); its data carries `dispatchId`, `turnOutcome` (`completed`, `interrupted`, `failed` or `unknown`, from that dispatch's recorded terminal, or `running` for none yet) and `taskStatus`.
- **S03** Otherwise, in one transaction, the operation is persisted and a message is recorded: kind `steer`, from `client:local`, to the session, its `summary` the text, its `dispatchId` the target, status `dispatching`. Only then is the runtime asked. A message of kind `steer` is never delivered in a prompt and never expires.
- **S04** The runtime's answer ends the operation:
  - accepted: the message becomes `completed`, the operation `completed` with `{ messageId, dispatchId }`, and the event `session.steered` carries `dispatchId`, `taskId`, `messageId` and the text;
  - refused because the turn ended: `STEER_TURN_ENDED`, with the data of S02;
  - refused because the turn cannot be steered, such as a compaction: `STEER_NOT_STEERABLE`;
  - refused otherwise: `STEER_REJECTED`, with the runtime's message;
  - no answer (the connection ended, or the adapter threw): `STEER_OUTCOME_UNKNOWN`, the message `outcome_unknown`. The engine never sends it again, and neither does a retry under the same key, which returns the first result.
  - A refused steer's message becomes `failed`.
- **S05** A host that restarts with a steer persisted and unanswered records it `STEER_OUTCOME_UNKNOWN`, and its message `outcome_unknown`.

## C. The Codex member

- **C01** Both Codex adapters declare `steer: true` and implement `steer`. It sends `turn/steer` on the dispatch's own connection with the turn id it holds, the text as one text input, and the message id as `clientUserMessageId`. An answer with a turn id is accepted; an error is a refusal, classified as `turnEnded` when the adapter has seen the turn end, `notSteerable` for `activeTurnNotSteerable` or a compaction, and otherwise by nothing but its message. A dispatch the adapter holds no running turn for is refused as ended, without a request.
- **C02** The engine classifies a refusal that is not yet known as an ended turn as `STEER_TURN_ENDED` when the dispatch's terminal arrives within 2 seconds after it, since Codex may answer before its notification of the end arrives.
- The Claude adapter declares no `steer`, so a Claude member is refused with `UNSUPPORTED_CAPABILITY`.

## Timing invariants

1. The steer is recorded before the runtime is asked (S03), so a host that stops at any point leaves it either answered or unknown, never sent and unrecorded.
2. A steer targets one dispatch: the engine checks `expectedDispatchId` against the running dispatch, and the adapter passes its own turn id as `expectedTurnId`, so a steer never lands in a later turn.
3. A steer while the turn waits for a runtime approval leaves the approval to the person.

## Acceptance

| ID       | Criterion                                                                                                                                 | Test                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0048-S01 | The method, its limits, the flag, and no access from runtime tools                                                                        | `tests/engine/steer-0048.test.ts`                                          |
| 0048-S02 | The refusals before anything is recorded, `STEER_TURN_ENDED` with its data                                                                | same                                                                       |
| 0048-S03 | The operation and the message are committed before the runtime is asked; a steer message is never delivered                               | same                                                                       |
| 0048-S04 | Each answer's operation, message and event; a retry never sends again                                                                     | same                                                                       |
| 0048-S05 | A restart leaves an unanswered steer unknown                                                                                              | same                                                                       |
| 0048-C01 | The Codex adapter's request and its classification of answers                                                                             | `tests/contract/codex-steer-0048.test.ts`                                  |
| 0048-C02 | A refusal followed by the turn's end is `STEER_TURN_ENDED`                                                                                | `tests/engine/steer-0048.test.ts`                                          |
| 0048-W01 | Both SDKs, the schema and the flag                                                                                                        | `tests/contract/steer-sdk-0048.test.ts`, `python/tests/test_steer_0048.py` |
| 0048-N01 | [Native] Real Codex: a steer reaches the model while a command runs, and while an approval waits; after the turn it is `STEER_TURN_ENDED` | `scripts/native-codex-local-smoke.mjs`                                     |

## Rollback

Reverting removes the method, the flag and the Codex adapter's `steer`; steer messages already recorded stay readable as messages.
