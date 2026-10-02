# SPEC-0035: The local Codex CLI as a member

Date: 2026-09-28. Status: approved by the owner on 2026-09-28 (D-35-10), after the downstream host agreed to every part (rounds R1 to R4 and the network follow-ups). Decisions: D-35-1 to D-35-11 (below). Release: A, B, C (without C08 and C09), E, F, G, H and J in 0.1.14; C08, C09, R, I and X in 0.1.15 (D-35-11), after [SPEC-0038](./0038-codex-approval-paths.md) (0.1.13). Environments: macOS arm64 and x86-64, Linux; Windows is unsupported. Engine, wire and storage are unchanged; everything here is the Codex adapter's configuration and a new connection API in `@orchvia/adapter-codex`. Evidence: [TDD-0035](../tdd/0035-local-codex-member.md).

## Why

A host wants to run the Codex CLI that the user installed and signed in to as a member: the user's own login and version, the host's own approval, tools and file fence, and the same stop proof as a Claude member. The adapter of 0.1.13 keeps its own Codex home under the state directory, knows only two sandbox parameters, declines host MCP approvals, and cannot prove that a Codex command stopped.

## Decisions

| ID      | Choice                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-35-1  | Verify against Codex CLI 0.153.4 and 0.157.1                                                                                                                      |
| D-35-2  | No full-access mode in this release                                                                                                                               |
| D-35-3  | `acceptEdits` = `untrusted` with the adapter accepting file changes inside the write paths                                                                        |
| D-35-4  | The writable profile allows writes to the temporary directory                                                                                                     |
| D-35-5  | `trustHostHook()` writes the one hook trust entry; an untrusted hook refuses the dispatch                                                                         |
| D-35-6  | Direct network through Codex's network proxy (`mode = "full"`, local addresses allowed, domains `*`), chosen per dispatch; also a limited mode with a domain list |
| D-35-7  | A command run by `/bin/sh` ends the turn and fails the dispatch                                                                                                   |
| D-35-9  | Internet use under the proxy verified locally and in CI                                                                                                           |
| D-35-10 | This specification approved                                                                                                                                       |
| D-35-13 | Fix the bridge's tools under `never` in 0.1.14                                                                                                                    |
| D-35-11 | Two releases: 0.1.14 without the host hook, stop markers and code-mode record; 0.1.15 with them                                                                   |

## A. The connection home

- **A01** `createCodexAdapter({ connection: { home } })`: `CODEX_HOME` and `CODEX_SQLITE_HOME` point at `home`, an absolute directory that the host owns and that is disjoint from every workspace and state directory. Orchvia writes nothing there except C08's trust entry; its settings go on the command line (`-c`). Without `connection`, the adapter keeps 0.1.13's managed home under the state directory. Codex itself writes its login, sessions and locks in `home`.
- **A02** App-servers on one home start one at a time, from the spawn until the thread is open: an in-process lock, and across processes a lock file in the system temporary directory named by a hash of the home's real path (`orchvia-codex-<hash>.lock`, holding the owner's PID; one whose process is gone is taken over), never inside the home. A lock not free within the acceptance time fails the dispatch with `CODEX_START_LOCK_TIMEOUT`. [SPEC-0060](0060-review-corrections.md) L makes that hold for a lock file that cannot be read or removed, and refuses what is not a regular file of this user with `CODEX_START_LOCK_UNUSABLE`.
- **A03** When `thread/start` fails while another process signs in or out on the same home (observed with 0.157.1: "application network permission was revoked"), the adapter retries it once.

## B. What commands can read and write

- **B01** The adapter uses Codex's named permission profiles (`default_permissions` and `permissions.<name>.filesystem`) instead of the sandbox parameter, because only they keep an approved command inside the profile. The read profile: the file system readable, `none` for the connection home, the state directory, `denyRead` and the stop marker root's other instances; the stop marker instance directory readable. The write profile adds the workspace (or `writePaths`) and the temporary directory as writable (D-35-4): Codex's `:tmpdir`, the whole of `TMPDIR`, not a directory of the dispatch's own. The settings are `-c default_permissions="orchvia"` and `-c permissions.orchvia={filesystem={…}}`; a `none` path wins over the readable root and over a writable workspace that contains it.
- **B02** `denyRead: string[]` takes the same shape as the Claude adapter's (absolute or workspace-relative paths), so one list can fence both members (R1).
- **B03** A file change is checked as in SPEC-0038 in every mode, because Codex applies approved patches outside the sandbox.
- **B04** Commands see no credentials (SPEC-0038 P02), and `SSH_AUTH_SOCK` is not passed to them.

## C. The connection API

`codexConnection({ command, home, clientInfo? })`, exported by `@orchvia/adapter-codex`, needs no engine; each call runs a short-lived app-server on `home` under A02's lock.

- **C01** `probe()`: `{ version, supported, userAgent, codexHome, platform }`; `CODEX_NOT_FOUND` when the command cannot run.
- **C02** `account()`: Codex's `account/read`.
- **C03** `login({ type: 'apiKey', apiKey } | { type: 'chatgpt' } | { type: 'chatgptDeviceCode' })`: returns `loginId` and the authorization URL or device code; an API key is handed to Codex and not kept.
- **C04** `waitForLogin(loginId, { timeoutMs })`, `cancel(loginId)`: the `account/login/completed` result; a cancelled or unknown login is reported as Codex reports it.
- **C05** `logout()`, `rateLimits()`.
- **C06** `clientInfo: { name, title, version }` is passed to `initialize`, for these calls and for the adapter's dispatches; the default stays `agent_orch`.
- **C07** Real sign-in (device code, API key, browser) is accepted by the downstream host's owner with their own account, not by Orchvia's tests.
- **C08** `trustHostHook()`: starts an app-server with the hook a dispatch passes, reads its key and hash from `hooks/list`, and writes `hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0".trusted_hash` through Codex's own `config/batchWrite`, the one entry that ever reaches the home's `config.toml` (D-35-5). It returns `{ key, hash }`. The hook command is this Node running the adapter's hook program, so a host that moves its Node or the package trusts again.
- **C09** `models({ cursor?, includeHidden?, limit? })`: Codex's `model/list`, the models the sign-in can use, one page at a time, as Codex answers (`{ data, nextCursor }`); asked for by the downstream host for its model list.

## E. Versions

- **E01** The minimum version is 0.153.4, read from `initialize`'s `userAgent` (`<client>/<version> (…)`) in each dispatch, so a binary the user upgrades is seen at once. `CODEX_NOT_FOUND` and `CODEX_VERSION_UNSUPPORTED` (also for a `userAgent` without a version) refuse a dispatch before its thread opens.
- **E02** The compatibility matrix is 0.153.4 and 0.157.1, in CI.

## F. Modes and network, per dispatch

- **F01** `policy(input) => { mode, network }` on the adapter, a host callback, sets each dispatch; without it, a read-only dispatch is `plan` and a writable one `auto`, without network. With `connection`, the adapter serves both profiles unless `permissionProfile` names one, and `networkAccess` is refused: the policy sets the network. The JSON CLI keeps the fixed profiles.

| `mode`        | Profile | Codex approval policy | Commands                          | File changes                                            |
| ------------- | ------- | --------------------- | --------------------------------- | ------------------------------------------------------- |
| `plan`        | read    | `never`               | read only                         | none                                                    |
| `default`     | write   | `untrusted`           | each asks the host                | each asks the host                                      |
| `acceptEdits` | write   | `untrusted`           | each asks the host                | accepted by the adapter inside the write paths (D-35-3) |
| `auto`        | write   | `on-request`          | inside the profile without asking | inside the write paths without asking                   |

- **F02** A `plan` dispatch must be read-only and the others writable; anything else, or a mode not listed (full access, D-35-2), fails with `CODEX_POLICY_INVALID` before submission.
- **F03** `network`: `'off'` (default), `'direct'`, or `{ domains: string[] }`. `plan` allows only `'off'`.
  - `'direct'` is Codex's network proxy (`features.network_proxy = true`, `network = { enabled = true, mode = "full", allow_local_binding = true, domains = { "*" = "allow" } }`), never `network = { enabled = true }` without the proxy, which lets commands reach any Unix socket.
  - `{ domains }` is the same proxy with only those domains and without local addresses.
- **F04** Before a dispatch with network opens its thread, the adapter checks the proxy with Codex's `command/exec` (which, without a sandbox parameter, runs under the dispatch's profile), running this Node on a short script: `HTTPS_PROXY` is set, a connection to a Unix socket the adapter listens on is refused, and a direct connection to TEST-NET-1 (192.0.2.1:80) is refused, with `EPERM` or `EACCES`. With Codex 0.153.4 and 0.157.1 the three states differ: the proxy gives set, refused, refused; network without the proxy gives unset, connected, a timeout; no network gives unset, refused, refused. If the check cannot run or any part differs, the dispatch fails before submission with `CODEX_NETWORK_PROXY_UNAVAILABLE`; the adapter never falls back to network without the proxy.
- **F05** Under `'direct'`, programs that ignore the proxy variables, such as `git` over ssh, cannot connect; this is documented.
- **F06** Local ports differ by platform under `'direct'`: on macOS a command reaches a port on 127.0.0.1 (the host's tool port answers 401 without its token); in CI's Linux sandbox it reaches none, so local services such as a development server or a database are out of reach there. Either way a host tool without its token is never called.

## G. Approvals

- **G01** Command, file change and MCP tool approvals reach the host's one `requestPermission` (whose `toolName` is the request's method) with their kind: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (with `changes`), and `mcpServer/elicitation/request` whose `_meta.codex_approval_kind` is `mcp_tool_call`, answered `{ action: 'accept' | 'decline', content: {} }`. Every other request is declined.
- **G02** The orchestration bridge's MCP server (`agent_orch`) has `default_tools_approval_mode = "approve"`: its tools act on the dispatch's own grant, and Codex's `never` policy refused every call to them since the bridge existed (D-35-13).

## H. Host tools

- **H01** `hostMcpServers: { [name]: { command, args?, env?, approval? } | { url, token, approval? } }`. A URL server's token reaches Codex through an environment variable whose name contains `TOKEN`, so commands never see it. `approval` is `'ask'` (default, Codex's `prompt`, through G01) or `'approve'` (Codex's `approve`, no question). A stdio server's `env` reaches it through the app-server's environment and `env_vars`, never the command line, and its names are excluded from commands' environment; a URL server's token goes in `ORCHVIA_HOST_MCP_TOKEN_<n>`. Codex's own MCP handshake carries the token.
- **H02** Host MCP servers run outside the command sandbox; what they can reach is the host's responsibility.

## R. The host's command rules

- **R01** `hostHook(event) => { allow: true } | { allow: false, reason? }`, a host callback with `connection`, receives each command, file change and other tool call before it runs, in every mode: `{ kind: 'command' | 'fileChange' | 'tool', tool, command?, patch?, input?, taskId, sessionId, dispatchId }`. It runs through Codex's `PreToolUse` hook, passed with `-c` (hooks are otherwise disabled): Codex runs Orchvia's hook program (`hook.ts`) outside the sandbox, which asks the adapter over a Unix socket in a private directory with a 32-byte token, both in `ORCHVIA_HOOK_*`, which commands never see. A refusal reaches the model with its reason. The program refuses whatever it cannot ask about: no channel, a wrong token, a failing callback, no answer within 590 s.
- **R02** A dispatch with `hostHook` whose hook `hooks/list` does not show trusted fails before its thread with `HOST_HOOK_UNTRUSTED`.
- **R03** The hook sees text only, and neither the shell nor `login` that the model chose; it is a policy, not a sandbox. Codex's `.rules` files are not used: `-c` and thread settings are silently ignored, and a prefix rule is bypassed by `command rm`, `xargs rm`, `$(echo rm)` or `perl`.

## I. Stop markers

- **I01** `stopMarker: true | { directory, onObservation? }` as for Claude (SPEC-0034, SPEC-0036, SPEC-0037), under the same root, with the same sweep, `keepProven`, acknowledgement and synchronous cleanups. With it, a Codex dispatch no longer needs owner reconciliation.
- **I02** Each command holds the marker as descriptor 9 through a private `ZDOTDIR/.zshenv` and `BASH_ENV` in the marker instance directory, which open `ORCHVIA_STOP_MARKER` (a failed open stops the command) and then run the user's own `.zshenv` (from their `ZDOTDIR`, else `HOME`) or `BASH_ENV`, which are not changed. Under a named profile the instance directory is readable only, even inside the writable temporary directory, and a host directory's other instances are `none`. The adapter's `endStopMarkersSync(timeoutMs)` and the Claude adapter's stop marker functions, which `@orchvia/adapter-codex` also exports, work for Codex markers alike.
- **I03** A login shell other than zsh or bash fails the dispatch before submission with `STOP_MARKER_UNSUPPORTED_SHELL`.
- **I04** A command whose item shows `/bin/sh` (the model may choose `sh`, or a shell Codex replaces with `sh`) runs without the marker: the adapter interrupts the turn and fails the dispatch with `STOP_MARKER_BYPASSED`, and the lease is not released automatically.
- **I05** The workspace check of SPEC-0034 B03 covers a process that dropped the marker and stayed in the workspace; a process that leaves the workspace first, or one a system service starts, is not covered. A bash started with a socket as its input by a program a command runs, as Node's `child_process` does, reads `~/.bashrc` instead of `BASH_ENV` when it is the first shell of its tree, and so holds no marker unless it inherited one.

## X. Codex's code mode

- **X01** The default model of both versions has a code-mode `exec` tool that composes the other tools in a JavaScript isolate. Measured with 0.153.4 and 0.157.1: a command it runs through `exec_command` is asked about under `untrusted`, passes the host hook as `Bash`, holds the marker, and shows its shell in its item; no path leaves any of them out.

## J. The rest

- **J01** Codex sends a resumed thread's previous usage again, and a compaction does so under its own turn, which 0.1.13 counted again. Each usage event now carries `sessionTotals: { codexThreadTotal }`, the thread's totals, which the engine hands to the next dispatch on the thread as `usageBaseline` (SPEC-0032); a resumed dispatch counts from them and skips the totals it was given. A fork keeps 0.1.13's counting. A subscription sign-in reports cost as unknown.
- **J02** Provider names (`codex-plan`, `codex-write`, …) and `capabilities.get({ provider })` stay as they are; `forkModelChange` stays false.

## Failures

A check that refuses a dispatch before submission ends it with an `error` event whose message starts with the code and a colon, such as `CODEX_POLICY_INVALID: mode plan does not fit the workspace-write profile`, and whose outcome is `failed`: the runtime event has no code field, and the engine is unchanged. The codes are `CODEX_NOT_FOUND`, `CODEX_VERSION_UNSUPPORTED`, `CODEX_POLICY_INVALID`, `CODEX_HOME_OVERLAP`, `CODEX_START_LOCK_TIMEOUT` and `CODEX_NETWORK_PROXY_UNAVAILABLE`, and in 0.1.15 `HOST_HOOK_UNTRUSTED`, `STOP_MARKER_UNSUPPORTED_SHELL` and `STOP_MARKER_BYPASSED`. The connection API throws errors with `code` set. A bad configuration still fails `createCodexAdapter` with `INVALID_ADAPTER_CONFIG`.

## Timing invariants

1. On one home at most one app-server is starting (A02).
2. A dispatch's marker, its record and the stop marker environment exist before its first command (I01, SPEC-0036 invariant 1).
3. The proxy check (F04), the hook trust check (R02), the shell check (I03) and the version check (E01) all finish before the turn is submitted; a failed check never submits.
4. A command approval never widens the profile; a file change approval applies only inside the write paths (B03).
5. An API key is handed to Codex only; Orchvia keeps no copy.

## Acceptance

Environments: Codex 0.153.4 and 0.157.1 on macOS arm64 (locally) and in CI on macOS arm64, macOS x86-64 and Ubuntu; a CI job with a bash login shell on macOS and Linux (I02). No real models: a loopback scripted gateway. Internet use (N) runs in CI and was run locally with the owner's approval.

| ID          | Criterion                                                                                                                                             | Test                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC-0035-A01 | The home is used, nothing but C08 is written there, and an overlap with a workspace or state directory is refused                                     | `tests/contract/codex-local-0035.test.ts`                                                                                             |
| AC-0035-A02 | Two adapters on one home start their app-servers one at a time                                                                                        | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-B01 | A command cannot read `auth.json` in the home, the state directory or a `denyRead` path, and can write the workspace and the temporary directory only | `scripts/native-codex-local-smoke.mjs`                                                                                                |
| AC-0035-B04 | A command sees no `SSH_AUTH_SOCK`, token or key variable                                                                                              | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-C01 | probe, account, API key login and logout, browser login start and cancel, rate limits without sign-in, `clientInfo` in `userAgent`                    | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-C08 | `trustHostHook()` makes the hook trusted and writes only its entry                                                                                    | `tests/contract/codex-hook-marker-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                            |
| AC-0035-C09 | `models()` forwards `model/list` and its paging                                                                                                       | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-E01 | A missing or too old binary refuses the dispatch with its code                                                                                        | `tests/contract/codex-local-0035.test.ts`                                                                                             |
| AC-0035-F01 | Each mode's approvals as in the table, with the real binary                                                                                           | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-F02 | An inconsistent mode, profile or network refuses the dispatch                                                                                         | `tests/contract/codex-local-0035.test.ts`                                                                                             |
| AC-0035-N01 | `'direct'`: npm install, `git clone` over https and an https request work; a connection outside the proxy fails                                       | `scripts/native-codex-local-smoke.mjs` (CI, internet)                                                                                 |
| AC-0035-N02 | `'direct'`: an ssh-agent socket and a Docker socket are refused                                                                                       | `scripts/native-codex-local-smoke.mjs`                                                                                                |
| AC-0035-N03 | `'direct'`: a command reaches the host tool port, a request without the token is refused, and no tool is called                                       | `scripts/native-codex-local-smoke.mjs`                                                                                                |
| AC-0035-N04 | Linux: a command cannot read the app-server's environment through `/proc/<pid>/environ`                                                               | `scripts/native-codex-local-smoke.mjs` (CI Linux)                                                                                     |
| AC-0035-N05 | The proxy check fails (a scripted app-server, any version): `CODEX_NETWORK_PROXY_UNAVAILABLE`, nothing submitted, no fallback                         | `tests/contract/codex-local-0035.test.ts`                                                                                             |
| AC-0035-N06 | A real Codex whose proxy does not come up (a wrapper that appends `-c features.network_proxy=false`): the same, and no model request                  | `scripts/native-codex-local-smoke.mjs`                                                                                                |
| AC-0035-G01 | Command, file change and MCP tool approvals reach the host; an unknown request is declined                                                            | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-G02 | The bridge's tools need no Codex approval; with the real binary a `work_read` call returns the engine's task                                          | `tests/contract/codex-local-0035.test.ts` and `scripts/native-gateway-smoke.mjs`                                                      |
| AC-0035-H01 | A command server and a URL server with a token work; `approve` needs no question                                                                      | `tests/contract/codex-local-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                                  |
| AC-0035-R01 | The host hook denies a command and a patch in every mode; `HOST_HOOK_UNTRUSTED` without trust                                                         | `tests/contract/codex-hook-marker-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                            |
| AC-0035-I01 | A detached command holds the marker and a sweep ends it, for zsh and bash login shells                                                                | `tests/contract/codex-hook-marker-0035.test.ts` and `scripts/native-codex-local-smoke.mjs` (CI: zsh and bash on macOS, bash on Linux) |
| AC-0035-I03 | A login shell other than zsh or bash refuses the dispatch                                                                                             | `tests/contract/codex-hook-marker-0035.test.ts`                                                                                       |
| AC-0035-I04 | A `/bin/sh` command interrupts the turn with `STOP_MARKER_BYPASSED`                                                                                   | `tests/contract/codex-hook-marker-0035.test.ts` and `scripts/native-codex-local-smoke.mjs`                                            |
| AC-0035-X01 | [Record] What code mode's nested commands pass through                                                                                                | `scripts/native-codex-local-smoke.mjs`                                                                                                |
| AC-0035-J01 | Usage of a resumed and a compacted dispatch is counted once                                                                                           | `tests/contract/codex-local-0035.test.ts` (and with the real binaries, recorded in TDD-0035)                                          |

## To be settled during implementation, before code

Settled before 0.1.14's code: `command/exec` runs under the named profile and the proxy (F04); the temporary directory opens as `:tmpdir`; `SSH_AUTH_SOCK` is excluded by `shell_environment_policy.exclude`; the compaction path (J01). `/proc/<pid>/environ` on Linux (N04) is checked by CI's Linux run. Settled before 0.1.15's code: the hook process has the app-server's environment, excluded variables included, and reaches a Unix socket outside the sandbox even without network (R01); the adapter sees each command's shell in its item only when it starts, so I04 interrupts rather than prevents; `config/batchWrite` trusts the hook (C08); code mode's commands pass every check (X01).

## Rollback

Without `connection`, `policy`, `hostMcpServers`, `hostHook` and `stopMarker`, the adapter behaves as in 0.1.13.
