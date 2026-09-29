# SPEC-0044: A stability policy, settling a task, and examples that run

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-t2-1 option 2, D-stab-1 option 1, D-44 option 1, D-t2-2 option 1). Release: 0.1.21. Environments: macOS and Linux. The engine, the wire and storage are unchanged. Both SDKs gain `settle()` and a rule judge (`createRuleJudge`, `RuleJudge` in Python). Evidence: [TDD-0044](../tdd/0044-onboarding-and-stability.md).

## Why

- **No stability rule.** Nineteen releases shipped in six days. Patch 0.1.10 changed an API (its CHANGELOG has a "Breaking" section), and 0.1.4 changed an error code. An integrating host asked to be told before event and field changes. `docs/design.md` says clients "negotiate minor capabilities", while the engine requires protocol `2.0` exactly and announces optional features as `capabilities.workflow.*` flags.
- **A wait that never ends.** `wait()` returns only when a task completes, fails or is cancelled. A task that waits for a person's acceptance has its approval expire after 24 hours and is then paused, and `wait()` goes on. `docs/design.md` shows `await task.wait()` for such a task. Three examples copy the same approval loop.
- **Examples that do not run.** Crash recovery, the durable mailbox and handoffs have no example. `checks-and-dependencies` (both languages), `connect.ts` and `fake_roundtrip.py` are documented but never run by a test. The routing layer's only judge needs a paid key.
- **Writable members from Python.** A Python host that starts the CLI's JSON host cannot run a writable Claude member or a Codex member without owner reconciliation. The CLI's `startStdioHost` accepts any adapters, but no document says so.

## S. Stability policy

- **S01** `docs/stability.md` defines:
  - **Stable surfaces:** the public exports of both SDKs, the wire's methods and fields, event types, error codes, configuration fields and CLI flags.
  - **Before 1.0:** a patch release only adds optional things, or fixes a defect without changing documented behavior; a change that breaks any stable surface bumps the minor version, with a "Breaking" section and migration notes in the changelog.
  - **Deprecation:** a deprecated surface stays at least until the next minor version, with a warning where the code can give one.
  - **Protocol version:** the engine requires protocol `2.0` exactly and announces optional features as `capabilities.workflow.*` flags; a client checks those flags before using a feature. `docs/design.md` says the same.
- **S02** A test fails when a release from 0.1.21 on has a "Breaking" section while its minor and major versions equal the release before it.

## T. Settling a task

- **T01** `TaskHandle.settle({ onApproval?, timeoutMs?, signal? })` in TypeScript, and `settle(*, on_approval=None, timeout=None)` in Python, polls the task as `wait()` does. It returns `{ task, reason, approval?, session? }`:
  - `reason: 'terminal'` when the task completed, failed or was cancelled;
  - `'paused'` or `'blocked'` when it is in that state; a blocked task comes with its session, whose status may be `outcome_unknown`;
  - `'waiting_approval'` when the task waits for a pending approval and no handler decides it; the approval is included.
  - A task that a model created has no handle; the existing public constructor makes one from its snapshot: `new TaskHandle(orch, snapshot)`, `TaskHandle(orch, snapshot)` in Python. No new method is added for it.
- **T02** With `onApproval`, each pending approval, by its ID and revision, is passed once to the handler with the task. The handler may return:
  - `'approve'` or `'deny'`, which is submitted with the approval's revision, after which settling goes on;
  - nothing, which ends settling with `'waiting_approval'`.
  - `settle()` never decides an approval by itself, and never retries, resends or reconciles anything.
- **T03** A timeout ends with `TIMEOUT`, as `wait()`'s does; the task is not cancelled.
- **T04** `docs/design.md` and the quickstart examples use `settle()`. The README's offline quickstart runs without `npm ci`, since it imports only the repository's sources and Node; a test runs both quickstarts from a copy of the sources without `node_modules`. The Claude quickstart keeps `npm ci`, which installs the Claude Agent SDK.

## E. Examples that run

- **E01** `examples/typescript/crash-recovery.ts` and `examples/python/crash_recovery.py`:
  - An engine host in a child process accepts a dispatch of a runtime that does not finish.
  - The child is killed once the dispatch is accepted, not after a guessed delay.
  - A new host on the same state directory shows the task blocked and its session's outcome unknown.
  - The example reconciles it as interrupted and shows that no dispatch was sent again.
- **E02** `examples/typescript/team-mailbox.ts` and `examples/python/team_mailbox.py`:
  - A lead agent delegates to a helper and sends it a message through the orchestration tools.
  - The helper's prompt shows the message.
  - A handoff is requested and approved by the host.
  - The runtime is a scripted fake, `examples/typescript/team-runtime.ts`, whose lead calls the orchestration tools. The Python example runs it in a custom Node host, `examples/typescript/team-host.ts`, which it starts and owns, as E05 describes for real runtimes.
- **E03** A test runs every example except the interactive `local.ts` and those that need a real runtime (`quickstart-claude.ts`, E05's host), and checks what each prints. It also fails when a file in `examples/` is neither run by a test nor listed with the reason it is not. `fake_roundtrip.py` gains `--emergency-bytes`, as `quickstart.py` has, so the test runs it with the 4 KiB reserve.
- **E04** `createRuleJudge(options?)`, and `RuleJudge(*, answer=None)` in Python, answer the router's questions without a model:
  - relevance from the words the request shares with an agent's description;
  - `writes` from verbs such as fix, add, change or implement;
  - `size` from the request's length.
  - Its confidence never exceeds 0.6, so the default routing policy asks for confirmation whenever there is an agent to choose; without candidates the router asks no choice and needs none.
  - `options.answer(id, question, state)` may answer any question instead.
  - It is documented as a baseline for trying the routing layer, not as a judge of quality.
- **E05** The guide and the Python README show a Python host that starts a custom Node host. `examples/typescript/writable-host.ts` builds it with `startStdioHost` and writable Claude and Codex adapters that use `stopMarker`.

## Timing invariants

1. E01 kills the child only after the parent has read the child's report that the dispatch was accepted, so the kill always interrupts an accepted dispatch.
2. `settle()` reads the approval after reading a task that waits for it, and passes the approval's revision, so a decision never applies to a newer revision than the handler saw.

## Acceptance

| ID       | Criterion                                                                                          | Test                                                                             |
| -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0044-S02 | A "Breaking" section in a patch release from 0.1.21 on fails                                       | `tests/contract/version.test.ts`                                                 |
| 0044-T01 | `settle()` returns terminal, waiting_approval, paused and blocked with the right snapshots         | `tests/contract/settle-0044.test.ts`, `python/tests/test_settle_0044.py`         |
| 0044-T02 | A handler's decision is submitted once per approval revision; no handler, no decision              | same                                                                             |
| 0044-T03 | A timeout raises `TIMEOUT` and leaves the task                                                     | same                                                                             |
| 0044-T04 | The offline quickstarts run from the sources without installed dependencies                        | `tests/contract/examples-0044.test.ts`                                           |
| 0044-E01 | Both crash-recovery examples print the same four steps, with no dispatch sent again                | same                                                                             |
| 0044-E02 | Both team-mailbox examples print the same three steps                                              | same                                                                             |
| 0044-E03 | Every runnable example runs and prints what its documentation says; every example is accounted for | same                                                                             |
| 0044-E05 | [Manual] `writable-host.ts` starts from Python with both members proving stop by markers           | TDD-0044                                                                         |
| 0044-E04 | The rule judge answers each question type, caps its confidence, and takes `answer` overrides       | `tests/contract/rule-judge-0044.test.ts`, `python/tests/test_rule_judge_0044.py` |

## Rollback

Reverting restores 0.1.20: no stability rule, `wait()` only, and the examples and the rule judge removed.
