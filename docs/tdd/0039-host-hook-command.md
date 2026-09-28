# TDD-0039: The host's hook command, and hooks that fail open

Specification: [SPEC-0039](../specs/0039-host-hook-command.md). Approved by the owner on 2026-09-28 (D-39-1 option 1, D-39-2 option 1).

## Measured before the design

All on this Mac, with Codex CLI 0.153.4 and 0.157.1, a scratch Codex home, a synthetic key and a scripted gateway on 127.0.0.1; no network and no model calls. The probes were throwaway copies of the local smoke, with the adapter's hook command replaced.

- **Fail open.** Each case trusted its hook command, then ran `echo ok > made.txt`. With a working command the host was asked and the file was made. With a missing command, `exit 1`, `exit 2`, output that is not JSON, and no output, the host was not asked and the file was made, on both versions.
- **Shell.** A command that printed its own process showed `/bin/zsh -c <command>` with `$0` = `/bin/zsh`; a variable prefix reached the hook process (`ORCH_PROBE_FLAG=yes` written to a file by the hook's shell).
- **Correlation.** The hook's input carries `tool_use_id`; in every case it equalled the `id` of the `commandExecution` or `fileChange` item Codex started next: one command, one under `/bin/sh`, two parallel calls in one response (hooks for `call_5_1` and `call_5_0`, then both items), a patch, a command with nested quotes, and code mode's nested command (`exec-…` ids). A refused call started no item.

## RED

- `tests/contract/codex-hook-command-0039.test.ts` failed to load: `The requested module '../../packages/adapter-codex/src/index.ts' does not provide an export named 'hostHookCommandFor'`. H01–H06 had no implementation.
- `tests/contract/stop-marker-mixed-0039.test.ts` passed on the unchanged code, 3 of 3: both adapters already mark through the engine's one `StopMarkers`, and both packages export the same functions. M01 and M02 are regression coverage of that behavior, recorded without a RED.

## Changes

- `local.ts`:
  - `hostHookCommand(command?)`, `hostHookSetting(command?)` and `hostHookTrusted(list, command?)` take the host's command, falling back to SPEC-0035's;
  - new `checkHostHookCommand`, `hostHookCommandFor`, `hostHookProgram` and `listedHostHook`;
  - the hook channel records the `tool_use_id` of each call the host allowed, before answering, and gains `probe`, which runs the command with the login shell and `-c` and a probe the channel refuses itself.
- `index.ts`:
  - `hostHookCommand` is validated and needs `hostHook`;
  - the app-server's environment is built once, and the probe runs in it before the start lock and the spawn (`HOST_HOOK_UNAVAILABLE`);
  - an item that was not allowed interrupts the turn (`HOST_HOOK_BYPASSED`, outcome `unknown`).
- `connection.ts`: `hostHookCommand`, used by `trustHostHook`, and `hostHookTrust()`.
- `scripts/build-packages.mjs`: an export key ending in `.mjs` publishes a standalone copy of its module, refused if it imports anything but `node:`. `@orchvia/adapter-codex/hook.mjs` is `dist/hook.mjs`.
- The Codex fixture gains `FIXTURE_HOOKED_ITEMS` (hooks run through the configured command, then the items Codex would start) and `FIXTURE_BACKGROUND`.

## GREEN

- `codex-hook-command-0039.test.ts`, 8 of 8; `stop-marker-mixed-0039.test.ts`, 3 of 3.
- Mutations, each restored from a copy:
  - dropping the record of allowed IDs failed H06;
  - accepting every probe failed H05.
- The timing-sensitive files together (the two 0039 files, 0035's hook and marker file, 0037's acknowledgement file) under the load proxy: one `yes` per core, `nice -n 10`, six copies in parallel, 27 of 27 in each copy.
- `npm run typecheck`, `npm run format:check`, `npm test` and `npm run test:python`.
- Built package, installed offline into an empty project:
  - `@orchvia/adapter-codex/hook.mjs` resolves by `import` and `require` to `dist/hook.mjs`, which `hostHookProgram()` returns;
  - a copy in a directory with no package denies when it cannot reach the host;
  - the default command still names `dist/hook.js`.

  `scripts/package-smoke.mjs` now checks this in CI. Locally its Python half could not run, because the `build` module is not installed.

## Native (0039-N01)

`scripts/native-codex-local-smoke.mjs`, run locally with 0.153.4 and 0.157.1, passed every case, with these new ones:

| Case                    | Setup                                                                                                                                    | Outcome                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-command`          | A runtime wrapper that runs the hook only when `ORCH_HOOK_PREFIX=1` is set, and a command built by `hostHookCommandFor` with that prefix | `hostHookTrust` went from `{ trusted: false, runs: true }` to `{ trusted: true, runs: true }` after `trustHostHook`. The host was asked once, and the command the model ran saw `prefix=none` |
| `host-command-broken`   | A trusted command whose program does not exist                                                                                           | `hostHookTrust` reported `{ trusted: true, runs: false }` with zsh's "no such file" as the reason; the dispatch ended `HOST_HOOK_UNAVAILABLE`                                                 |
| `host-command-bypassed` | A wrapper that answers the probe and exits 1 for every real call                                                                         | Codex ran the command unasked, as measured above; the dispatch ended `HOST_HOOK_BYPASSED`, and the host was never asked                                                                       |

The first local run of `host-command-bypassed` failed because the wrapper piped its input into `exec`. That runs `exec` in a subshell, so the wrapper went on to `exit 1` after the probe, and the adapter refused the dispatch with `HOST_HOOK_UNAVAILABLE`, which was correct. The wrapper now passes the input with a here-document.

CI runs the same smoke with 0.157.1 on Ubuntu and macOS and with 0.153.4 on macOS, including the macOS runner with a bash login shell.
