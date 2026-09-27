# SPEC-0023: Corrections before 0.1.2

Date: 2026-09-23. Status: approved by the owner and implemented: F01, E01, E02 and W with D-known-1 = 1, D-known-2 = 1 and D-known-3 = 2 on 2026-09-23; F02, found by CI on 2026-09-24, with D-known-8 = 1; E03, found while testing E02, with D-known-6 = 1; and P, implemented before the release (D-known-4 = 1), with its design approved as D-known-7 = 1; and S and F03, found by the CI runs of `known-issues` and `release-0.1.2` on 2026-09-24, with D-known-9 = 1 and D-known-10 = 1; and F04, found by the pull request CI on 2026-09-24 and fixed while merging for 0.1.2 on the principle of D-known-1, without a decision of its own. F05, found by the release run of `v0.1.2` on 2026-09-24, changes only tests and was made on `main` after the tag, on the same principle; the packages of 0.1.2 contain no tests, and the failed job passed when it was run again. The owner decided that 0.1.2 is released only after every known issue is solved, and that the verification gaps that the README lists as not verified do not block it (D-known-5 = 1). Evidence: [TDD-0023](../tdd/0023-corrections-before-0.1.2.md).

## Why

Besides the work already on branches (issues #12 to #14, one version number in SPEC-0021 P08 and P09, the 0019-C04 flake and stale documentation), four known issues remained:

- **F:** a CI flake. The lifecycle-wire tests give a stdio host 5 seconds to answer `initialize`, and a loaded runner can take longer to start it. It failed the first CI run of the rc.10 pull request; delaying the host start by 6 seconds reproduces it.
- **E:** the Python SDK hides why its host did not start. It raises `CONNECTION_CLOSED` with empty `data`, while the host printed `{"code":"INVALID_CONFIG",...}` on its error output.
- **W:** every CI job warns that its actions run on Node.js 20, which GitHub deprecates. The offline workflow also names actions by tags that can move.
- **P:** a host's stop observer cannot tell which operating-system processes belong to a dispatch.

CI found two more on 2026-09-24:

- **S:** a socket host announces that it is ready, and accepts connections, before it handles its stop signals, so a signal in between kills it.
- **F03:** a test of SPEC-0022 C02 times the whole close, which no budget bounds, instead of the wait that C02 bounds.

## Acceptance criteria

### F: Stdio fixture waits (tests only)

- **F01** The lifecycle-wire stdio fixture waits up to 10 seconds for each response, as the CLI shutdown fixtures do (D-R03-2), and each lifecycle-wire test that starts a host allows 60 seconds. Product bounds stay asserted as they are, such as the 5-second cleanup after an owner disconnects (SPEC-0003-A).
- Timing invariants: a fixture's wait only detects a host that hangs; it does not require a host to start quickly. A test's own timeout is longer than the fixture waits it can spend one after another, so a stall is reported as the step that stalled.
- **F02** The Claude deadline tests (`tests/contract/claude-deadlines.test.ts`) give 500 ms more to every deadline that must outlast the adapter's preparation before it submits, and allow each test 2.5 seconds. The adapter's request and turn deadlines include that preparation, which resolves paths with synchronous file calls. On a loaded runner it took longer than the 20 ms that one test allowed, and the adapter rightly reported a timeout before submission (`failed`) where the test expected `unknown`. The deadline rules under test are unchanged. Approved as D-known-8 = 1, on the principle of D-known-1.
- **F03** The test that `close({mode:'interrupt'})` waits at most half of its `timeoutMs` (`tests/contract/claude-close-interrupt.test.ts`) times that wait: from the call until the engine starts to close the adapters. For a 1-second budget it requires at least 490 ms and less than 1 second. It had timed the whole close, which also contains synchronous durable writes that no budget bounds: the shutdown receipt before the wait, and the final receipt and closing the database after it. On the macOS 14 and Node 22 runner of the `release-0.1.2` CI run the close took 1,226 ms. A second test slows every database close by 600 ms, checks that the close did take longer, and requires the same wait. The engine does not change. SPEC-0022 C03 said that the budget bounds the whole close; it now says that it bounds the wait. Approved as D-known-10 = 1.
  - Timing invariants: the test still catches an engine that waits the whole budget. It leaves the half of the budget above 500 ms for the receipt before the wait and for timer delays on a loaded runner, so a wait between half and the whole budget is not caught. The test that the wait ends at `timeouts.interruptMs` keeps its 5-second bound on the whole close.
- **F04** The interrupt lifecycle tests (`tests/contract/claude-interrupt-lifecycle.test.ts`) read a session's control target only after the runtime accepted the native session. Acceptance changes the session's revision after the task already runs, and the tests read the target as soon as the task ran. On a loaded runner the acceptance fell between that read and the pause, and the engine rightly refused the pause with `STALE_TARGET`: the push CI of `known-issues` failed that way on macOS 14 with Node 22. The control rules under test are unchanged. On the principle of D-known-1: a test waits for the state it needs, and its deadline only detects a hang.
- **F05** The tests that run the examples `usage-forwarding.ts` (AC-P08) and `hosted.ts` (AC-H09) give each example 60 seconds, as the quickstart tests do (0021-R01, 0021-R12), instead of 5. The examples keep the production emergency reserve of 256 MiB (SPEC-0011 R10), which their engine writes and flushes before it opens. On the Ubuntu 24.04 and Node 24 runner of the release run of `v0.1.2` the forwarding example had not finished after 5 seconds, while other tests of that job ran up to 17 times slower than usual; the same commit passed the test in every other job. The examples, with their own 2-second deadlines, are unchanged. On the principle of D-known-1: a test's deadline only detects a hang.

### E: Why a host did not start (Python SDK)

- **E01** When a host that `Orchestrator.local` started ends before it answers `initialize`, the SDK raises the same code as before, `CONNECTION_CLOSED` or `PROTOCOL_ERROR` for a partial frame. The message ends with the host's last error output, and `error.data["stderrTail"]` holds all of it that the transport kept, at most 16 KiB. When the host wrote nothing, the error is unchanged.
- **E02** Closing the connection to an owned host whose process has exited waits at most 1 second for its error output to reach end of file before it stops reading, so the last lines are kept. A live process is terminated first, as before; its error output is never awaited while it runs. Once the host's process has exited, the SDK also closes its ends of the host's pipes, which a process the host left behind could otherwise keep open; a host that still runs is never stopped this way.
- Timing invariants: the added wait starts only after the process exited, lasts at most 1 second and happens once per connection. Socket connections have no host error output and do not change. No wire field, method or error code changes. The TypeScript SDK starts no host of its own, so it does not change.
- **E03** When an owned host's process exits while another process still holds its standard output, pending requests fail at most 1 second later with `CONNECTION_CLOSED`, as when the output ends, and a start error carries the host's error output (E01). Today the transport notices a host's end only by the end of its standard output. A process that the host left behind and that inherited that output keeps it open, so a pending request waits for its timeout, 30 seconds by default, and fails as a timeout. A test found it: a host that exited at once left a process holding its standard output, and the start failed after 30.0 seconds.
  - While an owned host runs, the transport checks every 100 ms whether its process has exited. After an exit, it keeps reading for at most 1 second, so answers written before the exit still arrive, and then fails every pending request and stops reading.
  - Timing invariants: the end of the output is still handled first. The check runs only while an owned process is alive and stops when the connection closes. It adds at most 1.1 seconds between a host's exit and the failure of its requests. Socket connections do not change.

### W: Workflow actions

- **W01** Every action in `.github/workflows` that is not local is named by a full 40-character commit SHA, followed by its version as a comment. A test checks it.
- **W02** The actions are the latest major versions, each running on Node.js 24 according to its `action.yml` at the pinned commit (checked on 2026-09-23): `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `actions/setup-python` v7.0.0, `actions/upload-artifact` v7.0.1 and `actions/download-artifact` v8.0.1. `pypa/gh-action-pypi-publish` stays at v1.14.2, a composite action. [manual] The pull request's CI shows no Node.js 20 deprecation annotation, and its release dry run passes. The 0.1.2 release is the first npm publish through setup-node v7 and trusted publishing.

### P: Process identity for the stop proof

With extended Claude options or a writable profile, the adapter's terminal does not cover the whole execution, so the engine releases the dispatch's execution lease automatically only when the host's `observeExecutionStop` returns true (SPEC-0007). The observer receives the task, session, dispatch, generation and native IDs, but no operating-system process. The adapter owns spawning (`spawnClaudeCodeProcess` is reserved), so a host cannot know which processes a dispatch started. In a shared workspace with dispatches running at the same time, a host can only return false, and then every such dispatch waits for the owner, or return true without evidence, which defeats the proof.

- **P01** On macOS and Linux, the Claude adapter starts each Claude Code process as the leader of a new process group. Every descendant that does not create its own session or group stays in that group.
- **P02** The stop context gains an optional, read-only `processes: { pid: number; processGroupId: number }[]`: every process that the adapter started for this dispatch, including those that already exited. An adapter that starts no process, and every adapter on Windows, leaves it out. It is neither stored nor sent on the wire.
- **P03** (Deprecated by [SPEC-0034](./0034-background-command-stop-proof.md) A02: Claude Code runs Bash commands in groups of their own, so the premise that descendants share the Claude process's group does not hold for them.) `@orchvia/adapter-claude` exports `processGroupsStopped(context): boolean`. It returns true only when `processes` lists at least one process and none of the listed groups has a member left; any error other than "no such process group" counts as not stopped. A host calls it in its observer, together with its own checks for remote work.
- **P04** When the adapter must end a Claude process that did not stop by itself, it signals the whole group, first SIGTERM, then SIGKILL when the cleanup window ends, so descendants do not outlive a forced cleanup. Today only the Claude process itself receives SIGTERM.
- **P05** `orchvia host` handles SIGHUP like SIGTERM. Processes in their own group no longer receive the signals that a terminal sends to its foreground group, so closing the terminal must still shut the host and its dispatches down.

Timing invariants:

- The observer is called only after the adapter matched the native terminal, as today.
- The check can err only toward "not stopped". A group exists while any member exists, so its ID cannot be reused while one of our processes remains. A reused ID can only make a group look alive.
- A descendant that leaves the group, for example a daemon that calls `setsid`, is not seen. Hosts that need more add their own checks; the benchmark harness scans the workspace (D-bench-1).
- A host that crashes leaves its dispatches' processes running, as today.

Alternatives considered:

- The adapter checks the group itself and reports it as its own evidence, without a host observer. Host options can add remote execution that the adapter cannot see, so the host stays the authority and gets the check as a tool.
- Following the process tree with `ps` during the turn. A process whose parent exits is re-parented, so the tree loses it; the approach is also platform-specific and racy.

Tests: an offline query whose Claude process starts a grandchild that sleeps. The observer's context lists the Claude process and its group; `processGroupsStopped` is false while the grandchild lives and true after it ends, and false without `processes`. A forced cleanup leaves no member of the group. `orchvia host` shuts down on SIGHUP. Errors of the group check are injected to show they count as not stopped.

Environments: macOS and Linux. Windows is unchanged and stays unverified. The downstream host is told to call `processGroupsStopped` in its observer.

Rollback: `processes` is optional, and `processGroupsStopped` returns false without it, so reverting the adapter change leaves hosts that use it conservative.

### S: Stop signals while a socket host starts

`orchvia host --socket` wrote `orchvia listening on PATH` and only then handled its stop signals, and its socket accepted connections even earlier, while the host set the socket's permissions. A signal in either window ended the host by the signal's default action. A process manager or a test that signals as soon as it reads the line could kill it, and a turn that a client had started in the first window was not interrupted in order. Since P01, Claude processes no longer receive a terminal's SIGHUP, so a host killed this way leaves them running. The push CI run of `known-issues` found it: `0023-P05` saw `{ code: null, signal: 'SIGHUP' }` on Ubuntu with Node 24. The race is older than P05, which was the first test to signal on the line.

- **S01** From the moment the socket accepts connections until the host's close completes, SIGTERM, SIGINT and SIGHUP run the configured shutdown: the engine closes in the configured mode, the connections close, the socket file is removed and the process exits with code 0. None of them ends the host by its default action.
- **S02** The host writes `orchvia listening on PATH` only once S01 holds, and never after a stop signal arrived while it started.
- **S03** A stop signal that arrives while the host starts is kept: the host shuts down in order as soon as it has started.

Timing invariants:

- The host handles the signals from the moment the engine has opened its state, before it creates the socket. Before that, while the host reads its configuration and opens and recovers the state, a signal still ends the process like a crash during startup: no client can connect yet, recovery dispatches nothing, and the next start recovers as after any crash. The guide says so.
- The stdio host already handled its signals before it read any input, and does not change.

Approved as D-known-9 = 1. Alternatives considered: moving only the ready line after the handlers, which leaves the window while the socket accepts connections before the host has started; and waiting in the test before it signals, which hides the race from the test but not from a process manager.

Tests: test-only preloads stall a host for 300 ms right after its ready line, and after its socket accepts connections but before it has started. SIGHUP, SIGTERM and SIGINT sent on the ready line end the host with code 0 and remove its socket. SIGTERM sent while the host starts does the same without a ready line, and a second host then starts with the same state and socket path.
