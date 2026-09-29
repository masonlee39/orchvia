# SPEC-0049: A Claude API error keeps its own text

Date: 2026-09-29. Status: a defect an integrating host reported; fixed on the principle of its earlier corrections. Release: 0.1.23. The wire is unchanged. Evidence: [TDD-0049](../tdd/0049-claude-error-text.md).

## Why

When the model API fails during a turn, such as a connection lost mid-response, the Claude Agent SDK ends the query with a result of subtype `success`, `is_error: true`, and the error's text in `result`. The Claude adapter took the error message from `errors`, and without them from `subtype`, so the dispatch failed with the message `success`, which became the task's reason. The real cause was lost.

## E. The error message

- **E01** A Claude result that is an error (a subtype other than `success`, or `is_error: true`) fails the dispatch with, as its message: the `errors` joined with `; ` when there are any; otherwise the `result` text when it is a nonempty string; otherwise the subtype. Its outcome stays `failed`.

## Acceptance

| ID       | Criterion                                                                                | Test                                            |
| -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0049-E01 | `success` with `is_error` keeps the `result` text; `errors` come first; the subtype last | `tests/contract/claude-error-text-0049.test.ts` |

## Rollback

Reverting restores the subtype as the message.
