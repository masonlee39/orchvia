# TDD-0041: A proxy check the sandbox cannot read, and npm's download delay

Specification: [SPEC-0041](../specs/0041-proxy-check-paths.md). Approved by the owner on 2026-09-28 (D-41-1 option 3).

## Found

- An integrating Electron host verified 0.1.17 with Codex 0.157.1 and its production `denyRead`: the hook, the bridge and the proxy check all ran the host's way.
- It had first copied `proxy-check.mjs` into a directory that its `denyRead` lists. The check then failed with `the check printed no result`, since it runs inside the sandbox, where the hook and the bridge do not. The advice to copy it there came from this project and did not take `denyRead` into account.
- The 0.1.17 release showed npm's delay (TDD-0021, the sixteenth release).

## RED

`tests/contract/codex-proxy-check-paths-0041.test.ts`, 2 of 3 failed:

- `AC-0041-C01 a check the sandbox cannot read…`: the dispatch went on to the check instead of failing before its app-server.
- `AC-0041-C03`: `npm install` ran once, outside `eventually`.

`AC-0041-C01 a readable check…` passed at once; it is regression coverage.

## Changes

- `local.ts`: `deniedCheckPath`, the first absolute path of the check, resolved to its real location, inside a denied directory.
- `index.ts`: the denied directories (`denyRead`, the Codex home, the state directory) are computed once for the profile and for the check. A networked dispatch whose check lies in one ends before its app-server.
- `scripts/registry-check.mjs`: `npm install` inside `eventually`.
- The guide says where the check must lie.

## GREEN

- `codex-proxy-check-paths-0041.test.ts`, 3 of 3.
- Native (0041-N01), locally with Codex 0.153.4 and 0.157.1: a copy of `proxyCheckProgram()` in a directory under `denyRead`, with direct network, ended the dispatch before the thread. The error was `CODEX_NETWORK_PROXY_UNAVAILABLE: the proxy check needs <copy>, which lies in <directory>, …`. Every other case of the smoke passed.
