# TDD-0047: The benchmark counts every arm the same way

Specification: [SPEC-0047](../specs/0047-bench-metering.md). Approved by the owner on 2026-09-29.

- RED: `tests/contract/bench-metering-0047.test.ts` could not load: `bench/meter.mjs` did not exist. After the module, the report test failed alone: the report had no price table or parts.
- The first gateway run after the change reported the single arm's calls outside the main loop as unknown from its second request on: the metering subtracted the previous request's totals, while the bundled Claude Code, 2.1.274, does not continue them. The metering now follows the Claude adapter's version rule, and a test covers both versions and an unreadable one.
- GREEN: 7 of 7, and the existing benchmark tests 6 of 6.
- `node bench/run.mjs --gateway --require-pass` with Claude Code 2.1.274 and the loopback gateway: every arm passed 4 of 4 and reported the same parts (1,200 input and 240 output tokens, nothing outside the main loop, $0.0048). The gateway makes no call outside the main loop, so M02's equality for such calls rests on the unit test.
