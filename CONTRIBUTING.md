# Contributing

Thank you for helping. Bug reports and pull requests are welcome; for a larger change, open an issue first so the design can be agreed before code.

## Set up

You need Node.js 22.18 or later and Python 3.11 or later, on macOS or Linux.

```sh
git clone https://github.com/masonlee39/orchvia.git
cd orchvia
npm ci --ignore-scripts
npm test
npm run test:python
```

`npm run typecheck` and `npm run format:check` must pass too. Unix-socket tests need permission to create local sockets; a skipped test is not a pass.

## How changes are made

This project uses TDD. Start from the accepted design and acceptance criteria in `docs/specs/`: define observable behavior, run failing tests, then implement it. Distinguish compilation failures, passing test doubles, and interface responses from production acceptance.

Complete each increment in this order:

1. Write the specification: problem, target behavior, scope, non-goals, state/protocol rules, and numbered acceptance criteria.
2. Write tests for the main call path and relevant failure cases. Cross-language, restart, shutdown, and messaging changes require real subprocess integration, not only mocks of your own methods.
3. Run RED and record the command and actual failure. Behavior that is already correct may receive regression coverage directly; do not fabricate a failure history.
4. Implement GREEN. Refactoring must preserve behavior and passing tests without unrelated changes.
5. Run relevant tests and `npm run typecheck`. Shared wire or lifecycle changes require both `npm test` and `npm run test:python`.
6. Update the specification, runnable README examples, and verification evidence. Distinguish future interfaces from implemented behavior.

The public surface is compared with `schemas/compat-baseline.json` by `tests/contract/compat-baseline-0051.test.ts`. An addition passes. A removal, or an input that became required, fails the test until the version is a new minor, or, when it breaks nothing (a widened input reported as removed, say), until `schemas/compat-accepted.json` lists it with its category and a reason. `node scripts/set-version.mjs` checks the same and then writes the new version's baseline. `node scripts/compat-rollback.mjs` and `node scripts/compat-python.mjs` check a rollback and the Python SDK against the previous release; they need npm and PyPI, and CI runs them (SPEC-0051).

## Tests that depend on time

CI runners are several times slower than a developer's machine, and slower still when busy. Every CI flake so far came from a test that assumed otherwise ([docs/ci-flakes.md](docs/ci-flakes.md)). A test that depends on time:

- takes its clock from `EngineClock`, which the engine accepts through its configuration, instead of waiting for a real deadline, lifetime or interval of under a second;
- waits for a condition, polling with a bound of at least 10 seconds, instead of sleeping a fixed time; the bound only ends a test that is failing anyway;
- waits for a socket, server or tool to say it is ready before using it;
- asserts what happened, not how many milliseconds it took. A product bound, such as a cleanup deadline, is asserted with the engine's clock, or with a margin measured under load.

Before pushing such a test, run it under load: `node scripts/stress.mjs --copies 6 -- node --import ./tests/fixtures/reserve-guard.mjs --test <files>` keeps every core busy and runs six copies at once. The weekly stress workflow runs the whole suite the same way. When a CI run passes only on a second attempt, find the cause and record it in [docs/ci-flakes.md](docs/ci-flakes.md).

A turn's end waits for its files (SPEC-0057), so a test must not read the engine a fixed number of ticks or milliseconds after a runtime's last event. Wait for the task's state, or for `artifactWritesSettled()` from `packages/engine/src/store.ts`.

## Test environment

Ordinary tests use temporary workspace/stateDir directories and a deterministic fake runtime, without login credentials or paid model requests. A test engine uses a 4 KiB emergency reserve (`storage: { emergencyBytes: 4096 }`); the test commands fail any other process that would write a larger one, except the runnable examples. Real Claude/Codex acceptance must separately record versions, identity sources, task budgets, and model results; fake fixtures cannot prove it.

The foundation assumes a trusted local boundary under one OS user. Contributions must not silently expand network listeners, tool permissions, directory access, or automatic recovery. Preserve unknown external outcomes without blind retries. Generated idempotency keys must remain available for recovery after a lost receipt.

Node executes TypeScript source through type stripping, and tests use `node:test`; use only erasable TypeScript syntax. Dependencies are locked in package-lock.json. Normal startup must not download dependencies. Python runtime dependencies are standard-library-only.

Write repository documentation, examples, and source comments in English. Preserve intentional multilingual test data where it verifies Unicode behavior.

The project is licensed under MIT, and contributions are accepted under the same license. Third-party dependencies retain their own licenses. Releases are published by the maintainer through the release workflow; see [docs/release/publishing.md](docs/release/publishing.md).
