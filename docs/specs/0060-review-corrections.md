# SPEC-0060: Corrections from a review: bounded masking, a start lock that ends, private store files, indexed counts

Date: 2026-10-02. Status: approved by the owner on 2026-10-02 (D-audit-1 option 1: the corrections that change no contract, first). Release: 0.1.32. Environments: macOS and Linux. Storage schema 3 and wire 2.0 are unchanged; two indexes are added. Evidence: [TDD-0060](../tdd/0060-review-corrections.md). Corrects [SPEC-0053](0053-dispatch-progress.md) E07 and [SPEC-0035](0035-local-codex-member.md) A02.

## Why

A review of 0.1.31 found what this specification corrects. Each was reproduced first.

- **Masking could stop the engine.** SPEC-0053 E07 masks what looks like a secret in a command before the first 200 characters of it are kept. The patterns took time that grows with the square or the cube of the text: a command of 6,000 characters made of `token-token-token-…` held the engine's only thread for 8 seconds, and 10,000 characters for 17. A model writes its commands, so text that a model was led to write could stop every session, deadline and client of a host.
- **The Codex start lock could spin forever.** The lock is a file in the temporary directory, which other users share on Linux. A lock file that could not be read or removed made the loop that takes the lock run without ever waiting or looking at its time.
- **Three files of a new store were readable by others.** `store.sqlite-wal`, `store.sqlite-shm` and `owner.sqlite-journal` took the mode of their databases at the moment those were created, 0644, before the databases were set to 0600, and kept it until the store was closed. The state directory is 0700, which kept them private; the files themselves were not.
- **Two counts read whole tables.** The limit of tool calls per dispatch counted with a query that reads every row of `tool_calls`, a table that only grows: a tool call took 0.57 ms in an empty store, 8.3 ms with 20,000 rows and 38.9 ms with 100,000. The message rate limit did the same over `messages`: 0.98, 9.2 and 47 ms.

## M. Masking

- **M01** Masking a text takes time proportional to its length. The two patterns that look for a secret's name are replaced by one pass over the text: each run of letters, digits, `_` and `-` is looked at once, and a run that holds one of the names is followed by its value or it is not.
- **M02** What is masked is what 0.1.31 masked: for the same text, within the examined part, the result is the same.
- **M03** A bounded part of the text is examined: the first 262,144 characters of a command, of which 200 are kept, and the last 262,144 characters of a text, of which 280 are kept. The bound is far above what is kept because a value is masked whole: a quoted key of some thousand characters that begins in the kept part must be seen to its closing quote.
- **M04** The message of an `api_retry` progress is masked as text is; before, it was written as the runtime gave it.

## L. The Codex start lock

- **L01** Taking the lock ends within its time whatever the lock file is: a file that cannot be read or cannot be removed is waited for until the time passes, and then the start fails with `CODEX_START_LOCK_TIMEOUT`, which names the lock file.
- **L02** A lock path that is not a regular file of this user (a symbolic link, a FIFO, a directory, another user's file) is neither read nor followed. The start fails at once with `CODEX_START_LOCK_UNUSABLE`, which names the path.
- **L03** The lock file's place and content are unchanged, so hosts of different versions on one Codex home still start one at a time.

Another user of a shared machine can still refuse this user's starts by leaving a file at the lock's path; the start then fails at once and says which file. Moving the lock to a directory of this user's own changes what two versions share, and is left to a later specification.

## P. Private files

- **P01** When a store or a control directory is opened for writing, its databases (`store.sqlite` and `owner.sqlite` in a state directory, `owner.sqlite` in a control directory) and the files SQLite keeps beside them (`-wal`, `-shm`, `-journal`) are set to 0600 once they exist: those of a new store at its first start, and those that an earlier version left at the next start.

## I. Indexed counts

- **I01** The index `tool_calls_dispatch` on a tool call's dispatch answers the count of a dispatch's tool calls.
- **I02** The index `messages_sender_created` on a message's sender and creation time answers the message rate limit.
- **I03** A store gets both at its next start by this version, in the transaction that creates its tables. An earlier version opens such a store as before: SQLite keeps the indexes up to date by itself.

## Compatibility

No method, field, event or stored value changes. `CODEX_START_LOCK_UNUSABLE` is a new code at the head of a failure's text. A store written by this version opens in 0.1.31.

## Acceptance

| Id       | Criterion                                                                                                                                                                        | Test                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0060-M01 | 6,000 characters that held 0.1.31 for 8 seconds are masked at once through the engine; 200,000 in time proportional to them                                                      | `tests/engine/review-corrections-0060.test.ts` |
| 0060-M02 | Generated texts are masked as the patterns of 0.1.31 mask them                                                                                                                   | same                                           |
| 0060-M03 | A quoted value of 5,000 characters is masked whole; a command longer than the examined part keeps its first 200 characters                                                       | same                                           |
| 0060-M04 | A retry message is masked                                                                                                                                                        | same                                           |
| 0060-L01 | An unreadable lock file ends in `CODEX_START_LOCK_TIMEOUT` within the time                                                                                                       | `tests/contract/codex-start-lock-0060.test.ts` |
| 0060-L02 | A symbolic link, a FIFO and another user's file are refused at once and never read                                                                                               | same                                           |
| 0060-L03 | The lock's path and content are those of 0.1.31                                                                                                                                  | same                                           |
| 0060-P01 | Every file of a new state directory and control directory is 0600 and every directory 0700 while the engine runs; a `-wal` file left with 0644 is 0600 after the store is opened | `tests/engine/review-corrections-0060.test.ts` |
| 0060-I01 | The tool call count's plan names `tool_calls_dispatch`                                                                                                                           | same                                           |
| 0060-I02 | The rate limit's plan names `messages_sender_created`                                                                                                                            | same                                           |
| 0060-I03 | A store without the indexes gets them when it is opened                                                                                                                          | same                                           |

## Rollback

Reverting restores 0.1.31. The two indexes stay in a store and cost nothing but their upkeep; `DROP INDEX` removes them.
