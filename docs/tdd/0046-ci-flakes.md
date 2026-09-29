# TDD-0046: Tests that depend on time, run under load every week

Specification: [SPEC-0046](../specs/0046-ci-flakes.md). Approved by the owner on 2026-09-29.

- The run history came from GitHub's public API for `offline.yml`: 308 runs from 2026-09-20 to 2026-09-29, 8 with a second attempt. Their causes are from the TDD records and the maintainer's notes; for the two runs of 2026-09-21 the notes name two symptoms without saying which run showed which, and the ledger says so.
- RED: `tests/contract/stress-0046.test.ts` failed 6 of 6: no script, workflow, rules or ledger.
- GREEN: 6 of 6.
- The script was run on real test files, three copies under 18 busy loops: all copies passed, the summary listed them, and no busy loop was left afterwards.
- No YAML parser is installed; the workflow was checked by the test and by Prettier.
