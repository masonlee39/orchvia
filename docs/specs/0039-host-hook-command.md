# SPEC-0039: The host's hook and tool bridge commands, hooks that fail open, and member instructions

Date: 2026-09-28. Status: approved by the owner on 2026-09-28 (D-39-1 to D-39-6, option 1 each). Release: 0.1.16. Extends: SPEC-0035 R and C08, SPEC-0036 and SPEC-0037. Environments: macOS and Linux. Engine, wire schema and storage are unchanged. Evidence: [TDD-0039](../tdd/0039-host-hook-command.md).

## Why

SPEC-0035's host hook runs `process.execPath` with the adapter's `hook.ts` (`hook.js` when built). Two things make that command unusable for some hosts:

- In an Electron application `process.execPath` is the application itself, which runs as Node only with `ELECTRON_RUN_AS_NODE=1`. Put in the app-server's environment, that variable reaches every command the member runs, and breaks the Electron projects a user works on.
- A host that bundles the adapter decides where the hook program lies, and that place can change with each update.

Measured while designing the change, with Codex CLI 0.153.4 and 0.157.1 behind a loopback scripted gateway:

- **Codex fails open.** A hook command that cannot be found, exits 1 or 2, prints something other than JSON, or prints nothing lets the tool run, and the host is never asked. Only an explicit `permissionDecision: "deny"` refuses. The adapter's hook program denies when anything inside it fails, but not when it never starts. In an Electron host the 0.1.15 command starts the application, which prints nothing, so every call runs unasked.
- Codex runs the hook command with the login shell and `-c` (`/bin/zsh -c <command>` was observed), in the app-server's environment, so a variable prefix such as `ELECTRON_RUN_AS_NODE=1 …` applies to the hook process alone.
- The hook's input carries `tool_use_id`, which equals the `id` of the `commandExecution` or `fileChange` item that the call then starts. This holds for single calls, parallel calls in one response, a patch, a different shell, and code mode's nested commands.

## H. Changes

- **H01** `createCodexAdapter` and `codexConnection` take an optional `hostHookCommand: string`, a non-empty string of at most 4096 characters without NUL or line breaks; the adapter takes it only with `hostHook`. The dispatch's `hooks.PreToolUse` setting, its trust check (SPEC-0035 R02), `trustHostHook` and `hostHookTrust` use it as given. Left out, the command is 0.1.15's, byte for byte, so a hook trusted under 0.1.15 stays trusted. A command different from the one trusted leaves the dispatch refused with `HOST_HOOK_UNTRUSTED`, as before.
- **H02** `hostHookCommandFor({ runtime, program, env? })` returns the command that runs `program` with `runtime`, with `env`'s variables as a prefix, each part quoted for a POSIX shell: `NAME='value' 'runtime' 'program'`. Both paths must be absolute; a variable's name must match `[A-Za-z_][A-Za-z0-9_]*`, and no value may contain NUL or a line break.
- **H03** The built package holds `dist/hook.mjs`, the hook program as one ECMAScript module that imports only `node:net`, so it runs wherever it is copied, with no package beside it. `@orchvia/adapter-codex/hook.mjs` resolves to it under every condition, and `hostHookProgram()` returns its absolute path (the source's `hook.ts` when run from the repository). A host copies it to a place that does not change with its updates; Codex trusts the command, not the file's content, so replacing the file at the same path needs no new trust, and H05 checks the new file at the next dispatch.
- **H04** `codexConnection().hostHookTrust()` reports, without writing anything, `{ trusted, status, key, hash, runs, reason? }`: `trusted` and `status` from `hooks/list` for the connection's command, `hash` Codex's current hash (null when Codex does not list the hook), and `runs` whether the command passes H05's check in the connection's environment, with `reason` when it does not. `trustHostHook()` again after a change of command replaces the one trusted entry, so the earlier command is no longer trusted.
- **H05** Before each dispatch with `hostHook` starts its app-server, the adapter runs the hook command itself, the way Codex does: with the login shell (`/bin/sh` when the account has none) and `-c`, in the environment the app-server will get, with a probe as its input. The check passes only when the probe reaches the dispatch's hook channel with its token, and the command exits 0 having printed exactly one JSON object whose `hookSpecificOutput.permissionDecision` is `deny`: the channel refuses the probe without asking the host. Otherwise the dispatch ends before submission with `HOST_HOOK_UNAVAILABLE: …`, outcome `failed`, and no app-server is started. The check has 15 seconds, and no more than the acceptance budget left.
- **H06** The hook channel records the `tool_use_id` of each call the host allowed. When a `commandExecution` or `fileChange` item starts whose `id` the host did not allow, the adapter interrupts the turn at once and ends the dispatch with `HOST_HOOK_BYPASSED: …`, outcome `unknown`, since a command ran that the host never saw. Stop proof follows its usual rules. The interrupt cannot stop what has started.
- **H07** Limits, documented in the guide:
  - Other tools (MCP calls, web search) are not checked by H06; their hook calls still reach the host, but whether Codex honoured the answer is not verified.
  - A hook that fails during a call is caught by H06 only once the tool's item starts.
  - H05 runs the command in the adapter's process tree, not under Codex, so a difference between the two environments that Codex introduces is not seen.

## B. The host's tool bridge command

The orchestration tool bridge, the MCP server `agent_orch` that gives a member `work_delegate` and the other orchestration tools, runs `process.execPath` with the engine's `tool-bridge` module: the same problem as the hook in an Electron host, and a module that a bundled host may not be able to resolve. Measured with both Codex versions: a bridge command that cannot be found, or that exits before its handshake, makes Codex refuse the thread (`required MCP servers failed to initialize: agent_orch`), so no turn runs; the bridge fails closed and needs no probe.

- **B01** `createCodexAdapter` takes an optional `toolBridge: { command, args?, env? }`, used for `agent_orch` instead of `process.execPath` and the engine's module:
  - `command` is an absolute path;
  - `args` is at most 32 strings;
  - `env` holds variables for the bridge process alone, with H02's rules for names and values, and no name starting with `AGENT_ORCH_BRIDGE_`, which carries the bridge's socket and token.
  - No string may contain NUL or a line break.
  - Left out, the bridge is started as before.
- **B02** The built package holds `dist/tool-bridge.mjs`, the bridge as one module that imports only `node:` modules and runs wherever it is copied. `@orchvia/adapter-codex/tool-bridge.mjs` resolves to it under every condition, and `toolBridgeProgram()` returns its absolute path (the engine's `tool-bridge.ts` in the repository).
- **B03** A bridge that does not start ends the dispatch with Codex's error before submission, outcome `failed`, as before.

## K. Client information

- **K01** Codex's `initialize` requires `clientInfo.name` and `clientInfo.version` (both versions' protocol schema; a missing version is refused with `Invalid request: missing field 'version'`). A `clientInfo` without a non-empty `version` string fails `createCodexAdapter` and `codexConnection` with `INVALID_ADAPTER_CONFIG`. Without `clientInfo`, the default `{ name: 'agent_orch', version }` is unchanged.

## D. Member instructions

Measured with both Codex versions behind the loopback gateway: `developerInstructions` exists on `thread/start`, `thread/resume` and `thread/fork`, not on `turn/start`. Given at `thread/start`, it reaches the model as a developer message and stays in the thread. Given again at `thread/resume` or `thread/fork` with other text, Codex ignores it: the model still sees the first text only.

- **D01** `createCodexAdapter` takes an optional `instructions(input) => string | undefined` (or a promise of one). A dispatch that starts a new thread calls it before its app-server starts. It passes a non-empty result as `developerInstructions` on `thread/start`. The text reaches the model and never the task's goal, prompt or events.
- **D02** A dispatch that resumes or forks a thread does not call `instructions`: the thread keeps the text it was started with. A host that changes a member's instructions starts a new session.
- **D03** A result that is not a string or undefined, a string over 256 KiB, or a thrown error ends the dispatch before its app-server starts, outcome `failed`, with `CODEX_INSTRUCTIONS_INVALID: …`.

## M. One marker directory for both adapters

- **M01** `sweepStopMarkers(root)` and `staleStopMarkers(root)`, imported from either `@orchvia/adapter-claude` or `@orchvia/adapter-codex`, cover the markers that Claude and Codex dispatches of earlier instances left under `root`, whichever adapter made them.
- **M02** `endStopMarkersSync(root, timeoutMs)`, imported from either package, ends the commands that both adapters of this process mark under `root`. It covers the adapters that share its copy of `@orchvia/engine`; both adapter packages of one version depend on the same engine version, which a package manager installs once. With two copies, the sweep, which reads the directory, still covers both.

## Timing invariants

1. The hook channel records an allowed `tool_use_id` before it answers the hook program, and Codex starts the item only after it reads that answer, so a genuine call is recorded before its `item/started` is read.
2. H05 finishes before the app-server is spawned; a failed check starts nothing and submits nothing.
3. A call the host refused, or one the channel never answered, is never recorded, so its item, if Codex starts it anyway, is a bypass.

## Acceptance

| ID       | Criterion                                                                                                                                                                                                                   | Test                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0039-H01 | `hostHookCommand` is validated, reaches the setting, the trust check and `trustHostHook` unchanged; left out, the 0.1.15 command; a different command is refused as untrusted                                               | `tests/contract/codex-hook-command-0039.test.ts`                                        |
| 0039-H02 | `hostHookCommandFor` quotes paths with spaces and quotes and a variable prefix, and rejects relative paths and bad names or values; the command it makes runs through a shell                                               | same                                                                                    |
| 0039-H03 | The built package has `dist/hook.mjs`, exported as `./hook.mjs`; a copy in a directory without a package denies when it cannot reach the host; `hostHookProgram()` names a real file                                        | same, and `scripts/package-smoke.mjs`                                                   |
| 0039-H04 | `hostHookTrust` reports trust, hash and whether the command runs, and writes nothing                                                                                                                                        | `tests/contract/codex-hook-command-0039.test.ts`                                        |
| 0039-H05 | A missing, failing, silent or chattering hook command refuses the dispatch before its app-server starts; a working one, including one with a variable prefix, passes                                                        | same                                                                                    |
| 0039-H06 | A command or file change item the host did not allow interrupts the turn and ends it `HOST_HOOK_BYPASSED`; allowed items, parallel ones included, do not                                                                    | same                                                                                    |
| 0039-B01 | `toolBridge` is validated; its command, arguments and variables make the `agent_orch` entry, the variables stay out of the app-server's environment; left out, the entry is unchanged                                       | `tests/contract/codex-hook-command-0039.test.ts`                                        |
| 0039-B02 | `toolBridgeProgram()` serves the orchestration tools over the bridge's channel; the built `dist/tool-bridge.mjs` does so from a copy with no package beside it                                                              | same, and `scripts/package-smoke.mjs`                                                   |
| 0039-K01 | A `clientInfo` without `version` is refused by the adapter and the connection; one with it reaches `initialize`                                                                                                             | same                                                                                    |
| 0039-D01 | A new thread gets `instructions`' text as `developerInstructions`; a resumed or forked one neither calls it nor passes it; a bad result, an oversized one or an error ends the dispatch before its app-server starts        | same                                                                                    |
| 0039-M01 | A sweep from either package ends the commands that a Claude and a Codex dispatch of a dead instance left under one root                                                                                                     | `tests/contract/stop-marker-mixed-0039.test.ts`                                         |
| 0039-M02 | A synchronous cleanup from either package ends the commands of a running Claude and a running Codex dispatch under one root                                                                                                 | same                                                                                    |
| 0039-N01 | [Native] Real Codex: a host command with a variable prefix is trusted and asked before each call; a broken command refuses the dispatch; one that fails after the probe is caught as a bypass; `hostHookTrust` reports both | `scripts/native-codex-local-smoke.mjs` (CI: macOS and Linux, Codex 0.153.4 and 0.157.1) |

| 0039-N02 | [Native] Real Codex: a bridge started through `toolBridge` with a variable prefix serves a tool call to the host; the member's instructions reach the model once as a developer message and are not sent again on resume | `scripts/native-codex-local-smoke.mjs` |

## Rollback

Reverting restores 0.1.15: the fixed hook and bridge commands, a hook that fails open when its command does not start, no member instructions, and a `clientInfo` without `version` that fails at Codex's `initialize`. A host on 0.1.15 should use `hostHook` only where `process.execPath` is a Node binary and the package's files stay in place.
