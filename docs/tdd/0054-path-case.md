# TDD-0054: Paths in another case

Specification: [SPEC-0054](../specs/0054-path-case.md).

- Measurement: on APFS, `realpathSync('…/caseprobe/ws')` returned `…/caseprobe/ws` and `realpathSync.native` returned `…/CaseProbe/WS` for a directory created as `CaseProbe/WS`.
- RED, with `packages/engine/src/paths.ts` as a stub that compares strings: 4 of 6 failed:
  - A01: the Claude guard answered `deny` to a Write in the case on disk;
  - A02: the Codex adapter declined the change without asking the host (`asked` 0);
  - E01: reopening the store with the workspace in another case failed with `WORKSPACE_MISMATCH`;
  - E02: a write path in the case on disk failed with `INVALID_WORKSPACE_SCOPE`.
  - P01 and "another directory is still another workspace" are coverage of what must not change.
- GREEN: 6 of 6. A first run of E02 expected the write path in the case on disk; the test was wrong, since the design records the workspace's own spelling (`fs/promises.realpath` is the native call).
- Mutation, restored from a copy: write conflicts compared as strings again fail E02.
- R01, on macOS: `@orchvia/engine@0.1.28` from npm created a store with the workspace spelled `Work/WS` (on disk `WORK/WS`); this release opened it with `WORK/WS` and with `Work/WS`, creating a task each time; 0.1.28 then opened it again with `Work/WS` and created a task.
