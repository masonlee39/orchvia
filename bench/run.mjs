// SPEC-0021 E03-E06: the same four requests, done three ways, with tokens, time, cost and checks.
// node bench/run.mjs [--arms single,fresh,orchvia] [--reps 1] [--budget-usd 10] [--model claude-sonnet-5]
//                    [--out bench/results/NAME.json] [--fake [--fake-skip X2] | --gateway]
// --fake runs every arm without a model: the reference solutions stand in for the agent's edits.
// --gateway runs every arm with the real Claude Code binary against a loopback gateway that answers
// with the reference solutions (bench/gateway.mjs): no model is called.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createOrchestrator } from '../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../packages/engine/src/fake.ts';
import { createClaudeAdapter } from '../packages/adapter-claude/src/index.ts';
import { startGateway } from './gateway.mjs';
import { executionStopped } from './stop.mjs';
import { continuesTotals, costOf, directUsage, engineUsage, PRICES, priceFor } from './meter.mjs';

const run = promisify(execFile);
const bench = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    arms: { type: 'string', default: 'single,fresh,orchvia' },
    reps: { type: 'string', default: '1' },
    'budget-usd': { type: 'string', default: '10' },
    model: { type: 'string', default: 'claude-sonnet-5' },
    out: { type: 'string' },
    fake: { type: 'boolean', default: false },
    // Fake runs only: requests whose solution is left out, as if the agent did nothing.
    'fake-skip': { type: 'string', default: '' },
    gateway: { type: 'boolean', default: false },
    // Exits with 1 unless every arm passes every request, for CI.
    'require-pass': { type: 'boolean', default: false },
  },
});
const arms = args.arms.split(',');
for (const arm of arms)
  assert.ok(['single', 'fresh', 'orchvia'].includes(arm), `unknown arm ${arm}`);
const reps = Number(args.reps);
const budgetUsd = Number(args['budget-usd']);
const model = args.model;
const fake = args.fake;
const fakeSkip = new Set(args['fake-skip'].split(',').filter(Boolean));
const gateway = args.gateway;
assert.ok(!(fake && gateway), '--fake and --gateway exclude each other');
const requests = JSON.parse(await readFile(join(bench, 'requests.json'), 'utf8'));

// SPEC-0047: every arm is metered by bench/meter.mjs and priced per model there.
if (!fake) assert.ok(priceFor(model), `no list price for ${model}; add it to bench/meter.mjs`);
/** A request's estimated cost: known when every part's is; the budget counts the known part. */
function priced(usage) {
  const parts = [usage.main, ...usage.outside].map(costOf);
  const known = parts.reduce((total, part) => total + (part.usd ?? 0), 0);
  const unpriced = parts.filter((part) => part.usd === null).length;
  return {
    costUsd: unpriced ? null : known,
    knownCostUsd: known,
    unpricedParts: unpriced,
    cacheWriteAt5mRate: parts.some((part) => part.estimated5m),
  };
}

// Every arm gets the same tools, permission mode, settings isolation and sandbox, matching the
// engine's writable Claude profile. Node lives in the home directory on some machines, and the
// sandbox denies the home directory, so its installation directory is readable and first on PATH.
const TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const nodeHome = dirname(dirname(await realpath(process.execPath)));
const PATH = `${nodeHome}/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
// The scripted model's answers are held back for Y1, so that in the orchvia arm X1 finishes while
// Y1's Claude process still runs in the shared workspace.
const scripted = gateway
  ? await startGateway({ bench, requests, finalDelayMs: { Y1: 3_000 } })
  : null;
const gatewayHome = scripted
  ? await realpath(await mkdtemp(join(tmpdir(), 'orchvia-bench-home-')))
  : null;
if (gatewayHome) await mkdir(join(gatewayHome, '.claude'), { mode: 0o700 });
// Without the test runner's variable: a nested `node --test` under it exits 0 even when a check fails.
const { NODE_TEST_CONTEXT: _runner, ...inherited } = process.env;
const env = scripted
  ? // A private home: no credentials, settings or history of the machine are used.
    {
      PATH,
      HOME: gatewayHome,
      TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(gatewayHome, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: scripted.url,
      ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
    }
  : { ...inherited, PATH };
const sandboxFor = (workspace) => ({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: false,
  filesystem: {
    allowWrite: [workspace],
    allowRead: [workspace, nodeHome],
    denyRead: [homedir()],
  },
});

const spent = { usd: 0 };
const overBudget = () => spent.usd >= budgetUsd;

async function workspaceFor(label) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `orchvia-bench-${label}-`)));
  const workspace = join(root, 'workspace');
  await cp(join(bench, 'fixture'), workspace, { recursive: true });
  await mkdir(join(root, 'state'), { mode: 0o700 });
  return { root, workspace, stateDir: join(root, 'state') };
}

/** The reference solution of a request, standing in for the agent's edits in --fake runs. */
const applySolution = async (workspace, id) => {
  if (!fakeSkip.has(id))
    await cp(join(bench, 'solutions', id), workspace, { recursive: true, force: true });
};

/** A request passes when its hidden check and the track's own tests pass. */
async function check(workspace, request) {
  const result = { hidden: false, own: false };
  const options = { cwd: bench, env: { ...env, BENCH_WORKSPACE: workspace }, timeout: 60_000 };
  try {
    await run(
      process.execPath,
      ['--test', join(bench, 'checks', `${request.id}.test.mjs`)],
      options,
    );
    result.hidden = true;
  } catch {}
  try {
    await run(process.execPath, ['--test', join(workspace, request.track, 'index.test.js')], {
      ...options,
      cwd: workspace,
    });
    result.own = true;
  } catch {}
  return result;
}

const zeroPart = (name = model) => ({
  model: name,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});
const zero = () => ({ main: zeroPart(), outside: [], total: zeroPart('*') });

/** One request through the Claude Agent SDK directly, as a host without the engine would do. */
async function sdkRequest(workspace, request, resume, previousTotals) {
  if (fake) {
    await applySolution(workspace, request.id);
    return {
      sessionId: resume ?? `fake-${request.id}`,
      usage: zero(),
      totals: {},
      reportedCostUsd: null,
    };
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let result;
  for await (const message of query({
    prompt: request.prompt,
    options: {
      model,
      cwd: workspace,
      ...(resume ? { resume } : {}),
      settingSources: [],
      tools: TOOLS,
      allowedTools: TOOLS,
      disallowedTools: ['mcp__*'],
      permissionMode: 'dontAsk',
      env,
      sandbox: sandboxFor(workspace),
    },
  }))
    if (message.type === 'result') result = message;
  assert.ok(result, 'the SDK returned no result');
  // A resumed session's totals continue from its previous request (SPEC-0047 M01).
  const continues = continuesTotals((await claudeVersions())?.claudeCode);
  const { totals, ...usage } = directUsage(
    result,
    model,
    resume ? previousTotals : undefined,
    continues,
  );
  return {
    sessionId: result.session_id,
    ok: result.subtype === 'success',
    usage,
    totals,
    reportedCostUsd: result.total_cost_usd ?? null,
  };
}

/** The single and fresh arms: requests in order, one session throughout or a new one each time. */
async function sdkArm(arm, rep) {
  const { root, workspace } = await workspaceFor(`${arm}-${rep}`);
  const rows = [];
  const started = performance.now();
  let session;
  let totals;
  try {
    for (const request of requests) {
      if (overBudget()) break;
      const begin = performance.now();
      const resume = arm === 'single' ? session : undefined;
      const turn = await sdkRequest(workspace, request, resume, totals);
      const end = performance.now();
      session = turn.sessionId;
      totals = turn.totals;
      const pass = await check(workspace, request);
      const cost = priced(turn.usage);
      spent.usd += cost.knownCostUsd;
      rows.push({
        id: request.id,
        track: request.track,
        startMs: Math.round(begin - started),
        endMs: Math.round(end - started),
        wallMs: Math.round(end - begin),
        usage: turn.usage,
        ...cost,
        reportedCostUsd: turn.reportedCostUsd,
        pass,
      });
    }
    return { wallMs: Math.round(performance.now() - started), rows };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The orchvia arm: both tracks at once, each on its own session that stays warm for its follow-up. */
async function orchviaArm(rep) {
  const { root, workspace, stateDir } = await workspaceFor(`orchvia-${rep}`);
  const adapter = fake
    ? // A delay makes the two tracks overlap measurably without a model.
      createFakeAdapter({ provider: 'claude', delayMs: 200 })
    : createClaudeAdapter({
        permissionProfile: 'workspace-write',
        readRoots: [nodeHome],
        options: { env },
        observeExecutionStop: ({ target, signal }) =>
          executionStopped({ adapter, workspace, target, signal }),
        // The stop proof first waits for the dispatch's Claude process to exit (bench/stop.mjs).
        cleanupTimeoutMs: 10_000,
      });
  const orch = await createOrchestrator({
    workspace,
    stateDir,
    adapters: [adapter],
    providers: { claude: { model, permissionProfile: 'workspace-write' } },
    writeScopes: { restock: ['restock'], report: ['report'] },
    allowCrossRootReuse: true,
    limits: { maxActiveSessions: 2 },
    // --fake runs are tests (SPEC-0011 R10): a 4 KiB emergency reserve, not the 256 MiB default.
    ...(fake ? { storage: { emergencyBytes: 4096 } } : {}),
  });
  const rows = [];
  const started = performance.now();
  const track = async (name) => {
    let session;
    for (const request of requests.filter((item) => item.track === name)) {
      if (overBudget()) return;
      const begin = performance.now();
      const task = await orch.tasks.create({
        goal: request.prompt,
        runtime: { provider: 'claude', model },
        acceptance: { mode: 'human', criteria: ['The hidden check and the track tests pass'] },
        writeScope: name,
        ...(session
          ? {
              contextPlan: {
                requestedMode: 'reuse',
                candidateSessionId: session,
                independent: true,
                dependencyTaskIds: [],
                contextRefs: [],
                fallbackModes: [],
                maxQueueWaitMs: 600_000,
              },
            }
          : {}),
      });
      let pass;
      let ended = false;
      // Task events are named task.<status>; a task that fails or is blocked asks for no approval.
      for await (const event of orch.events({
        taskId: task.id,
        signal: AbortSignal.timeout(1_800_000),
      })) {
        if (['task.failed', 'task.cancelled', 'task.blocked'].includes(event.type)) {
          ended = true;
          break;
        }
        if (event.type !== 'approval.requested') continue;
        if (fake) await applySolution(workspace, request.id);
        // The harness is the reviewer: it records the checks and accepts either way, so the
        // follow-up request still runs.
        pass = await check(workspace, request);
        const approval = await orch.approvals.get(String(event.data.approvalId));
        await orch.approvals.decide(approval.approvalId, {
          choice: 'approve',
          expectedRevision: approval.revision,
        });
        break;
      }
      // A blocked task never finishes on its own, so it is read instead of awaited.
      const done = ended
        ? await orch.tasks.get(task.id)
        : await task.wait({ timeoutMs: 1_800_000 });
      const end = performance.now();
      session = done.sessionId;
      const records = (await orch.usage.get(task.id)).records;
      const usage = fake ? zero() : engineUsage(records, model);
      const cost = priced(usage);
      spent.usd += cost.knownCostUsd;
      rows.push({
        id: request.id,
        track: name,
        status: done.status,
        session: done.sessionId,
        startMs: Math.round(begin - started),
        endMs: Math.round(end - started),
        wallMs: Math.round(end - begin),
        usage,
        ...cost,
        reportedCostUsd: null,
        pass: pass ?? { hidden: false, own: false },
      });
      // Its session cannot take the follow-up; the rest of the track is reported as not run.
      if (done.status !== 'completed') return;
    }
  };
  try {
    await Promise.all([track('restock'), track('report')]);
    return { wallMs: Math.round(performance.now() - started), rows };
  } finally {
    await orch.close();
    await rm(root, { recursive: true, force: true });
  }
}

const runs = [];
const startedAt = new Date().toISOString();
try {
  for (let rep = 1; rep <= reps && !overBudget(); rep++)
    for (const arm of arms) {
      if (overBudget()) break;
      const result = arm === 'orchvia' ? await orchviaArm(rep) : await sdkArm(arm, rep);
      // Main loop and outside it apart; a count unknown in any request is unknown in the total.
      const add = (a, b) => (a === null || b === null ? null : a + b);
      const part = (pick) =>
        result.rows.reduce(
          (sum, row) =>
            Object.fromEntries(
              ['input', 'output', 'cacheRead', 'cacheWrite'].map((field) => [
                field,
                add(
                  sum[field],
                  pick(row.usage).reduce((n, p) => add(n, p[field]), 0),
                ),
              ]),
            ),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        );
      const main = part((usage) => [usage.main]);
      const outside = part((usage) => usage.outside);
      const totals = {
        main,
        outside,
        input: add(main.input, outside.input),
        output: add(main.output, outside.output),
        cacheRead: add(main.cacheRead, outside.cacheRead),
        cacheWrite: add(main.cacheWrite, outside.cacheWrite),
        costUsd: result.rows.some((row) => row.costUsd === null)
          ? null
          : result.rows.reduce((total, row) => total + row.costUsd, 0),
        knownCostUsd: result.rows.reduce((total, row) => total + row.knownCostUsd, 0),
        passed: result.rows.reduce((n, row) => n + (row.pass.hidden && row.pass.own ? 1 : 0), 0),
      };
      runs.push({ arm, rep, wallMs: result.wallMs, requests: result.rows, totals });
      console.log(
        `${arm} #${rep}: ${totals.passed}/${requests.length} passed, ${(result.wallMs / 1000).toFixed(1)} s, ` +
          `${totals.costUsd === null ? `at least $${totals.knownCostUsd.toFixed(4)}` : `$${totals.costUsd.toFixed(4)}`} ` +
          `(in ${totals.input}, cache read ${totals.cacheRead}, ` +
          `cache write ${totals.cacheWrite}, out ${totals.output})`,
      );
    }
} finally {
  await scripted?.close();
  if (gatewayHome) await rm(gatewayHome, { recursive: true, force: true });
}
/** The Agent SDK and the Claude Code build it bundles, which every arm runs. */
async function claudeVersions() {
  try {
    const path = join(
      bench,
      '..',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    );
    const sdk = JSON.parse(await readFile(path, 'utf8'));
    return { agentSdk: sdk.version, claudeCode: sdk.claudeCodeVersion ?? null };
  } catch {
    return null;
  }
}

const report = {
  version: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  model,
  fake,
  gateway,
  prices: PRICES,
  budget: { limitUsd: budgetUsd, spentUsd: spent.usd, stopped: overBudget() },
  machine: { platform: process.platform, arch: process.arch, node: process.version },
  claude: await claudeVersions(),
  requests: requests.map(({ id, track }) => ({ id, track })),
  runs,
};
if (args.out) {
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(resolve(args.out), JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({ spentUsd: spent.usd, stopped: report.budget.stopped, runs: runs.length }),
);
if (args['require-pass'] && runs.some((run) => run.totals.passed < requests.length))
  process.exitCode = 1;
