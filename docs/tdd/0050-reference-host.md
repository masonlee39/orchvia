# TDD-0050: A recoverable reference host

Specification: [SPEC-0050](../specs/0050-reference-host.md).

- U01 RED: `tests/engine/fake-usage-0050.test.ts` found no usage record for a fake dispatch configured with `usage` (0, expected 1), and the CLI refused the configuration with `Unknown fake provider field: usage`. The case without `usage` passed before: regression coverage. GREEN: 3 of 3.
- W, F, I RED: `tests/contract/reference-host-0050.test.ts` was written before the hosts. The first TypeScript and Python hosts failed 7 of 22:
  - W03 in both languages: the hosts created the review only after the change completed, so with failing tests there was no review task waiting on the change. The hosts now create it after the change's receipt, as invariant 3 states, and the engine holds it (W02).
  - F02 and F03 in both languages ended in `needs_reconcile` instead of `awaiting_review`: killing the host killed its engine during the change's dispatch, a race between the kill and the dispatch. The design now names this: an embedded engine dies with its host, so F02 kills during a held dispatch and expects the receipt found, nothing resent and the dispatch unknown, and F03 kills while nothing runs, at the events that ask for the review's decision.
  - The inspector test failed for the same missing review task, then because the host recorded `blockedBy` before projecting the review's first event; the host now projects first.
  - GREEN: 22 of 22.
- Mutations of the finished TypeScript host, each restored from a copy:
  - a found create sent again under another key: F02 and T04 fail;
  - the checkpoint advanced in its own commit before the events were applied: F03 fails.
  - A replayed usage record written with `INSERT OR REPLACE` instead of `INSERT OR IGNORE` passed: the primary key already keeps one row per record, so it was not a real change.
- T04 in Python: `python/tests/test_reference_host_0050.py`, 4 of 4, the same answers as the TypeScript stand-in test.
- B RED: `tests/contract/bench-0050.test.ts` failed 5 of 5: unknown options `--fake-throw` and `--fake-cost-usd`, unknown arm `parallel`, no report after a harness failure, and a paid run started without `--reserve-usd`. GREEN: 5 of 5, and the earlier benchmark tests, 13 of 13, after the default arms gained `parallel`.
- The RED run of "a paid run requires `--reserve-usd`" called a model: without the guard, the harness ran the fresh arm through the Agent SDK with the machine's Claude sign-in, 4 requests of claude-sonnet-5 before the test's timeout, about $0.53 to $0.65 at list prices. The test now gives the harness a private home without credentials and a model endpoint on a closed loopback port, so that no state of the code under test can reach a model; the guard also runs before anything loads the SDK.
- D RED: `tests/contract/docs.test.ts` 0050-D02 found `not on PyPI` in `docs/design.md`, and 0050-D01/D03 found no reference host README; GREEN after the documentation changes.
