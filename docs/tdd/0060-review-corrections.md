# TDD-0060: Corrections from a review

Specification: [SPEC-0060](../specs/0060-review-corrections.md).

## Reproductions, before any test

- Masking: the patterns of 0.1.31 on a text of `token-` repeated took 17.1 seconds for 10,000 characters; on `a-` repeated, 0.12, 0.45, 1.9 and 7.5 seconds for 10,000, 20,000, 40,000 and 80,000. Through the engine, one `tool_started` whose command was 1,500, 3,000 and 6,000 characters of `token-` held `reportProgress` for 1.5, 2.4 and 8.2 seconds. Ordinary text of 80,000 characters took 0.4 ms.
- Start lock: with a lock file of mode 000, `startLock(home, 500)` never returned and its process was ended after 6 seconds; with a lock holding the PID of another running process it failed after 509 ms, as intended.
- Files: a new state directory held `store.sqlite-wal`, `store.sqlite-shm` and `owner.sqlite-journal` with mode 644 beside databases of mode 600.
- Counts: with 0, 20,000 and 100,000 rows, a tool call took 0.57, 8.31 and 38.92 ms and `messages.send` 0.98, 9.18 and 47 ms; both plans were `SCAN`.

## RED

- `tests/engine/review-corrections-0060.test.ts`: 9 of 10 failed. M01 through the engine took 7.1 seconds; M01 and M02 had no `masking.ts`; M04 wrote the key; both P01 tests found the three files with 644; I01 and I02 found `SCAN`; I03 found no index. M03 describes what 0.1.31 already did for a long value, and passed.
- `tests/contract/codex-start-lock-0060.test.ts`: 5 of 6 failed. The unreadable lock and the FIFO each ended only when the test ended their process after 10 seconds; the timeout did not name the lock file; the symbolic link was read through and removed; `unusableLock` did not exist. L03, the lock's path and content, passed. A lock that cannot be taken is tried in a process of its own, so that a loop that never ends fails the test instead of holding the run.

## GREEN

- Both files pass, 10 of 10 and 6 of 6.
- Masking: `packages/engine/src/masking.ts`. Beyond the committed 40,000 generated texts, 3,000,000 more, from words and from single characters, gave the same result as the patterns of 0.1.31 with no difference. Through the engine, commands of 1,500, 6,000 and 60,000 characters of `token-` now take 1 ms.
- A first version examined only the first 1,024 characters of a command. A quoted value longer than that, such as a private key, was then not seen to its closing quote, and its first characters were kept unmasked, which 0.1.31 did not do. The examined part is now 262,144 characters, and M03 holds a quoted value of 5,000 characters.
- A first version also created each database with mode 0600 before SQLite opened it. Setting the files' modes once they exist gives the same result with one call, and without it the tests fail; the earlier creation changed nothing a test could see and was removed.
- Counts after the indexes, same measurement: a tool call 0.64, 0.36 and 0.47 ms; `messages.send` 0.77, 0.71 and 1.94 ms; both plans `SEARCH … USING COVERING INDEX`.

## Mutations, each restored from a copy

Each fails a test: the examined part cut to 1,024 characters (M03); a flag's name accepted without a dash before it, and a masked value looked at again (M02); the lock's owner not checked (L02); the time not looked at when the lock cannot be read (L01); the database's, the lock's and the control directory's files left as SQLite made them (P01, three mutations).
