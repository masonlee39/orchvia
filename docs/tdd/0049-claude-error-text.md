# TDD-0049: A Claude API error keeps its own text

Specification: [SPEC-0049](../specs/0049-claude-error-text.md).

- Reported by an integrating host with 0.1.22: a dispatch whose Claude session ended with an API error, `Connection lost mid-response`, failed with the message `success`.
- RED: `tests/contract/claude-error-text-0049.test.ts` reproduced it: a result of subtype `success` with `is_error: true` and the error in `result` failed with `success`. The case with `errors`, and the one with only a subtype, passed before: regression coverage.
- GREEN: 2 of 2, and the Claude usage and interruption tests, 38 of 38 together.
- The release run of `v0.1.23` failed this test on macOS 14 with Node 24: the fixture's Claude process had 20 ms to end, the runner took longer, and the adapter added `(cleanup unconfirmed)` to the message, which the test compared exactly. The test now allows 5 seconds and checks that the message begins with the error's text. Six copies under 18 busy loops passed, and with the adapter of 0.1.22 the test still fails.
