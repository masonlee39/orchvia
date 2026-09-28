# TDD-0021: Open-source readiness

Date: 2026-09-23. Base: `7af317c`. Branch `oss-launch`. Specification: [SPEC-0021](../specs/0021-open-source-readiness.md). This record covers groups G, R and C and the repository rename (merged as pull request #10), then the package rename (N) and publishing (P) on branch `orchvia-rename` (pull request #11), then the real-model evidence (E) on branch `bench-and-claude-quickstart`. L is recorded when it is done.

## RED

The tests in `tests/contract/docs.test.ts` were written first and run against the unchanged documentation: `node --test tests/contract/docs.test.ts` failed 5 of 6.

| Test | Failure before the change |
| --- | --- |
| 0021-R01 the README opens with what it is, three reasons, a diagram, a quickstart, a comparison and the status | No `# Orchvia` title, reasons, diagram or the three sections |
| 0021-R02 0021-R06 0021-R08 no release evidence, price or paid judge, within 15 KB | The README was 46,486 bytes, and cited test counts, CI runs, candidate versions, a price and the paid judge |
| 0021-R03 no internal term in the README; `docs/concepts.md` explains them | The README used A/Q/R and other internal terms; `docs/concepts.md` did not exist |
| 0021-R05 the README embeds a diagram of at most 400 KB | No embedded image; the two diagrams were 1.4 MB and 1.1 MB |
| 0021-R09 no repository file names a downstream product | 24 files: 23 tracked Markdown files, and the draft of SPEC-0021 itself |

0021-R04 (every relative link resolves) passed before the change. It guards the move of the design document, the guide and the diagrams, which rewrote 136 links.

The test for the offline quickstart (0021-R01, second test) was written with the example, so it has no failing run of its own; mutation 9 below shows that it detects a quickstart that does not reuse the session.

## Changes

- **README:** rewritten for a first-time reader, 5,384 bytes: one sentence, three reasons, the diagram, a quickstart, a comparison, what it does, status and links. Package names in the README follow the release plan; the packages are not published yet, and the README says so.
- **Quickstart:** `examples/typescript/quickstart.ts` runs two tasks with the fake runtime; the second reuses the first agent's session. The engine setting `allowCrossRootReuse` makes the second request eligible to reuse it.
- **Documentation moved under `docs/`:** the design document to `docs/design.md`, the guide to `docs/guide.md`, and the diagrams to `docs/images/` as JPEG files of 369 KB and 243 KB. A script rewrote the relative links in every Markdown file; links inside code blocks were left alone.
- **New pages:**
  - `docs/reference.md`: the detailed part of the old README. The candidate-specific install steps became build-from-source steps; the price of the hosted judge was removed; writing your own judge now comes first.
  - `docs/status.md`: verification record, candidate history, the specification index and the runtime baselines.
  - `docs/concepts.md`: every internal term, in plain words first.
- **Internal names:** removed from 24 files and replaced with neutral descriptions. Branch names were replaced by the pull requests that carried them. The check stores only SHA-256 digests of the names. Git history is unchanged.
- **Agent instructions:** `CLAUDE.md` moved to `.claude/CLAUDE.md`. The Claude Code documentation says a project's instructions may be stored in either place (checked on 2026-09-23). `AGENTS.md` stays at the root. Both were updated for the new layout and the renamed repository.
- **Comparison (R07):** each cell rests on the other project's own documentation, checked on 2026-09-23: LangGraph persistence, CrewAI processes, OpenAI Agents SDK handoffs, the Microsoft Agent Framework overview and Claude Code subagents.

## Repository page and rename

On 2026-09-23, with the owner's go-ahead:

- the npm organization `orchvia` exists (the owner registered it; the registry answers 200 for it);
- the repository was renamed from `Multi-Agent` to `orchvia` in its settings; it kept its 19 stars, and the old URL answers 301 to the new one;
- the description and the six topics of G01 and G02 were set;
- the local remote now points to `git@github.com:masonlee39/orchvia.git`, which the worktrees share, and `git ls-remote` reads `main`.

## GREEN

- `node --test tests/contract/docs.test.ts`: 7 of 7 passed.
- `npm test`: 564 passed, none failed or skipped. That is 557 before, plus the seven documentation tests.
- `PYTHONDONTWRITEBYTECODE=1 npm run test:python`: 79 passed.
- `npm run typecheck`, `npm run format:check`, `npm run check:generated` and `git diff --check` passed.
- `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py` completed, as the README says.

## Mutation checks

Each change was made in turn, the matching test was run, and the file was restored:

| Mutation | Result |
| --- | --- |
| A test count in the README | caught (R02) |
| A candidate version in the README | caught (R02) |
| A price in the README | caught (R06) |
| The status heading renamed | caught (R01) |
| An internal term in the README | caught (R03) |
| A term missing from `docs/concepts.md` | caught (R03) |
| A broken relative link | caught (R04) |
| An internal name in a document | caught (R09) |
| The quickstart starting a fresh session | caught (R01) |
| An embedded image over 400 KB | caught (R05) |

## Not done or not verified

- R06: at this point the documents did not state the relationship to TypeSafe; the rename branch below adds it, after the owner confirmed there is none.
- R10: at this point the package READMEs and the PyPI description still said "unpublished"; the rename branch below replaces them.
- R01: the quickstart variant with real Claude was added with E01 below; its sample output waits for E02.
- The diagram in the README is the existing detailed one. A simpler overview may suit first-time readers better; that is a judgment, not a failing check.
- Old links: GitHub redirects the old repository URL. Historical records keep their original URLs.
- Remote branches named after the downstream product still existed on GitHub; the owner approved deleting them with the plan (D-oss-10).
- After pull request #10 merged, one CI job on Ubuntu with Node 24 failed 0011-R03 once: the host did not exit within 3 seconds of its shutdown request. 24 local runs under CPU load passed, and the rerun passed. The timing is followed up separately.

## Package rename and publishing (N, P)

Base: `702a3d7`. Branch `orchvia-rename`, merged as pull request #11 (`f331930`).

### RED

- `node --test tests/contract/naming.test.ts`: 2 of 3 failed. 0021-N01 found the packages named `@agent-orch/*`, the command `agent-orch` and the Python distribution `agent-orch`. 0021-N02 found the old names in current files. 0021-N06 passed: it fixes identifiers that were already right, as a guard for the rename.
- `python/tests/test_naming.py`: both tests stopped with `ModuleNotFoundError: No module named 'orchvia'`. That only shows the new module did not exist yet; it is not counted as a defect.
- The golden request digest `1c80623d…dc42` was computed at the base in both languages before any change, and the tests assert it afterwards.

### Changes

- `python/src/agent_orch` moved to `python/src/orchvia`. A script renamed the package names, imports, the command, file names and temporary-directory prefixes in 58 files, and skipped specifications and TDD records. A second pass fixed five places the first missed: text that followed an escaped newline in a string, and module attributes in one test.
- Kept on purpose (N06): the MCP server name and tool names, the Codex client name, the request digest prefix, the schema identifier and the bridge variables.
- `scripts/build-packages.mjs` builds publishable packages: no `private`, public access, `repository`, `homepage`, `bugs`, a description and keywords, and a README for users. It accepts final and pre-release versions.
- `scripts/build-python.py` and `python/pyproject.toml`: the distribution `orchvia`, PEP 440 versions for pre-releases, project links and classifiers. `python/README.md` is the PyPI description, with absolute links.
- `scripts/package-smoke.mjs` checks every archive's metadata and README and the wheel's metadata.
- `.github/workflows/release.yml` (P02, P03), `scripts/registry-check.mjs` (P04), `CHANGELOG.md` (P05), `docs/release/publishing.md` (P06). `offline.yml` can be called by the release workflow.
- R06: the reference and the guide say Orchvia is not affiliated with TypeSafe. L03: issue and pull request templates, `SECURITY.md` and an updated `CONTRIBUTING.md`.

### GREEN

- `node --test tests/contract/naming.test.ts`: 3 of 3; `python/tests/test_naming.py`: 2 of 2.
- A build of 0.1.0 and the package smoke: all nine installation and bundle modes passed, with the new metadata checks.
- Two builds of 0.1.0 produced byte-identical npm archives. That matters because the first npm publish is built locally and the release workflow compares the registry's bytes with its own build.
- `npm publish --dry-run` works without a login when the archive path starts with `./`; without it, npm read `out/<file>` as a GitHub repository. The workflow and the guide use `./`.
- Full checks: `npm test` 567 passed (564 before, plus three naming tests), `npm run test:python` 81 passed (79 plus two), and typecheck, formatting, the generated-contract check and `git diff --check` passed. The quickstart and the Python example ran.
- CI on the pull request ran the release workflow without publishing. Its first run failed because npm requires `--tag` to publish a pre-release version, which the dry run uses; `62f0893` publishes pre-releases to `next`, and the rerun passed the build, the nine package modes, `npm publish --dry-run` for every package and `twine check`.
- A build of 0.1.0 from the merge commit `f331930` produced the same npm archives, byte for byte, as the builds before the merge.

### Mutation checks

| Mutation | Result |
| --- | --- |
| A package keeps its old name | caught (N01) |
| The command keeps its old name | caught (N01) |
| An example imports the old module | caught (N02) |
| The request digest prefix changes, in TypeScript | caught (N06) |
| The request digest prefix changes, in Python | caught (N06) |
| The MCP server name changes | caught (N06) |
| The schema identifier changes | caught (N06) |

### Not verified yet

- The release workflow's publishing jobs and `scripts/registry-check.mjs` run for the first time with a tag; only the build job runs on pull requests. They ran with `v0.1.2` and passed; see "The first release (P04)" below.
- The `v0.1.0` tag's run ([35865838151](https://github.com/masonlee39/orchvia/actions/runs/35865838151)) passed the offline matrix and stopped in the build job's dry run: `npm error You cannot publish over the previously published versions: 0.1.0.` The npm job skips a version already on the registry, but the dry run did not, and 0.1.0 had been published by hand first (P06). Nothing was published. The same local script failed the same way on the published archives; the corrected step skips the five published versions and still dry-runs a new one (0.0.0-rc.999). By the owner's choice (D-rel-1), 0.1.1 is the first release on PyPI and GitHub Releases, and 0.1.0 stays on npm only. Later, D-rel-2 stopped 0.1.1 before publishing (see "One version" below).

## Real-model evidence (E)

Base: `f331930`. Branch `bench-and-claude-quickstart`.

### E01: the quickstart with real Claude

- `examples/typescript/quickstart-claude.ts` runs the offline quickstart's two tasks on Claude with the default read-only profile; the second task reuses the first one's session.
- `scripts/quickstart-claude-smoke.mjs` runs that example with the real Claude Code binary against a scripted loopback gateway, with a private home directory and synthetic credentials. It checks that both tasks complete, that the second reuses the session, and that the second request to the gateway carries the first answer, so the follow-up ran in the same Claude conversation. The pinned native-protocol CI job runs it.
- The example and its check were written together, so the check has no failing run of its own. Mutation: with the second task's context plan removed, the check failed with "reused the first agent's session: false".
- Local run: `{"quickstart":"claude","gatewayRequests":2,"modelCalls":0}`.

### E03 to E05: the benchmark harness

- `bench/` holds the fixture project, the four requests, hidden checks that live outside the agent's workspace, reference solutions and `run.mjs`. The arms and measurements follow E03 as approved with D-oss-10.
- `--fake` replaces the agent's edits with the reference solutions and needs no Claude Code. `--gateway` runs the real Claude Code binary for every arm against a loopback gateway (`bench/gateway.mjs`) that answers each request by reading and writing the reference solution with Claude Code's own tools, so the sandbox, the tools and the engine's writable profile all run, with no model call.
- Prices were checked on 2026-09-23 on Anthropic's pricing page: Claude Sonnet 5 costs $2 input, $10 output, $0.20 cache read, and $2.50 or $4 cache write for 5 minutes or 1 hour, per million tokens. Every arm prices cache writes at the 5-minute rate, because the engine's usage records do not separate the two.
- Each report records the Agent SDK and Claude Code versions: 0.3.274 and 2.1.274.
- CI runs `node bench/run.mjs --gateway --require-pass` in the pinned native-protocol job on Linux and on both macOS runners. `--require-pass` exits with 1 unless every arm passes every request.

#### RED

- **A failed check counted as passed under `npm test`.** `0021-E04 a request whose work is missing fails its checks and is reported so` leaves X2's solution out and failed at first: the report said X2 passed its hidden check. The harness runs each check with `node --test`, and under `npm test` it inherited the test runner's `NODE_TEST_CONTEXT`; a nested run with that variable exits 0 even when a test fails. Outside the test runner the same run reported X2 as failed, and with `NODE_TEST_CONTEXT=child-v8` set by hand it reported all four as passed. So the first E04 test could not detect a failing check. The harness now drops the variable.
- **The Orchvia arm's stop proof fails whenever the other track is still running.** The engine releases a writable Claude dispatch only after the host proves that its execution stopped. The harness's proof was that no process has its working directory in the workspace, but both tracks share the workspace. `node bench/run.mjs --gateway --arms orchvia`, with Y1's last answer held back for 3 seconds, reproduced it: X1's dispatch ended `outcome_unknown` with `remoteExecution: unknown`, and its task was blocked. Y1 and Y2 completed on one session. The X track never continued: the harness waited up to 30 minutes for the blocked task, which is not a terminal status, so the run was stopped by hand.
- The stop-proof tests in `tests/contract/bench.test.ts` state the intended proof. Against the workspace-wide check, two of three failed: a live process of the harness in the workspace blocked the proof (expected to hold), and the proof did not wait for the dispatch's own Claude process to exit. The third, that a process which outlived its parent blocks the proof, already passed.
- **lsof's exit status hid what it found.** With the corrected proof, the gateway run still blocked X1. Logging the proof showed that `lsof -Fp +D <workspace>` listed Y1's Claude process but exited with 1 and no message: with `+D`, lsof exits with 1 when some file under the directory is open in no process. The proof read that status as an error. The stop-proof tests had used an empty workspace, where lsof exits with 0; with one file in the test workspace, the test for the other track failed as well.

#### Changes

- `bench/stop.mjs`, as approved with D-bench-1: the proof waits until the adapter reports that the dispatch's own Claude process exited. It then lists the processes that use the workspace with `lsof +D` and requires each to descend from the harness process, following parent ids from `ps`. A process that exited in between counts as stopped. Any error, timeout or cancellation leaves the stop unproven. Exit status 1 from lsof without a message is read as a result.
- The orchvia arm's Claude adapter gets a 10-second cleanup window instead of the default second, so the wait for the process exit and the two listings fit in it.
- A task that ends failed, cancelled or blocked is read instead of awaited, and its track stops there: its session cannot take the follow-up, and the report shows the rest of the track as not run. Before, the harness waited up to 30 minutes for a blocked task.
- `--require-pass` for CI.

Timing invariants, as approved:

- The proof judges only after the dispatch's own Claude process exited. Until then it waits; a wait that outlasts the cleanup window leaves the stop unproven.
- Every process that still uses the workspace must descend from the harness. One that does not fails the proof of every dispatch while it runs.
- Errors and timeouts never prove a stop.

#### GREEN

- `node --test tests/contract/bench.test.ts`: 6 of 6.
- `node bench/run.mjs --gateway --require-pass`: every arm passed 4 of 4 with the real Claude Code binary, and the run exited with 0. In the orchvia arm, X1 and X2 completed on one session between 0 and 1.8 seconds while Y1 still ran until 3.9 seconds; Y2 then reused Y1's session.
- Before the lsof correction, when the proof still failed, the same run finished in 15 seconds, reported X1 as blocked and the rest of its track as not run, and exited with 1 under `--require-pass`. Before the harness change, it had waited for the blocked task.
- Full checks: `npm test` 573 passed (567 before, plus the six benchmark tests), `npm run test:python` 81 passed, and typecheck, formatting, the generated-contract check and `git diff --check` passed. `scripts/quickstart-claude-smoke.mjs` passed.

#### Mutation checks

| Mutation | Result |
| --- | --- |
| The Orchvia arm's follow-ups start a new session | caught (E04) |
| The two tracks run one after the other | caught (E04) |
| The budget is never checked | caught (E05) |
| A failed hidden check counts as passed | caught (E04) |
| The test runner's variable reaches the checks | caught (E04) |
| The quickstart's second task starts a new session | caught (E01 check) |
| The stop proof does not wait for the dispatch's own process | caught (E04) |
| The stop proof accepts a process that outlived its parent | caught (E04) |
| lsof's exit status 1 with a result counts as an error again | caught (E04) |
| Any error proves the stop | caught (E04) |

#### Not verified yet

- E02, E05 and E06: on 2026-09-23 the owner decided against paid model runs for now. An earlier attempt at the pilot stopped before any model call because the Claude Code sign-in had expired; nothing was spent.
- The scripted gateway only reads and writes files, so the agent running the project's tests through sandboxed Bash is exercised only by a real run.
- The stop proof cannot see a leftover process that left the workspace directory and holds no file in it.
- The CI step runs for the first time with the pull request that adds it.

## Good first issues (L03)

Base: `5d95079`. Branch `community-12-13-14`. The maintainer implemented L03's three good first issues on one branch. Issue #14 keeps the outside contributor's commit: the head of pull request #15, `29fab73` by Gambit-Checkmate, is merged unchanged, and the corrections follow in a separate commit.

### R11: the overview diagram (issue #14, pull request #15)

#### RED

`node --test --test-name-pattern 0021-R11 tests/contract/docs.test.ts`, run after merging `29fab73` and before any correction, failed with eight problems:

- `a font attribute, which SVG does not have: <text x="592" y="319" text-anchor="middle" fill="#fff" font="700 18px system-ui, sans-serif">`. Browsers ignore the attribute, so the banner was drawn in a serif 16 px regular.
- `"TypeScript or Python"`, `"Messages and results"` and `"remain available"` were 14 px, about 10.5 px when the image is shown 900 px wide.
- `"A person reviews and approves each result": no font family, no px`.
- The description, the banner and the README's alternative text named only a person, not a registered check.

Two corrections concern the drawing and the layout, so a rendering checks them rather than the test: the mailbox stood outside the engine and the results passed through it, and the heading "Orchestration flow" that the pull request added to the design document put the three paragraphs about the design reviews under it.

#### Changes

- `docs/images/orchestration-overview.svg`, redrawn. Fonts come from CSS rules (`font-family`, `font-size`, `font-weight`); the smallest text is 16 px in a viewBox 1,200 wide. The engine holds the scheduler and its SQLite state, and the mailbox is part of that state; each session exchanges messages with the mailbox. Results leave the sessions and reach the application through the banner "A person or a registered check accepts each result". Connectors are drawn after the boxes, so no box covers an arrow. The file is 3.7 KB. As in the pull request, it sets no `width` or `height`, so a browser sizes it to the README's column; with them, Quick Look rendered only the left half.
- The README's alternative text and the SVG's description say the same.
- `docs/design.md`: the heading is removed, and the detailed diagram with its sentence opens section 3, Architecture.
- The test reads the SVG's style rules, attributes and inline styles. It understands the CSS `font` shorthand, so it read the contributor's classes with their real sizes.

#### GREEN

- `node --test tests/contract/docs.test.ts tests/contract/naming.test.ts`: 11 of 11.
- Rendered with Quick Look at 1,600 px, and with headless Chrome in a 900 px column as on GitHub: the text is sans-serif, the titles are bold, and the smallest text is 12 px.

#### Mutation checks

| Mutation | Result |
| --- | --- |
| The banner uses the `font` attribute again | caught |
| Notes at 14 px | caught |
| No font family | caught |
| The description names only a person | caught |
| The banner names only a person | caught |
| The README's alternative text names only a person | caught |
| A viewBox 1,600 wide | caught |

#### Not verified

- How github.com shows the image: it was checked with Chrome and Quick Look on this machine, before anything was pushed.
- Fonts on Windows and Linux: `system-ui` falls back to Segoe UI, Roboto or the default sans-serif.

### P07: `orchvia --version` (issue #12)

#### RED

- `node --test --test-name-pattern 0021-P07 tests/contract/host-cli.test.ts` failed before the change: `{"code":"UNSUPPORTED_COMMAND","message":"Unknown command: --version"}`, with exit code 1 instead of 0.
- With the new branch removed from `main.ts` again, a build followed by `npm run test:packages` failed at the new check: `Command failed: node …/node_modules/@orchvia/cli/dist/main.js --version`, with the same message.

#### Changes

- `packages/cli/src/main.ts`: `--version`, next to `--help`, reads `../package.json` next to the running module when it is asked for, and prints its `version` and a newline. `--help` lists `orchvia --version`.
- `scripts/package-smoke.mjs`: the installed CLI must print the version the packages were built as.
- The CLI paragraph of the reference, and the changelog.

#### GREEN

- `node --test tests/contract/host-cli.test.ts`: 6 of 6.
- `npm run build:packages`, `scripts/build-python.py dist/release` and `npm run test:packages`, with the Python build tools pinned as in CI: all nine installation and bundle modes passed. The built `dist/main.js` keeps `new URL('../package.json', import.meta.url)`; the build rewrites only `../../` URLs and `.ts` or `.js` paths.
- A build as `0.2.0-rc.7`, a version that no source manifest holds, passed the same smoke, so the installed CLI prints the version it was built as.
- From a checkout the command prints `0.1.0`, the version in `packages/cli/package.json`.

#### Mutation checks

| Mutation | Result |
| --- | --- |
| `--help` does not list `--version` | caught (source test) |
| JSON instead of the bare version | caught (source test) |
| No newline | caught (source test) |
| `-v` prints the version too | caught (source test) |
| The version is written into the code as `0.1.0` | not caught by the source test, whose manifest also says 0.1.0; caught by the smoke of the build as `0.2.0-rc.7` (`'0.1.0\n'` instead of `'0.2.0-rc.7\n'`). The release workflow runs that smoke with the tag's version, and with `0.0.0-rc.N` on pull requests that touch packaging. |

The check that `-v` stays an unknown command was added after its mutation first went unnoticed. It covers behavior that was already right, so it has no failing run of its own.

### R12: the Python quickstart (issue #13)

#### RED

The test and the example were written together, as the TypeScript quickstart's were. A missing example file would only have shown that the file did not exist, so it is not counted as a failure of behavior.

- The first run of `node --test --test-name-pattern 0021-R12 tests/contract/docs.test.ts` failed while the client initialized the host: `orchvia.errors.OrchestrationError: Engine connection ended before the next complete response`. The host had stopped on the reserve guard of SPEC-0011 R10, which `npm test` loads into every Node process through `NODE_OPTIONS`. Started by hand under the guard with the same configuration, it printed ``{"code":"TEST_RESERVE_GUARD","message":"…/state/emergency.reserve would grow past 4096 bytes in `node …/packages/cli/src/main.ts host --stdio --config …`. …"}``. The guard lets the engine's 256 MiB default through only for Node processes started from a file under `examples/`, and the host that the Python example starts runs from `packages/cli/`. The Python client keeps the host's error output in `stderr_tail` and does not repeat it in the exception.
- Run as a reader runs it, without the guard, the example printed the three lines and exited with 0.

#### Changes

- `examples/python/quickstart.py`, the Python version of `examples/typescript/quickstart.ts`. It writes a host configuration with the fake provider and `allowCrossRootReuse`, starts `packages/cli/src/main.ts host --stdio` with `Orchestrator.local`, approves each result as the TypeScript example does, and gives the second task a `ContextPlan`, with its camelCase keys, that asks to reuse the first task's session. `--node` names the Node executable, as in `fake_roundtrip.py`. `--emergency-bytes` sets the host's emergency reserve, which is otherwise the engine's 256 MiB.
- The test passes its own Node with `--node`, and `--emergency-bytes 4096`. The guard's rules are unchanged.
- The README gives the Python command after the offline quickstart's output. It replaces the mention of `fake_roundtrip.py`, which the reference and the guide still document. The README is 5,949 bytes.

#### Mutation checks

| Mutation | Result |
| --- | --- |
| The second task starts a new session | caught |
| The last line prints Python's `True` | caught |
| No `allowCrossRootReuse` | caught |
| Another goal for the second task | caught |
| The result is read without waiting for the task to end | caught |

## One version (P08, P09)

Base: the last tree of the branch `community-12-13-14`. The owner chose D-rel-2 option 2 and D-ver-1 option 1 on 2026-09-23.

### What was found

A local build of 0.1.1 from its tag's commit `5d95079`, made as the release workflow makes it, showed that the builds rewrote only the package manifests, `pyproject.toml` and `orchvia.__version__`. Eight literals kept 0.1.0: the engine's `engineVersion`, the TypeScript SDK's `sdkVersion` in two places, the Python SDK's `SDK_VERSION`, the tool bridge's MCP `serverInfo`, the Claude adapter's MCP server version, and the Codex adapter's `clientInfo` in two places. The source manifests said 0.1.0 while 0.1.1 was tagged, and `build-python.py` fell back to a written `0.1.0`.

### RED

- `node --test tests/contract/version.test.ts` failed 4 of 5:
  - `0021-P08 package source writes the version only in version.ts and _version.py` listed nine literals: the eight above and `__version__` in `orchvia/__init__.py`.
  - `0021-P08 set-version writes the version to every copy and changes nothing else` failed against a stub that wrote nothing: every copy still said 0.1.0.
  - `0021-P09 a release tag must equal the source version, have a changelog section and be on main` ran against the release workflow's Version step, moved unchanged into `scripts/release-version.mjs`. It accepted `v0.1.1` while `package.json` said 0.1.0, and a tag on a commit that is not on main.
  - `0021-P08 every copy of the version is the root version, and the changelog has its section` failed only because `version.ts` and `_version.py` did not exist yet, which is not counted as a defect.
  - `0021-P08 the engine reports the root version to the TypeScript SDK` passed: with every copy at 0.1.0, the written literal happened to agree. It guards the behavior.
- Packages built as `0.2.0-rc.7` with the unchanged builds failed the package smoke's new check: `client.info.engineVersion` was `'0.1.0'` instead of `'0.2.0-rc.7'`.

### Changes

- `packages/engine/src/version.ts` and `python/src/orchvia/_version.py` hold the version, and the eight places and `orchvia.__version__` read it. The SDK and the adapters import it from the engine, which the build maps to `@orchvia/engine/internal/version`, so bundled hosts get it too.
- `scripts/set-version.mjs X.Y.Z [--root DIR]` reads and checks every copy before writing any: the root and package manifests, the lockfile's seven entries, `version.ts`, `pyproject.toml` and `_version.py`. It writes JSON as npm does, so setting the old version again leaves each file byte for byte as it was.
- `scripts/build-packages.mjs` and `scripts/build-python.py` take the root version by default and stop when a copy differs from it. With `--version` they also rewrite the built `version.js`, `version.d.ts` and `_version.py`.
- `scripts/release-version.mjs` replaces the release workflow's Version step. The build job checks out the full history, so the script can check that the tagged commit is on main; any error of that check stops the release.
- The package smoke and the registry check require `orchvia --version`, `engineVersion`, `orchvia.__version__` and the Python SDK's version to equal the release.
- `docs/release/publishing.md` describes the release pull request. `CHANGELOG.md` lists 0.1.1's changes under the next version and marks 0.1.1 as not published. The guide no longer names a local candidate version, and `AGENTS.md` and `.claude/CLAUDE.md` name the script.

### GREEN

- `node --test tests/contract/version.test.ts`: 5 of 5.
- A build as `0.2.0-rc.7` and the package smoke: all nine modes passed. The built `version.js` and `version.d.ts` say `0.2.0-rc.7`; the wheel's `_version.py` and metadata say `0.2.0rc7`.
- Builds without `--version`, which use 0.1.0, and as `0.0.0-rc.999`, the kind of version a pull request's dry run uses: the smoke passed all nine modes for each.
- `npm test`: 593 passed, 588 before plus the five version tests. `npm run test:python`: 81 passed. Typecheck, formatting, the generated-contract check and `git diff --check` passed.

### Mutation checks

| Mutation | Result |
| --- | --- |
| `engineVersion` written as a literal again | caught (P08 source) |
| `SDK_VERSION` written as a literal again | caught (P08 source) |
| A package manifest at another version | caught (P08 copies) |
| A lockfile workspace entry at another version | caught (P08 copies) |
| `_version.py` at another version | caught (P08 copies) |
| No changelog section for the source version | caught (P08 copies) |
| `set-version` skips the lockfile | caught (P08 set-version) |
| `set-version` writes JSON with four spaces | caught (P08 set-version) |
| The release check skips the tag comparison | caught (P09) |
| The release check skips the check that the commit is on main | caught (P09) |
| An error in that check lets the release through | caught (P09) |
| The Python build leaves `_version.py` as it is | caught by the smoke of a `0.2.0-rc.7` build: `AssertionError: ('0.1.0', '0.1.0')` |

### Not verified

- The release workflow's new Version step and the registry check's new assertions run only with the next tag. The registry check's generated scripts were checked with `py_compile` and `node --check`. Both ran with `v0.1.2` and passed; see "The first release (P04)" below.
- D-rel-2 on GitHub was carried out on 2026-09-23: the deployments of the v0.1.1 run ([35868558191](https://github.com/masonlee39/orchvia/actions/runs/35868558191)) were rejected, so the run ended without publishing. npm lists only 0.1.0, and neither PyPI nor GitHub Releases has 0.1.1.

## The first release (P04)

The tag `v0.1.2`, on the merge commit `fc6ad55` of pull request #23, started the release workflow ([35962234095](https://github.com/masonlee39/orchvia/actions/runs/35962234095)) on 2026-09-24.

- The Version step accepted the tag: it equals the version in `package.json`, the changelog has its section, and the commit is on `main` (P09). The build's offline installation reported 0.1.2 everywhere (P08).
- In the first attempt, one of the offline matrix's jobs, Ubuntu 24.04 with Node 24, failed one test: the forwarding example of AC-P08 did not finish within its test's 5-second limit on a slow runner. The same commit passed that test in every other job. The publishing jobs did not start, so nothing was published. That job was run again once and passed. The test was corrected on `main` afterwards; see [SPEC-0023 F05](../specs/0023-corrections-before-0.1.2.md).
- The owner approved the `npm` and `pypi` deployments in the run. The npm job published the five packages through trusted publishing, in dependency order; the PyPI job published the wheel and the sdist. The GitHub release "Orchvia 0.1.2" was created after both, with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.2 section.
- P04 passed on both runners, Ubuntu 24.04 with Node 22.18.0 and Python 3.11.13, and macOS 14 with Node 24.14.0 and Python 3.14.6. The Ubuntu runner's log shows that for about three minutes after the npm job ended the registry answered 404 for the new versions, first for `@orchvia/engine@0.1.2` and last for `@orchvia/sdk@0.1.2`, and that the check waited for each, as it is written to. Both runners then printed `{"version":"0.1.2","pythonVersion":"0.1.2","results":[{"mode":"npm-registry","status":"completed","reused":true},{"mode":"pypi-registry","status":"completed"}]}`.
- The npm registry lists 0.1.2 as the `latest` version of all five packages, and PyPI lists `orchvia` 0.1.2 with its wheel and sdist.

## The second release, 0.1.3

The owner pushed the tag `v0.1.3` on the merge commit `2eaf9a2` of pull request #26, which started the release workflow ([36094084619](https://github.com/masonlee39/orchvia/actions/runs/36094084619)) on 2026-09-25. The push of the tag from the Claude Code session on the web had been cut off.

- The Version step accepted the tag, and the offline matrix and the build passed at the first attempt.
- The owner approved the `npm` and `pypi` deployments. The npm job published the five packages with provenance, in dependency order; the PyPI job published the wheel and the sdist. The GitHub release "Orchvia 0.1.3" followed, with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.3 section.
- P04 passed on both runners. The macOS runner's log shows that the registry answered 404, for `@orchvia/engine@0.1.3` and then `@orchvia/adapter-codex@0.1.3`, until about a minute and a half after the npm job ended, and that the check waited. Both runners printed `{"version":"0.1.3","pythonVersion":"0.1.3","results":[{"mode":"npm-registry","status":"completed","reused":true},{"mode":"pypi-registry","status":"completed"}]}`.
- The npm registry lists 0.1.3 as the `latest` version of all five packages, and `@orchvia/adapter-claude@0.1.3` declares only the optional Claude SDK peer. PyPI lists `orchvia` 0.1.3 with its wheel and sdist. In an empty project, `npm install zod@4.6.5 @orchvia/adapter-claude@0.1.3 @orchvia/engine@0.1.3 @anthropic-ai/claude-agent-sdk` installed without an error, with SDK 0.3.282, and the installed server listed the four tools ([SPEC-0026](../specs/0026-claude-mcp-without-zod.md) Z08).

## The third release, 0.1.4

Pull request #29 set the version to 0.1.4 on top of SPEC-0027 (#28). A local Claude Code session pushed the tag `v0.1.4` on its merge commit `093b5bd`, on the owner's authorization, which started the release workflow ([36230462734](https://github.com/masonlee39/orchvia/actions/runs/36230462734)) on 2026-09-26.

- The offline matrix and the build passed at the first attempt; the build's package check found no `internal/` module in the SDK's declarations (SPEC-0027 T03).
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.4" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.4 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run passed at its first attempt.
- The npm registry lists 0.1.4 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.4` declares only the optional Claude SDK peer. PyPI lists `orchvia` 0.1.4 with its wheel and sdist.

## The fourth release, 0.1.5

Pull request #32 set the version to 0.1.5 on top of SPEC-0028 (#31). A local Claude Code session pushed the tag `v0.1.5` on its merge commit `b22a16c`, on the owner's authorization, which started the release workflow ([36239429067](https://github.com/masonlee39/orchvia/actions/runs/36239429067)) on 2026-09-26.

- The offline matrix and the build passed at the first attempt.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.5" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.5 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run passed at its first attempt.
- The npm registry lists 0.1.5 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.5` declares only the optional Claude SDK peer. PyPI lists `orchvia` 0.1.5 with its wheel and sdist. For a few minutes after publication, PyPI's JSON API and simple index still answered 0.1.4 from their caches; a request that bypassed the cache answered 0.1.5.

## The fifth release, 0.1.6

Pull request #35 set the version to 0.1.6 on top of SPEC-0029 (#34). A local Claude Code session pushed the tag `v0.1.6` on its merge commit `52fab05`, on the owner's authorization, which started the release workflow ([36245593329](https://github.com/masonlee39/orchvia/actions/runs/36245593329)) on 2026-09-26.

- The offline matrix and the build passed at the first attempt.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.6" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.6 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run passed at its first attempt.
- The npm registry lists 0.1.6 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.6` declares only the optional Claude SDK peer. PyPI lists `orchvia` 0.1.6 with its wheel and sdist. As with 0.1.5, PyPI's JSON API and simple index first answered the previous version from their caches, while the endpoint of version 0.1.6 already answered it; later requests to both answered 0.1.6.

## The sixth release, 0.1.7

Pull request #38 set the version to 0.1.7 on top of SPEC-0030 (#37). A local Claude Code session pushed the tag `v0.1.7` on its merge commit `c00bff9`, on the owner's authorization, which started the release workflow ([36252624174](https://github.com/masonlee39/orchvia/actions/runs/36252624174)) on 2026-09-26.

- The offline matrix and the build passed at the first attempt.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.7" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.7 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run passed at its first attempt.
- The npm registry lists 0.1.7 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.7` declares only the optional Claude SDK peer. PyPI lists `orchvia` 0.1.7 with its wheel and sdist; this time its JSON API and simple index already answered 0.1.7 when they were first checked.

## The seventh release, 0.1.8

Pull request #42 set the version to 0.1.8 on top of SPEC-0031 (#41). A local Claude Code session pushed the tag `v0.1.8` on its merge commit `7f5375f`, on the owner's authorization, which started the release workflow ([36258047289](https://github.com/masonlee39/orchvia/actions/runs/36258047289)) on 2026-09-27. It is the first release recorded by the next release pull request (P10).

- The offline matrix and the build passed at the first attempt, the pinned native job's new usage check with the real Claude binary included.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.8" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.8 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.
- The npm registry lists 0.1.8 as the `latest` version of all five packages, with provenance attestations. PyPI lists `orchvia` 0.1.8 with its wheel and sdist; its per-version JSON answered 0.1.8 at once, while the project's JSON still answered 0.1.7 from a cache at the first check.

## The eighth release, 0.1.9

Pull request #51 set the version to 0.1.9 on top of SPEC-0032 (#49) and SPEC-0033 (#50). A local Claude Code session pushed the tag `v0.1.9` on its merge commit `66079e7`, on the owner's authorization, which started the release workflow ([36304226976](https://github.com/masonlee39/orchvia/actions/runs/36304226976)) on 2026-09-27.

- The offline matrix and the build passed at the first attempt, with CI's new pins, Claude Agent SDK 0.3.283 and Codex CLI 0.157.1, and the usage check also on SDK 0.3.274.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.9" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.9 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.
- The npm registry lists 0.1.9 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.9` declares the Claude SDK peer `>=0.3.241 <1`. PyPI lists `orchvia` 0.1.9 with its wheel and sdist.

## The ninth release, 0.1.10

Pull request #53 set the version to 0.1.10 on top of SPEC-0034 (#52). A local Claude Code session pushed the tag `v0.1.10` on its merge commit `c3c4799`, on the owner's authorization, which started the release workflow ([36313642053](https://github.com/masonlee39/orchvia/actions/runs/36313642053)) on 2026-09-27.

- The offline matrix and the build passed at the first attempt, with the new stop smokes of the real Claude and Codex binaries on Ubuntu and macOS.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.10" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.10 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.
- The npm registry lists 0.1.10 as the `latest` version of all five packages, with provenance attestations, and `@orchvia/adapter-claude@0.1.10` declares the Claude SDK peer `>=0.3.241 <1`. PyPI lists `orchvia` 0.1.10 with its wheel and sdist.

## The tenth release, 0.1.11

Pull request #55 set the version to 0.1.11 on top of SPEC-0036 (#54). A local Claude Code session pushed the tag `v0.1.11` on its merge commit `9004b34`, on the owner's authorization. That run ([36321112536](https://github.com/masonlee39/orchvia/actions/runs/36321112536)) failed in its tests on the x86-64 macOS runner, before the build could publish anything: the new restart smoke required a verified synchronous stop that the slower runner could not fit in 300 ms. npm, PyPI and GitHub Releases had no 0.1.11. After the fixes of pull request #56, which also made the new contract tests robust on loaded runners, the owner chose to move the tag (D-0036-4): it was deleted and pushed again on `a21833d`, which started the release workflow ([36327186872](https://github.com/masonlee39/orchvia/actions/runs/36327186872)).

- The offline matrix and the build passed at the first attempt, with the restart smoke on Ubuntu and both macOS runners.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.11" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`; its notes are the changelog's 0.1.11 section.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.
- The npm registry lists 0.1.11 as the `latest` version of all five packages, with provenance attestations, and the published `@orchvia/adapter-claude` declares `sweepStopMarkers`, `staleStopMarkers` and `endStopMarkersSync`. PyPI lists `orchvia` 0.1.11 with its wheel and sdist.

## The eleventh release, 0.1.12

Pull request #58 set the version to 0.1.12 on top of SPEC-0037 (#57). A local Claude Code session pushed the tag `v0.1.12` on its merge commit `6b88b66`, on the owner's authorization. That run ([36331720031](https://github.com/masonlee39/orchvia/actions/runs/36331720031)) failed in its tests on the x86-64 macOS runner, before the build could publish anything: in 300 ms the root-level synchronous cleanup of the restart smoke did not finish its first listing on the slower runner. npm, PyPI and GitHub Releases had no 0.1.12. After the fixes of pull request #59, the owner chose to move the tag again (D-0037-3): it was deleted and pushed again on `868ca2b`, which started the release workflow ([36335671711](https://github.com/masonlee39/orchvia/actions/runs/36335671711)).

- The offline matrix and the build passed at the first attempt, with the restart smoke on Ubuntu and both macOS runners.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.12" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.

## The twelfth release, 0.1.13

Pull request #61 set the version to 0.1.13 on top of SPEC-0038 (#60). A local Claude Code session pushed the tag `v0.1.13` on its merge commit `7a94003`, on the owner's authorization, which started the release workflow ([36379408394](https://github.com/masonlee39/orchvia/actions/runs/36379408394)).

- The offline matrix and the build passed at the first attempt, with the new Codex security smoke on Ubuntu and both macOS runners.
- The owner approved the `npm` and `pypi` deployments. Both jobs passed, and the GitHub release "Orchvia 0.1.13" followed with the five npm archives, the wheel, the sdist, both manifests and `SHA256SUMS`.
- P04 passed on the Ubuntu and macOS runners, and the whole run, 13 jobs, passed at its first attempt.
- The npm registry lists 0.1.13 as the `latest` version of all five packages, and PyPI lists `orchvia` 0.1.13 with its wheel and sdist.

## P10: no document names the latest release (D-rel-3)

On 2026-09-27 the owner chose D-rel-3: a release is recorded by the next release pull request, and no document names the latest release.

- RED: `0021-P10` failed on `main` (`ed0716e`): `.claude/CLAUDE.md` and `docs/guide.md` each stated which version was published.
- Changes:
  - The guide and `.claude/CLAUDE.md` point at GitHub Releases instead.
  - The readiness ledger, SPEC-0021's status and the release guide's step 2 describe the releases in words that do not change with each one.
  - Step 1 of the release guide adds the record of the release before it: the Published line and the specification's row in `docs/status.md`, and a section here.
- GREEN: `tests/contract/docs.test.ts` and `tests/contract/version.test.ts`, 15 of 15.
