# TDD-0046: Tests that depend on time, run under load every week

Specification: [SPEC-0046](../specs/0046-ci-flakes.md). Approved by the owner on 2026-09-29.

- The run history came from GitHub's public API for `offline.yml`: 308 runs from 2026-09-20 to 2026-09-29, 8 with a second attempt. Their causes are from the TDD records and the maintainer's notes; for the two runs of 2026-09-21 the notes name two symptoms without saying which run showed which, and the ledger says so.
- RED: `tests/contract/stress-0046.test.ts` failed 6 of 6: no script, workflow, rules or ledger.
- GREEN: 6 of 6.
- The script was run on real test files, three copies under 18 busy loops: all copies passed, the summary listed them, and no busy loop was left afterwards.
- No YAML parser is installed; the workflow was checked by the test and by Prettier.

## The first flake after the rules

The push run of this branch ([36587076958](https://github.com/masonlee39/orchvia/actions/runs/36587076958)) failed `0019-C04` on macOS 14 with Node 24: a real-time bound of 190 ms on an evaluation with a 50 ms deadline took 217 ms. Following R01, the two tests now record the timers set during the evaluation and check that the 200 ms retry pause never ran to its end, and that no retry was sent. With the pause made to ignore the deadline, the first test fails; six copies under 18 busy loops passed.
