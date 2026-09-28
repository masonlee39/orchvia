# SPEC-0038: Codex file change paths and command environment

Date: 2026-09-28. Status: approved by the owner on 2026-09-28 (D-0038-1 option 1). Release: 0.1.13. Corrects: the Codex adapter of 0.1.0 to 0.1.12. Environments: macOS and Linux. Engine, wire schema and storage are unchanged; the permission payload the Codex adapter hands to `requestPermission` gains a field. Evidence: [TDD-0038](../tdd/0038-codex-approval-paths.md).

## Why

Two defects, found while probing the local Codex member of SPEC-0035 and reproduced with the released adapter and Codex CLI 0.153.4 and 0.157.1:

- **A file change approved outside the workspace.** Codex asks to approve a file change with `item/fileChange/requestApproval`, which names only the item (`itemId`), not its paths. The adapter handed that request to the host as it was, so a host could not see what it approved, and when it approved, Codex applied the patch itself, in the app-server, outside the command sandbox: a patch that added a file in the user's home directory was written there.
- **Credentials in commands' environment.** The adapter excluded the orchestration bridge's `AGENT_ORCH_BRIDGE_*` variables with `shell_environment_policy.exclude`, but Codex's shell snapshot, on by default, exports the app-server's whole environment again in each command, so no exclude, `inherit` or `include_only` setting had any effect. Commands saw the bridge's token and every credential of the app-server's environment, such as `OPENAI_API_KEY`. With `networkAccess: true` a command could reach the bridge's socket and call an orchestration tool itself, as a repository's test script run by the model could.

## P. Changes

- **P01** When a `item/fileChange/requestApproval` arrives, the adapter takes the paths of the `fileChange` item that Codex started before it with the same item ID in the same turn: each change's `path` and, for an update that moves the file, `kind.move_path`. Each path is resolved against the workspace and then to its real location: the real path of the path itself or, when it does not exist yet, of its nearest existing ancestor, followed by the missing names. A dangling symbolic link, or a path that cannot be resolved, is not accepted.
  - When the item was not seen, is malformed, or names a path outside every write path (the workspace, or `writePaths`), the adapter declines the request itself, without asking the host.
  - Otherwise the host's `permission` payload carries, besides Codex's own fields, `changes: [{ path, kind, movePath? }]`, with the resolved paths and `kind` one of `add`, `delete` and `update`.
- **P02** Codex starts, for `execute` and `inspect`, with `features.shell_snapshot=false` and `shell_environment_policy.ignore_default_excludes=false`, besides the existing exclude of `AGENT_ORCH_BRIDGE_*`. Commands then see neither the bridge's variables nor any variable whose name contains `KEY`, `SECRET` or `TOKEN`, which Codex excludes by default. This changes behavior: a command that used such a variable from the host's environment, for example `GITHUB_TOKEN`, no longer gets it.

## Timing invariants

1. The `item/started` notification of a file change precedes its approval request on the app-server's output, which the adapter reads in order; both Codex versions were observed to send them so.
2. A request whose item has not been seen is declined, never forwarded, so an out-of-order or missing item cannot let a change through.

## Acceptance

| ID       | Criterion                                                                                                                                                                                                                                               | Test                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 0038-P01 | A change outside the workspace, through a symbolic link or a dangling one leaving it, moved out of it, outside narrowed write paths, or whose item was never seen, is declined without asking; a change inside reaches the host with its resolved paths | `tests/contract/codex-approval-paths-0038.test.ts` |
| 0038-P02 | Codex starts without the shell snapshot and with the default excludes                                                                                                                                                                                   | same                                               |
| 0038-N01 | [Native] Real Codex: a host that approves everything; a patch into the home directory is not written and the host is not asked; a patch inside the workspace is written                                                                                 | `scripts/native-codex-security-smoke.mjs`          |
| 0038-N02 | [Native] Real Codex, `networkAccess: true`, the orchestration bridge: a command sees neither the bridge's token nor `OPENAI_API_KEY`, keeps an ordinary variable, and cannot call a tool through the bridge                                             | same                                               |

The native criteria run in CI with the pinned Codex CLI 0.157.1, and were run locally with 0.146.0, 0.153.4 and 0.157.1.

## Rollback

Reverting restores 0.1.12's behavior and both defects. A host that must stay on an earlier version should not approve Codex file changes, or should use the read-only profile, and should not set `networkAccess: true`.
