/** Explicitly opt-in, bounded native smoke. Preparation never inspects login credentials. */
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, path, authorization] = process.argv.slice(2);
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
if (mode === 'prepare') {
  if (!path) throw new Error('Usage: node scripts/native-acceptance.mjs prepare PLAN.json');
  const plan = {
    version: 1,
    provider: null,
    language: 'typescript',
    model: null,
    identitySourceLabel: null,
    expectedVersions: { node: process.versions.node, claudeSdk: '0.3.283', codexCli: '0.157.1' },
    budget: { currency: 'USD', maxCost: '1', reservePerDispatch: '1' },
    pricing: null,
    limits: { maxActiveSessions: 1, maxTurnsPerTask: 1 },
    timeouts: { acceptanceMs: 30000, turnMs: 120000 },
    permissionProfile: 'read-only',
    goal: 'Reply exactly ORCH_NATIVE_ACCEPTANCE_V1. Do not use any tools.',
    approvalRequired:
      'Fill provider/model/pricing/identity-source label, review the complete plan and explicitly authorize its SHA-256 before run. Native credentials remain with the provider runtime.',
  };
  await writeFile(resolve(path), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({ prepared: resolve(path), modelCalls: 0, credentialsInspected: false }),
  );
} else if (mode === 'run') {
  if (!path || !authorization)
    throw new Error('Run requires PLAN.json and its separately authorized SHA-256');
  const raw = await readFile(resolve(path), 'utf8');
  if (hash(raw) !== authorization) throw new Error('Authorized plan digest differs');
  const plan = JSON.parse(raw);
  if (
    plan.version !== 1 ||
    !['claude', 'codex'].includes(plan.provider) ||
    !['typescript', 'python'].includes(plan.language) ||
    typeof plan.model !== 'string' ||
    !plan.model.trim() ||
    typeof plan.identitySourceLabel !== 'string' ||
    !plan.identitySourceLabel.trim() ||
    !plan.pricing
  )
    throw new Error(
      'Provider, model, language, registered pricing and a non-secret identity-source label are required',
    );
  if (
    plan.permissionProfile !== 'read-only' ||
    plan.limits?.maxActiveSessions !== 1 ||
    plan.limits?.maxTurnsPerTask !== 1 ||
    plan.timeouts?.turnMs > 120000 ||
    plan.timeouts?.acceptanceMs > 30000
  )
    throw new Error('Native smoke is limited to one read-only turn and at most 120 seconds');
  if (
    plan.pricing.provider !== plan.provider ||
    plan.pricing.model !== plan.model ||
    plan.pricing.currency !== plan.budget.currency
  )
    throw new Error('Pricing must identify the authorized provider/model/currency');
  if (process.versions.node !== plan.expectedVersions.node)
    throw new Error('Node version differs from approved plan');
  const versions = { node: process.versions.node };
  if (plan.provider === 'codex') {
    versions.codexCli = execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 16384,
    })
      .trim()
      .replace(/^codex-cli /, '');
    if (versions.codexCli !== plan.expectedVersions.codexCli)
      throw new Error('Codex version differs from approved plan');
  } else {
    const require = createRequire(
      new URL('../packages/adapter-claude/src/index.ts', import.meta.url),
    );
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    versions.claudeSdk = JSON.parse(
      await readFile(join(dirname(entry), 'package.json'), 'utf8'),
    ).version;
    if (versions.claudeSdk !== plan.expectedVersions.claudeSdk)
      throw new Error('Claude SDK version differs from approved plan');
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orch-authorized-native-')));
  const workspace = join(directory, 'workspace'),
    stateDir = join(directory, 'state');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  const config = {
    workspace,
    stateDir,
    providers: { [plan.provider]: { model: plan.model, permissionProfile: 'read-only' } },
    limits: plan.limits,
    timeouts: plan.timeouts,
    budget: plan.budget,
    pricing: [plan.pricing],
    storage: { emergencyBytes: 4 * 1024 * 1024 },
  };
  const configPath = join(directory, 'host.json');
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  const evidence = {
    planSha256: authorization,
    provider: plan.provider,
    language: plan.language,
    model: plan.model,
    identitySourceLabel: plan.identitySourceLabel,
    versions,
    workspace,
    stateDir,
    startedAt: new Date().toISOString(),
    acceptance: 'awaiting_human_review',
  };
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  try {
    if (plan.language === 'python') {
      const output = execFileSync(
        'python3',
        [
          join(root, 'scripts/native-acceptance.py'),
          configPath,
          plan.provider,
          plan.model,
          plan.goal,
        ],
        {
          encoding: 'utf8',
          timeout: 155000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PYTHONPATH: join(root, 'python/src'),
            ORCH_NATIVE_NODE: process.execPath,
          },
        },
      );
      Object.assign(evidence, JSON.parse(output));
    } else {
      const { engineConfig } = await import('../packages/cli/src/config.ts');
      const { createOrchestrator } = await import('../packages/sdk-typescript/src/index.ts');
      const client = await createOrchestrator(await engineConfig(config));
      try {
        const task = await client.tasks.create({
          goal: plan.goal,
          runtime: { provider: plan.provider, model: plan.model },
          acceptance: {
            mode: 'human',
            criteria: [
              'Review exact native output, usage, resource release and unchanged workspace',
            ],
          },
        });
        let snapshot = task.initial;
        const deadline = performance.now() + 125000;
        while (
          !['waiting_approval', 'blocked', 'paused', 'failed', 'cancelled', 'completed'].includes(
            snapshot.status,
          )
        ) {
          if (performance.now() > deadline) throw new Error('Native observation deadline reached');
          await new Promise((r) => setTimeout(r, 100));
          snapshot = await task.get();
        }
        Object.assign(evidence, {
          task: snapshot,
          session: await client.sessions.get(snapshot.sessionId),
          usage: await client.usage.get(task.id),
          costs: await client.costs.get(task.id),
          scheduler: await client.scheduler.get(),
        });
      } finally {
        await client.close({ mode: 'interrupt', timeoutMs: 10000 });
      }
    }
  } catch (error) {
    evidence.error = { code: error.code ?? 'NATIVE_SMOKE_FAILED', message: error.message };
    evidence.acceptance = 'unverified';
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      directory,
      evidence: join(directory, 'evidence.json'),
      status: evidence.task?.status ?? 'unverified',
      acceptance: evidence.acceptance,
    }),
  );
} else throw new Error('Use prepare or run; there is no automatic native execution mode');
