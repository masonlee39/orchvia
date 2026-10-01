# SPEC-0054: Paths in another case

Date: 2026-10-01. Status: approved by the owner on 2026-10-01 (D-case-1 option 1, D-case-2 option 1, D-case-3 option 1). Release: 0.1.29. Environments: case-insensitive volumes (macOS by default) for the case tests, which skip elsewhere; every platform for the rest. Evidence: [TDD-0054](../tdd/0054-path-case.md).

## Why

An integrating host registered its workspace as `/Users/x/Work/Project` on macOS, whose volume ignores case, while the directory on disk is named `/Users/x/WORK/Project`. Node's `realpathSync` resolves symbolic links but keeps the case it is given, so the adapters kept the registered spelling. The Claude process works in the directory as the volume names it, and the model names files that way; the Claude guard compared the two spellings with `relative()` and refused a Write inside the workspace as outside it. Bash, which the guard does not check by path, wrote the same file. The Codex adapter's file-change check and the engine's write paths compared paths the same way.

`realpathSync.native` returns each name in the case on disk. Using it where the engine records a path would change the record: an engine released before this one compares the record with the host's spelling as a string, and would refuse the store with `WORKSPACE_MISMATCH` after a rollback.

## P. Paths compared as the volume names them

- **P01** `canonicalPath(path)` (`packages/engine/src/paths.ts`) is `realpathSync.native` of the nearest existing ancestor, followed by the names that do not exist yet. `samePath`, `insidePath` and `rebasePath` compare and rebase paths through it.
- **P02** Only comparisons use it. What the engine records, the store's workspace, the control plane's manifest and a task's write paths, keeps the spelling it had before: the host's path with its symbolic links resolved (`realpathSync`). The checks that a path holds no symbolic link, `realpathSync(path) !== path`, keep `realpathSync`, which does not change case, so that another spelling is not taken for a link.

## A. The adapters

- **A01** The Claude guard resolves the workspace, the state directory, the write roots, the read roots and each tool's target with `realpathSync.native`, so a Read, Write, Edit, NotebookEdit, Glob or Grep inside the workspace is allowed in either spelling, and a path outside it is still refused.
- **A02** The Codex adapter resolves the workspace, its state directory and home, the write paths and each file change's paths as the volume names them, and the denied-read paths of a local member.

## E. The engine

- **E01** A store whose recorded workspace names the same directory as the host's workspace in another spelling opens; the record is not rewritten, so an engine released before this one still opens the store after a rollback. Another directory is still `WORKSPACE_MISMATCH`.
- **E02** A write path given in another spelling of a path inside the workspace is inside it, and is recorded in the workspace's own spelling. Write conflicts compare recorded write paths as the volume names them, so a task recorded before an upgrade in one spelling conflicts with one in another.
- **E03** The control plane compares a manifest's state directory with the host's in the same way, and management directories that overlap the workspace in another spelling are refused; a stop-marker directory that overlaps the workspace or state directory in another spelling is refused.

## Timing invariants

None: paths are compared, never rewritten, and no persisted value changes.

## Acceptance

| ID | Criterion | Test |
| --- | --- | --- |
| 0054-P01 | `canonicalPath` resolves what exists and keeps what does not; `samePath` tells directories apart | `tests/engine/workspace-case-0054.test.ts` |
| 0054-A01 | A Claude Write, Edit, Read and Glob inside a workspace registered in another case are allowed; a path outside is refused | `tests/contract/workspace-case-0054.test.ts` |
| 0054-A02 | A Codex file change named in the case on disk is approved in a workspace registered in another | same |
| 0054-E01 | A store opens with its workspace in another spelling, its record unchanged; another directory is refused | `tests/engine/workspace-case-0054.test.ts` |
| 0054-E02 | A write path in the case on disk is accepted and recorded in the workspace's spelling; write conflicts across spellings are found | same |
| 0054-R01 | [Manual, macOS] 0.1.28 creates a store with one spelling, this release opens it with both, and 0.1.28 opens it again | TDD-0054 |

## Rollback

Reverting restores string comparison. No stored value changed, so a store used by this release opens in the release before it with the spelling it was created with.
