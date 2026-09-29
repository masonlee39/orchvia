# TDD-0043: Upstream drift, unlisted models, and credibility checks

Specification: [SPEC-0043](../specs/0043-drift-and-credibility.md). Approved by the owner on 2026-09-29.

## A. Drift preflight

- `.github/workflows/drift.yml` was written before `tests/contract/drift-workflow-0043.test.ts`. The test's RED was observed on a checkout of `origin/main` without the workflow: 3 of 3 failed (`ENOENT` for the workflow, no environment variables in the protocol check). On this branch it passes, 3 of 3.
- No YAML parser is installed, so the workflow was parsed with Prettier. Its summary logic was run in a shell with a failing entry, and it wrote the table and exited 1. The version check refused `x;rm`.
- `ORCH_EXPECT_CODEX=0.158.0 node scripts/check-native-protocol.mjs` passed with Codex 0.158.0, and `9.9.9` failed.
- RED of `codex-model-0043.test.ts` A03, with only `TESTED_CODEX_VERSIONS` added so that the file loads: `probe()` had no `tested`, and `doctor` had none either.

## M. Unlisted models

- RED: an unlisted model proceeded; `allowUnlistedModel` was not validated.
- The Codex fixture's model list, read with hidden models and without `FIXTURE_MODELS`, now names no model, which the adapter cannot check against. Four SPEC-0042 cases with unlisted models now pass `allowUnlistedModel`.
- GREEN: `codex-model-0043.test.ts` 4 of 4, with `codex-effort-0042.test.ts` 5 of 5.

## L. Documentation checks

- RED:
  - `0043-L02` failed because the status table lacked SPEC-0043;
  - `0043-L03` failed because the ledger did not name the verified Codex versions.
- The first version of L03's parser split `0.153.4` at its first dot. It now reads the versions with a pattern.
- The status summary names no range of specifications and points at the table and the TDD records.
- The ledger was rebuilt with a state, evidence and next step for each gate, and it lists the verified versions.

## E. Delegation and tool-call limits

`tests/engine/delegation-limits-0043.test.ts`, 3 of 3, passed on the unchanged engine: they are regression coverage, with no RED. Two mutations were each caught:

- a child limit one higher failed the child test;
- `tool.limit_reached` left unwritten failed all three.

## C. Approved patch paths

Measured with Codex 0.157.1 and 0.158.0, with a scratch home, the loopback scripted gateway and synthetic credentials.

- The first version of C01 linked the directory to one under the temporary directory, and the change landed there. The profile makes the temporary directory writable (`:tmpdir`), so that was no escape.
- Every later run linked to a directory in the working directory, which commands may only read. The change did not land there in any of these cases:
  - the host swapping the directory after the adapter's check (`default` mode);
  - the model's background process swapping it two seconds later, while the host took four seconds to approve (`default`);
  - a background loop swapping it every 5 ms, 5 dispatches each, in `acceptEdits` and `auto` modes;
  - the same loop, and a single early swap, without `connection`, 5 dispatches each.
- With a link into the temporary directory, the `auto` loop redirected the change there in 5 of 5 dispatches. That is where the profile lets commands write anyway.
- C01 now asserts that an approved change never lands in a directory commands may only read, and it passed with both versions.
- C02: `scripts/native-read-fence-smoke.mjs` passed on this Mac with the pinned Claude SDK: the home directory and `denyRead` paths are refused, and the workspace is readable. The native CI job now runs it on each runner.
