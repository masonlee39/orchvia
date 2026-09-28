# SPEC-0041: A proxy check the sandbox cannot read, and npm's download delay

Date: 2026-09-28. Status: approved by the owner on 2026-09-28 (D-41-1 option 3). Release: 0.1.18. Extends: SPEC-0040. Environments: macOS and Linux. Engine, wire schema and storage are unchanged. Evidence: [TDD-0041](../tdd/0041-proxy-check-paths.md).

## Why

- **A check the sandbox cannot read.** The proxy check (SPEC-0035 F04, SPEC-0040) runs inside the command sandbox, under the dispatch's profile, since it must see what commands see. The hook and the tool bridge run outside it. An integrating host copied `proxy-check.mjs` into a directory it also lists in `denyRead`. The check could not read its program, and every networked dispatch failed with `CODEX_NETWORK_PROXY_UNAVAILABLE: the check printed no result`, which does not name the cause. The failure is safe, but the cause took a real run to find.
- **npm's download delay.** The release workflow's registry check waits for `npm view` to report the new version, then runs `npm install` once. On 2026-09-28, eight minutes after 0.1.17 was published, `npm view` answered, but the archive `engine-0.1.17.tgz` still returned 404. Both registry jobs failed although every package was published; a rerun passed.

## C. Changes

- **C01** Before a dispatch with network starts its app-server, the adapter checks each path the proxy check needs: the command, and each argument that is an absolute path. These are `proxyCheck.command` and `proxyCheck.args`, or `process.execPath` without `proxyCheck`. Each existing path is resolved to its real location.
  - A path inside a directory the dispatch's profile denies ends the dispatch before submission, outcome `failed`. Those directories are `denyRead`, as resolved for the dispatch, the Codex home and the state directory. The error is `CODEX_NETWORK_PROXY_UNAVAILABLE: …`, naming the path and the denied directory.
  - Arguments that are not absolute paths are not paths the check reads, and are not checked.
- **C02** The guide says where the check's program and runtime must be: where the member's commands can read them, which the hook's and the bridge's need not be.
- **C03** `scripts/registry-check.mjs` retries `npm install` as it retries `npm view` and `pip install`, for up to 10 minutes.

## Acceptance

| ID       | Criterion                                                                                                                                                                                                                     | Test                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0041-C01 | A check program or runtime under `denyRead`, the Codex home or the state directory ends a networked dispatch before its app-server, naming the path; a readable one, a non-path argument, and a dispatch without network pass | `tests/contract/codex-proxy-check-paths-0041.test.ts` |
| 0041-C03 | The registry check retries `npm install`                                                                                                                                                                                      | same                                                  |
| 0041-N01 | [Native] Real Codex, direct network: a `proxyCheck` program under `denyRead` is refused before the thread with the path named                                                                                                 | `scripts/native-codex-local-smoke.mjs`                |

## Rollback

Reverting restores 0.1.17: a check that cannot read its program fails with `the check printed no result`, and a registry check can fail while npm's archives are still arriving.
