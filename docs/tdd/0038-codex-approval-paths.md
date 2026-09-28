# TDD-0038: Codex file change paths and command environment

Date: 2026-09-28. Base: `868ca2b` (0.1.12 on `main`). Specification: [SPEC-0038](../specs/0038-codex-approval-paths.md).

## RED

- `tests/contract/codex-approval-paths-0038.test.ts` on the base, with only the tests and the fixture `tests/fixtures/codex-file-change.ts` added: 8 of 8 failed. Every change outside the write paths was forwarded and approved (`actual: 'accept'`), the host's payload had no `changes`, and the app-server's arguments had neither `features.shell_snapshot=false` nor `shell_environment_policy.ignore_default_excludes=false`.
- `scripts/native-codex-security-smoke.mjs` with the base adapter, real Codex CLI 0.153.4 and 0.157.1, loopback gateway, no model calls: both failed every check. The approved patch wrote `.planted-by-patch` into the home directory and the host was asked with no paths; the command printed the bridge's token and `key=sk-synthetic-offline`, and its call through the bridge returned `{"result":{"ok":true}}`.

## Changes

- `packages/adapter-codex/src/index.ts`: the `fileChange` items of the turn by ID; `canonicalPath` and `checkedChanges`; a file change request declined when its paths are not all inside the write paths, and otherwise forwarded with `changes`; the two settings in `defensiveArgs`.
- `scripts/native-codex-security-smoke.mjs` and its CI step.

Found on the way:

- **The environment settings had never worked.** The probes of SPEC-0035 showed that with the shell snapshot on, `exclude`, `inherit = "core"` and `include_only` all leave every variable in commands, and that without it `exclude` works; `ignore_default_excludes = false` then also drops names containing `KEY`, `SECRET` or `TOKEN`. Codex 0.146.0 starts with both settings too.
- **The host is not asked for a change inside the workspace.** In the writable profile Codex applies such a change without asking, and asks only for one outside its writable roots, which are the write paths, and which the adapter now refuses itself. The native case therefore checks that the host is not asked at all; the contract test checks the paths the host sees.
- **A surviving mutation.** Accepting a dangling symbolic link as its parent's child survived the first tests; writing through such a link creates the file it names, so a link to a file outside the workspace is now tested.

## GREEN

- New tests: 8 of 8; with the Codex approval and policy tests, six copies in parallel under one busy loop per core: 16 of 16 each. `npm test` 805 of 805, `npm run test:python` 106 of 106.
- Mutations, each restored from a file copy: 7 of 7 killed (forwarding unchecked, no real path, move ignored, workspace instead of the write paths, shell snapshot kept, default excludes off, dangling link accepted).
- Native, macOS arm64, loopback gateway, no model calls: Codex CLI 0.146.0, 0.153.4 and 0.157.1 passed; the patch outside was not written and the host was not asked, the patch inside was written, and the command printed `token=unset key=unset plain=plain-value`, its call through the bridge failing.
