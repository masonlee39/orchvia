# Multi-agent orchestration SDK usage and detailed wiring

Updated 2026-09-27. This guide describes the interfaces implemented on `main`, which can be ahead of the latest release. Each release publishes the five npm packages on npm and the Python package `orchvia` on PyPI; [GitHub Releases](https://github.com/masonlee39/orchvia/releases) lists the versions and what each changes. The five npm packages are **ESM-only**; direct require is not exported. A Claude consumer installs SDK + engine + adapter-claude. See [the local RC and CJS/ESM bundled-host contract](acceptance/bundled-host.md). Offline process/transport/storage acceptance is recorded separately from real-model, sandbox, external-host and release acceptance in the [completion matrix](specs/0009-complete-design.md#completion-matrix).

## 1. Choose an integration mode

| Mode                | Owner                                                              | Runtime and storage                                                              |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Embedded TypeScript | `createOrchestrator(config)`                                       | Same Node process; caller injects optional adapters                              |
| Managed Python      | `await Orchestrator.local(engine_command=[...])`                   | Python owns one Node stdio host                                                  |
| Shared local host   | CLI `host`, clients `connectOrchestrator` / `Orchestrator.connect` | One host owns SQLite and adapters; connected clients cannot administer the owner |

Use exactly one writer for a state directory. Python is a client, not a second scheduler. An application's existing execution pipeline can be supplied as a RuntimeAdapter; see section 5.1.

## 2. Overall wiring

```mermaid
flowchart LR
  TS[Embedded TS owner] --> Engine
  PY[Python owner] -->|stdio| Host
  Clients[TS / Python / CLI clients] -->|Unix socket| Host
  Host --> Engine[Shared Node engine]
  Engine --> Store[SQLite and private artifacts]
  Engine --> Adapter[Selected host or native adapter]
  Adapter --> Runtime[Owned native runtime]
  Runtime -->|Four private tools| Engine
  Engine -->|Approvals and events| Clients
```

Wire protocol 2.0 uses JSON-RPC 2.0 in UTF-8 JSONL frames. stdout is protocol-only for stdio hosts. The limits are 1 MiB per frame, 64 pending requests per connection, 32 connections, 256 host-wide pending requests, 8 MiB aggregate pending input and 8 MiB queued output per connection. No public TCP listener is provided. Trusted same-OS-user access is not an authenticated multi-tenant boundary.

## 3. Installation and directories

Node.js 22.18+ is required; Python needs 3.11+. Development source uses Node type stripping. Distribution tarballs contain emitted JS and declarations because installed node_modules cannot depend on source stripping.

```sh
npm ci --ignore-scripts
npm run check:generated
npm run typecheck
npm run build:packages
# Run in an isolated Python build environment with setuptools/wheel/build installed.
python -m build --no-isolation --sdist --wheel --outdir dist/release python
PACKAGE_BUILD_PYTHON="$(command -v python)" npm run test:packages
```

Install the engine and SDK tarballs together with the chosen adapter. An embedded Claude consumer needs `@orchvia/sdk`, `@orchvia/engine` and `@orchvia/adapter-claude`; add `@orchvia/cli` only for a standalone/managed host. The five npm packages share one version, and a package that depends on another requires exactly that version. Claude's optional SDK peer and Codex's native executable are separate runtime dependencies; ordinary startup does not download them. The Claude adapter needs no Zod. Host-injected Claude query owns dependency selection: provide an inspection callback as described in the [bundled-host guide](acceptance/bundled-host.md). Python installs the unchanged wheel with `python -m pip install --no-index --no-deps /absolute/release/orchvia-0.1.0-py3-none-any.whl`.

Keep workspace, private state, and application/native credentials separate. The workspace and private directories must be canonical existing paths as required by CLI validation; state is outside the workspace. If using archive rollover, controlDir/storesRoot/archiveRoot must be private canonical outside-workspace directories, exclusively owned by this host. Do not use another application's state or history for fixture tests.

## 4. One configuration connects the components

This is runnable with explicit fake data after replacing the paths:

```json
{
  "configVersion": 1,
  "workspace": "/absolute/workspace",
  "stateDir": "/absolute/private/state",
  "transport": { "mode": "unix", "socketPath": "/absolute/private/state/host.sock" },
  "providers": { "fake": { "model": "fixture", "permissionProfile": "read-only" } },
  "limits": { "maxActiveSessions": 2, "maxTurnsPerTask": 20, "maxQuarantinedDispatches": 32 },
  "tools": {
    "enabled": true,
    "maxDepth": 4,
    "maxChildren": 32,
    "maxCallsPerDispatch": 100,
    "maxRepeatedCalls": 6
  },
  "runtimeApprovals": { "enabled": true, "ttlMs": 30000 }
}
```

Each provider names its allowed models with `model` (one model) or `models` (a non-empty list of unique names), never both. Tasks and sessions must use an allowed model; removing a model on restart leaves existing sessions unchanged and rejects new tasks for it. A fork can move to another model only when the provider configures one of these lists (see section 8).

Host options also include verificationRules, registered writeScopes, pricing, budget, contextLimits, messageLimits, storage and stores. Read the typed [EngineConfig](../packages/engine/src/types.ts) and validated [CLI config](../packages/cli/src/config.ts) before adding fields. JSON providers remain read-only; native options, write profiles and callbacks use embedded TS. There is no generic auth/executable/gateway object. Native credentials and model endpoints belong to the selected runtime or an application-owned adapter, and are not stored in task specifications.

`doctor --config FILE` checks Node/SQLite, path access and the selected native dependency version without login or model calls. `doctor --socket PATH` proves the existing host handshake only. Neither proves authentication, tool sandboxing, model availability or task completion.

## 5. Embedded TypeScript wiring

Source entry points are under packages; installed imports use `@orchvia/sdk`, `@orchvia/engine/fake`, and the selected `@orchvia/adapter-*` package. The complete [local example](../examples/typescript/local.ts) creates a task, collects explicit fixture approval, handles shutdown and preserves supplied state. The [hosted example](../examples/typescript/hosted.ts) tests an existing-runtime seam without a model.

```ts
import { createOrchestrator } from '@orchvia/sdk';
import { createFakeAdapter } from '@orchvia/engine/fake';

const orch = await createOrchestrator({
  workspace: '/absolute/workspace',
  stateDir: '/absolute/private/state',
  adapters: [createFakeAdapter()],
  tools: { enabled: true },
});
```

Creating an orchestrator is not submitting a task. Await task state and acceptance; save IDs and immutable retry identities. Close embedded owners explicitly. `SHUTDOWN_INCOMPLETE` retains the client and operationId for continuation. A connected client's close only disconnects.

### 5.1 Integrating an existing application's runtime

Use `createOrchestrator({ workspace, stateDir, adapters: [applicationAdapter] })` with an application-owned implementation of the current `RuntimeAdapter`. The built-in adapters are optional; do not start another provider runtime when the application already owns permission checks, tools, confirmations, and audit. This is an in-process extension point. The stock CLI currently allows only fake/Claude/Codex providers and is not a loader for arbitrary adapter modules.

Follow [design sections 7.3–7.5](./design.md#73-current-application-adapter-extension-point) in this order:

1. Declare the exact provider, permission profiles, resume/interrupt support, budget v2 caps, and evidence v1 coverage. Require the engine's generation, shared remaining budget, and evidence callback; do not reset the timer at host admission.
2. Enter the host's full admission/execution pipeline with a trusted caller and a durable dispatch binding. A queue receipt is not native acceptance. Definite rejection before submission can produce failed plus pre-submission stop evidence; ambiguity after possible submission must remain unknown.
3. Preserve separate tool-confirmation and task-acceptance paths. Keep full host tool/UI events in the host; map native acceptance, result, usage, interruption, failure, and independently observed execution evidence into the engine contract.
4. Keep resource observation alive for owned child/background work after the main turn ends. Never declare terminal coverage simply because the host emitted a completed UI turn. Stop acknowledgements and no remaining in-memory handle are insufficient evidence.
5. Use stable identifiers and a durable projection checkpoint for host persistence. Recover a missing receipt with the original dispatch identity; do not replay uncertain work. Engine restart retains unresolved executions for owner reconciliation.

The [SPEC-0006](./specs/0006-host-runtime-contract.md) implementation covers the typed contract, runtime validation, reusable offline acceptance, and a deterministic example. It does not implement a concrete application bridge, durable cross-store journal, authenticated multi-tenant API, package publication, or application hot update. The host journal and event projection above are requirements for the concrete integration, not current configuration fields.

`readRuntimeCapabilities(adapter)` returns a validated, detached, recursively frozen snapshot. `RuntimeBudgetCapabilities` requires version 2 and explicit nulls for unspecified caps; `RuntimeEvidenceCapabilities` names version 1 coverage. Inside a hosted adapter, call `requireEngineRuntimeInput(input)` before host submission to obtain `EngineRuntimeInput`. It preserves the original identity, signal, budget functions, and evidence callback; it is not authentication or proof of host enforcement. Ordinary standalone provider calls retain their optional `RuntimeInput` engine fields.

Run the complete offline example and contract tests from the source checkout:

```sh
node examples/typescript/hosted.ts
node --test tests/contract/host-runtime.test.ts tests/contract/runtime-capabilities.test.ts tests/contract/runtime-input.test.ts
node --test tests/contract/host-runtime-process.test.ts
```

The example creates and cleans up a temporary workspace/stateDir. Its output reports a null native ID while queued, waiting_approval before an explicitly simulated review, completed afterward, one dispatch, and no occupied execution slot. It never reads credentials or invokes a model. Its host bindings exist only in memory.

The optional `packages/engine/src/testing.ts` entry point exports `registerRuntimeAdapterContract(name, createFixture)`. A `RuntimeContractFixture` supplies the application adapter, its observed submissions and native IDs, observation-completion status, expected result/usage, controlled host actions, and cleanup. The actions cover accept, confirm-tool, reject, finish, main-result with background work, disconnect, mismatched-generation/dispatch stop evidence, and observed full stop. `finish` must emit duplicate usage under one ID so deduplication is exercised. A driver routes these actions through its controlled host/runtime boundary, not directly into engine state. Each case uses a fresh engine and temporary state; waits and cleanup are bounded. Drivers must remain offline and release every owned fixture resource in dispose.

The package exports `./testing` and `./testing-host` separately; neither is imported by normal engine startup. Use [the registration example](../tests/contract/host-runtime.test.ts) as a starting point, replacing the deterministic fixture with a driver for the actual application boundary. Passing the supplied fixture suite verifies the engine and test harness, not another application's adapter. A negative subprocess test verifies that the suite rejects a deliberately incorrect main-turn/full-stop mapping.

Acceptance must distinguish: (a) SDK source running under the target Node/Electron runtime; (b) deterministic lifecycle/failure-path acceptance; (c) the actual packaged application's permissions, UI, restart, and cleanup; (d) a separately authorized real-model run through the same host adapter. An earlier source-only probe in Electron's Node mode cannot establish (c) or (d).

### 5.2 Implemented host policy and usage forwarding

[SPEC-0007](./specs/0007-host-policy-and-usage.md) implements these source interfaces. Native callback configuration is an embedded TypeScript surface; it is not a new Python/JSON configuration language. `EngineConfig.providers` and the adapter must select the same `permissionProfile`. Each adapter advertises only its configured profile, defaulting to `read-only`.

Claude `options` and `extendOptions(context)` preserve native callback types through a generic parameter. Use the types from the exact SDK installed by your host; the peer range is not a native compatibility matrix. This factory illustrates the typing without inventing full-stop observation:

```ts
import type { Options as NativeOptions } from '@anthropic-ai/claude-agent-sdk';
import {
  createClaudeAdapter,
  type ClaudeHostOptions,
  type ClaudeOwnedOption,
} from './packages/adapter-claude/src/index.ts';
import type { RuntimeStopObserver } from './packages/engine/src/types.ts';

type HostNative = Omit<NativeOptions, ClaudeOwnedOption>;

function hostClaude(
  options: ClaudeHostOptions<HostNative>,
  observeExecutionStop: RuntimeStopObserver,
) {
  return createClaudeAdapter<HostNative>({
    permissionProfile: 'workspace-write',
    options,
    extendOptions: async ({ input }) => ({
      systemPrompt: `Work only on dispatch ${input.dispatchId} in its allowed workspace.`,
    }),
    observeExecutionStop,
  });
}
```

The host can supply tools/allow/deny lists, `canUseTool`, `hooks`, `mcpServers`, `systemPrompt`, `maxTurns`, `env`, `settings`, `managedSettings`, and `settingSources`. Model, cwd, resume/session identity, prompt, abort controller, process spawn, and extra directory grants remain adapter-owned. Overrides fail at typecheck/runtime. Native options beyond the common policy fields are checked against the caller's installed SDK, not a universal compatibility promise. See the [positive/negative compilation fixture](../tests/fixtures/claude-options-types.ts).

Extensions run before submission and consume the original acceptance/turn budget. Rejection, timeout, or cancellation does not start a query. Their immutable input retains identity and remaining-budget functions. Tool/source arrays and hook containers are detached per dispatch; callback and native MCP instance identities are retained. The host must keep shared native objects and policy stable. Private options are not persisted.

Claude defaults to Read/Glob/Grep; write mode adds Edit/Write/Bash. Its built-in `PreToolUse` guard coexists with host hooks and blocks read-only mutation, engine-state access, outside-workspace edits including resolved symlinks, explicitly background Bash, and unsandboxed Bash. Write mode forces native sandbox availability, disables unsandboxed fallback, and restricts explicit writable roots. Host hooks/settings additionally enforce application-specific protected directories and custom/MCP authorization. `settingSources` selects native settings files; it does not replace guards, supplied settings, or confirmation policy. Symlink races, SDK scratch paths, native hook precedence, and actual OS enforcement still require native-runtime acceptance.

Supplying `canUseTool` without an explicit allow list/mode selects `allowedTools: []` and `permissionMode: default`. Explicit choices are preserved. Native tool confirmation and engine task-result approval are separate. SPEC-0009 adds opt-in `runtime_permission` requests through the existing approval event/decision API; the consuming application supplies its UI. Claude interruption follows the terminal and stop-proof contract below.

Codex accepts `permissionProfile`, `networkAccess` (default false), and `webSearch` (`disabled` by default, or `cached`/`live`). Search is independent from command network access. New/resumed threads and every turn receive the selected sandbox policy. Workspace-write uses the canonical workspace as its explicit writable root and excludes general temporary roots. Managed-home feature/MCP restrictions remain. JSON CLI supports network/search, but write and host callbacks remain embedded-only.

Codex applies an approved file change itself, outside the command sandbox, and its approval request names no paths. The adapter therefore takes the paths from the change's item, resolves symbolic links, and declines a change with any path outside the workspace or `writePaths` without asking the host; the host sees the others with `permission.changes` (`[{ path, kind, movePath? }]`). Codex starts without its shell snapshot, which would otherwise export the app-server's whole environment into each command, and with its default excludes, so commands see neither the orchestration bridge's variables nor any variable whose name contains `KEY`, `SECRET` or `TOKEN` ([SPEC-0038](./specs/0038-codex-approval-paths.md)).

**The user's own Codex CLI.** With `createCodexAdapter({ connection: { home }, policy })` the adapter runs the Codex CLI the user installed and signed in to, on their Codex home, which Orchvia leaves as it is ([SPEC-0035](./specs/0035-local-codex-member.md)):

```ts
import { codexConnection, createCodexAdapter } from '@orchvia/adapter-codex';

const home = '/Users/me/.codex';
await codexConnection({ home }).probe(); // version, supported, userAgent; sign-in: login(), waitForLogin()
const codex = createCodexAdapter({
  connection: { home },
  executionStop: 'owner-reconcile',
  denyRead: ['.env'],
  policy: (input) =>
    input.permissionProfile === 'read-only'
      ? { mode: 'plan' }
      : { mode: 'acceptEdits', network: 'direct' },
});
```

Each dispatch runs under a named permission profile: commands read the file system but neither the home, the state directory nor `denyRead`; a writable dispatch also writes the workspace (or `writePaths`) and the temporary directory. `plan` never asks; `default` asks the host for each command and file change; `acceptEdits` asks for commands and takes file changes inside the write paths itself; `auto` asks only for what leaves the profile. `network: 'direct'` goes through Codex's network proxy with every domain allowed: Unix sockets such as an ssh-agent or Docker stay out of reach, local ports do not, and programs that ignore `HTTPS_PROXY`, such as `git` over ssh, cannot connect. `{ domains }` allows only those. Before a network dispatch opens its thread the adapter checks that the proxy is in force and otherwise refuses it with `CODEX_NETWORK_PROXY_UNAVAILABLE`, never falling back to network without the proxy. Other refusals are `CODEX_NOT_FOUND`, `CODEX_VERSION_UNSUPPORTED` (older than 0.153.4), `CODEX_POLICY_INVALID`, `CODEX_HOME_OVERLAP` and `CODEX_START_LOCK_TIMEOUT`, at the start of the dispatch's error message. MCP tool calls ask the host through `requestPermission` like commands; `hostMcpServers` adds the host's own servers by command or by `{ url, token }`. Under `never`, Codex itself refuses commands such as `rm -f`.

`hostHook(event)` asks the host before each command, file change and tool call, in every mode: `{ kind: 'command' | 'fileChange' | 'tool', command?, patch?, … }` answered `{ allow: true }` or `{ allow: false, reason }`. It runs through Codex's hook, which Codex runs only when the home trusts it: call `codexConnection({ home }).trustHostHook()` once, and again after moving Node or the package; an untrusted hook refuses the dispatch with `HOST_HOOK_UNTRUSTED`. A host whose `process.execPath` is not Node, such as an Electron application, copies `hostHookProgram()` (the package's `hook.mjs`) to a place its updates do not move, and passes the same `hostHookCommand` to the adapter and the connection, built with `hostHookCommandFor({ runtime, program, env: { ELECTRON_RUN_AS_NODE: '1' } })`; a variable in `env` reaches the hook process only. `hostHookTrust()` says whether the home trusts that command and whether it runs; after a change of command, `trustHostHook()` trusts the new one and the old one no longer. Codex runs a tool whose hook does not answer, so each dispatch first runs the hook command itself and refuses to start with `HOST_HOOK_UNAVAILABLE` when it does not answer, and a command or file change that starts without the host's permission ends the turn with `HOST_HOOK_BYPASSED` (SPEC-0039). That check covers commands and file changes, not MCP calls or web search. Such a host also starts the orchestration tool bridge its own way, with `toolBridge: { command, args: [toolBridgeProgram() copied beside its files], env }`; a bridge that does not start makes Codex refuse the thread. `instructions(input)` gives a member its role as Codex developer instructions when a dispatch starts a new thread, outside the task's goal and events; Codex keeps the first ones for the thread's life, so a changed role needs a new session. `clientInfo` needs `name` and `version`. The policy's `effort` sets Codex's reasoning effort for one dispatch; it is not kept for the next, which uses the model's default unless it names one too. An effort the model's list lacks refuses the dispatch before its thread (`CODEX_EFFORT_UNSUPPORTED`), and each usage record says which effort it ran with in `raw._reasoningEffort`, which `usage.byTask` sums up per task as `reasoningEfforts` (SPEC-0042). A model that Codex's list does not name refuses the dispatch before its thread (`CODEX_MODEL_UNLISTED`), since Codex would give it no `apply_patch`; `allowUnlistedModel: true` lets a custom provider's model through. `codexConnection().probe()` and `orchvia doctor` say whether the Codex version is one CI runs (`tested`), without refusing others (SPEC-0043). The proxy check before a networked dispatch runs the host's way too, with `proxyCheck: { command, args: [proxyCheckProgram() copied beside its files], env }`; its `env` reaches that check alone (SPEC-0040). Unlike the hook and the bridge, which Codex starts outside the sandbox, the check runs inside it under the dispatch's profile: its program and runtime must be where the member's commands can read them, not under `denyRead`, the Codex home or the state directory, or the dispatch is refused with the path named (SPEC-0041). The hook sees the command's text, not the shell the model chose, so it is a policy, not a sandbox. `codexConnection().models()` lists the models the sign-in can use. `stopMarker: true` (or `{ directory }`, shared with Claude members) marks each zsh and bash command as for Claude and proves a dispatch stopped without `executionStop`; a login shell other than zsh or bash refuses the dispatch (`STOP_MARKER_UNSUPPORTED_SHELL`), and a command the model runs with `/bin/sh` ends the turn (`STOP_MARKER_BYPASSED`) and leaves the dispatch to the owner.

For extended Claude options, the writable Claude profile or any Codex profile, `observeExecutionStop({ target, terminal, signal, remainingMs })` must observe complete remote/background stop for the exact dispatch/generation/native IDs. Return true only after actual host observation. False, rejection, absence, and timeout retain unknown execution. Waiting is bounded by cleanup time; late true evidence is retained without clearing business quarantine or resubmitting. Local child-process exit is independently required. With an observer configured, `terminalCoversExecution` denotes this combined proof; native-terminal evidence retains `remoteExecution: unknown` until host confirmation.

Without an observer, no dispatch of such an adapter could release its execution lease, and the engine would stop dispatching once capacity ran out. So `createClaudeAdapter` given `options`, `extendOptions` or `permissionProfile: 'workspace-write'`, and every `createCodexAdapter`, fail at once with `INVALID_ADAPTER_CONFIG` unless the host gives `observeExecutionStop` or chooses `executionStop: 'owner-reconcile'`. The second keeps leases held until the owner reconciles each dispatch with `sessions.reconcile`, and the task waits blocked with `outcome_unknown` until then; it cannot be combined with an observer ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) A01 to A03, [SPEC-0034](./specs/0034-background-command-stop-proof.md) A01).

**Commands outlive their turn.** A command that Claude Code's Bash tool or Codex runs is not bound to the turn that started it:

- Codex runs each command in a process group of its own. A command that `exec_command` returns from early (`yield_time_ms`), or that a shell leaves in the background, keeps running after `turn/completed`, and survives a SIGTERM to the app-server's group. So from 0.1.10 no Codex profile claims that its terminal ends execution, read-only included. A JSON CLI host cannot pass an observer and must set `"executionStop": "owner-reconcile"` for `codex`. Each dispatch still ends what is left of its app-server's process tree when it closes the app-server, but a command whose shell already exited has left that tree (SPEC-0034 A01, A03).
- Claude Code runs each Bash command in a process group of its own, and a command backgrounded by a shell is handed to the system's init process. Neither is in the Claude process's group, so `processGroupsStopped(context)` from `@orchvia/adapter-claude` cannot see them. It still checks the groups listed in `processes: [{ pid, processGroupId }]` (SPEC-0023 P), but it is deprecated and warns once (SPEC-0034 A02). In the adapter's default writable mode Claude Code refuses a bare `&`, and the adapter refuses `run_in_background`, but `sh -c '… &'`, a pipe into `sh`, or a program that starts a daemon are allowed.

**`stopMarker: true`** (Claude, macOS and Linux) is an observer for this. Each dispatch gets a marker file and a wrapper script in a private temporary directory, and the adapter sets `CLAUDE_CODE_SHELL_PREFIX` to the wrapper and `CLAUDE_CODE_SHELL` to the shell it runs (the host's `CLAUDE_CODE_SHELL`, else `/bin/bash`, else `/bin/zsh`). The wrapper opens the marker as descriptor 9 and runs the command; a command that cannot open it does not run (exit 126). Everything a command leaves behind inherits the descriptor. At the terminal the observer lists the marker's holders with `lsof`, ends them with SIGTERM and then SIGKILL, and vouches only when none is left. In the writable profile the marker directory is added to the sandbox's `allowRead`. Linux needs `lsof`; without it, or when it fails, no dispatch is proven stopped. On Ubuntu 23.10 and later, AppArmor's restriction of unprivileged user namespaces keeps bubblewrap from starting (`bwrap: loopback: Failed RTM_NEWADDR`), so the writable profile's Bash commands fail; the CI lifts it with `kernel.apparmor_restrict_unprivileged_userns=0`. Claude Code's Linux sandbox runs each Bash command in a PID namespace of its own (bubblewrap `--unshare-pid`), so there nothing a sandboxed command starts outlives the command, and the marker matters only for commands still running at the terminal; on macOS what a command leaves behind keeps running.

```ts
const claude = createClaudeAdapter({ permissionProfile: 'workspace-write', stopMarker: true });
```

A program that closes inherited descriptors drops the marker; Python's `subprocess` does so by default. What it starts keeps its working directory, so the observer also counts any process whose working directory is in the dispatch's workspace, that started during the dispatch and that is outside the host's own process tree. While such a process runs, the dispatch is not proven stopped and waits for the owner, and the process is not ended, because it may not be the dispatch's: a process started in the workspace by a person, or by another session's command that dropped its marker, holds the lease the same way. A process that changes its working directory out of the workspace before it detaches, or one started for the command by another service (for example `open` on macOS), is not seen. `stopMarker` supplies the observer, so it excludes `observeExecutionStop` and `executionStop`, and a host that sets `CLAUDE_CODE_SHELL_PREFIX` itself cannot use it (SPEC-0034 B01 to B03). Closing the adapter ends the holders of every marker left.

**Across a restart** ([SPEC-0036](./specs/0036-stop-marker-restart.md)), give `stopMarker: { directory, onObservation? }`: an absolute directory that outlives the host, private to its user (created 0700 when missing, never a symbolic link, writable by no one else) and outside every workspace and state directory. Each adapter instance works in `<directory>/<pid>-<random>`, whose `instance.json` records the process, and each dispatch records its workspace and start next to its marker. The files of a dispatch not proven stopped stay after the host exits. At its next start the host calls `sweepStopMarkers(directory)` from `@orchvia/adapter-claude`, which needs no engine: for every instance whose process is gone, it ends what still holds its markers and returns, per dispatch, `{ dispatchId, holders, ended, strays, stopped, reason? }`, applying the workspace check above and looking again every 200 ms within `timeoutMs` (5 seconds), because the killed host's Claude Code stays in the workspace until it notices its input closed. Only a dispatch with `stopped: true` may be reported stopped with `sessions.reconcile`. `staleStopMarkers(directory)` reports the same without ending anything. Instances of running processes, this one included, are never touched. For a synchronous exit path, `adapter.endStopMarkersSync(300)` ends this instance's holders within its time and never throws; it reports `stopped` only after a last listing found none, and leaves the files for the next sweep. `onObservation` receives the result of each observation (`dispatch`, `sync`, and for the sweep functions' own callback `sweep` or `stale`).

```ts
const directory = '/Users/me/Library/Application Support/MyHost/stop-markers';
const swept = await sweepStopMarkers(directory); // before starting the engine
const claude = createClaudeAdapter({
  permissionProfile: 'workspace-write',
  stopMarker: { directory },
});
process.on('exit', () => claude.endStopMarkersSync(300));
```

With `sweepStopMarkers(directory, { keepProven: true })` a proven dispatch keeps its files with a `.proven` record, and later sweeps report it `proven` at once, so that a host that crashes before it reconciles the dispatch still finds the proof; after `sessions.reconcile` the host calls `acknowledgeStopMarkers(directory, dispatchIds)`, which removes only proven dispatches and refuses the others. `endStopMarkersSync(directory, timeoutMs)` from `@orchvia/adapter-claude` cleans up every adapter of this process under the directory with one listing ([SPEC-0037](./specs/0037-stop-marker-acknowledgement.md)).

When the adapter has to end a Claude process that did not stop by itself, it sends SIGTERM to the whole group and, when the cleanup window ends, SIGKILL to what is left of it. Because the processes no longer share the host's process group, a terminal's Ctrl-C or hang-up reaches only the host; `orchvia host` shuts down in order on SIGINT, SIGTERM and SIGHUP.

The writable Claude profile always requires the runtime's OS sandbox (`enabled` and `failIfUnavailable`, with no unsandboxed fallback). It works only where Claude Code can sandbox Bash. macOS uses its built-in sandbox; Linux needs `bubblewrap` and `socat` installed. Without them a writable task fails at its first dispatch with the runtime's `Sandbox required but unavailable` reason, and nothing runs unsandboxed. The engine's native checks cover macOS and Ubuntu CI with those packages. Other platforms are unverified; check Claude Code's sandbox support before enabling the writable profile there.

Usage consumers subscribe to existing engine events and read exact records:

```ts
for await (const event of orch.events({ storeId: savedStoreId, afterCursor: savedCursor })) {
  if (event.type === 'usage.recorded') {
    const record = await orch.usage.getRecord(event.data.usageRecordId as string);
    // Persist (event.storeId, record.id, record) to the host outbox transactionally.
  }
  // Advance the checkpoint only with/after that durable transaction.
}
```

The full [offline example](../examples/typescript/usage-forwarding.ts) implements the outbox/checkpoint transaction and destination deduplication. It reopens both databases, resumes a saved cursor, replays older events, and simulates a lost acknowledgment. Run `node examples/typescript/usage-forwarding.ts`; two delivery attempts produce one ledger row. Replace the fixture destination with an API honoring `(storeId, record.id)` idempotency. A failed delivery leaves the outbox pending. Larger streams must continue bounded pages until caught up. Do not count native usage both in the host and in this projection.

`reportUsage` plus iterator replay emits one atomic row/event per `dispatchId:usageId`; conflicting content rejects. Failed or late matching Claude results preserve usage despite cleanup uncertainty; mismatched sessions are excluded. Missing fields remain null. Python exposes `usage.get_record` and maps `usageRecordId` to `usage_record_id`, preserving raw provider keys. Wrong store/cursor pairs reject. The current host requires wire 2.0/schema 3 and namespace-bound mutations.

These guarantees cover observations that reached the engine. Historical rows are not backfilled, unreported crash-time usage cannot be recovered, and turn aggregates do not prove per-native-request accounting. `usage.get(taskId).completeness` retains its prior record-field meaning, not exhaustive upstream coverage. There is no distributed transaction with an external ledger. Real host integration, native audit completeness, native permissions, and model acceptance remain separate; no other application's files are changed by this increment.

### 5.3 Claude interruption and revision

[SPEC-0008](./specs/0008-claude-interruption.md) implements Claude `interrupt: true` using exactly one user message per open streaming input. The adapter owns the prompt UUID and `includePartialMessages: true`; host options cannot override them. Injected factories receive `AsyncIterable<ClaudeUserMessage>` instead of a string. They must consume that input and expose native `interrupt()` for active control; a legacy factory with no method cannot confirm interruption from the request alone.

After submission, the engine AbortSignal requests `Query.interrupt()` once. Startup cancellation waits for a matched main-turn assistant/stream event, because an init event can precede a running turn. The SDK controller remains alive to observe the result. A matched result with `terminal_reason: aborted_streaming` or `aborted_tools` becomes interrupted; arbitrary errors and missing reasons retain their error outcome. A success racing cancellation remains a success result for the engine's existing control rules. The adapter then closes input and cleans up owned processes. Extended host work still needs positive `observeExecutionStop` proof.

For an existing task `taskId`, pause it, queue revised context, and resume:

```ts
const task = await orch.tasks.get(taskId);
const session = await orch.sessions.get(task.sessionId);
const pause = await orch.sessions.control(
  {
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedDispatchId: session.activeDispatchId,
    expectedState: session.status,
  },
  { action: 'pause', mode: 'interrupt' },
);
const paused = await pause.wait({ timeoutMs: 35000 });
if (paused.status !== 'completed')
  throw new Error(`Pause requires investigation: ${paused.status}`);
const current = await orch.sessions.get(session.id);
await orch.messages.send({
  taskId,
  toSessionId: current.id,
  expectedGeneration: current.generation,
  kind: 'finding',
  summary: 'Use the revised requirements in the next turn.',
});
await orch.tasks.resume(taskId);
```

Python uses the same `sessions.control` / `messages.send` / `tasks.resume` flow with snake_case fields. `tasks.cancel` interrupts an active Claude turn using the same evidence rules. There is no new `modify` action: revision is the existing pause, queued context, and resume sequence. Resume preserves saved native history; it does not recover unsaved reasoning. Read the returned operation/task state before treating control as successful.

A message waits for the target session's next dispatch until its TTL (`messages.ttlMs`, 24 hours by default). `message.expired` reports a TTL expiry without a `reason`, a cancelled task with `reason: "task_cancelled_before_submission"` and a stopped session with `reason: "session_stopped"`. Stopping a session expires every message still waiting for it, when the session actually closes: at once without a running dispatch, otherwise when that dispatch ends. Messages that the last dispatch carried keep that dispatch's outcome. `messages.send` to a stopped session fails with `SESSION_CLOSED` ([SPEC-0017](./specs/0017-audit-corrections.md) A05).

`interruptTimeoutMs` defaults to 30000 and starts at the cancellation request, including startup waiting. It cannot extend acceptance/turn budgets or the host's `timeouts.interruptMs`. An expired host operation remains outcome_unknown/blocked even if late terminal/usage/exit evidence later releases execution capacity. No blind resend occurs. [Verification evidence](./tdd/0008-claude-interruption.md) separates real local processes and installed native SDK transport from the still-unverified real CLI/model boundary.

### 5.4 Host labels and the task chain

A host can give each task and each opened session a `label`, a string of 1 to 256 UTF-8 bytes that it can filter by, and `metadata`, a JSON object of at most 4096 bytes when encoded and 16 levels deep that the engine only stores and returns ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) L). Both are part of the request digest, and `initialize` lists `workflow.labels` when a host accepts them.

```ts
const task = await orch.tasks.create({
  goal: 'Review the change',
  runtime: { provider: 'claude', model: 'claude-sonnet-5' },
  acceptance: { mode: 'human', criteria: ['A reviewer read the answer'] },
  label: 'conversation:42',
  metadata: { agent: 'reviewer' },
});
const page = await orch.tasks.list({ label: 'conversation:42' });
```

What the host creates carries what the host passed. What the engine creates inherits: a child that `work_delegate` creates takes its parent's `label` and `metadata`, a session that the engine opens for a task takes the task's, and a fork takes its source session's. A task that a handoff hands over is created by the host, so the host labels it. `tasks.list({ label })` pages in creation order through an index; give at most one of `parentTaskId`, `sessionId` and `label`. `task.*` events carry the task's `label` in their data.

Each dispatch's `RuntimeInput` carries `parentTaskId` (null for a root task), `rootTaskId`, `label`, `metadata`, `sessionLabel` and `sessionMetadata`, each null when absent, so that a Claude adapter's `extendOptions` can choose a system prompt or tools without calling the engine. The metadata values are deep-frozen copies.

### 5.5 Task queries, token totals and why a task waits

Where `initialize` lists `workflow.taskQueries`, a host reads what it shows without listing every task ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) P):

```ts
// Is any task active? Answered from the status index, however many tasks have finished.
const active = await orch.tasks.list({
  status: ['queued', 'waiting_dependency', 'running', 'verifying'],
  limit: 1,
});
// A conversation's tasks, newest first; nextCursor continues with older ones.
const recent = await orch.tasks.list({ label: 'conversation:42', order: 'desc', limit: 20 });
// Up to 100 tasks in one call, in the order asked; unknown IDs are listed in `missing`.
const { tasks, missing } = await orch.tasks.getMany(timelineIds);
// Token counts of a root task and every task under it, per provider and model.
const summary = await orch.usage.summary(rootTaskId);
// Each of up to 100 tasks' own token counts per model, in the order asked (SPEC-0029 A).
const rows = await orch.usage.byTask(pageOfTaskIds);
```

- `status` takes 1 to 10 distinct statuses and combines with one of `parentTaskId`, `sessionId` and `label`. Python: `tasks.list(status=[...], order="desc")`, `tasks.get_many(ids)` and `usage.summary(root_task_id)`.
- `usage.summary` sums each token count over the records that report it; `unknownRecords` counts the records without an input or output count, and `completeness` is `reported` only when there is none, as for `usage.get`. A record written by an earlier version has no `model` and takes its dispatch's session's; `model` is null when that dispatch or session was collected. A task that has a parent is refused: pass its `rootTaskId`.
- These reads, and `usage.get`, search indexes. The first start of this version creates two: `tasks_root` and `usage_task`.
- Where `initialize` lists `workflow.usageByTask`, `usage.byTask(taskIds)` (Python `usage.by_task`) returns each task's own totals, not its children's, grouped and counted as `usage.summary` counts a tree, with the IDs that name no task in `missing` ([SPEC-0029](./specs/0029-usage-by-task-and-close-markers.md) A). A usage page that lists one task per row reads a page of `tasks.list` and then one `usage.byTask` for that page: two calls per 100 tasks.
- The totals of `usage.summary` and `usage.byTask`, overall and per model, also hold `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens` (Python `cache_write_5m_input_tokens`, `cache_write_1h_input_tokens`): the cache writes that live five minutes and one hour, summed over the records that split them, so that a host can price the two at their own rates. The Claude adapter splits its cache writes from 0.1.7 on. `cacheWriteInputTokens` minus both is the cache writes of the records without a split, written before 0.1.7, by a runtime that does not split them, or for calls outside a dispatch's main loop (section 9); when it is 0, the split is complete ([SPEC-0030](./specs/0030-cache-write-durations-and-commit-time.md) A).
- A task snapshot holds `deliveredAt`, the time the task last delivered a result: for human acceptance, each time the task entered review of its result, including a result offered again after its approval expired; for checks acceptance, when its checks passed and it completed. A review for a runtime permission, an approval, a denial and a failed check do not change it. It is stored with the task, so a read-only view has it too; tasks that delivered before 0.1.6 have none (SPEC-0029 B). From 0.1.7 on, the engine reads its clock once for each transaction, so `deliveredAt` and `updatedAt` equal the `occurredAt` of the event of the same change, and every time follows a clock passed in `EngineConfig` (SPEC-0030 B).

Where `initialize` lists `workflow.queueReasons`, a queued task, and a task that waits for its dependencies, carries `blockedBy`: the first condition that keeps the scheduler from dispatching it (SPEC-0028 B). The engine computes it from the scheduler's own checks when the task is read; it is not stored, no event announces it, and a read-only view returns none.

| `reason`              | The task waits for                                               | Also given                                         |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `scheduler_failed`    | a restart: an internal failure stopped the engine (section 11.6) |                                                    |
| `host_stopping`       | nothing: the host is closing                                     |                                                    |
| `capacity`            | a free execution slot, `limits.maxActiveSessions`                | `taskIds`: the tasks that hold the slots           |
| `quarantine_capacity` | owner reconciliation of quarantined results (section 11.5)       |                                                    |
| `resource_cleanup`    | an owner's resource cleanup to finish                            |                                                    |
| `execution_conflict`  | the owner to resolve an execution evidence conflict              |                                                    |
| `storage`             | storage to leave backpressure, or a rollover to settle           |                                                    |
| `session_busy`        | its session, which another task holds                            | `sessionId`, and `taskIds`: the tasks that hold it |
| `write_conflict`      | a task whose write paths overlap its own                         | `taskIds`: those tasks                             |
| `scheduling`          | nothing: the next scheduler pass takes it                        |                                                    |
| `dependency`          | its dependencies to complete                                     | `taskIds`: the ones not completed                  |

A task whose budget does not allow a dispatch is paused, not queued, and says so in its `reason`.

### 5.6 Desktop hosts

A host that embeds the engine in a desktop application, such as an Electron main process, shares the user's disk and the thread that draws its window. `createEngine` and `createOrchestrator` write the emergency reserve through `fs.promises` in chunks of 1 MiB, so the event loop keeps running while they start, and they resolve only when the reserve is complete and synced ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) W). These settings suit such a host:

```ts
const orch = await createOrchestrator({
  workspace,
  stateDir,
  adapters: [createClaudeAdapter({ cleanupTimeoutMs: 5000 /* ... */ })],
  storage: {
    quotaBytes: 2 * 1024 ** 3, // 2 GiB
    minFreeBytes: 512 * 1024 ** 2, // 512 MiB
    emergencyBytes: 32 * 1024 ** 2, // 32 MiB
  },
  limits: { defaultMaxQueueWaitMs: 7 * 24 * 3600 * 1000 }, // seven days
});
```

- **`storage.quotaBytes` 2 GiB, `minFreeBytes` 512 MiB.** The defaults, 10 GiB and 1 GiB, suit a server. On a laptop, backpressure should start before the application fills the user's disk, and a free-space floor of 512 MiB still leaves the system room to work.
- **`storage.emergencyBytes` 32 MiB.** The reserve is released to finish settlement after a full disk. The default, 256 MiB, is sized for a server's write load; 32 MiB covers the records a desktop session settles, and writes in a fraction of the time.
- **`limits.defaultMaxQueueWaitMs` seven days.** The default of 30 seconds suits a service whose queue drains quickly. On a desktop, tasks wait while the user is away or the machine sleeps, and a task that expired in the queue must be created again (section 8.2).
- **`cleanupTimeoutMs` 5000 for the Claude adapter.** When a turn ends, the adapter closes the Claude process, signals what is left of its process group after half of this window and kills it at the end. The default of 1 second is short for a loaded laptop, or one waking from sleep: a process that is still finishing is signalled after half a second and killed after one. Five seconds lets it exit on its own and still bounds a close.
- **Closing when the user quits.** `close({ mode: 'pause' })` interrupts running turns and pauses them with reason `owner_shutdown`, as it pauses queued tasks, so the next start can tell the tasks this close paused from ones that a runtime interrupted (section 11.2).

## 6. Local Python wiring

Run `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py` from the checkout for a complete owned-host example, including known-fixture review and shutdown. Installed Python still needs the Node CLI and selected adapter in a stable tool directory.

```python
from orchvia import Orchestrator, RuntimeSpec, TaskSpec, CheckAcceptanceSpec

orch = await Orchestrator.local(engine_command=[
    "/absolute/node", "/absolute/orchvia-cli/dist/main.js",
    "host", "--stdio", "--config", "/absolute/host.json",
])
try:
    task = await orch.tasks.create(TaskSpec(
        goal="Perform the configured work",
        runtime=RuntimeSpec("fake", "fixture"),
        acceptance=CheckAcceptanceSpec(rule_refs=[{"id": "host-check", "version": "1"}]),
    ), idempotency_key="saved-business-key")
    result = await task.wait(timeout=30)
finally:
    await orch.close(timeout=5)
```

From 0.1.9 on, results carry types for editors and type checkers ([SPEC-0033](./specs/0033-cost-retention-pricing-polling.md) Y). `orchvia.views` holds read-only views generated from the schema, such as `TaskSnapshotView`, named as the SDK names the fields: `task.status` is a `Literal` of the task statuses and `task.spec.goal` a `str`. Mutations return receipt views, such as `TaskReceiptView`, that add `method`, `scope`, `idempotency_key` and `retry_identity`. At run time every result is still a `Snapshot`; raw JSON such as `operation.result` keeps the wire's names and is typed `Mapping[str, Any]`. A field that the schema does not require may be absent, so read it with `get()`, except on a `TaskHandle`, whose `get()` reads the task again. Methods whose results the schema does not define, such as `costs.get`, `storage.status`, `context.estimate` and `context.check_refs`, still return `Snapshot`.

This checks example requires a registered host-check rule in host.json. A wait timeout stops only observation. Preserve shutdown errors and original business exceptions as shown in [Python README](../python/README.md); do not delete state or kill shared processes after an incomplete close. Snake_case public fields map to camelCase wire fields; operation results and raw native JSON preserve wire keys.

## 7. Standalone host and CLI

```sh
node packages/cli/src/main.ts doctor --config /absolute/host.json
node packages/cli/src/main.ts host --config /absolute/host.json
# In another terminal:
node packages/cli/src/main.ts run --socket /absolute/private/state/host.sock --task /absolute/task.json
node packages/cli/src/main.ts attach --socket /absolute/private/state/host.sock --task TASK_ID
node packages/cli/src/main.ts control --socket /absolute/private/state/host.sock --target /absolute/target.json --action pause --mode drain
```

`submit` persists without observing; `status` reads a task; `approve` requires the approval ID, current revision and explicit approve/deny. `run`/`attach` detach on approval, blocked or paused by default; `--follow` keeps observing, `--interactive` requires TTY input for a decision, and `--timeout-ms` limits local observation. Ctrl-C detaches without cancelling shared work. `control` freezes all five session target fields, and compact/rotate/stop return durable operations.

The host handles SIGINT, SIGTERM and SIGHUP with the configured shutdown mode and time from the moment it has opened its state, before its socket accepts connections, and writes `orchvia listening on PATH` only after that. A signal that arrives while the host starts shuts it down in order once it has started, without that line. Before the state is open, while the host reads its configuration and recovers, a signal ends it like a crash during startup: no client can connect yet, nothing is dispatched, and the next start recovers ([SPEC-0023](./specs/0023-corrections-before-0.1.2.md) S). A host that ended without closing, after SIGKILL, an out-of-memory kill or a power loss, leaves its socket file behind. Once the next `orchvia host --socket` has opened the state, it removes that socket if no process accepts connections on it; it refuses with `SOCKET_IN_USE`, and removes nothing, when another process listens on the path or the path is not a socket ([SPEC-0025](./specs/0025-operability-and-sdk-errors.md) S). Incomplete cleanup retains the control endpoint and operationId; another signal continues the same mode. Stdio parent EOF separately triggers bounded interrupt cleanup. No command approves automatically, enables fake implicitly, or invokes another management model.

## 8. Private tools, routing and verification

Owner-enabled tools have exactly four names: work_delegate, work_send, work_read, work_control. Claude uses SDK createSdkMcpServer/tool; Codex runs a private stdio MCP bridge. Its temporary Unix endpoint/token binds the original task/session/dispatch/generation, reaches the bridge process but not the model's commands (from 0.1.13, SPEC-0038 P02) and revokes when the turn ends. Tool arguments cannot supply a trusted actor, escalate policy, control siblings/parents, approve work, register commands, administer storage or shut down the host. The model sees one fixed catalog with an outer request object.

work_delegate validates declared independence and inherited/narrowed provider/model/profile/write scope. Task dependencies wait without consuming execution slots and wake only after required acceptance. Reuse is serial, requires compatible context/root/profile/workspace, and has a finite persisted queue deadline. Only declared fallbackModes may create a different candidate. Continue/parallel_tools are in-turn intents, not hidden child tasks. Context references must name existing bounded digest-verified artifacts.

Logical session opening makes no native/model call. Fork captures a completed source checkpoint; first use must return a distinct native identity. Compact executes a maintenance turn and requires an actual compact boundary; a method acknowledgment is insufficient. Rotate requires a quiet settled session, archives generation evidence and clears the native binding. Stop closes scheduling independently of business cancellation. Inspect performs bounded read-only native history lookup and returns unknown execution; it never settles work automatically.

Fork preconditions and effects apply to every caller:

- The source session must be quiet. An in-flight dispatch, held lease, quarantined or verification-pending dispatch, or retained runtime resource fails with `RUNTIME_STILL_ACTIVE`; a non-terminal associated task fails with `SESSION_BUSY`.
- The source's associated task must be `completed`, and `snapshotRef` must be one of its `artifactRefs`; otherwise the fork fails with `INVALID_SNAPSHOT` (`NO_SESSION_TASK` when the session has no associated task). A failed or cancelled task cannot be forked. Continue in a new session instead; it does not carry the earlier history.
- The runtime must declare `fork`, and the source needs a native session ID and a completed native checkpoint; otherwise the fork fails with `UNSUPPORTED_CAPABILITY`.
- The fork is a new logical session with the source's provider, write paths and root task, and the permission profile configured for that provider. It keeps the source model unless the call names another allowed model (below). The source session is unchanged. The fork counts toward `limits.maxLogicalSessions` (`SESSION_CAPACITY_EXHAUSTED`) and is subject to quarantine admission (`QUARANTINE_CAPACITY_EXCEEDED`).
- A fork cannot change the provider name, permission profile or write paths. Use a new session for that; it does not carry the earlier history.
- `sessions.fork` only prepares the fork. The native fork happens on the fork's first dispatch.
- A task uses a prepared fork by naming it as `candidateSessionId`; the declared mode's usual rules apply, and `reuse` requires `independent: true`. Inline `requestedMode: "fork"` instead names the source session and `snapshotRef`, and also requires `independent: true` (`INVALID_ROUTING`). Either way, the task must match the fork's provider, model, permission profile and write paths (`SESSION_INCOMPATIBLE`), and must belong to the source's root task unless the owner enables `allowCrossRootReuse` (`HISTORY_REUSE_FORBIDDEN`).

A fork may continue the source history on another model of the same provider. These rules also apply to every caller:

- Pass `model` to `sessions.fork`. It must be in the provider's configured `models` (or `model`) list. Without a configured list, or for an unlisted model, the fork fails with `VALIDATION_ERROR`. Omitting `model`, or naming the source model, is an ordinary fork.
- The runtime must declare `forkModelChange: true`, otherwise `UNSUPPORTED_CAPABILITY`. Claude declares it; Codex does not. Both SDKs also require the host to advertise `sessionLifecycle.forkModel` before sending `model`.
- The caller must also pass `acknowledgeCacheLoss: true`, otherwise the fork fails with `CACHE_LOSS_NOT_ACKNOWLEDGED` and no session is created. The runtime resends the whole history with every request, so the new model receives the source conversation up to the checkpoint. It cannot reuse the source model's prompt cache: the first response after the change reprocesses the whole inherited history and is slower and more expensive; later responses warm the new model's cache. Tell end users this before they switch. The operation result and the `session.fork_prepared` event carry `modelChange: {fromModel, toModel, promptCacheReuse: false}` for that message.
- Tasks on the fork must declare the target model (`SESSION_INCOMPATIBLE` otherwise). `contextLimits`, pricing and budget reservation use the target model at dispatch, as for any task; a missing price under an active budget pauses the task with `BUDGET_PRICE_UNKNOWN`. The engine does not estimate inherited history from recorded usage, so `contextEstimate` must include the inherited history. The provider's own context limit remains the final boundary.
- Only a client can change the model. Inline `requestedMode: "fork"` keeps the source model, and bound runtime tools can neither name a model nor claim a prepared fork.

```ts
const branch = await orch.sessions.fork(target, snapshotRef, {
  model: 'claude-haiku-4-5',
  acknowledgeCacheLoss: true, // after telling the user about the slower, costlier first response
});
```

```python
branch = await orch.sessions.fork(target, snapshot_ref, model="claude-haiku-4-5",
                                  acknowledge_cache_loss=True)
```

Checks use owner-registered verificationRules with ID/version/argv/canonical cwd/time/output/profile/success criteria. The task freezes their digest at admission. Checks run after runtime stop, capture baseline hashes and output, and require all checks and dependencies to pass. Failed checks consume a finite repair/turn budget. Unconfirmed verifier cleanup retains execution/write ownership until explicit owner evidence. Registered commands run as the local user; baseline checks detect mutation afterward and are not an OS sandbox. Startup, store switches and configuration loading check only a rule's shape, including that its paths do not leave the workspace by name. Paths are resolved when a rule is registered and when a task that uses it is admitted: a path that cannot be resolved refuses the task with `INVALID_WORKSPACE_SCOPE`, and the message names the rule, the path and the system error code. A path removed after admission makes that check fail ([SPEC-0017](./specs/0017-audit-corrections.md) A01).

Rules run in order, and a verification stops at its first failed rule. When a task is dispatched again after a failed verification, its prompt lists the failed rule as one line of JSON: `ruleId`, `argv`, `exitCode`, `signal`, `timedOut`, `error`, `outputBytes`, `outputTruncated`, and `outputTail`, the end of the captured output within 4 KiB after JSON encoding. The output is labeled untrusted, and the prompt still names the evidence artifacts. **The check's output reaches the model on retry: a rule must not print secrets.** The event `verification.completed` carries `rules`, a summary of every rule that ran with the same fields except `argv`, so a host can show why a check failed. A failed rule also holds `outputTail`, the tail that the retry prompt shows, or `outputOmitted: 'limit'` when the 16 KiB for the event's failed rules ran out; **the event therefore holds what a check printed** ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) E03, which supersedes V04). The evidence artifacts themselves have no read method on the current store ([SPEC-0022](./specs/0022-close-interrupt-and-verification-feedback.md) V01 to V03).

Task acceptance mode human uses purpose task_acceptance. `runtimeApprovals.enabled` routes native permission requests as purpose runtime_permission with exact dispatch/tool digest and expiry. The consumer must distinguish them; no consumer, cancellation, expiry or stale target grants permission. The four owner-enabled orchestration tools are preapproved by native MCP and remain subject to engine authorization and limits. Native permission-hook coverage still requires real-runtime acceptance. With Claude Code 2.1.283, a dangerous removal such as `rm -rf "$(pwd)"` still reaches `canUseTool` in `default` and `bypassPermissions` modes, and Claude Code waits for the answer until the runtime permission expires; in `auto` mode its built-in safety check denies the call without asking ([SPEC-0032](./specs/0032-claude-session-totals.md) B03).

### 8.1 Host workflow controls

[SPEC-0014](./specs/0014-host-workflow-controls.md) adds the controls below for every caller. `initialize` advertises them as `capabilities.workflow` (`version: 1` and one `true` flag per feature); both SDKs check the relevant flag before sending a new method or field and fail with `UNSUPPORTED_CAPABILITY` otherwise. Four of them change existing behavior on upgrade: dependency results in prompts, JSON-encoded message summaries, the default read fence and its Bash sandbox rules.

**Several profiles of one runtime.** `createClaudeAdapter({ provider, permissionProfile })` and `createCodexAdapter({ provider })` register under a chosen name (default `claude`/`codex`; 1–128 characters of `[A-Za-z0-9._-]`). One engine can therefore run a read-only and a writable Claude, for example `claude-read` and `claude-write`, each with its own `providers.<name>` entry. The adapter reports execution evidence under the same name; never rename an adapter by wrapping it, because evidence under another name is rejected and the dispatch stays quarantined. Pricing, `contextLimits` and provider configuration use the chosen name. The JSON CLI keeps the fixed names `fake`, `claude` and `codex`.

**Dependency results.** When a task with `dependencyTaskIds` is dispatched, its prompt includes each completed dependency's result artifact, in declared order, after the goal and context references, as `Untrusted dependency result {"taskId":…,"artifactRef":…}` followed by the JSON-encoded text. Each block is limited to 32 KiB and all blocks to 96 KiB, counted in UTF-8 bytes after JSON encoding, headers and omission records included. Text that encoding expands, such as control characters, quotes and backslashes, reaches the limit sooner. A larger or missing result contributes only its identifiers, size and the reason; a block that would leave no room for the records of later dependencies is omitted too. The results are repeated on later dispatches of the task only until one dispatch that carried them returns a result. No host action is needed, so a host no longer has to wait for the upstream task and create the downstream one itself. Include the injected results in `contextEstimate`. A bound `work_read` may read (kinds `task` and `artifact`) the tasks in its own task's `dependencyTaskIds` and their artifacts, but not their dependencies. Message summaries are now JSON-encoded in the prompt too, so text produced by one model cannot forge a message header for another.

**Revise, and decision comments.** `approvals.decide` accepts `comment` (1–16,384 UTF-8 bytes) with any choice and stores it on the approval. `choice: "revise"` requires a comment and applies only to `task_acceptance` approvals: the approval becomes `revised` (event `approval.revised`), the task returns to `queued` with reason `revision_requested` (or `paused` when its session is paused) in the same session, and the next dispatch prompt includes `Reviewer revision request (approval <id>)` with the JSON-encoded comment. Downstream tasks keep waiting, and each revision counts toward `maxTurnsPerTask`. `revise` on a runtime-permission approval fails with `VALIDATION_ERROR`. `revise` on a task whose session was stopped fails with `SESSION_CLOSED` and changes nothing; approve or deny the result instead (SPEC-0017 A03). Stopping a session expires the messages still waiting for it, so a later approve or deny ends the task normally (SPEC-0017 A05).

**Read fence.** By default the Claude adapter denies `Read`, `Glob` and `Grep` outside the workspace and `readRoots`, and inside `denyRead` or the state directory; a search root that contains a denied path is also denied. Configure `readRoots` (existing absolute directories), `denyRead` (absolute or workspace-relative paths) or `readFence: false` on the adapter; capabilities report `readFence`. In the writable profile the OS sandbox additionally denies Bash reads of the host process's home directory (`os.homedir()`), the state directory and `denyRead`, while re-allowing the workspace and `readRoots`; `denyRead` inside the workspace stays denied. Commands that read home-directory configuration such as `~/.gitconfig` or `~/.npmrc` need those paths in `readRoots`. A host-supplied `sandbox.filesystem.allowRead` that overlaps the state directory is rejected. Codex declares `readFence: false` because its sandbox does not restrict reads. The guard is covered by the Claude scripted-gateway smoke; the Bash sandbox rules were verified locally on macOS with `scripts/native-read-fence-smoke.mjs`, which needs an available OS sandbox.

**Concurrency.** `limits.maxActiveSessions` accepts 1–8 (default 2). The engine never raises it. Keep `maxQuarantinedDispatches` comfortably above it: with both at 8, eight running dispatches fill the quarantine floor and new tasks are refused with `QUARANTINE_CAPACITY_EXCEEDED` until work settles. Each active Claude or Codex session is a native child process.

**Delegation gate.** With `tools.approveDelegation: true`, a child created by `work_delegate` starts `paused` with reason `DELEGATION_APPROVAL_REQUIRED` and holds no execution slot. Approve it with `tasks.resume` and reject it with `tasks.cancel`; pausing or resuming its session, including from a runtime tool, does not release it. On approval the engine rechecks its dependencies and restarts its routing wait, so time spent awaiting the host never expires the route.

**Handoff requests.** With `tools.handoffs: true`, a `work_delegate` that reuses an existing open session outside the model's subtree records a pending handoff request instead of failing with `UNAUTHORIZED`, and returns `{handoffId, status: "pending"}`. The request carries only the goal and context references the requester may read: artifacts of its own subtree and of the tasks in its own `dependencyTaskIds`, not their dependencies or unrelated tasks. It creates no task, changes nothing in the target session and grants nothing. The host reads requests with `handoffs.get`/`handoffs.list` (events `handoff.requested`, `.accepted`, `.rejected`, `.expired`) and decides. To accept, the host creates the task itself — for example as a child of the target session's root task reusing that session, so it runs with that session's permissions and budget — then calls `handoffs.resolve` with `outcome: "accepted"` and the task's ID. The engine only records the link. Requests expire after `tools.handoffTtlMs` (default 24 hours, 1 minute to 7 days, wall-clock time), on time even on an idle host (SPEC-0017 A04), each root task may hold 100 pending requests (`HANDOFF_LIMIT`), and the requester can read its own request with `work_read` kind `handoff`. A backup import marks pending requests `invalidated`; they do not block a rollover or import.

**Narrowed write paths.** A task or `sessions.open` spec may add `writePath`, an existing workspace path inside its `writeScope`; the task's or session's write paths become that one path. Write conflicts, session compatibility and the Claude write sandbox use it, so agents with disjoint paths under one registered scope write concurrently. `work_delegate` accepts `writePath` within the parent's write paths, and a child inherits a narrowed parent path. Tasks with verification rules still lock the whole workspace. Clients still cannot register a new write root.

**Runtime rules.** The owner (in-process or stdio host) can call `rules.register({rule})` to append a verification rule version in the configured rule format; an existing `id@version` with the same content is a no-op and different content fails with `CONFLICT`. `rules.list()` shows effective rules with `source: "config" | "runtime"`. Registered rules persist in the active store; if a configured rule later conflicts with a registered one, startup fails with `VALIDATION_ERROR`. A rule whose directory was removed or renamed no longer blocks startup; tasks that use it are refused until the path exists again. `stores.rollover` carries registered rules into the new store. `stores.import` restores the backup's rules, so rules registered after the backup must be registered again; an import whose backup conflicts with a configured rule fails with `VALIDATION_ERROR` before switching. A rule `id` or `version` may contain `@`. Tasks still freeze their rules at admission. At most 1,000 rules may be effective. Limits, tool limits and message limits still change only on restart.

**Retiring rules.** Where `initialize` lists `workflow.ruleRetirement`, the owner calls `rules.retire({ id, version })` (Python `rules.retire(id, version)`) to retire a rule registered at runtime ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) U). It leaves the effective rules at once: it no longer counts toward the 1,000, and a task admitted afterwards that names it fails with `RULE_RETIRED`. A task admitted before keeps its frozen copy for its verification and its repair retries. Retirement commits the event `rule.retired` and lasts across restarts, rollovers and imports; a retired rule never keeps a host from starting, even when the configuration now defines the same `id` and `version` differently. Registering a retired version again with the same content reactivates it: it is effective again, the event `rule.reactivated` is committed, and the operation's result holds `reactivated: true`; it counts toward the 1,000 again. Other content under a retired version fails with `RULE_RETIRED`: a changed rule takes a new version ([SPEC-0029](./specs/0029-usage-by-task-and-close-markers.md) C). An idempotency key names one request, not the state a host wants: sent again, it returns the first result and changes nothing. Registering a retired rule under the key of its first registration therefore leaves it retired, and retiring a reactivated rule under the key of an earlier retirement leaves it effective. Reactivate a version, or retire it again, under a new key, for example one that names the retirement it undoes ([SPEC-0030](./specs/0030-cache-write-durations-and-commit-time.md) C). A rule of the configuration cannot be retired (`VALIDATION_ERROR`); remove it from the configuration instead. `rules.list({ includeRetired: true })` lists the retired rules after the effective ones, each with `retiredAt`.

**Listing tasks.** `task.created` data includes `parentTaskId` and `rootTaskId`. `tasks.list({parentTaskId? | sessionId?, limit?, afterCursor?})` returns creation-ordered pages (default 50, at most 100) with `nextCursor`.

```ts
const page = await orch.tasks.list({ parentTaskId: root.id });
await orch.approvals.decide(approval.approvalId, {
  choice: 'revise',
  expectedRevision: approval.revision,
  comment: 'Add tests for the empty case',
});
const [request] = (await orch.handoffs.list({ status: 'pending' })).handoffs;
const takeover = await orch.tasks.create({
  goal: request.goal,
  runtime: { provider: 'claude-read', model: 'claude-sonnet-4-6' },
  acceptance: { mode: 'human', criteria: ['Reviewed'] },
  parentTaskId: agentRootTaskId,
  contextPlan: {
    requestedMode: 'reuse',
    independent: true,
    candidateSessionId: request.targetSessionId,
  },
});
await orch.handoffs.resolve(request.handoffId, {
  expectedRevision: request.revision,
  outcome: 'accepted',
  taskId: takeover.id,
});
```

```python
page = await orch.tasks.list(parent_task_id=root.id)
await orch.approvals.decide(approval.approval_id, {"choice": "revise", "expected_revision": approval.revision,
                                                   "comment": "Add tests for the empty case"})
request = (await orch.handoffs.list(status="pending")).handoffs[0]
await orch.handoffs.resolve(request.handoff_id, expected_revision=request.revision, outcome="rejected")
```

### 8.2 Queue waits

[SPEC-0015](./specs/0015-queue-waits.md) defines how long a task may wait in the queue for its first dispatch. It applies to every caller and changes behavior on upgrade.

- **The wait.** A task's wait is `contextPlan.maxQueueWaitMs`, from 0 to 604,800,000 ms (seven days). A task without a plan, or whose plan omits the field, uses the host default `limits.defaultMaxQueueWaitMs`, which is 30,000 ms unless configured. The wait is fixed when the task is admitted, so a configuration change affects only new tasks. An identical `tasks.create` retry returns the original task under any default, because the idempotency digest uses the fixed 30,000 ms fallback (SPEC-0017 A02). A request first admitted by rc.9 or rc.10 under another default gets `IDEMPOTENCY_CONFLICT` once if it is retried after the upgrade. `0` means the task must dispatch as soon as it is ready, or expire. This includes children created by `work_delegate` whose plan omits the field. A `work_delegate` call without a `contextPlan` continues in the caller's session and creates no child.
- **Only queued time counts.** A task that waits for its dependencies, or is paused, has no running deadline. Each time a task enters the queue, the wait restarts and `routing.enqueuedAt` and `routing.deadlineAt` are reset: when its dependencies complete, when it is resumed and when a delegation is approved. `enqueuedAt` is therefore not the creation time; use `createdAt`. While a task is not queued, `deadlineAt` is informational. Dispatch order stays creation order. A retry never renews a deadline.
- **Expiry.** A task still queued when its wait ends moves to a declared fallback, or becomes `blocked` with `SCHEDULING_BLOCKED`. It is never revived; create a new task.
- **Clock and host lifetime.** The wait is measured on the wall clock. Time the computer sleeps while a task is queued counts; after waking, an overdue task expires at the next scheduler pass. Time the host is not running never counts. Closing the host pauses queued tasks with reason `owner_shutdown`, and a start after a crash pauses them with `owner_restart`. They do not run until the host resumes them with `tasks.resume` or a session resume, and resuming restarts the full wait. A host whose users close the app or let the computer sleep with queued work should resume these tasks at startup and choose a default long enough to cover sleep.
- **Dependent tasks created up front** wait for their dependencies and their acceptance without a deadline, then get their full wait to be dispatched. Waiting tasks still count toward `limits.maxQueuedTasks`. A dependency that fails or is cancelled still blocks its dependents.

```ts
const orch = await createOrchestrator({
  workspace,
  stateDir,
  adapters,
  limits: { defaultMaxQueueWaitMs: 86_400_000 }, // a day; the JSON CLI accepts the same field
});
```

### 8.3 Optional routing layer

[SPEC-0018](./specs/0018-routing-layer.md) adds `@orchvia/sdk/routing` and `orchvia.routing`, and [SPEC-0019](./specs/0019-routing-corrections.md) corrects it; the published packages include both. A judge answers typed questions about a request and the agents of one group. Code turns the answers into an ordinary `TaskSpec` with `contextPlan`, and the host submits it or not. The router adds no engine rule or storage. Its one engine addition is the read-only `context.checkRefs` of [SPEC-0020](./specs/0020-context-check.md), after rc.13, and every engine rule still applies to what is submitted.

**Setup.**

- Create the router with `createRouter({ orchestrator, judge, runtimes, scope?, describe?, policy? })`, or `Router(orch, judge, read_only=..., writable=..., scope=..., describe=..., policy=...)` in Python.
- `runtimes` names the provider and default model for fresh read-only and for fresh writable work, each with an optional `small` and `large` model. Those models must be in the provider's configured model list.
- `scope` sets what a group is:
  - `'root'`, the default: a group is one root task. Pass the group's `rootTaskId`; the proposed task becomes its child.
  - `'engine'`: a group is the whole engine. Run one engine per group, with its own workspace and `allowCrossRootReuse: true`. The engine does not report that flag, so a wrong scope shows up as `HISTORY_REUSE_FORBIDDEN` on submit.

**Candidates.** `route({ goal, acceptance, members, rootTaskId?, needsWrites?, spec? })` considers only the given member session ids, at most 16.

- It reads each member with `sessions.get` and its latest task with `tasks.get`.
- It drops a member when:
  - the session is closed, paused, pausing or has an unknown outcome;
  - the session has no task;
  - it belongs to another root task under `'root'`;
  - the request's `spec.writeScope` or `spec.writePath` differs from the member's.
- A member counts as busy when it is not idle, or when its latest task has not ended. Waiting for approval counts as not ended.
- A reused member keeps its provider, model, write scope and write path.

**What the judge receives.** One call per route.

- State: `{ request: { goal }, agents: { A1: { description, status: 'idle' | 'busy', access: 'read-only' | 'writable' }, … } }`. Aliases follow the member order.
- Questions:
  - `best`: a choice over the aliases and `fresh`;
  - `relevant.<alias>`: yes/no, one per member;
  - `writes`: yes/no, asked only without `needsWrites`;
  - `size`: a score of trivial, moderate or large, asked only when a ladder has `small` or `large`;
  - `depends.<alias>` and `clash.<alias>`, for each busy member: a score of none, helpful or essential, and a yes/no.
- Notifications send `{ finding: { text }, agents }` and ask `affects.<alias>`, a yes/no, for every member except the source.

**Decisions.** The thresholds are `policy` fields.

| Situation                                                                                   | Proposal                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The judge fails or times out                                                                | Fresh session with no context; `JUDGE_UNAVAILABLE`; confirmation unless `onJudgeFailure: 'fresh'`                                                                                        |
| `best` is `fresh`, or no eligible member reaches `relevantAt` (0.5)                         | Fresh session carrying the results of members at `contextAt` (0.7) or above, most relevant first, at most `maxContextRefs` (20); a result over 32 KiB is left out with `CONTEXT_OMITTED` |
| The best member is idle                                                                     | `reuse` it, wait up to `busyWaitMs` (20 minutes), fall back to `fresh`                                                                                                                   |
| The best member is busy and `clash` ≥ `clashAt` (0.5) or P(essential) ≥ `essentialAt` (0.5) | `reuse` it and wait; no fallback when P(essential) ≥ `essentialNoFallbackAt` (0.7)                                                                                                       |
| The best member is busy otherwise                                                           | Fresh session now, carrying that member's result first                                                                                                                                   |
| The request needs writes                                                                    | Read-only members are removed and the `best` probabilities renormalized; the shares only order the alternatives                                                                          |
| Model for fresh work                                                                        | `small` when P(trivial) ≥ `smallAt` (0.85), `large` when P(large) ≥ `largeAt` (0.7), else the default                                                                                    |

`needsConfirmation` is set by any of these reasons:

- `LOW_CONFIDENCE`: `confidence` is below `confirmBelow` (0.85). It is the lower of the judge's own `best` confidence (`judgeConfidence`) and the judge's probability for the proposed option; for a fresh session because no member is relevant, 1 minus the highest relevance takes that probability's place;
- `NARROW_MARGIN`: the top two options are within `minMargin` (0.2);
- `WRITES_UNCERTAIN`: the writes probability is between 0.3 and 0.7;
- `RUNTIME_MISSING`: the needed runtime is not configured.

`alternatives` lists the options as session ids or `fresh`, each with `probability`, its share among the options that can take the work, and `judgeProbability` (Python `judge_probability`), the probability the judge gave it.

**Carried results.** Every path that carries results, including a busy member's own, measures each result in UTF-8 bytes from the task snapshot and leaves out any over the engine's 32 KiB inline limit. It records a `CONTEXT_OMITTED` reason with `sessionId`, `artifactRef`, `reason: 'too_large'`, `maxBytes` and, when known, `bytes`; the result takes no `maxContextRefs` place and is never summarized. It does not set `needsConfirmation`; a host that wants a confirmation checks `reasons` for `CONTEXT_OMITTED`.

**Checking results before submitting** ([SPEC-0020](./specs/0020-context-check.md)). Where `initialize` reports `capabilities.workflow.contextCheck`, the router asks the engine about every result it might carry, in one `context.checkRefs` call per 20, and leaves out the ones the engine refuses. Their `CONTEXT_OMITTED` reason is `expired`, `corrupt`, `missing`, `unreadable` or `too_large`, with the engine's `code` and, when known, `bytes`. An engine without the capability gets the size check only, and the proposal adds `CONTEXT_UNCHECKED` with the number of unchecked results. A failed check fails `route()`. The engine checks again on submit, so a result that changes in between still fails with its error and creates nothing.

Any client, including a socket client that is not the owner, can call `orch.context.checkRefs([{ artifactRef, version: 1 }])`, or `await orch.context.check_refs([{"artifact_ref": ref, "version": 1}])` in Python, with 1 to 20 references. The result lists, in order, `{ artifactRef, admissible, code?, bytes? }`: what task admission would decide at that moment. The codes are `ARTIFACT_TOO_LARGE`, `ARTIFACT_HISTORY_EXPIRED`, `ARTIFACT_CORRUPT`, `NOT_FOUND` and `ARTIFACT_UNREADABLE`. The call reads only: it returns no content, records nothing and does not extend retention. Admission reports a reference it cannot read as `ARTIFACT_UNREADABLE` too.

**Findings.** `notifications({ text, fromSessionId, members, rootTaskId? })` first checks the group, before the judge is asked. The source must be one of `members`, or it fails with `RoutingError` `ROUTING_SOURCE_NOT_MEMBER`. Under `'root'` the group is the source's own root task, and a different `rootTaskId` fails with `ROUTING_ROOT_MISMATCH`; under `'engine'` `rootTaskId` is ignored. It returns three lists:

- `notify`: members at `notifyAt` (0.7) or above whose task has not ended. `notify(plan)` sends them `finding` messages.
- `confirm`: members between 0.5 and 0.7 whose task has not ended; the host decides.
- `followUp`: affected members whose task ended. The engine does not accept messages for them, so start a follow-up task instead.

If the judge fails, the plan is empty and reports why.

**Jev.** TypeSafe's Jev is a third-party paid service; Orchvia is not affiliated with TypeSafe. `createJevJudge({ apiKey, model?, baseUrl?, timeoutMs? })`, or `JevJudge(api_key, ...)` in Python:

- calls `POST https://api.typesafe.ai/v1/systemone` with a bearer token, and pins `jev-1.13.0` by default;
- retries once on HTTP 429, 529, 5xx or a network error, within `timeoutMs` (10 seconds by default), which bounds the whole evaluation, including the retry, its pause and a slowly arriving response. Python runs each request on its own thread and shuts the connection down at the deadline or on cancellation; a name lookup cannot be interrupted, so that thread then only ends when the lookup returns;
- raises `JudgeError` with one of these codes: `JUDGE_AUTH`, `JUDGE_INVALID_REQUEST`, `JUDGE_RATE_LIMITED`, `JUDGE_UNAVAILABLE`, `JUDGE_TIMEOUT`, `JUDGE_PROTOCOL`.

Any other judge only has to return the documented answer shapes; malformed answers count as `JUDGE_PROTOCOL`.

## 9. Usage, costs and context estimates

Usage belongs to the original dispatch/task/root even when a native session is reused. Callback/yield replay deduplicates observations by dispatch and source ID. Late records remain on the original owner. Missing fields and ambiguous cumulative scope remain unknown; overlapping total/cached token buckets are not billed twice.

A usage record written from 0.1.5 on also holds `sessionId`, `model`, `rootTaskId` and `recordedAt`, and the event `usage.recorded` carries the four token counts, `model` and `rootTaskId` besides the record's ID, so a host can update its totals from the event alone; `usage.getRecord` still returns `raw`, which the event leaves out. A repeated report of an observation is compared on the fields that earlier versions stored, so a late repeat is accepted ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) E01, E02). `usage.summary({ rootTaskId })` totals a root task's tree per model (section 5.5).

A runtime may split its cache writes by how long they live. The record then holds `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`, which together are `cacheWriteInputTokens`, and `usage.recorded` carries them; a record without a split has neither. The engine refuses one count alone, or two that do not add up, with `INVALID_RUNTIME_CONTRACT`, and the Claude adapter reports them only when Claude's own counts add up ([SPEC-0030](./specs/0030-cache-write-durations-and-commit-time.md) A). Registered prices keep one rate for cache writes, so the engine's own cost estimates stay approximate for writes that live an hour.

From 0.1.8 on, the Claude adapter also records the calls of a dispatch outside its main loop ([SPEC-0031](./specs/0031-usage-outside-the-main-loop.md)). Claude's result counts the main loop in `usage`, and every call of the query in `modelUsage`: Task subagents, sidechains and internal calls such as a compaction, which Claude Code also runs by itself when a context fills. The record of the main loop is unchanged. Each model's calls outside it become a further record: the main model's under the dispatch's model, so that one model makes one row in the totals, and another model's under its canonical name. These records have no split of their cache writes. When the adapter cannot tell which model ran the main loop, or a count does not add up, the record's counts are unknown rather than guessed. A usage observation may name its `model` for this; a repeated observation must resolve to the same model. The cost ledger prices a record of another model at that model's registered price in the dispatch's currency; without one, the cost is unknown and the dispatch's reservation stays held.

From Claude Code 2.1.277 (Claude Agent SDK 0.3.277) on, a resumed or forked session's `modelUsage` continues from its earlier dispatches. From 0.1.9 on, the adapter reports each dispatch's session totals, the engine keeps them with the dispatch, and the adapter subtracts those of the dispatch before on the same native session, or for a fork's first dispatch those of its source's latest dispatch ([SPEC-0032](./specs/0032-claude-session-totals.md)). When there are none to rely on, because the dispatch before had no matched result, the session's last dispatch ran on an earlier Claude Code, or a fork's source was running, the record outside the main loop has unknown counts. Records that 0.1.8 wrote on SDK 0.3.277 or later are not corrected: the `…:outside:…` records of a native session's second and later dispatches, and of a fork's first dispatch, include the earlier dispatches.

Owner pricing identifies provider, model, currency, version and decimal per-million-token rates. From 0.1.9 on, `perMillion` may also set `cacheWrite5m` and `cacheWrite1h`: a record that splits its cache writes by duration prices each part at its own rate, or at `cacheWrite` without one; a record without the split, such as a record outside the main loop, takes `cacheWrite`; a cache write without any applicable rate makes the cost unknown with the reason `cache_write_rate_missing` ([SPEC-0033](./specs/0033-cost-retention-pricing-polling.md) C). Costs use exact decimal arithmetic; costs.get and budget checks read only the records they concern, through indexes (P); costs.get supports direct/tree/host_overhead, and owner-only recordOverhead deduplicates a supplied billingId. Reservations are committed before dispatch and include concurrent held reservations. Confirmed complete usage settles unused reserve; missing usage retains reserve. These are scheduling estimates, not upstream invoices or hard provider-side spend caps.

context.estimate reports per-request keep/compact scenarios for continued cache hits, TTL rebuilds, partial retained prefixes and history growth. Compaction is counted once; unknown intervals/metrics yield explicit ranges or unknown. No automatic economic routing or compaction optimization is enabled without measured native capability/benefit evidence.

## 10. Namespace, retention and archives

Every mutation uses expectedStoreId. TS receipts/errors expose retryIdentity; Python exposes retry_identity. Preserve `(storeId, method, scope, idempotencyKey, digestVersion, requestDigest)` with the original request. SDK retry reuses this identity and rejects changed payloads. `refresh()` intentionally observes the current active namespace; it never rewrites an old retry. An old key sent into a new store must fail before mutation.

The engine commits nothing for a request it rejects, and each SDK forgets the identity of a key that the rejected call claimed, so the same key with a corrected request is sent. It keeps the identity when the key held one before the call, when the request failed in the SDK or its transport (a timeout, a lost connection, an abort) and after the engine errors that can follow a commit or leave it unknown: `RESOURCE_CLEANUP_INCOMPLETE`, `ROLLOVER_IN_PROGRESS`, `ROLLOVER_BLOCKED`, `STORE_SWITCH_IN_PROGRESS`, `SHUTDOWN_INCOMPLETE`, `OUTCOME_UNKNOWN`, `OPERATION_HISTORY_EXPIRED`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ERROR`, `STORAGE_DEGRADED` and an error without a code. `forgetIdempotencyKey(key)` (Python `forget_idempotency_key`) removes a key's identities; the engine still refuses another request under a key it committed. Each client keeps at most 10,000 identities; a retry of an evicted key is still checked by the engine, but is no longer bound to the store of its first attempt ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) K).

Read operations.lookup in the original store. After rollover, use archives.lookup with the original storeId/method/scope/key and optional requestDigest. Expired details produce OPERATION_HISTORY_EXPIRED while lifetime tombstones preserve deduplication. ARCHIVE_UNAVAILABLE, ARCHIVE_CORRUPT and ARCHIVE_NOT_FOUND are distinct and are never proof of non-execution.

Save event cursor with storeId. A cursor other than `0` without its `storeId`, or one that is not a decimal cursor, fails with `VALIDATION_ERROR`: the caller must fix the request. `CURSOR_EXPIRED` means that the reader must resynchronize, and its data says why: `reason` is `store_changed` when `storeId` names another store (after a rollover or an import), `below_retention_floor` when events after the cursor were collected, and `ahead_of_store` when the store has fewer events than the cursor (after restoring an older copy); the data also holds `retentionFloorCursor`, `lastCursor` and `currentStoreId` ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) C). CURSOR_EXPIRED requires state.snapshot: retain its snapshotId/cursor, read bounded pages using nextOffset, rebuild visible state, release the lease and resume events exclusively after the captured cursor. The snapshot is fixed, lasts at most 60 seconds, and does not reconstruct deleted audit history. Expiry requires a new snapshot rather than mixing pages.

Owner storage APIs expose status/configure/collect/pin/unpin/backup. Protected references override retention. GC operates in bounded batches; inspect oversizedArtifacts and pressure instead of assuming one call removes all eligible data. Policy changes are audited and do not initiate destructive rollover automatically. Full/I/O errors stop admission and release emergency reserve for bounded recovery; degraded public close releases owned resources and reports STORAGE_DEGRADED_CLOSED with durableReceipt=false if it could not save a shutdown receipt.

stores.rollover requires configured controlDir/storesRoot/archiveRoot and a fully settled old store. It verifies a complete archive, prepares a fresh identity, retires/fences the old writer, commits the active manifest and then activates the new writer. Restart resumes the same durable switch. Old state remains preserved. Unfinished tasks, unknowns, resources, approvals/messages/outbox, operations, conflicts, GC and leases block rollover with IDs.

storage.backup returns a registered backupId. stores.importBackup / stores.import_backup imports it under a fresh store identity, preserves provenance, and quarantines unfinished work with explicit reconciliation targets. It never restores credentials or replays tasks. Original native history outside managed runtime storage is not promised in a backup. No cross-store semantic deduplication is inferred.

## 11. Startup, shutdown, and recovery SOP

### 11.1 Startup order

Run offline doctor; select exactly one owner; let migration/file recovery complete; negotiate wire 2.0 and capabilities; attach event/approval consumers; explicitly submit or resume work. Native identity, authentication and sandbox checks are separate acceptance steps. Recovery never blindly sends an unfinished dispatch again.

### 11.2 Normal shutdown

Use `orch.close({mode:'drain',timeoutMs:30000})` for an embedded owner or `await orch.close(mode="drain",timeout=30)` for Python. Drain does not escalate automatically. If SHUTDOWN_INCOMPLETE occurs, retain its live client and operationId and explicitly continue or request interrupt. Preserve the original business result/error/cancellation while handling cleanup. Connected clients simply disconnect. Public close after a latched storage failure may report STORAGE_DEGRADED_CLOSED after releasing resources, because no durable shutdown receipt can be promised.

What close leaves behind ([SPEC-0016](./specs/0016-session-after-task-end.md) S02):

- `close({mode:'interrupt'})` asks every running turn to interrupt, then waits for the turns to end before it closes the adapters: at most `timeouts.interruptMs` (default 30 seconds) and at most half of `timeoutMs`. A turn whose runtime reports the interruption in that time is paused with reason `runtime_interrupted`, after the host's stop proof when the adapter needs one, and its session is paused without a `pauseOrigin`. A turn that does not answer in time is ended by closing the adapters and stays `outcome_unknown`, blocked after the next start ([SPEC-0022](./specs/0022-close-interrupt-and-verification-feedback.md) C01 to C03). It pauses queued tasks with reason `owner_shutdown`.
- `close({mode:'pause'})` closes as `interrupt` does, and a turn that it interrupted and that reports the interruption in time is paused with reason `owner_shutdown`, as queued tasks are, instead of `runtime_interrupted`. A turn that another request had already interrupted keeps `runtime_interrupted`, and one that does not answer in time stays `outcome_unknown` ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) S). `host.shutdown`, `host.shutdown.continue` and the command-line configuration's `shutdown.mode` accept `pause` where `initialize` lists `workflow.pauseClose`.
- When the owner of a stdio host disconnects, the host closes the adapters at once, so running turns stay `outcome_unknown` (C05).
- Pausing each running session with `sessions.control` `{action:'pause', mode:'interrupt'}` and then closing with `mode: 'drain'` does not stop all work. As soon as a paused turn frees its execution slot or its write paths, the scheduler can start a queued task, and the drain then waits for that task. `close({mode:'interrupt'})` and `close({mode:'pause'})` stop dispatch and pause every queued task before they interrupt any turn. For a runtime that needs longer to answer an interrupt, raise `timeouts.interruptMs` and the close's `timeoutMs`: the close waits for the smaller of `interruptMs` and half of `timeoutMs`.
- A task that a close paused carries `pausedByClose: { operationId, wasRunning }` while it stays paused: `wasRunning` is true for a turn that an `interrupt` or `pause` close interrupted, and false for a queued task that a close of any mode paused. A turn that another request had already interrupted carries none ([SPEC-0029](./specs/0029-usage-by-task-and-close-markers.md) D).
- After the next start, `tasks.resume` continues these tasks, and each resumed queued task gets its full queue wait again (SPEC-0015). Resume the tasks with `wasRunning: true` first: a queued task that wrote the same files would otherwise start before the turn it waited for.
- A client's own pause records `pauseOrigin: "client"` on the session, and the task reason is also `runtime_interrupted` if the pause interrupted a turn. A host that resumes interrupted work automatically must skip sessions whose `pauseOrigin` is `client`, or it overrides the user's pause.

### 11.3 Restart recovery

Reconnect to a live host instead of starting a second writer. Reuse canonical workspace/state paths and correct runtime configuration. Unknown execution remains blocked with original native/dispatch IDs. Read-only sessions.inspect may add evidence but never proves non-execution from missing history. Resume only after the relevant explicit owner resolution. Do not restore an old database over live state, discard tombstones or reset keys to bypass uncertainty.

If the host process ends before `close` completes, the next start finds:

- Each running task `blocked` with reason `outcome_unknown: previous owner exited during a dispatch`. Its session is `outcome_unknown`, and it holds an execution slot and a quarantine slot.
- Queued tasks paused with reason `owner_restart`.

Reconcile each unknown dispatch with `sessions.reconcile` (section 11.4). The evidence decides what is released:

- **`localResources` and `remoteExecution` stopped, but `sideEffects` or `outcome` unknown:** the execution slot is released and the dispatch keeps its quarantine slot. The session stays `outcome_unknown` and cannot be reused. When `limits.maxQuarantinedDispatches` slots (default 32) are held this way, no new work is admitted (`QUARANTINE_CAPACITY_EXCEEDED`). Once the side effects are known, reconcile the same session again with a resolved attestation to free the slot.
- **Resolved, with `outcome: "interrupted"`:** use this after the host has confirmed its processes ended and the side effects were checked. It releases both slots and fails the task with `reconciled_interrupted`. The session stays `paused`. To continue with its history, resume the session with `sessions.control` (`action: "resume"`), which returns it to `idle`, then create a task that reuses it. The resume runs nothing by itself. The same resume works for any paused session whose task has ended, for example one paused while its task awaited acceptance and then approved or denied.

### 11.4 Implemented owner attestation

Current A/A2 accounts for execution resources separately from business reconciliation. Confirmed execution/cleanup releases the lease while business unknown remains quarantined. Two possibly running unknowns fill two execution slots; larger quarantine capacity cannot bypass concurrency. [A2 evidence](./tdd/0003-a2-wiring.md) covers offline TS/Python and actual Node stdio/Unix hosts, not real models.

Host defaults are acceptanceMs=30000, turnMs=1800000, drainMs=300000, interruptMs=30000, reconcileMs=60000, each integer 1..86400000 ms. Embedded TS passes createOrchestrator configuration; CLI/Python use [README host JSON](./reference.md#standalone-host-and-cross-language-integration). Python passes engine_command=[node, cli, "host", "--stdio", "--config", config_file], not local(timeouts=...). Convert LifecycleTimeouts snake_case values with orchvia.types.to_wire. SDK wait does not renew deadlines.

Total budget starts at dispatch and includes initialization/acceptance; acknowledgments/output do not renew it. Use the shorter host/explicit-provider cap; longer provider caps cannot extend host time. CLI requestTimeoutMs/turnTimeoutMs accept integer 1..3600000 ms. Cleanup fields are Claude cleanupTimeoutMs and Codex closeTimeoutMs with the same range; crossed names fail. Claude additionally accepts interruptTimeoutMs with the same range. No implicit 300-second cap remains when unspecified. Upgrades/config changes do not renew old deadlines.

Timeout retains dispatch/control/related messages as outcome_unknown and Task blocked. Potentially executing unknown work keeps its slot. Late matched terminal/cleanup can release resources without business reconciliation. sessions.reconcile records an owner declaration after actual history/resource/side-effect investigation; it does not perform that investigation. Only embedded TS or managed-stdio Python owners qualify; ordinary sockets return UNAUTHORIZED. SDKs require initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true} before send, otherwise UNSUPPORTED_CAPABILITY.

Evidence fields below map camelCase to snake_case in Python:

| Field                            | Value                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| source / summary                 | "owner_attestation" / human investigation summary                                                                                       |
| localResources / remoteExecution | Each "stopped" or "unknown"                                                                                                             |
| sideEffects                      | "resolved" or "unknown"                                                                                                                 |
| outcome                          | "not_executed", "completed", "failed", "interrupted", or "unknown"                                                                      |
| result                           | Required for completed: reviewed complete string, genuinely empty allowed, maximum 524288 characters; still subject to human acceptance |

These functions accept **an existing owner SDK instance, task ID, reviewed human evidence, and durable business key**. They never infer stopped/resolved from timeout. They illustrate a first reconciliation: read an exact target, submit it, and return current state. Applications requiring recovery must save the complete target/evidence/key before the first RPC. After failure, do not rerun a helper that reads a new target; use the saved-parameter continuation below. The creating application still owns section 11.2 shutdown.

```ts
import type { Orchestrator, ReconcileEvidence } from './packages/sdk-typescript/src/index.ts';

export async function reconcileReviewedTask(
  orch: Orchestrator,
  taskId: string,
  evidence: ReconcileEvidence,
  idempotencyKey: string,
) {
  const task = await orch.tasks.get(taskId);
  const session = await orch.sessions.get(task.sessionId);
  if (
    task.status !== 'blocked' ||
    session.status !== 'outcome_unknown' ||
    !session.activeDispatchId
  ) {
    throw new Error('Task is not awaiting reconciliation');
  }
  const operation = await orch.sessions.reconcile(
    {
      sessionId: session.id,
      expectedGeneration: session.generation,
      expectedRevision: session.revision,
      expectedDispatchId: session.activeDispatchId,
      expectedState: session.status,
    },
    evidence,
    { idempotencyKey },
  );
  const outcome = await operation.wait({ timeoutMs: 30_000 });
  return { operation: outcome, task: await orch.tasks.get(taskId) };
}
```

```python
from orchvia import Orchestrator, ReconcileEvidence


async def reconcile_reviewed_task(
    orch: Orchestrator, task_id: str, evidence: ReconcileEvidence, idempotency_key: str,
):
    task = await orch.tasks.get(task_id)
    session = await orch.sessions.get(task.session_id)
    if (task.status != "blocked" or session.status != "outcome_unknown"
            or not session.active_dispatch_id):
        raise ValueError("Task is not awaiting reconciliation")
    operation = await orch.sessions.reconcile({
        "session_id": session.id,
        "expected_generation": session.generation,
        "expected_revision": session.revision,
        "expected_dispatch_id": session.active_dispatch_id,
        "expected_state": session.status,
    }, evidence, idempotency_key=idempotency_key)
    outcome = await operation.wait(timeout=30)
    return {"operation": outcome, "task": await orch.tasks.get(task_id)}
```

Operation completed confirms both the reconciliation record and any required adapter-record cleanup. Inspect result.executionReleased, result.resolved, and current task separately. Both resources stopped with no active handles/conflicts can yield executionReleased=true,resolved=false when business fields remain unknown: release only A, retain Q/blocked/outcome_unknown/activeDispatchId, and forbid resume. Python operation.result is raw JSON: receipt.result["executionReleased"] and ["resolved"], not execution_released. Active execution observation or an observed process returns RUNTIME_STILL_ACTIVE. R04 permits only the narrow owner path for an exact record whose observation ended, whose spawn callback is sealed, and for which no process was ever observed. Contradictory evidence returns EVIDENCE_CONFLICT; changed targets return STALE_TARGET. On a lost receipt, operations.lookup uses method=sessions.reconcile, scope=sessionId, and the original key. Preserve original target/evidence; do not put a newly read target under the old key or blindly switch keys.

R04 adds two result fields. `unobservedResourcesReconciled` is true only after unobserved resource records are retired and durably acknowledged; it is false when no such records exist or cleanup remains pending. Optional `resourceCleanup={status:"pending"|"completed",ownerInstanceId}` exists only when this cleanup is required. Python reads `receipt.result["unobservedResourcesReconciled"]` and `receipt.result.get("resourceCleanup")`; nested ownerInstanceId remains camelCase.

RESOURCE_CLEANUP_INCOMPLETE means **the declaration committed but cleanup is unconfirmed**. It carries operationId and auditCommitted=true (Python: `error.operation_id` and `error.data["auditCommitted"]`); earlier resource/business decisions are not rolled back. This host pauses new dispatches with RESOURCE_CLEANUP_PENDING. First inspect the original receipt with get/lookup, then let the owner explicitly decide whether to continue. `operations.get/lookup` and `OperationHandle.wait()` are read-only. persisted is not terminal, so wait alone polls until local timeout without invoking the finalizer.

The following snippets explicitly continue on **the same still-running owner**. originalTarget/originalEvidence/originalKey are the complete values saved before the first request:

```ts
const operation = await owner.sessions.reconcile(originalTarget, originalEvidence, {
  idempotencyKey: originalKey,
});
const receipt = await operation.wait({ timeoutMs: 10_000 });
```

```python
operation = await owner.sessions.reconcile(
    original_target, original_evidence, idempotency_key=original_key,
)
receipt = await operation.wait(timeout=10)
```

A same-key retry continues the original finalizer, or only persists acknowledgement if the record was already retired. On another failure, preserve the original error and parameters; do not loop automatically or change keys. Restart loses the original in-memory finalizer and leaves the receipt outcome_unknown; same-key retries still report RESOURCE_CLEANUP_INCOMPLETE. Neither disappearance of the in-memory blocker nor wait returning unknown proves the original cleanup succeeded.

Completed business attestation saves full output and pauses; explicit tasks.resume requests human acceptance only. not_executed permits explicit requeue; failed/interrupted fails the original. Unknown controls retain history plus resolution, not false on-time completion. See [historical A evidence](./tdd/0003-a-evidence.md) and [A2 wiring](./tdd/0003-a2-wiring.md).

### 11.5 Implemented scheduler queries and resource conflicts

limits.maxActiveSessions defaults to 2, integer 1..8. limits.maxQuarantinedDispatches defaults to 32, integer 1..1024 and at least effective maxActiveSessions. scheduler.get reads A/Q/R and conflict data in one database transaction: A=executionOccupied held leases, Q=quarantined business unknown, R=quarantineReserved unquarantined reservations including initialization/cleanup. canDispatch/reasons also include this host's closing flag and in-memory cleanup records, so the complete response is not a pure database snapshot. After an internal failure stopped the host, such as a state write that failed, reasons list `SCHEDULER_FAILED` besides `HOST_STOPPING`, and writes are refused with `HOST_STOPPING` whose data holds `failure: {step, code, at}`; the host's error output has the full error. Restart the host; it recovers as after a crash (SPEC-0025 F). A/Q overlap. Admission needs A < maxActiveSessions and Q+R < maxQuarantinedDispatches, with no shutdown, cleanup, or conflict blocker. At quarantine capacity, refuse new work but retain original receipts, queries, cancel, reconcile, approval, close, and saved-result acceptance resume.

orch is an existing SDK instance. Queries need no owner authority and invoke no models. Occupancy/conflict examples each cap at 16; check truncated/conflictsTruncated and totals.

```ts
const status = await orch.scheduler.get();
console.log(status.executionOccupied, status.quarantined, status.quarantineReserved);
console.log(status.canDispatch, status.reasons);
if (status.conflicts.length) {
  const conflict = await orch.scheduler.getConflict({ conflictId: status.conflicts[0].conflictId });
  console.log(conflict.id, conflict.revision, conflict.dispatchId, conflict.status);
}
```

```python
status = await orch.scheduler.get()
print(status.execution_occupied, status.quarantined, status.quarantine_reserved)
print(status.can_dispatch, status.reasons)
if status.conflicts:
    conflict = await orch.scheduler.get_conflict(status.conflicts[0].conflict_id)
    print(conflict.id, conflict.revision, conflict.dispatch_id, conflict.status)
```

All three scheduler methods require exact initialize.capabilities.executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}; missing/incompatible capability yields UNSUPPORTED_CAPABILITY before send. Ordinary sockets can read; the server checks owner authority for resolution. Current stable reasons include EXECUTION_CAPACITY_EXHAUSTED, QUARANTINE_CAPACITY_EXCEEDED, HOST_STOPPING, RESOURCE_CLEANUP_PENDING, and EXECUTION_EVIDENCE_CONFLICT; clients must tolerate future additional reasons. See the preceding section for owner continuation of RESOURCE_CLEANUP_PENDING. Optional sessions.get execution includes dispatchId, lease, quarantined, lastEvidence, and budget. Budget stores policyVersion=2, start/end, effective acceptance/total limits, and sources. Python maps known fields to snake_case; remaining-time callbacks are not wire data.

Matched contradictory evidence after release durably blocks new dispatch through restart. Functions below accept **an existing owner, conflictId, reviewed stop declaration, and durable key**. Use ReconcileEvidence with both localResources/remoteExecution (snake_case in Python) stopped; sideEffects/outcome may remain unknown. Do not infer declarations from timeout.

```ts
import type { Orchestrator, ReconcileEvidence } from './packages/sdk-typescript/src/index.ts';

export async function resolveReviewedConflict(
  owner: Orchestrator,
  conflictId: string,
  evidence: ReconcileEvidence,
  idempotencyKey: string,
) {
  const conflict = await owner.scheduler.getConflict({ conflictId });
  const operation = await owner.scheduler.resolveConflict(
    {
      conflictId: conflict.id,
      expectedRevision: conflict.revision,
      evidence,
    },
    { idempotencyKey },
  );
  return await operation.wait({ timeoutMs: 10_000 });
}
```

```python
async def resolve_reviewed_conflict(owner, conflict_id, evidence, idempotency_key):
    conflict = await owner.scheduler.get_conflict(conflict_id)
    operation = await owner.scheduler.resolve_conflict(
        conflict.id, evidence, expected_revision=conflict.revision,
        idempotency_key=idempotency_key,
    )
    return await operation.wait(timeout=10)
```

Resolve by durable conflictId even if activeDispatchId cleared. Reject stale revision, active handles, or insufficient proof. Resolve every conflict, then satisfy normal capacity/close gates before dispatch. This does not rewrite business outcomes, original unknown, or acceptance history. Idempotency uses method=scheduler.resolveConflict, scope=conflictId. Recover lost receipts by original-key lookup; do not substitute a new revision under that key.

### 11.6 When an internal failure stops the engine

A failure the engine cannot persist around, such as a result it cannot write, stops it from accepting work: `scheduler.get` lists `SCHEDULER_FAILED` and writes fail with `HOST_STOPPING` and `failure: {step, code, at}` ([SPEC-0025](./specs/0025-operability-and-sdk-errors.md) F). An embedding host hears of it at once through `EngineConfig.onFatal(failure)`, which runs once, in a microtask after the failure was recorded, and never for a requested close. Where the store can still be written, the engine first commits the event `scheduler.failed` with the same data, which socket and stdio clients read; a degraded store gets no event, but the callback still runs. `orchvia host` writes one line to its error output ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) F). Restart the host to recover.

### 11.7 Reading a store while its engine is stopped

`openOrchestratorReadOnly({ stateDir })` reads a store without an engine: it takes no lock, runs no recovery, starts no scheduler or adapter, writes no reserve and migrates nothing ([SPEC-0027](./specs/0027-read-only-access-and-host-corrections.md) R). It answers `tasks.get`, `tasks.getMany`, `tasks.list`, `sessions.get`, `usage.get`, `usage.getRecord`, `usage.summary`, `usage.byTask`, `events.read`, `operations.get`, `operations.lookup`, `approvals.get`, `messages.get`, `handoffs.get`, `handoffs.list`, `costs.get`, `context.checkRefs` and `rules.list` through the same code as an engine; everything else fails with `READ_ONLY`. It has no scheduler, so its tasks carry no `blockedBy` ([SPEC-0028](./specs/0028-host-queries-and-lifecycle.md) B03).

```ts
import { openOrchestratorReadOnly } from '@orchvia/sdk';

const reader = await openOrchestratorReadOnly({ stateDir });
const { recoveryPending } = await reader.info();
const usage = await reader.usage.get(taskId);
await reader.close();
```

- **Files.** `store.sqlite`, an existing write-ahead log, `owner.sqlite` and every other file stay unchanged. SQLite may create or update the WAL index `store.sqlite-shm`, and create an empty `store.sqlite-wal`, to read a store in WAL mode. A log left by an engine that did not close is read in full.
- **No recovery, no expiry.** Rows read as they were last written: a crash's running tasks stay `running`, and due approvals, messages and handoffs stay pending. `info().recoveryPending` is true when starting an engine would change rows during recovery.
- **Other stores.** A store of another schema fails with `SCHEMA_MISMATCH`; an older one needs one start of a full engine to migrate. Retired, archived and standby stores can be read. `rules.list` returns only the rules registered at runtime, because a configuration's rules are unknown offline.
- **Alongside an engine.** An open reader does not keep an engine from starting on the same directory, and its next call sees what the engine committed. Each call reads one snapshot.
- **Python and other languages.** `orchvia host --read-only --state-dir <absolute path> --stdio` serves the same methods without a configuration file, and `initialize` lists `readOnly: { version: 1 }`. From Python: `Orchestrator.local(engine_command=["orchvia", "host", "--read-only", "--state-dir", state_dir, "--stdio"])`.

## 12. Layered acceptance

| Evidence                                          | What it establishes                                                           | Still required                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Full Node/Python suites                           | Engine, wire, actual local IPC, owned process and storage-fault behavior      | Real upstream execution                                  |
| Installed pinned native SDK / generated CLI types | Actual offline MCP/permission transport and versioned API shape               | Real model, history and sandbox behavior                 |
| Clean package installation                        | Emitted npm packages and wheel/sdist run in fresh offline environments        | Publication/license/release operation                    |
| Local capacity report                             | Bounded measurements on the recorded host and data size                       | Unexecuted OS/runtime matrix cells and production sizing |
| Opt-in native plan                                | Explicit version, identity source, spending estimate and evidence preparation | Separate authorization and real execution                |

Follow [native acceptance instructions](acceptance/README.md). A source/runtime probe is not packaged-application acceptance. A protocol response or main-turn result is not complete process/resource stop. A fixed price estimate is not a measured cost benefit. No application-specific implementation, external ledger integration, credentials or paid model requests are part of the offline suite.
