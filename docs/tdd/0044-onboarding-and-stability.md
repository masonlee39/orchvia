# TDD-0044: A stability policy, settling a task, and examples that run

Specification: [SPEC-0044](../specs/0044-onboarding-and-stability.md). Approved by the owner on 2026-09-29.

## S. Stability policy

- `docs/stability.md` was written, and `docs/design.md` now says that the engine accepts protocol 2.0 exactly and announces optional features as `capabilities.workflow.*` flags.
- `0044-S02` in `tests/contract/version.test.ts` checks the changelog from 0.1.21 on. Its checker is test code, so the test carries its own cases: a patch release with a "Breaking" section is caught, and a minor release with one, or a release before 0.1.21, is not. The real changelog passes. There was no RED to observe: no release from 0.1.21 on existed.

## T. Settling a task

- RED, TypeScript: `tests/contract/settle-0044.test.ts` failed 5 of 5 with `task.settle is not a function`.
- RED, Python: `python/tests/test_settle_0044.py`, run on a checkout of `origin/main`, failed to import `SettledTask`.
- GREEN: 5 of 5 and 3 of 3.
- The quickstarts, `docs/design.md`'s examples and the Claude quickstart use `settle()`. The Claude quickstart's own loop stopped at a failed or blocked task; `settle()` does the same.
- `0044-T04`, in `tests/contract/examples-0044.test.ts`, runs both offline quickstarts from a copy of `package.json`, `packages`, `examples` and `python/src` without `node_modules`. It passed before the README changed, since the quickstarts never needed the dependencies: it is regression coverage, with no RED. The copy runs without the reserve guard, which exempts only the repository's own `examples/`.

## E. Examples that run

- `crash-recovery` (both languages) prints the same four lines. The first host reports the task once `dispatch.runtime_accepted` is read, and the parent kills it only then. The TypeScript version counts the second host's dispatches; the Python version, whose host runs the CLI's fake provider, counts `dispatch.started` events of the task and subtracts the one before the crash.
- `team-mailbox` (both languages) prints the same three lines. The fake runtime's result is its prompt, so the helper's result shows the message it received. The Python version starts `examples/typescript/team-host.ts`, a custom stdio host, which is the pattern of E05.
- `0044-E03` runs every example that needs no person and no model, `connect.ts` against a Unix host in the test process, and `fake_roundtrip.py`, which gained `--emergency-bytes` so that the test can give it the 4 KiB reserve. It also compares the files in `examples/` with a list that says where each runs or why it does not. GREEN: 7 of 7. These examples were written before the test, so there is no RED.

## E04. The rule judge

- RED, TypeScript: `tests/contract/rule-judge-0044.test.ts` failed to load: `routing.ts` did not export `createRuleJudge`.
- RED, Python: `python/tests/test_rule_judge_0044.py` failed to import `RuleJudge`.
- GREEN: 4 of 4 in each language.
- Mutation: without the 0.6 cap on the `best` answer's confidence, two tests failed in each language, the router test included.

## E05. Writable members from Python

`examples/typescript/writable-host.ts` passes the type check. Started from Python with a scratch Codex home, a scratch marker directory and no model call, the host answered `capabilities.get` with both members, each with `terminalCoversExecution: true`, and closed. No task was run: that would call Claude and Codex.

## Checks

- `npm test` 897 of 897, `npm run test:python` 113 of 113, the type check, Prettier and the generated-code check passed.
- Under load, one busy loop per core and six copies at `nice 10`, the examples, settle and rule-judge tests passed 16 of 16 in each copy.
