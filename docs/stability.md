# Stability

Orchvia is alpha software, and it is used by applications that upgrade it. This page says what an upgrade may change ([SPEC-0044](specs/0044-onboarding-and-stability.md) S01).

## Stable surfaces

- The public exports of `@orchvia/sdk`, `@orchvia/engine`, `@orchvia/adapter-claude`, `@orchvia/adapter-codex`, `@orchvia/cli` and the Python package `orchvia`. Paths under `internal/` are not public.
- The wire: its methods, their parameters and results, as `schemas/protocol.schema.json` defines them.
- Event types and the fields of their data.
- Error codes, including the codes that begin a failure message, such as `CODEX_EFFORT_UNSUPPORTED: …`.
- Configuration fields, of the engine, the adapters and the CLI's JSON host, and CLI commands and flags.

## What a release may change

Before 1.0:

- **A patch release**, such as 0.1.21 after 0.1.20, only adds optional things, such as a field, a method, a flag or an error code for a case that failed before. It may fix a defect, if the fix does not change documented behavior.
- **A minor release**, such as 0.2.0 after 0.1.x, may break a stable surface: remove or rename it, change its type, change a default, or refuse something that was accepted. Its changelog section has a "Breaking" part that says what changed and how to move.
- **Deprecation.** A surface marked deprecated stays at least until the next minor release, and the code warns where it can.
- A test fails when a release from 0.1.21 on has a "Breaking" part without a new minor version (SPEC-0044 S02).
- A test compares the public surface with `schemas/compat-baseline.json`, the surface of the release before: package exports and their types, the Python package, the wire schema, methods, events, error codes, task reasons and the texts hosts parse. A removed token, or an input that became required, fails it unless the version is a new minor (SPEC-0051 G). Every pull request also opens a store of this release with the previous release, and the reverse, and runs the Python SDK of each release with the host of the other (SPEC-0051 R01, P01).

An application that depends on `~0.1.20` receives patch releases only.

## The protocol version

The engine accepts protocol `2.0` exactly. It announces optional features in `initialize`'s `capabilities.workflow`, for example `usageByTask` or `reasoningEfforts`. A client checks a flag before it uses the feature, so a newer client can tell an older host's missing feature from a failure. The SDKs do this for the features they wrap.

## Upstream runtimes

The Claude Agent SDK and the Codex CLI change on their own schedule. Which of their versions are verified is recorded in the [readiness ledger](acceptance/readiness.md). A weekly check runs the newest ones and reports, without changing what Orchvia accepts.
