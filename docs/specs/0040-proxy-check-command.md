# SPEC-0040: The host's proxy check command, and two release fixes

Date: 2026-09-28. Status: approved by the owner on 2026-09-28 (D-40-1 option 1, D-40-2 option 1). Release: 0.1.17. Extends: SPEC-0035 F04 and SPEC-0039 B. Environments: macOS and Linux. Engine, wire schema and storage are unchanged. Evidence: [TDD-0040](../tdd/0040-proxy-check-command.md).

## Why

SPEC-0035 F04 checks, before a dispatch with network, that Codex's proxy is in force: `command/exec` runs `[process.execPath, '-e', <check>, <socket>]` under the dispatch's profile. In an Electron host, `process.execPath` is the application, which prints nothing, so every networked dispatch fails with `CODEX_NETWORK_PROXY_UNAVAILABLE: the check printed no result` and makes no model request. The failure is safe, since nothing runs without the check, but it blocks networked Codex members in such a host. After SPEC-0039 the check is the last place where the Codex adapter runs `process.execPath` with no way for the host to choose. The other two are the hook (`hostHookCommand`) and the tool bridge (`toolBridge`).

Codex's `command/exec` takes `env`, overrides merged into the environment of that one process (both supported versions' protocol schema). A variable given there does not reach the member's commands.

## P. Changes

- **P01** `createCodexAdapter` takes an optional `proxyCheck: { command, args?, env? }`, validated as `toolBridge` (SPEC-0039 B01). In addition, no variable name in `env` may contain `PROXY` in any case, since the check reads the proxy variables to decide. It needs `connection`.
- **P02** With `proxyCheck`, the check runs `command/exec` with `command: [command, ...args, <socket>]` and `env` as given, under the dispatch's profile as before. Left out, the command is 0.1.16's.
- **P03** The built package holds `dist/proxy-check.mjs`, the check as one module that takes the socket as its last argument, imports only `node:` modules and runs wherever it is copied. `@orchvia/adapter-codex/proxy-check.mjs` resolves to it under every condition, and `proxyCheckProgram()` returns its absolute path (the source's `proxy-check.ts` in the repository). Given the same socket and environment, it prints the same result as the built-in check.
- **P04** The verdict and its failures are unchanged: output that is not the check's result, a proxy not in force, or a direct connection that is not refused ends the dispatch with `CODEX_NETWORK_PROXY_UNAVAILABLE` before its thread.

## R. Release fixes

- **R01** `test_node_reconcile.test_a_socket_client_cannot_submit_owner_attestation` waited for the host's socket file and then connected once. On macOS the file exists after `bind` and before `listen`, and a connection in between is refused (`ECONNREFUSED`, errno 61), as a CI run on 2026-09-28 showed. The test now waits until a connection is accepted.
- **R02** The release workflow's registry check waited 10 minutes for PyPI. On 2026-09-28, PyPI's simple index did not list `orchvia` 0.1.16 for longer than that after the upload, and both registry jobs failed although every package was published. It now waits up to 25 minutes, and the job's time limit goes from 30 to 45 minutes.

## Acceptance

| ID       | Criterion                                                                                                                                                                              | Test                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0040-P01 | `proxyCheck` is validated, including proxy variable names, and needs `connection`                                                                                                      | `tests/contract/codex-proxy-check-0040.test.ts` |
| 0040-P02 | With `proxyCheck`, `command/exec` gets its command, arguments, the socket and `env`, which the app-server's environment lacks; left out, the command is unchanged; the verdict is kept | same                                            |
| 0040-P03 | `proxyCheckProgram()` prints what the built-in check prints for the same socket; the built `dist/proxy-check.mjs` runs from a copy with no package beside it                           | same, and `scripts/package-smoke.mjs`           |
| 0040-R01 | The Python socket test connects only once the host accepts connections                                                                                                                 | `python/tests/test_node_reconcile.py`           |
| 0040-R02 | The registry check waits up to 25 minutes for PyPI within a 45-minute job                                                                                                              | `tests/contract/codex-proxy-check-0040.test.ts` |
| 0040-N01 | [Native] Real Codex, direct network: a check run by a runtime that works only with a variable from `proxyCheck.env` passes, and the member's command does not see that variable        | `scripts/native-codex-local-smoke.mjs`          |

## Rollback

Reverting restores 0.1.16: a networked Codex dispatch in a host whose `process.execPath` is not Node fails before its thread. Such a host can instead give `ELECTRON_RUN_AS_NODE=1` in the adapter's `env`, at the cost of that variable reaching every command of the member.
