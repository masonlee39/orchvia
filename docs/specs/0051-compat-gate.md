# SPEC-0051: A compatibility gate

Date: 2026-09-30. Status: approved by the owner on 2026-09-30 (D-road-4 option 1; D-compat-1 option 1, D-compat-2 option 1, D-compat-3 option 2). Release: 0.1.26. Environments: CI on Linux; the rollback and cross-version checks need npm and PyPI. Evidence: [TDD-0051](../tdd/0051-compat-gate.md).

## Why

The [stability policy](../stability.md) promises that a patch release breaks no public export, wire method or field, event, error code or configuration field. Only people check it. An integrating host upgrades at once to every release, and listed what it relies on: methods, capability flags, events and their data fields, the values it branches on (task, session, approval and operation statuses; task reasons; error codes and their data), and the texts of some reasons, which it parses because no code exists for them. It also named one real path across versions: its hot update rolls back when the new version fails to start, and the older engine then opens a store the newer one wrote.

The engine refuses a store of another schema version (`SCHEMA_MISMATCH`, `packages/engine/src/store.ts`), so a future schema is refused by every engine released so far. Data written in the same schema by a newer engine, such as 0.1.23's steer messages, was never opened by an older one in a test.

## G. The surface baseline

- **G01** `scripts/compat-baseline.mjs` writes `schemas/compat-baseline.json`, the public surface at a version, as sets of tokens:
  - `exports`: each package entry of the five npm packages, its exports as values or types, and the Python package (`orchvia`, `orchvia.routing`): its public names, the public members of its classes, the public methods of the client's namespaces (`orchvia.Orchestrator.tasks.create`), and each parameter of those, marked required (`(spec)`) or optional (`(idempotency_key=)`);
  - `types`: the members of each exported interface, class and object type of those entries, marked optional (`?`), with the members of anonymous object types nested up to three levels (`Orchestrator.tasks.create`), each string or number of a literal union, and a class's static members (`::`), read with the TypeScript compiler;
  - `wire`: each definition of `schemas/protocol.schema.json`, flattened to its property paths, each required property, and each `enum` or `const` value;
  - `methods`: the wire methods the engine dispatches;
  - `events`: the event types the packages emit, with `task.<status>` expanded;
  - `errors`: the error codes the packages raise;
  - `reasons`: the literal task reasons the engine sets;
  - `texts`: the reason and error texts that hosts parse (G03).
- **G02** `tests/contract/compat-baseline-0051.test.ts` builds the surface of the working tree and compares it with the baseline:
  - A token of the baseline that is gone is a breaking change, and so is a newly required input where its owner was already there: a required property of a `*Params` or `*Spec` definition, a required member of an `*Options`, `*Params`, `*Spec` or `*Config` type, or a required Python parameter. It passes only when the version's minor number is higher than the baseline's, or when the token is listed with its category and a reason in `schemas/compat-accepted.json`.
  - The approved design also let a `### Breaking` part of the newest changelog section pass a breaking patch. SPEC-0044 S02 already fails a patch release that has one, so that exception could never apply and was left out: a breaking change needs a new minor version.
  - New tokens pass, and the test names them.
  - The committed baseline is of the working tree's version. `node scripts/set-version.mjs` runs the same check against the new version before it writes anything, then writes the new version's baseline and empties `compat-accepted.json`, so each release's additions are kept from the next release on. The gate is conservative: a change that only widens an input may be reported, and is accepted in `compat-accepted.json`.
- **G03** `texts` lists the fragments a host parses, each with the file that holds it: `outcome_unknown: previous owner exited during a dispatch`, `Execution stop or local cleanup is unconfirmed`, `; cleanup unconfirmed`, `supports`/`was requested` of `CODEX_EFFORT_UNSUPPORTED`, `is not among Codex's models` of `CODEX_MODEL_UNLISTED`, `HOST_HOOK_BYPASSED`, `STOP_MARKER_BYPASSED`. The surface records each fragment only while its file contains it, so changing a text is a breaking change like any other.

## R. Rollback

- **R01** `scripts/compat-rollback.mjs [--previous <version>]` installs the previous published `@orchvia/engine` (the highest version on npm below the working tree's, by default) and checks both directions with the fake runtime:
  - the working tree's engine writes a store with a completed task, a task waiting for acceptance, a steered turn (its operation and message), usage records, a runtime rule, and a label with metadata; the previous engine then opens it and must read every one of them back as written, or refuse with `SCHEMA_MISMATCH` or `STORE_TOO_NEW`; the working tree's engine opens the store again afterwards and reads the same;
  - the previous engine writes such a store, without the steer, and the working tree's engine opens it and reads it back.
  - Anything else, such as an internal error, a crash or a value read differently, fails the check.
- **R02** A store may record `storeFeatures`, `[{ name, engineVersion }]`, in its metadata: data that an engine which does not know the feature cannot read correctly. An engine records a feature in the transaction that first writes such data. Opening a store, writable or read-only, whose features include one the engine does not know fails with `STORE_TOO_NEW`, whose data lists the unknown features and the engine versions that wrote them. Each engine also records `lastEngineVersion` when it opens a store. No data of 0.1.26 is a feature: the mechanism is for later releases, and protects a rollback only to 0.1.26 or later; a rollback to 0.1.25 or earlier is covered by R01 alone.

## P. Python across versions

- **P01** `scripts/compat-python.mjs [--previous <version>]` runs one Python round trip, a fake task created, accepted and completed, through `Orchestrator.local`:
  - the working tree's Python SDK with the previous published `@orchvia/cli` as its host;
  - the previous published `orchvia` from PyPI, in a fresh virtual environment, with the working tree's CLI as its host.

## C. CI

- **C01** The contract workflow runs R01 and P01 in a job of their own on Linux.

## B. The installed command

- **B01** npm installs the `orchvia` command as a symbolic link to `@orchvia/cli`'s `dist/main.js`. The CLI ran only when the path it was started by was the module's own path, so through that link it did nothing and exited 0: `npx orchvia host ...`, or `orchvia` on the path, as the guide's Python example starts it. P01 found it on macOS, whose temporary directory is itself under a symbolic link. The CLI compares the real path of the started file with its own, and the package installation check starts the host through `node_modules/.bin/orchvia`.

## Timing invariants

1. A feature is recorded in the same transaction as the first data that needs it, so no store holds such data without its marker.
2. An engine checks the features before recovery or any write, so a newer store is refused before anything in it changes.

## Acceptance

| ID       | Criterion                                                                                                                                        | Test                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 0051-G01 | The surface has every category, is deterministic, and the committed baseline is of this version with nothing gone                                | `tests/contract/compat-baseline-0051.test.ts`                      |
| 0051-G02 | A removed token, a narrowed enum and a new required input are breaking; additions pass; a higher minor or an acceptance passes a breaking change | same                                                               |
| 0051-G03 | Each parsed text is in the surface while its file holds it                                                                                       | same                                                               |
| 0051-R02 | An unknown feature is refused writable and read-only, with its data, before recovery; `lastEngineVersion` is recorded                            | `tests/engine/store-features-0051.test.ts`                         |
| 0051-R01 | [Network] Both rollback directions against the previous release                                                                                  | `scripts/compat-rollback.mjs`                                      |
| 0051-P01 | [Network] Both Python directions against the previous release                                                                                    | `scripts/compat-python.mjs`                                        |
| 0051-B01 | The CLI runs when started through a symbolic link, and the installed package's `.bin/orchvia` starts a host                                      | `tests/contract/cli-bin-0051.test.ts`, `scripts/package-smoke.mjs` |

## Rollback

Reverting removes the gate and the checks; stores written with `storeFeatures` or `lastEngineVersion` stay readable, since no feature is recorded by 0.1.26.
