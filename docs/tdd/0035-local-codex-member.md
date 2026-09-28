# TDD-0035: The local Codex CLI as a member (0.1.14 part)

Date: 2026-09-28. Base: `7a94003` (0.1.13 on `main`). Specification: [SPEC-0035](../specs/0035-local-codex-member.md); this record covers A, B, C without C08, E, F, G, H and J. C08, R, I and X follow in 0.1.15.

## Probes before the code

Round 0 and the follow-ups with Codex CLI 0.153.4 and 0.157.1 (and 0.146.0 for some) settled the design; the 0.1.14 part added: `command/exec` without a sandbox parameter runs under the command line's named profile and proxy, and tells the proxy, network without it, and no network apart (F04); `":tmpdir"="write"` opens the temporary directory; `shell_environment_policy.exclude` takes `SSH_AUTH_SOCK` once the shell snapshot is off; `initialize`'s `userAgent` carries Codex's version.

## RED

- **J01 first, test before code.** `tests/contract/codex-local-0035.test.ts` with only the J01 test and `tests/fixtures/codex-compact-usage.ts`, whose compaction sends the previous usage again under its own turn as the real binaries do: it failed, no usage event carrying the thread's totals. With the real binaries, the released adapter recorded `[1000, 2000]` for a compaction the gateway billed 2000.
- **A to H: the code came first.** For these parts the implementation was written before their tests, which is not the order this project requires. The tests were then written from the specification and run against 0.1.13's adapter, with the connection API stubbed since 0.1.13 has none: 17 of 17 failed. That shows the tests fail without the change; it does not show that each test was written before the code it checks.

## Changes

- `packages/adapter-codex/src/app-server.ts`: the app-server connection, moved from `index.ts` unchanged, for the connection API.
- `packages/adapter-codex/src/local.ts`: the connection home and its overlap check, the start lock (in-process chain and a PID lock file in the temporary directory), the version from `userAgent`, the policy check, the named profile, network and host MCP settings, and the proxy check's script and verdict.
- `packages/adapter-codex/src/connection.ts`: `codexConnection` (probe, account, sign-in with an API key, a browser or a device code, waiting, cancelling, sign-out, rate limits).
- `packages/adapter-codex/src/index.ts`: `connection`, `policy`, `denyRead`, `hostMcpServers` and `clientInfo`; per-dispatch profile and approval policy; the lock from spawn to the open thread; one retry of a revoked thread start; the version and proxy checks before the thread; MCP tool elicitations; `acceptEdits`; `SSH_AUTH_SOCK` excluded; usage events with `sessionTotals` and a resumed dispatch counting from its baseline.
- `scripts/native-codex-local-smoke.mjs` and two CI steps: the pinned 0.157.1 with the internet checks, and 0.153.4.
- `tests/contract/adapters.test.ts` expects `sessionTotals` on the Codex usage event; `tests/contract/naming.test.ts` finds the `agent_orch` MCP name in its new place.

Found on the way:

- **A compaction's usage counted twice** (J01): the replay comes under the compaction's own turn, which the turn filter of 0.1.13 cannot tell apart.
- **The temporary directory is all of `TMPDIR`.** The native smoke's "outside" directory under `TMPDIR` was writable; it now lies elsewhere, and the specification says so.
- **Codex's MCP handshake carries the host's token**, so the native check counts tool calls, not authorized requests.
- **A cancelled sign-in** could still be found waiting for a moment; `cancel` now returns after the sign-in has ended.
- **The version guard** (0021-P08) took TEST-NET-1's address for a version; the script builds it.

## The first CI run

Pull request #62's first run failed in three ways, none seen locally:

- **One set of thread totals per dispatch.** The first version put the thread's totals on every usage event, and the engine keeps one set per dispatch and refuses a different second one (SPEC-0032 E01) with `IDEMPOTENCY_CONFLICT`, so every Codex dispatch with two model requests ended `outcome_unknown`; the existing native gateway smoke failed on each runner. The contract tests had not seen it: their dispatches had one usage event each. A test with two requests in one turn failed first; each usage event now goes out when the next arrives or the turn ends, so the last one carries the totals and none is sent twice, and a test checks that usage held back still reaches the host when the turn fails.
- **Linux refuses a direct connection differently.** Under Codex's proxy on Linux the direct connection of the proxy check was `ENETUNREACH`, not `EPERM`; the check now takes `ENETUNREACH` and `EHOSTUNREACH` as refused too, still requiring the proxy variables and a refused Unix socket.
- **Test mistakes.** A contract test expected macOS's `/private/etc/hosts`; the native smoke ran all internet checks in one command, which Codex hands back after 10 s, so the last check's output was missing. Each now runs on its own with time to finish, and a failing smoke prints what its commands printed.

Found while reading those logs, and not changed here: in 0.1.13 already, the orchestration bridge's tools fail under Codex's `never` policy ("MCP tool call requires approval, but approval policy is never"); the gateway smoke does not require the call to succeed.

## GREEN

- New tests: 19 of 19. `npm test` 823 of 823, `npm run test:python` passed. Under one busy loop per core, six copies of the SPEC-0035, SPEC-0038, adapter and Codex policy contract tests: 49 of 49 each.
- Mutations, each restored from a file copy: 12 of 12 killed (plan on any profile, proxy always in force, no start lock, no retry, acceptEdits asking, any elicitation, no version check, no baseline, denyRead not fenced, agent socket passed, home overlap allowed, temporary directory not writable).
- Native, macOS arm64, Codex CLI 0.153.4 and 0.157.1, loopback gateway, synthetic credentials, no model calls, without the internet checks: each profile's reads and writes (the home, a `denyRead` path and a directory outside denied; the workspace and the temporary directory writable in `auto`, nothing in `plan`), no `SSH_AUTH_SOCK` or key variable; `default` asked for the command and the edit, `acceptEdits` for the command only, `auto` for neither; under direct network a real ssh-agent refused (`ssh-add` 2), the Docker-path socket unreachable, the host tool port 401 without the token, no tool called; a Codex without its proxy refused with `CODEX_NETWORK_PROXY_UNAVAILABLE` before any model request; a host MCP tool call asked through an elicitation; the connection API's probe (`userAgent` with the host's name), API key sign-in and sign-out, browser sign-in and cancel; two members on one home at once. J01 with the real binaries: 1000, 2000 and 3000 recorded for 1000, 2000 and 3000 billed.
- After the CI fixes, with 0.153.4 and 0.157.1 locally: the native gateway, security and local-member smokes passed, and J01 recorded 1000, 2000 and 3000. The internet checks (N01) and Linux (N04) run in this change's CI.
