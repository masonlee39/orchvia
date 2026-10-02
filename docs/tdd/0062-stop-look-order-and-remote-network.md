# TDD-0062: A stop marker looks after the runtime has ended; a network without local addresses

Specification: [SPEC-0062](../specs/0062-stop-look-order-and-remote-network.md).

## Reproductions, before any test

- A host reported that, of several tests with the real Codex run one after another, a later one sometimes ended with `outcome_unknown: Execution stop or local cleanup is unconfirmed`, and never when run alone.
- With the fixture app-server and a process of its own that ends 700 ms after SIGTERM, the dispatch was not proven stopped 3 times of 3, in 0.1.32 as well: the observation's record was `reason: 'strays'`, the stray was that process, and its ancestor was process 1.
- With the real Codex 0.157.1 behind the scripted gateway, 12 dispatches and then 20 under 16 busy loops, with only the orchestration bridge, were all proven stopped. So were 5 each with a host MCP server started directly, ending at once or 700 ms late, and with one behind `sh -c` that ends at once: Codex ends the servers it started itself. With one behind `sh -c` that ends 700 ms late, 3 of 5 and then 10 of 10 were not proven stopped, with the same record.
- A prototype that started the observation after the close, removed again, proved all 10, and the end of a dispatch took 496 ms instead of 364.
- The reporting host has only the bridge, started directly, which this does not reproduce; its record of the next occurrence will tell.
- Network: under `'direct'` a command reached a server on 127.0.0.1 (200 through the proxy and without it); without `allow_local_binding` the proxy answered 403 and the connection without it was refused. The bridge's socket was refused under `'off'`, `'direct'` and `{ domains }`. Without `connection`, with `networkAccess: true`, a command called an orchestration tool through the bridge with the token it had read.

## RED

`tests/contract/stop-look-order-0062.test.ts`: 4 of 5 failed. Both S01 tests ended not proven, with the stray named; S02 did not vouch for a process that ended 900 ms later; N01 refused `'remote'`. S03, a host's observer is called while the runtime is closed, describes what 0.1.32 does and passed.

## GREEN

- The file passes, 5 of 5, six times in a row.
- A first version of the two S01 tests passed with the look at its old place as well, because the second look made up for it. The Codex test now requires that the observation found nothing to wait for, and the Claude stand-in takes 400 ms to exit, so that a look at the terminal vouches while its process still lives.
- With no limit on the looks, tests that leave a real stray waited their whole time, 15 to 30 seconds, and one ran into its timeout. The looks now end after 3 seconds, as a sweep's wait does.
- S02 first used real processes that end after a set time, and failed under load when `lsof` took longer than they lived. It now gives the observation its looks' answers through the test seam `listStrays`, and no longer depends on time.
- Under load (`scripts/stress.mjs`, 6 copies of the stop marker and Codex test files), four older tests overshot budgets of 1, 2 and 8 seconds; they are in [ci-flakes.md](../ci-flakes.md). The last run passed in all 6 copies.

## Native, with the real Codex binary and a scripted loopback gateway

`scripts/native-codex-local-smoke.mjs` with Codex 0.157.1 and 0.158.0 on macOS: `marker-late-server`, an MCP server behind `sh -c` that ends 700 ms late, is proven stopped; `network-remote`: Codex refuses a command's request to 127.0.0.1 (`local/private network addresses are blocked by the sandbox policy`), no request reaches the host's tool port, and a connection without the proxy is refused. The internet check and Linux are measured by CI.

## Mutations, each restored from a copy

Each fails a test: the Codex look while the app-server is closed, and the Claude look at the terminal (S01); no second look, no limit of 3 seconds, the strays forgotten when a look cannot be made, `waited` not recorded (S02); a host's observer deferred as well (S03); `'remote'` with local addresses, and `plan` allowing it (N01).
