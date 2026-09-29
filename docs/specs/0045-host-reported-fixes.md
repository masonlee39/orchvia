# SPEC-0045: Recorded results in reconciliation, strays of other tools, collection behind a reused session, and complete Codex usage

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-rc-A option 1, D-rc-B option 1, D-gc-1 option 1, D-usage-1 option 1; after the host's follow-up, D-rc-A2 option 1 and D-rc-B2 option 1). Release: 0.1.22. Environments: macOS and Linux. Storage is unchanged. The wire relaxes one schema rule and `initialize` adds one workflow flag. Evidence: [TDD-0045](../tdd/0045-host-reported-fixes.md).

## Why

- **A recorded result the owner cannot repeat.** A dispatch whose runtime returned a result, and whose stop proof then failed, is blocked with `outcome_unknown`. Reconciling it as `completed` needs `result`, word for word the recorded text, and no method returns that text.
- **Other tools' processes count as strays.** An integrating host reported a Codex dispatch whose stop observation found no marker holders and three strays: a `sleep` loop and a browser that another Claude Code session ran in the same directory, whose shell existed before the dispatch. SPEC-0034 B03 counts any process in the workspace that started during the dispatch outside the host's own tree, so the task stayed blocked.
- **A reused session stops event collection.** `isProtected` walks from a record to every record that references it. A session references every task it ran (`taskIds`), and a later task on the session references the session, so while that task is active, or ended within the detail period, the earlier tasks stay protected. Events are collected only as a continuous prefix, so none after the oldest such task is collected, and the earlier tasks' results are kept.
- **Codex never asserts complete usage.** Without `usageComplete` a dispatch's budget reservation stays held, so a host budget is used up by reservations of Codex dispatches that cost little.

## R. A recorded result in reconciliation

- **R01** `sessions.reconcile` with `outcome: 'completed'` may leave out `result` when the dispatch recorded a runtime terminal of type `result`. The engine then uses the recorded text, as if the owner had given it. A given `result` is still compared with the recorded text, word for word. Without a recorded result, `result` stays required: `VALIDATION_ERROR`.
- **R02** The schema no longer requires `result` for `completed`. `initialize` lists `workflow.reconcileRecordedResult`. Both SDKs refuse to send a `completed` attestation without `result` to a host that does not list it, with `UNSUPPORTED_CAPABILITY`.
- **R03** `outcome: 'recorded'` takes the outcome of the dispatch's recorded terminal: a result is `completed`, with its text; an interruption is `interrupted`; a failure is `failed`. Without such a terminal, or with an error whose outcome is unknown, it fails with `VALIDATION_ERROR`. It takes no `result`. The operation's `result.outcome`, the `session.reconciled` event and the task's reason use the outcome it took; the audit record keeps the attestation as given and adds `recordedOutcome`. It needs the same flag. A host cannot read which terminal was recorded, so without it an interrupted or failed dispatch could only be reconciled by guessing.
- The task is still paused with reason `reconciled_result` and still needs acceptance: `tasks.resume` then puts a task with human acceptance into `waiting_approval`, with the result, never straight into `completed`. `scheduler.resolveConflict` is unchanged and refuses `recorded`.

## K. Strays of other tools

- **K01** A candidate of SPEC-0034 B03 (in the workspace, started during the dispatch, outside the host's tree) is walked up to its nearest ancestor that started before the dispatch. It is not counted when that ancestor is neither process 1 nor a direct child of process 1: it then belongs to something that was already running, such as another terminal's shell or another agent. It is still counted when that ancestor is process 1 or a direct child of it, which covers:
  - an orphan, whose parent became process 1;
  - an orphan adopted by a per-user service manager such as `systemd --user`, a direct child of process 1;
  - a program started through a server that runs as a daemon, such as `tmux new -d`.
  - It is also counted when the walk cannot reach such an ancestor: a parent missing from the process table, or a loop.
- **K02** Each observation and each sweep result lists, besides the count, `strayProcesses: [{ pid, command, ancestor: { pid, command } | null }]` for the processes counted, and `foreignProcesses` of the same shape for candidates left out by K01, so a host can tell its user what kept a dispatch from being proven stopped.
- **K03** On macOS, an ancestor that is a direct child of launchd and whose executable is an application's own (`*.app/Contents/MacOS/*`) counts as an ordinary process: every running application is such a child, and a Git client's periodic `git status` in the project is not the dispatch's. A helper elsewhere in a bundle still counts.
- **Not seen:** a program that a dispatch has an already running application start for it, other than a daemon, is not counted, as a program started through `open` on macOS already is not. That includes a command run in Terminal or iTerm through AppleScript, which macOS allows only after the user grants the automation permission.

## G. Collection behind a reused session

- **G01** `isProtected` does not follow a reference from a session to a task. A task's own references are unchanged, and so are a session's references to anything else: its checkpoint, snapshot and dispatch stay protected by an active task on the session. A later task that needs an earlier task's result names it in `contextRefs` or `dependencyTaskIds`, which protect it directly.

## U. Complete Codex usage

- **U01** A local Codex dispatch's result carries `usageComplete: true` when all of these hold:
  - the turn completed with a result, and the dispatch is not a compaction;
  - no `contextCompaction` item appeared in the turn;
  - at least one usage observation arrived, and each one gave all three counts (input, cached input, output) as a difference of Codex's cumulative totals;
  - the first observation had a known starting total: the thread's total that the previous dispatch reported (`usageBaseline`), or, for a thread this dispatch started, a first total equal to that observation's own request.
- Otherwise it carries none, and the reservation stays held, as before.
- **U02** `scripts/native-codex-local-smoke.mjs` gives every gateway request distinct counts and checks, in `plan`, `default`, `acceptEdits` and `auto`, and for a second dispatch on the same thread with its baseline, that the counts the adapter reports add up to what the gateway served and that the result carries `usageComplete`. It runs in the native CI job and in the weekly drift check, so an upstream change in how Codex reports usage fails a check.
- Cache writes: Codex reports none, so its records keep `cacheWriteInputTokens: null`. Price Codex with `inputTokenMode: 'total'` and no cache-write rate, or the cost stays unknown.

## Timing invariants

1. K01 reads one process table after listing the workspace's processes. An ancestor that exits in between leaves its children to process 1, so they are counted: an exit never hides a stray.
2. An ancestor counts as existing before the dispatch only when it started more than a second before it, the resolution of `lstart`; one that may have started during the dispatch is walked past.
3. U01 decides after `turn/completed` and after the last usage observation of the turn, and the adapter reads no usage after closing the app-server. A count that Codex sent after `turn/completed` would be missing, so U02 checks the sums against the gateway in CI.

## Acceptance

| ID       | Criterion                                                                                                    | Test                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 0045-R01 | `completed` without `result` takes the recorded text; a different text conflicts; without a record it fails  | `tests/engine/reconcile-recorded-0045.test.ts`                                                   |
| 0045-R02 | The flag, the schema and both SDKs                                                                           | `tests/contract/reconcile-recorded-0045.test.ts`, `python/tests/test_reconcile_recorded_0045.py` |
| 0045-R03 | `recorded` takes a result, an interruption or a failure; nothing else, and no `result`                       | `tests/engine/reconcile-recorded-0045.test.ts`                                                   |
| 0045-K01 | Strays whose nearest earlier ancestor is an ordinary process are left out; orphans and daemon children count | `tests/contract/stop-marker-foreign-0045.test.ts`                                                |
| 0045-K02 | Observations and sweeps list the counted and the left-out processes                                          | same                                                                                             |
| 0045-K03 | An application's own executable on macOS is an ordinary process; a helper in a bundle is not                 | same                                                                                             |
| 0045-G01 | A reused session no longer keeps earlier tasks from collection; its own references still protect             | `tests/engine/gc-protection-0045.test.ts`                                                        |
| 0045-U01 | `usageComplete` under exactly the listed conditions                                                          | `tests/contract/codex-usage-complete-0045.test.ts`                                               |
| 0045-U02 | [Native] Reported counts equal the gateway's in four modes and on a resumed thread                           | `scripts/native-codex-local-smoke.mjs`                                                           |

## Rollback

Reverting restores 0.1.21: `completed` needs `result`, every in-workspace process started during a dispatch is a stray, a reused session keeps its earlier tasks protected, and Codex dispatches keep their reservations.
