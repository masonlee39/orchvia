# TDD-0061: Corrections from a review, second part

Specification: [SPEC-0061](../specs/0061-review-second-batch.md).

## Reproductions, before any test

- Journals: a state directory with 5,000 and 30,000 artifacts whose journals were still in `file-commits/` took 0.74 and 6.3 seconds to start; the start after it, with the journals gone, took milliseconds.
- Process table: `ps -axo pid=,ppid=,pgid=,lstart=,comm=` run synchronously took 36 to 40 ms on a developer's Mac, during which the engine's thread did nothing else.
- Baselines: the synchronous baseline of 449 files of 6 MB took 65 ms with a cold cache; of 594 files of 11.9 MB with a warm one, 15 to 17 ms, all of it holding the thread.
- A check's environment: a rule whose command exits 3 when `ORCH_0061_SECRET` is set blocked its task: the command saw the variable of the host.
- What a Codex command reads: under `codex sandbox` of Codex 0.157.1 on macOS, a Python program read the environment of another process of the same user with `sysctl` (`KERN_PROCARGS2`), and a connection to a Unix socket was refused with the network off.

## RED

- `tests/engine/review-second-batch-0061.test.ts`: 7 of 8 failed. J01 found three journals a task and a kept total that the directory did not have; J03 had no `artifact.committed` step, so the journal was not there to be removed; B01 counted synchronous reads; B02 and the two environment tests had no function to call; B03 ran with a baseline already computed; the engine's V01 test completed no task, because `verificationEnvironment` was not a setting. J02, a registration that rolls back keeps its journal, describes what 0.1.32 already did and passed.
- `tests/contract/process-table-0061.test.ts`: 3 of 4 failed. There was no asynchronous listing; an observation and a sweep ran `ps` synchronously; so did the end of a process tree. T02, the synchronous cleanup lists synchronously, describes what 0.1.32 already did and passed.
- The CLI test of V02 was written with the implementation and has no observed RED; its mutations are below.

## GREEN

- Both files pass, 9 of 9 and 4 of 4.
- Journals: after 5,000 and 30,000 artifacts written through the store, `file-commits/` is empty and the next start takes 25 and 97 ms.
- Baselines: for 594 files of 11.9 MB the asynchronous baseline takes 42 to 44 ms and holds the thread for at most 2 ms at a time; the synchronous one took 15 to 17 ms and held it for all of them. The hash is the same. The production code keeps no synchronous computation; B02 compares with 0.1.32's, which the test carries.
- The synchronous `descendantsOf` had no caller left and was replaced by the asynchronous one under the same name.
- A first version of the T01 test of an observation had no process in the workspace, so the observation never read the process table and the mutation that reads it synchronously passed. The test now starts a process there.

## Native, with the real Codex binary and a scripted loopback gateway

`scripts/native-codex-security-smoke.mjs`, case `process-environment`, with Codex 0.157.1 and 0.158.0 on macOS: with the network off, a command read the bridge's token and a credential from the Codex process's environment (`environReadable: true`), its connection to the bridge's socket was refused (`Operation not permitted`), no tool was called, and the host was asked nothing. Linux is measured by CI.

## Mutations, each restored from a copy

Each fails a test: a journal removed before the commit (J01, J02, J03); never removed (J01, J03); its size not taken from the kept total (J01); the stop after the commit ignored (J03); the process table read synchronously by an observation, by the sweep, by `endProcesses` and by `descendantsOf` (T01, four mutations); the cancellation not looked at, and a cancelled baseline's command run (B03); only the first part of a file hashed, `.git` not left out, the size limit not checked (B02); `'minimal'` passing the whole environment, names not checked, named variables not passed, the mode not checked (V01, V02); the command not given the environment, the engine not checking at start (V01); the CLI not checking, and not passing the settings (V02).
