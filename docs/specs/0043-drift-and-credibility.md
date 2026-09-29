# SPEC-0043: Upstream drift, unlisted models, and credibility checks

Date: 2026-09-29. Status: approved by the owner on 2026-09-29 (D-exp-1 option 1, D-drift-1 option 2, D-drift-3 option 1, D-model-2 option 1, D-43 option 1). Release: 0.1.20. Environments: macOS and Linux. Storage is unchanged. The wire is unchanged. `codexConnection().probe()` and `orchvia doctor` each add one field. Evidence: [TDD-0043](../tdd/0043-drift-and-credibility.md).

## Why

- **Drift.** Upstream changes reached users before the project saw them.
  - Claude Agent SDK 0.3.277 changed how `modelUsage` counts; the change was found nine days later.
  - Codex CLI 0.158.0 was found by chance, when a standalone installer replaced a local binary.
  - The design's G5 asks for a weekly, non-paid preflight of the latest upstream versions, and none was scheduled.
- **Unlisted models.** Codex 0.158.0 gives a model it does not list a reduced tool set, without `apply_patch` or tool search, and says so only in a warning (TDD-0042). A host that names such a model gets a member that cannot edit files, and no error.
- **Credibility.** Some claims in the documentation no longer match the facts:
  - `docs/status.md` says SPEC-0001 to SPEC-0020 are implemented;
  - `docs/acceptance/readiness.md` was last updated on 2026-09-21;
  - SPEC-0009 F09 says the delegation and tool-call limits are tested, and no test names their codes.
- **Patch paths.** The Codex adapter checks the paths of a file change when it asks the host, and Codex applies an approved change outside the command sandbox (SPEC-0035 B03). A directory replaced by a symbolic link after the check could send the change elsewhere. No test has tried.

## A. Drift preflight

- **A01** `.github/workflows/drift.yml` runs every Monday at 06:00 UTC and on demand, with the Codex and Claude SDK versions as optional inputs; the default is the latest on npm. It runs on `ubuntu-24.04`, `macos-14` and `macos-15-intel`.
  - It installs those versions without saving them.
  - It runs the native smokes of the native CI job with them, except the checks that need the internet and the benchmark.
  - Every smoke runs even when an earlier one fails. A table of the versions and each smoke's result goes to the run's summary, and the run fails when any smoke fails.
  - It opens no issue and changes no file.
- **A02** `scripts/check-native-protocol.mjs` takes the expected versions from `ORCH_EXPECT_CLAUDE_SDK` and `ORCH_EXPECT_CODEX`, defaulting to the pinned `0.3.283` and `0.157.1`.
- **A03** `TESTED_CODEX_VERSIONS`, exported by `@orchvia/adapter-codex`, lists the Codex versions CI runs: 0.153.4, 0.157.1 and 0.158.0. `codexConnection().probe()` adds `tested`: whether the binary's version is one of them. `orchvia doctor` adds `tested` to its `codex-cli` check. An untested version is reported, never refused (D-drift-1 option 2).

## M. Unlisted models

- **M01** A dispatch with `connection` whose model is not in Codex's model list, read as in SPEC-0042 E02 with hidden models and every page, ends before its thread with `CODEX_MODEL_UNLISTED: <model> is not among Codex's models: <first 20 ids>`, outcome `failed`.
  - The dispatch opens no thread and makes no model request.
  - A list that cannot be read, or that lists no model at all, cannot tell, and the dispatch proceeds as before, with `source: 'unverified'`.
- **M02** `createCodexAdapter` takes `allowUnlistedModel: true` for a host whose models Codex does not list, such as a custom provider's. It needs `connection`. With it, an unlisted model proceeds, as in 0.1.19.

## L. Documentation checks

- **L01** `docs/acceptance/readiness.md` lists each gate with its state (closed, partial or open), its evidence, and what would close it.
- **L02** The specifications in the table of `docs/status.md` are exactly the files in `docs/specs`.
- **L03** The Codex versions that `docs/acceptance/readiness.md` lists as verified, and `TESTED_CODEX_VERSIONS`, are exactly the Codex versions `.github/workflows/offline.yml` installs.

## E. Delegation and tool-call limits

- **E01** Deterministic engine tests name `DELEGATION_CHILD_LIMIT`, `DELEGATION_DEPTH_LIMIT` and `TOOL_CALL_LIMIT`. For each they check the error, the `tool.limit_reached` event, the task's reason, and that later calls of the same turn fail. SPEC-0009 F09 cites them.

## C. Approved patch paths

- **C01** A native case of `scripts/native-codex-security-smoke.mjs` runs in `default` mode, where each file change reaches the host. In the host's approval callback, after the adapter has checked the change's paths, it replaces a directory of the workspace with a symbolic link to a directory that commands may only read, then approves. The change must not land there.
  - Measured with Codex 0.157.1 and 0.158.0: Codex writes an approved change within the dispatch's sandbox, so a link redirects it only into places the profile makes writable. This held in `default`, `acceptEdits` and `auto` modes, and without `connection`. It also held when the model's own background process swapped the directory.
  - A link into the temporary directory, which the profile makes writable, does redirect the change there. Commands can write there anyway.
- **C02** The native CI job runs `scripts/native-read-fence-smoke.mjs`, which checks what Claude's Bash commands can read.

## Acceptance

| ID       | Criterion                                                                                                                                | Test                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0043-A01 | The drift workflow has the schedule, the inputs, the three runners, every smoke with a result that does not stop the rest, and a summary | `tests/contract/drift-workflow-0043.test.ts`  |
| 0043-A02 | The protocol check takes its expected versions from the environment                                                                      | same                                          |
| 0043-A03 | `probe()` and `doctor` report `tested`                                                                                                   | `tests/contract/codex-model-0043.test.ts`     |
| 0043-M01 | An unlisted model ends the dispatch before its thread; an empty or unreadable list does not                                              | same                                          |
| 0043-M02 | `allowUnlistedModel` lets an unlisted model proceed, and needs `connection`                                                              | same                                          |
| 0043-L02 | The status table and `docs/specs` agree                                                                                                  | `tests/contract/docs.test.ts`                 |
| 0043-L03 | The verified Codex versions, `TESTED_CODEX_VERSIONS` and CI agree                                                                        | same                                          |
| 0043-E01 | The three limits end their calls as SPEC-0009 F09 says                                                                                   | `tests/engine/delegation-limits-0043.test.ts` |
| 0043-C01 | [Native] Where an approved change goes after its directory became a link                                                                 | `scripts/native-codex-security-smoke.mjs`     |
| 0043-C02 | [Native] Claude's read fence in CI                                                                                                       | `scripts/native-read-fence-smoke.mjs`         |

## Rollback

Reverting restores 0.1.19: no weekly preflight, no `tested` report, unlisted models proceed with the reduced tools, and the documentation claims stand unchecked.
