# SPEC-0062: A stop marker looks after the runtime has ended; a network without local addresses; what a command reaches with a token it read

Date: 2026-10-02. Status: approved by the owner on 2026-10-02 (D-stop-1 option 1, D-bridge-1 option 1, D-loop-1 option 1). Release: 0.1.33. Environments: macOS and Linux. Storage schema 3 and wire 2.0 are unchanged. Evidence: [TDD-0062](../tdd/0062-stop-look-order-and-remote-network.md). Corrects [SPEC-0034](0034-background-command-stop-proof.md) B03 and [SPEC-0035](0035-local-codex-member.md) F03, F06 and H01; follows [SPEC-0061](0061-review-second-batch.md) E.

## Why

- **A dispatch could end unproven although everything had stopped.** With `stopMarker`, a dispatch is proven stopped when nothing holds its marker and no process in its workspace, started during it, is outside the host's process tree. The look for such processes ran at the same time as the runtime was closed. A process the runtime itself had started, such as an MCP server, is inside the host's tree while the runtime lives and is left to process 1 when it exits. One that took a moment to end after the runtime was therefore counted as a stray, the dispatch was not proven stopped, and the engine ended it with `outcome_unknown: Execution stop or local cleanup is unconfirmed`. With the real Codex 0.157.1 and an MCP server started through a wrapper (`sh -c`, as `npx` does) that ends 700 ms after its input closes, 10 dispatches of 10 ended so.
- **The same order could prove too much.** A process that was still below the runtime when the look ran was not counted, and could outlive the runtime afterwards.
- **A token that a command can read is not a boundary where the command can connect.** SPEC-0061 E says that a Codex member's command reads the Codex process's environment on macOS. Measured with Codex 0.157.1 and 0.158.0: without `connection`, with `networkAccess: true`, a command read the bridge's token and called an orchestration tool through the bridge's socket. With `connection`, the bridge's socket was refused under every network setting, but under `network: 'direct'` a command reached a server on 127.0.0.1, so a host MCP server given by `url` and `token` can be called by a command without the approval that `approval: 'ask'` asks for. SPEC-0035 F06 had relied on the token there.

## S. The order of the look

- **S01** With `stopMarker`, an adapter starts the marker's observation of a dispatch when the dispatch's runtime has ended: for Codex, when the app-server has exited and the processes it had started were ended (SPEC-0034 A03); for Claude, when the cleanup of the dispatch's Claude processes has finished. The observation's time (`closeTimeoutMs`, `cleanupTimeoutMs`) counts from then.
- **S02** An observation that finds strays looks again every 200 ms while its time lasts, for at most 3 seconds, and vouches when a look finds none. Its record says `waited: true` when it looked more than once.
- **S03** An observer the host supplies (`observeExecutionStop`) is called as before.

Invariants:

1. The look for strays happens after the runtime's own processes were ended.
2. Only a look that finds no stray, after the marker's holders are gone, proves a stop. Strays that remain when the time ends leave the dispatch unproven, as before.
3. No lease is released earlier than before, and no evidence kind or event changes.

Cost: the observation no longer overlaps the close. With the real Codex 0.157.1 the end of a dispatch took 364 ms before and 496 ms after.

## N. A network without local addresses

- **N01** `policy().network` also takes `'remote'`: Codex's network proxy with every domain allowed, as `'direct'`, but without `allow_local_binding`. A command reaches the internet through the proxy and no address of this machine: measured with Codex 0.157.1, a request to a server on 127.0.0.1 is answered 403 by the proxy and refused without it, where `'direct'` reaches it.
- **N02** `'direct'` and `{ domains }` are unchanged. `plan` allows only `'off'`, as before, and the proxy check of F04 runs for `'remote'` as for the others.

## D. Documentation

- **D01** The guide and SPEC-0035 F06 and H01 say what a command reaches with what it read: without `connection`, with `networkAccess: true`, the bridge, whose tools are the member's own; with `connection` and `'direct'`, a server on a local address, so a host MCP server's `token` and `approval: 'ask'` are not a boundary there. A host that needs the approval gives the server as a `command`, or sets the network to `'remote'`, `{ domains }` or `'off'`.

## Compatibility

Additions only: the network value `'remote'` and `waited` on a dispatch's observation. A dispatch with `stopMarker` ends about 0.13 seconds later.

## Acceptance

| Id       | Criterion                                                                                                                  | Test                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0062-S01 | A Codex dispatch whose app-server's process ends 700 ms after it is proven stopped, and the process is gone                | `tests/contract/stop-look-order-0062.test.ts` |
| 0062-S01 | A Claude dispatch whose Claude process leaves a process that ends 700 ms later is proven stopped                           | same                                          |
| 0062-S02 | An observation with a stray that ends within its time vouches and says `waited`; with one that stays, it does not vouch    | same                                          |
| 0062-S03 | A host's observer is called while the runtime is being closed, as before                                                   | same                                          |
| 0062-N01 | `'remote'` gives the proxy settings without `allow_local_binding`; another value is refused                                | same                                          |
| 0062-N01 | [Native] Under `'remote'` a command does not reach a server on 127.0.0.1; with the internet check, it reaches the internet | `scripts/native-codex-local-smoke.mjs`        |
| 0062-S01 | [Native] A dispatch with an MCP server behind a wrapper that ends late is proven stopped                                   | same                                          |

## Rollback

Reverting restores 0.1.32's order. A host that set `'remote'` must set `'direct'` or `{ domains }` again: 0.1.32 refuses the value with `CODEX_POLICY_INVALID`.
