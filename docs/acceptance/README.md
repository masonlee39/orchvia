# Acceptance and local distribution

The source implementation and offline completion matrix are in [SPEC-0009](../specs/0009-complete-design.md#completion-matrix). [SPEC-0010](../specs/0010-bundled-host-delivery.md) adds local RC and single-file CJS/ESM delivery; see [consumer instructions](bundled-host.md). No native model, login credential, publication or production deployment is part of ordinary verification.

## Offline verification

```sh
npm ci --ignore-scripts
npm run check:generated
npm run typecheck
npm run format:check
npm test
npm run test:python
npm run build:packages
```

Python distribution tooling belongs in an isolated venv, not the runtime package. The recorded builder uses setuptools 80.9.0, wheel 0.45.1, build 1.2.2.post1, packaging 25.0 and pyproject_hooks 1.2.0. Once prepared:

```sh
BUILD_PYTHON=/absolute/build-venv/bin/python
"$BUILD_PYTHON" scripts/build-python.py dist/release
PACKAGE_BUILD_PYTHON="$BUILD_PYTHON" npm run test:packages
```

The Node build emits five private local tarballs and npm-manifest.json with SHA-256 values. Package smoke creates its own clean environments and uses offline installs. It verifies checksums and lockfile integrity, embedded TS, the CLI, each provider alone, packaged Codex private MCP, actual Claude SDK MCP, installed Python to the owned Node host, and a wheel rebuilt from the sdist. Separate CJS/ESM bundles execute fixture tasks after their node_modules is deleted. Supplying PACKAGE_BUILD_PYTHON is required for the sdist case. esbuild, Zod and Claude SDK are pinned development dependencies; runtime startup does not install them. Node/Python dependencies are not installed globally.

Pinned native **protocol-only** checks can run with explicit installed paths:

```sh
node scripts/check-native-protocol.mjs /absolute/claude-agent-sdk/sdk.mjs /absolute/codex
```

This requires Claude SDK 0.3.283 and Codex CLI 0.157.1 (SPEC-0032 B04), uses the real SDK against owned offline peers, generates App Server declarations, and makes no model requests. It does not exercise upstream history or OS sandbox enforcement. Default paths resolve project-local installations.

## Support and execution matrix

| Environment | Evidence in this task |
| --- | --- |
| macOS Darwin 25.6.0 arm64, Apple M5 Pro, Node 24.14.0, Python 3.14.6 | Full local suites, native protocol-only checks, package smoke and capacity samples |
| macOS 14 / Ubuntu 24.04, Node 22.18.0 | Passed 438 Node / 48 Python tests, package and capacity checks in [run 35529393933](https://github.com/masonlee39/Multi-Agent/actions/runs/35529393933), source `cf574c4`; Python 3.11.9 on macOS and 3.11.13 on Linux |
| macOS 14 / Ubuntu 24.04, Node 24.14.0 + Python 3.14.6 | Passed the same full matrix in run 35529393933; both separate native jobs also passed real binaries with scripted gateways |
| Claude SDK 0.3.274 + Zod 4.4.3 / Codex CLI 0.153.4 | Real local binaries with scripted loopback responses: tools, approval, retained history, fork/reuse/compact and both clients pass |
| Single-file CJS/ESM Claude host, Node 24.14.0, no node_modules | Actual engine tasks, approval, four native MCP operations and injected inspection pass |
| Real Claude/Codex models and actual native sandbox | Not executed or accepted |
| A Vite/Electron 43.2.0 application (Node 24.18) | Host-side acceptance pending; generic Node bundles do not establish this |

The broad optional Claude peer range is an installation constraint, not a claim that all versions pass. Re-run drift review before changing tested candidates. SPEC-0012 [measures bound tool reads](../tdd/0012-capacity.json) at up to 50k retained tasks with `maxLogicalSessions: 100000`; the programmatic default is 10,000 sessions. This is not million-record/10 GiB production validation. The [current readiness ledger](readiness.md) contains exact remaining gates and native-gateway reproduction commands.

## Separately authorized native smoke

Preparation is safe and non-model:

```sh
node scripts/native-acceptance.mjs prepare /absolute/new-plan.json
```

Review the [template](native-plan.template.json). A concrete run needs provider, exact model, TS or Python path, a non-secret identity-source label, exact runtime versions, explicit registered pricing and a currency budget. Keep credentials with the native runtime; never paste them into the plan. The default plan reserves an estimated USD 1 for one read-only turn, at most 120 seconds, with no requested tools. Pricing estimates and host reservation are not provider-side spend caps.

After the user separately authorizes the complete plan and its SHA-256, the explicit entry point is:

```sh
node scripts/native-acceptance.mjs run /absolute/reviewed-plan.json AUTHORIZED_SHA256
```

The harness validates the digest/version/one-turn bounds before runtime startup, creates owned private workspace/state directories, captures task/session/usage/cost/scheduler evidence, and attempts bounded cleanup. It leaves the result awaiting human review and never automatically approves it. Review evidence.json and the retained state directory. Repeat deliberately for each chosen provider/language; passing one cell does not prove the others. This minimal smoke also does not prove fork/cache economics, arbitrary tool security, write sandboxing or a production application's UI/journal.

Native SDK callbacks, OS sandbox escape/failure behavior, real saved-history fork/compact/recovery, complete upstream usage, and application integration require their own authorized scenarios. The project license is MIT. Public release additionally needs the joint-provider acceptance gate, external CI results and explicit publication authority. No release command is run by these scripts.
