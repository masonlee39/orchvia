# TDD-0040: The host's proxy check command, and two release fixes

Specification: [SPEC-0040](../specs/0040-proxy-check-command.md). Approved by the owner on 2026-09-28 (D-40-1 option 1, D-40-2 option 1).

## Found

- An integrating Electron host reported the problem. With 0.1.16 and Codex 0.157.1, `network: 'direct'` failed with `CODEX_NETWORK_PROXY_UNAVAILABLE: the check printed no result` and no model request.
- An audit of the adapters' sources found three places that run `process.execPath`: the hook's default command, the tool bridge's default command, and the proxy check. The first two can be replaced by the host since SPEC-0039. The check was missed then.
- Both supported Codex versions' protocol schema gives `command/exec` an `env`, overrides for that process only.

## RED

`tests/contract/codex-proxy-check-0040.test.ts`, with only `proxy-check.ts` and `proxyCheckProgram()` added so that the file loads: 3 of 5 failed.

- `AC-0040-P01`: no error for a `proxyCheck` with a relative command.
- `AC-0040-P02` with `proxyCheck`: `command/exec` still ran `process.execPath` with the built-in script.
- `AC-0040-R02`: the PyPI wait was 10 minutes.

`AC-0040-P02` without `proxyCheck`, and `AC-0040-P03` (the program prints what the built-in check prints), passed at once. They are regression coverage.

R01 has no RED test of its own. The race needs the host to be preempted between `bind` and `listen`. Its cause was shown directly on this Mac:

- after `bind` and before `listen`, the socket file exists and a connection fails with `[Errno 61] Connection refused`, the error of the CI run;
- after `listen`, the same connection succeeds.

## Changes

- `local.ts`: a shared `checkChildCommand` behind `checkToolBridge` and the new `checkProxyCheck`, which refuses variable names containing `PROXY`; `proxyCheckProgram()`.
- `index.ts`: `proxyCheck`, which needs `connection`. The check's `command/exec` gets `[command, ...args, socket]` and `env`.
- `packages/adapter-codex/src/proxy-check.ts`: the check as a program. The export `./proxy-check.mjs` is bundled by the build (SPEC-0039).
- `python/tests/test_node_reconcile.py`: waits until the host accepts a connection.
- `scripts/registry-check.mjs`: 25 minutes for PyPI. `.github/workflows/release.yml`: the registry job's limit is 45 minutes.
- `scripts/package-smoke.mjs`: the built check resolves by `import` and `require`, runs from a copy and reaches a listening socket. The socket lies under `/tmp`, since a path in a macOS temporary directory can pass the 104-byte limit.

## GREEN

- `codex-proxy-check-0040.test.ts`, 5 of 5; `test_node_reconcile.py`, 3 of 3.
- The built 0.1.17 packages, installed offline: `hook.mjs`, `tool-bridge.mjs` and `proxy-check.mjs` resolve and run from copies.
- Native (0040-N01), locally with Codex 0.153.4 and 0.157.1, direct network, through a runtime that runs the check only when `ORCH_CHECK_PREFIX=on` is set:
  - with that variable in `proxyCheck.env`, the dispatch completed, and the member's command saw `check=none`;
  - without it, the dispatch failed with `CODEX_NETWORK_PROXY_UNAVAILABLE: the check printed no result`, the error the host reported, so the check that passed was the host's.
