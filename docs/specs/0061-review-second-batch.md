# SPEC-0061: Corrections from a review, second part: journals, the process table, baselines, a check's environment, and what a Codex command reads

Date: 2026-10-02. Status: approved by the owner on 2026-10-02 (D-batch2 option 1, D-env-1 option 1, D-audit-3 option 1). Release: the next one; it is not released on its own. Environments: macOS and Linux. Storage schema 3 and wire 2.0 are unchanged; the configuration gains two optional settings. Evidence: [TDD-0061](../tdd/0061-review-second-batch.md). Follows [SPEC-0060](0060-review-corrections.md).

## Why

The review of 0.1.31 also found what a host pays for as it runs longer, and two things a host could not know from the documentation.

- **An artifact's journal stayed until the next start.** Each artifact has a journal file, which lets a start find a file that was written but not registered. Once the transaction that registers the artifact has committed, the journal has no use, but it was removed only by the next start, which read and hashed every such artifact first. A host that wrote 5,000 artifacts since its last start took 0.74 seconds to start, and one that wrote 30,000 took 6.3 seconds; three journals a task stayed in one directory meanwhile.
- **Listing processes held the engine's thread.** The process table is read with `ps`, run synchronously: 36 to 40 ms on a developer's Mac each time. A stop marker observation reads it once, the end of a Codex dispatch once, and the wait for a Codex dispatch's leftover commands every 25 ms until they end. SPEC-0057 had brought the event loop's 95th percentile to 5.7 ms.
- **A verification's baseline held it too.** The content hash of a rule's baseline paths is computed before and after its command, synchronously: 65 ms each for 449 files of 6 MB, and up to 20,000 entries and 64 MiB are allowed.
- **A check ran what a member wrote, with the host's whole environment.** A verification command runs as the local user, outside any sandbox, on a workspace a member has just changed, and inherited every variable of the host, credentials included. The guide said that checks are not sandboxed; it did not say what they inherit.
- **A Codex member's command can read the Codex process's environment.** SPEC-0035 B04 keeps the bridge's, the hook's and the host MCP servers' variables out of a command's own environment and said that they never reach commands. On macOS a command in Codex's sandbox reads the environment of the user's other processes, the app-server's included, with `sysctl`; measured with Codex 0.157.1 and 0.158.0. With the network off it cannot connect to a Unix socket, so the bridge's and the hook's tokens are of no use to it; a host MCP server's token is a secret the command can then read.

## J. Artifact journals

- **J01** The journal of an artifact is removed when the transaction that registered the artifact has committed. The store notes each registration of a `Store.transaction`, and removes those journals after its `COMMIT`, with no sync.
- **J02** A transaction that rolls back removes no journal: the file it wrote is found by the next start, as before.
- **J03** A journal that could not be removed, or whose registration happened in a transaction the store did not begin itself, stays for the next start, as before.

Invariants:

1. A journal is removed only after the transaction that registered its artifact has committed.
2. After a crash at any point a store is in one of the two states it could already be in: the journal exists, and the next start checks the file and registers it when no record names it; or the journal is gone, the record is committed and the file was synced before it.
3. Removing a journal never changes a transaction's result.

A start no longer reads and hashes the artifacts of the previous run. Reading an artifact checks its size and hash, as before.

## T. The process table

- **T01** `processTableAsync()` reads the process table without holding the thread. A stop marker's observation and sweep, and the end of a Codex app-server (`descendantsOf` and the wait for them in `endProcesses`), use it.
- **T02** The synchronous paths keep the synchronous call: `endStopMarkersSync`, `acknowledgeStopMarkers`, an adapter's `acknowledgeStopMarkers`, and the first use of a marker directory.

Invariant: a process is signalled in the same turn of the event loop in which the listing that names it, with its start time, was read; nothing is awaited between the two.

## B. Baselines

- **B01** `verifyRule` computes its baselines with asynchronous file calls, a file at a time in the order 0.1.32 used, and a large file in parts of 1 MiB.
- **B02** The hash is the one 0.1.32 computed for the same tree, and so are the limits and their errors.
- **B03** A cancelled verification stops between two entries of the baseline before its command, and its command does not run. The baseline after a command is not cancelled: the evidence says what the command left.

## V. A check's environment

- **V01** The configuration takes `verificationEnvironment`: `'inherit'` (the default, as before) or `'minimal'`. With `'minimal'`, a rule's command gets only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `USER`, `LOGNAME` and `SHELL` of the host (on Windows also `SystemRoot`, `PATHEXT`, `TEMP`, `TMP` and `USERPROFILE`), each when the host has it, and the variables that V02 names.
- **V02** The configuration takes `verificationInheritEnv`: up to 64 names of host variables, each a POSIX name. With `'minimal'` they are added to every rule's command when the host has them; with `'inherit'` they change nothing. The names are the host's and not a rule's: a rule is stored, in a store and in each task that froze it, and a field that 0.1.32 does not know would keep it from opening that store.
- **V03** The default becomes `'minimal'` with the next minor version (SPEC-0044: a patch release changes no behavior a host may rely on).
- **V04** The guide says that a check runs outside every sandbox on what a member changed, what its command inherits, and that a rule's `permissionProfile` is recorded and has no effect.

## E. What a Codex command reads

- **E01** SPEC-0035 B04 and H01, SPEC-0038 P02 and the guide say what holds: the variables are kept out of a command's own environment; a command may still read them from the Codex process on macOS, so what a host gives Codex through the environment (`env`, a host MCP server's `token` and `env`) is readable by the member.
- **E02** The native security check reads the Codex process's environment from a command and tries the bridge's socket with what it found. It records whether the environment was readable (`environReadable`), and requires that the socket could not be reached with the network off, and that the command stayed in the sandbox.

A file for the bridge's token was considered and not made: without `connection`, Codex's sandbox lets a command read every file, and Codex takes a host MCP server's token only from the environment.

## Compatibility

Additions only: the configuration fields `verificationEnvironment` and `verificationInheritEnv`. Nothing changes for a host that sets neither, and nothing that is stored or sent changes: a store written by this version opens in 0.1.32.

## Acceptance

| Id       | Criterion                                                                                               | Test                                            |
| -------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0061-J01 | After a task ends, no journal is left; the next start reads none                                        | `tests/engine/review-second-batch-0061.test.ts` |
| 0061-J02 | A rolled back registration keeps its journal, and the next start registers the file                     | same                                            |
| 0061-J03 | A stop between the commit and the removal leaves a journal that the next start removes, with one record | same                                            |
| 0061-T01 | A stop marker observation, a sweep and the end of a process tree run no synchronous `ps`                | `tests/contract/process-table-0061.test.ts`     |
| 0061-T02 | The synchronous cleanup still lists processes synchronously                                             | same                                            |
| 0061-B01 | A verification reads no file synchronously                                                              | `tests/engine/review-second-batch-0061.test.ts` |
| 0061-B02 | The hash equals the one 0.1.32 computed for a tree with directories, links and a large file             | same                                            |
| 0061-B03 | A verification cancelled during its baseline ends without running its command                           | same                                            |
| 0061-V01 | With `'minimal'` a command sees the listed variables and no other; with `'inherit'` it sees the host's  | same                                            |
| 0061-V02 | A named variable is passed with `'minimal'`; an invalid name is refused at start, also by the CLI       | same                                            |
| 0061-E02 | [Native] A command reads the Codex process's environment or not, and cannot reach the bridge's socket   | `scripts/native-codex-security-smoke.mjs`       |

## Rollback

Reverting restores 0.1.32. Journals that were removed are not needed, and the two settings are refused by 0.1.32's configuration check, which names them.
