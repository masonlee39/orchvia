# SPEC-0034: Stop proof for commands that outlive their turn

Date: 2026-09-27. Status: A, B and C approved by the owner on 2026-09-27 (D-STOP-1 and D-STOP-2 option 1; D-0034-1 to D-0034-3 option 1); B03 added the same day after the native check of B01 (D-0034-4 option 2). Release: 0.1.10. Supersedes: the premise of SPEC-0023 P that a Claude Code process's descendants share its process group, and the read-only Codex terminal coverage of SPEC-0003-A2 and SPEC-0027 A03. Environments: macOS and Linux; Windows is unchanged and unverified. Evidence: [TDD-0034](../tdd/0034-background-command-stop-proof.md).

## Findings

All from real binaries against a loopback scripted gateway, without models or credentials.

- **F1 (Codex, codex-cli 0.153.4).** A command that `exec_command` returns from early (`yield_time_ms`), or that a shell backgrounds, keeps running after `turn/completed` and after a SIGTERM to the app-server's process group: each command has a process group of its own. Through `createCodexAdapter` in the read-only profile the task reached `waiting_approval` with no lease held while the command ran, and the command was orphaned when the host closed. Disabling `unified_exec` does not help. A descriptor passed to the app-server is not inherited by its commands.
- **F2 (Claude Code, Agent SDK 0.3.283).** Bash commands run in process groups of their own; a command a shell backgrounds is handed to the init process. `processGroupsStopped`, which SPEC-0023 recommended, checks only the Claude process's group and so cannot see either.
- **F3.** In the adapter's writable mode (`dontAsk`) Claude Code refuses a bare `&`, and the adapter's guard refuses `run_in_background`; `sh -c '… &'` and a pipe into `sh` run. Python's `subprocess.Popen` closes inherited descriptors by default, so a daemon it starts drops a marker descriptor; it keeps its working directory. On macOS the environment of system binaries such as `/bin/sleep` cannot be read, so an environment marker is not an option; `lsof -a -d cwd` lists working directories in about 0.2 s.
- **F4.** A Codex `PreToolUse` hook that rewrites commands never ran on 0.153.4, cause unknown, so Codex gets no marker in this release (SPEC-0035).

## A. Conservative rules

- **A01** No Codex profile claims that its terminal ends execution: `terminalCoversExecution` is true only with `observeExecutionStop`. Without an observer or `executionStop: 'owner-reconcile'`, `createCodexAdapter` fails with `INVALID_ADAPTER_CONFIG`, read-only included. The JSON CLI accepts `executionStop` for `codex` and requires `'owner-reconcile'`. Breaking for hosts that created a read-only Codex adapter without either.
- **A02** `processGroupsStopped` keeps its answers, is marked deprecated and emits one `DeprecationWarning` per process. The engine's message for a missing stop proof no longer suggests it; for a Claude adapter it names `stopMarker: true`.
- **A03** When a Codex dispatch closes its app-server, it first lists the app-server's descendants, then ends those that are still the same processes (same start time): SIGTERM, then after `closeTimeoutMs` SIGKILL. A descendant that leads its own group is signalled with its group, never the host's group. A Claude dispatch with `stopMarker` ends the holders of its marker when it finishes, whether or not it was proven stopped, and closing the adapter ends the holders of every marker left. Nothing is ended by name.

## B. Marker files for Claude

- **B01** `createClaudeAdapter({ stopMarker: true })`, on macOS and Linux, supplies the stop observer. Before submission each dispatch gets `<dir>/<id>.tag` and `<dir>/<id>.sh` in a private directory `orchvia-stop-*` under the system temporary directory (mode 0700; not the state directory, which the write sandbox denies). The request's `env` is the host's `env`, or the process environment, with `CLAUDE_CODE_SHELL_PREFIX` set to the wrapper and `CLAUDE_CODE_SHELL` to the host's `CLAUDE_CODE_SHELL`, else `/bin/bash`, else `/bin/zsh`. The wrapper takes exactly one argument, opens the marker as descriptor 9 with `command exec`, so that a failed open does not end a POSIX shell such as dash with its own status, and `exec`s the shell with `-c`; otherwise it exits 126. A sandbox's `filesystem.allowRead` gains the directory. The observer lists the holders with `lsof -t -w`, sends SIGTERM, waits up to half the remaining time, sends SIGKILL and lists again. `lsof` failing, or holders left, means not stopped.
- **B01b** `stopMarker` must be a boolean. It fails with `INVALID_ADAPTER_CONFIG` together with `observeExecutionStop` or `executionStop`, on Windows, and when the host's options or process environment set `CLAUDE_CODE_SHELL_PREFIX`. When `extendOptions` sets it for a dispatch, that dispatch fails before submission.
- **B02** Deferred to SPEC-0035 (F4).
- **B03** (D-0034-4 option 2) After the holders are gone, the observer also lists processes whose working directory is the workspace or inside it. One that started in or after the second before the one in which the dispatch was prepared (Linux derives `ps` start times from a boot time truncated to the second, so they can read up to a second early), and that is not in the host's own process tree (the runtimes of every session and the observer's own `lsof`), means not stopped, and the marker stays for a later observation. Such processes are not ended. Accepted costs: a process a person or another session starts in the workspace during the dispatch holds its lease too; a process that leaves the workspace before detaching, or one another service starts, is not seen. [SPEC-0062](0062-stop-look-order-and-remote-network.md) S: the observation starts when the runtime has ended, and looks again while its time lasts.

## C. Documentation and release

- **C01** `scripts/native-stop-smoke.mjs claude|codex` runs in the pinned native CI jobs, and fails when a scripted command did not run. On Ubuntu 24.04 the job sets `kernel.apparmor_restrict_unprivileged_userns=0`: with AppArmor's restriction bubblewrap fails (`loopback: Failed RTM_NEWADDR`) and no sandboxed command of either runtime runs. Cases: Claude with `sh -c '… &'` (lease released, command ended), with a Python daemon (never a released lease while it runs; on macOS the lease is held and the daemon left running; on Linux Claude Code's sandbox runs each command in a PID namespace of its own, bubblewrap `--unshare-pid`, and the daemon ends with its command) and with `processGroupsStopped` (recorded); Codex with a yielded `exec_command` (lease held, command ended by its dispatch) and a backgrounded one (lease held; recorded).
- **C02** Guide §5, the reference's CLI settings, the CHANGELOG with the affected hosts and the configuration they must add, and notes in SPEC-0023 P03 and SPEC-0027 A03.

## Timing invariants

1. The marker exists before the query is made; if it cannot be created, the dispatch fails before submission.
2. A command holds the marker before it runs; a command that cannot is not run.
3. A lease is released automatically only when the observer returns true within its time. Timeout, a failing `lsof` or `ps`, holders left, or a process counted by B03 all mean not stopped.
4. Holders are ended before the marker is removed; the marker is removed only once the dispatch is proven stopped, when the dispatch finishes, or when the adapter closes.

## Acceptance

| ID        | Criterion                                                                                                                                                                                                           | Test                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0034-A01  | Codex without proof fails in every profile; owner reconcile gives no coverage, an observer does; the JSON CLI requires owner reconcile                                                                              | `tests/contract/stop-proof-0034.test.ts`        |
| 0034-A02  | Same answers, one warning, the message names `stopMarker`                                                                                                                                                           | same                                            |
| 0034-A03  | A Codex dispatch ends the background command its app-server started; a Claude dispatch without a terminal ends its marked commands                                                                                  | same; `tests/contract/stop-marker-0034.test.ts` |
| 0034-B01  | A backgrounded command holds the marker until the observer ends it; one that ignores SIGTERM is killed; the sandbox can read the marker; a command that cannot hold it is refused; unlisted holders are not stopped | `tests/contract/stop-marker-0034.test.ts`       |
| 0034-B01b | The option excludes the other choices and a host's own shell prefix                                                                                                                                                 | same                                            |
| 0034-B03  | A process that dropped the marker keeps the dispatch unstopped and is left running; only processes started during the dispatch in its workspace count                                                               | same                                            |
| 0034-C01  | [Native] Real Claude Code and Codex, as C01 describes                                                                                                                                                               | `scripts/native-stop-smoke.mjs`                 |

## Rollback

Reverting A01 restores the false coverage of F1. `stopMarker` is opt-in; a host that turns it off returns to its own observer or owner reconciliation.
