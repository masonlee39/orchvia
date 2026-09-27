import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { EngineConfig, RuntimeAdapter } from '../../engine/src/types.ts';
import { normalizeRules, workspacePath } from '../../engine/src/verification.ts';
import { MAX_QUEUE_WAIT_MS } from '../../engine/src/validation.ts';

export interface HostConfig {
  configVersion?: 1;
  workspace: string;
  stateDir: string;
  transport?: { mode: 'unix' | 'stdio'; socketPath?: string };
  providers: Record<
    string,
    Record<string, unknown> & {
      model?: string;
      models?: string[];
      permissionProfile?: 'read-only' | 'workspace-write';
    }
  >;
  limits?: EngineConfig['limits'];
  timeouts?: EngineConfig['timeouts'];
  approvalTtlMs?: number;
  runtimeApprovals?: EngineConfig['runtimeApprovals'];
  messages?: EngineConfig['messages'];
  pricing?: EngineConfig['pricing'];
  budget?: EngineConfig['budget'];
  contextLimits?: EngineConfig['contextLimits'];
  shutdown?: { mode?: 'drain' | 'interrupt' | 'pause'; timeoutMs?: number };
  verificationRules?: EngineConfig['verificationRules'];
  writeScopes?: EngineConfig['writeScopes'];
  allowCrossRootReuse?: boolean;
  tools?: EngineConfig['tools'];
  storage?: EngineConfig['storage'];
  stores?: EngineConfig['stores'];
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[], location: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(`Unknown ${location} field: ${unknown.join(', ')}`);
}
export async function loadConfig(configPath: string): Promise<HostConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    invalid(`Cannot read JSON config: ${(error as Error).message}`);
  }
  if (!object(parsed)) invalid('Config must be an object');
  fields(
    parsed,
    [
      'configVersion',
      'workspace',
      'stateDir',
      'transport',
      'providers',
      'limits',
      'timeouts',
      'approvalTtlMs',
      'runtimeApprovals',
      'messages',
      'pricing',
      'budget',
      'contextLimits',
      'shutdown',
      'verificationRules',
      'writeScopes',
      'allowCrossRootReuse',
      'tools',
      'storage',
      'stores',
    ],
    'config',
  );
  if (parsed.configVersion !== undefined && parsed.configVersion !== 1)
    invalid('Only configVersion 1 is supported');
  for (const key of ['workspace', 'stateDir']) {
    if (typeof parsed[key] !== 'string' || !isAbsolute(parsed[key]))
      invalid(`${key} must be an absolute existing directory`);
    const path = parsed[key] as string;
    if (!(await stat(path)).isDirectory() || (await realpath(path)) !== path)
      invalid(`${key} must be a real directory path without symlinks`);
  }
  const rel = relative(parsed.workspace as string, parsed.stateDir as string);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)))
    invalid('stateDir must be outside workspace');
  if (!object(parsed.providers) || !Object.keys(parsed.providers).length)
    invalid('Configure at least one provider explicitly; fake is never enabled by default');
  for (const [provider, settings] of Object.entries(parsed.providers)) {
    if (!['fake', 'claude', 'codex'].includes(provider))
      invalid(`Provider is not in the installed adapter allowlist: ${provider}`);
    if (!object(settings)) invalid(`providers.${provider} must be an object`);
    if (
      settings.adapter !== undefined &&
      settings.adapter !== `@orchvia/adapter-${provider}` &&
      !(provider === 'fake' && settings.adapter === '@orchvia/engine/fake')
    )
      invalid(`Adapter module is not allowed for ${provider}`);
    if (settings.models === undefined) {
      if (typeof settings.model !== 'string' || !settings.model.trim())
        invalid(`providers.${provider}.model must name an explicit model`);
    } else {
      if (settings.model !== undefined)
        invalid(`providers.${provider} must configure model or models, not both`);
      const models = settings.models;
      if (
        !Array.isArray(models) ||
        models.length === 0 ||
        models.some((model) => typeof model !== 'string' || !model.trim()) ||
        new Set(models).size !== models.length
      )
        invalid(`providers.${provider}.models must be a non-empty list of unique model names`);
    }
    if (
      settings.permissionProfile !== undefined &&
      !['read-only', 'workspace-write'].includes(settings.permissionProfile as string)
    )
      invalid(`Unknown permissionProfile for ${provider}`);
    if (provider === 'fake') {
      fields(
        settings,
        ['adapter', 'model', 'models', 'permissionProfile', 'delayMs', 'result'],
        'fake provider',
      );
      if (
        settings.delayMs !== undefined &&
        (typeof settings.delayMs !== 'number' ||
          !Number.isFinite(settings.delayMs) ||
          settings.delayMs < 0)
      )
        invalid('fake.delayMs must be a non-negative finite number');
      if (settings.result !== undefined && typeof settings.result !== 'string')
        invalid('fake.result must be a string');
    } else if (provider === 'claude') {
      fields(
        settings,
        [
          'adapter',
          'model',
          'models',
          'permissionProfile',
          'requestTimeoutMs',
          'turnTimeoutMs',
          'cleanupTimeoutMs',
          'interruptTimeoutMs',
        ],
        'claude provider',
      );
      if (settings.permissionProfile === 'workspace-write')
        invalid(
          'Claude JSON host supports read-only; workspace-write requires embedded host policy and stop observation',
        );
    } else if (provider === 'codex') {
      fields(
        settings,
        [
          'adapter',
          'model',
          'models',
          'permissionProfile',
          'command',
          'args',
          'env',
          'networkAccess',
          'webSearch',
          'requestTimeoutMs',
          'turnTimeoutMs',
          'closeTimeoutMs',
          'executionStop',
        ],
        'codex provider',
      );
      // SPEC-0034 A01: a JSON host cannot pass a stop observer, so it must choose owner reconcile.
      if (settings.executionStop !== 'owner-reconcile')
        invalid(
          "codex.executionStop must be 'owner-reconcile': a Codex command can outlive its turn, so a JSON host releases leases by owner reconciliation",
        );
      if (settings.permissionProfile === 'workspace-write')
        invalid(
          'Codex JSON host supports read-only; workspace-write requires embedded host stop observation',
        );
      if (settings.networkAccess !== undefined && typeof settings.networkAccess !== 'boolean')
        invalid('codex.networkAccess must be a boolean');
      if (
        settings.webSearch !== undefined &&
        !['disabled', 'cached', 'live'].includes(settings.webSearch as string)
      )
        invalid('codex.webSearch must be disabled, cached, or live');
      if (
        settings.command !== undefined &&
        (typeof settings.command !== 'string' || !settings.command.trim())
      )
        invalid('codex.command must be a non-empty string');
      if (
        settings.args !== undefined &&
        (!Array.isArray(settings.args) || settings.args.some((value) => typeof value !== 'string'))
      )
        invalid('codex.args must be an array of strings');
      if (
        settings.env !== undefined &&
        (!object(settings.env) ||
          Object.values(settings.env).some((value) => typeof value !== 'string'))
      )
        invalid('codex.env must map names to string values');
    }
    if (provider === 'claude' || provider === 'codex') {
      const cleanupKey = provider === 'claude' ? 'cleanupTimeoutMs' : 'closeTimeoutMs';
      for (const key of [
        'requestTimeoutMs',
        'turnTimeoutMs',
        cleanupKey,
        ...(provider === 'claude' ? ['interruptTimeoutMs'] : []),
      ]) {
        if (
          settings[key] !== undefined &&
          (!Number.isSafeInteger(settings[key]) ||
            (settings[key] as number) < 1 ||
            (settings[key] as number) > 3600000)
        )
          invalid(`${provider}.${key} must be an integer from 1 through 3600000`);
      }
    }
  }
  if (parsed.transport !== undefined) {
    if (!object(parsed.transport)) invalid('transport must be an object');
    fields(parsed.transport, ['mode', 'socketPath'], 'transport');
    if (!['stdio', 'unix'].includes(parsed.transport.mode as string))
      invalid('transport.mode must be stdio or unix');
    if (
      parsed.transport.socketPath !== undefined &&
      (typeof parsed.transport.socketPath !== 'string' || !isAbsolute(parsed.transport.socketPath))
    )
      invalid('transport.socketPath must be absolute');
  }
  try {
    if (parsed.allowCrossRootReuse !== undefined && typeof parsed.allowCrossRootReuse !== 'boolean')
      invalid('allowCrossRootReuse must be a boolean');
    // Shape only: a missing rule directory is refused at task admission (SPEC-0017 A01).
    normalizeRules(
      parsed.workspace as string,
      parsed.verificationRules as EngineConfig['verificationRules'],
      { checkPaths: false },
    );
    if (parsed.writeScopes !== undefined) {
      if (!object(parsed.writeScopes)) invalid('writeScopes must be an object');
      for (const paths of Object.values(parsed.writeScopes)) {
        if (
          !Array.isArray(paths) ||
          !paths.length ||
          paths.length > 100 ||
          paths.some((path) => typeof path !== 'string')
        )
          invalid('Invalid write scope paths');
        for (const path of paths) workspacePath(parsed.workspace as string, path);
      }
    }
  } catch (error) {
    invalid((error as Error).message);
  }
  if (parsed.limits !== undefined) {
    if (!object(parsed.limits)) invalid('limits must be an object');
    fields(
      parsed.limits,
      [
        'maxActiveSessions',
        'maxTurnsPerTask',
        'maxQuarantinedDispatches',
        'maxLogicalSessions',
        'maxQueuedTasks',
        'defaultMaxQueueWaitMs',
      ],
      'limits',
    );
    const bounds: Record<string, number> = {
      maxActiveSessions: 8,
      maxTurnsPerTask: 1000,
      maxQuarantinedDispatches: 1024,
      maxLogicalSessions: 100000,
      maxQueuedTasks: 10000,
      defaultMaxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    };
    for (const [key, value] of Object.entries(parsed.limits)) {
      // A zero queue wait means no waiting (SPEC-0015 Q04); every other limit starts at one.
      const minimum = key === 'defaultMaxQueueWaitMs' ? 0 : 1;
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < minimum ||
        (value as number) > bounds[key]
      )
        invalid(`limits.${key} must be an integer from ${minimum} through ${bounds[key]}`);
    }
    if (
      ((parsed.limits.maxQuarantinedDispatches ?? 32) as number) <
      ((parsed.limits.maxActiveSessions ?? 2) as number)
    )
      invalid('limits.maxQuarantinedDispatches must be at least maxActiveSessions');
  }
  if (parsed.tools !== undefined) {
    if (!object(parsed.tools)) invalid('tools must be an object');
    fields(
      parsed.tools,
      [
        'enabled',
        'maxDepth',
        'maxChildren',
        'maxCallsPerDispatch',
        'maxRepeatedCalls',
        'approveDelegation',
        'handoffs',
        'handoffTtlMs',
      ],
      'tools',
    );
    for (const key of ['enabled', 'approveDelegation', 'handoffs'])
      if (parsed.tools[key] !== undefined && typeof parsed.tools[key] !== 'boolean')
        invalid(`tools.${key} must be boolean`);
    const ttl = parsed.tools.handoffTtlMs;
    if (
      ttl !== undefined &&
      (!Number.isSafeInteger(ttl) || (ttl as number) < 60000 || (ttl as number) > 604800000)
    )
      invalid('tools.handoffTtlMs must be an integer from 60000 through 604800000');
    for (const [key, max] of Object.entries({
      maxDepth: 16,
      maxChildren: 1000,
      maxCallsPerDispatch: 10000,
      maxRepeatedCalls: 100,
    })) {
      const value = parsed.tools[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
      )
        invalid(`Invalid tools.${key}`);
    }
  }
  if (parsed.runtimeApprovals !== undefined) {
    if (!object(parsed.runtimeApprovals)) invalid('runtimeApprovals must be an object');
    fields(parsed.runtimeApprovals, ['enabled', 'ttlMs'], 'runtimeApprovals');
    if (
      parsed.runtimeApprovals.enabled !== undefined &&
      typeof parsed.runtimeApprovals.enabled !== 'boolean'
    )
      invalid('runtimeApprovals.enabled must be boolean');
    if (
      parsed.runtimeApprovals.ttlMs !== undefined &&
      (!Number.isSafeInteger(parsed.runtimeApprovals.ttlMs) ||
        (parsed.runtimeApprovals.ttlMs as number) < 1 ||
        (parsed.runtimeApprovals.ttlMs as number) > 86400000)
    )
      invalid('runtimeApprovals.ttlMs must be 1..86400000');
  }
  if (parsed.messages !== undefined) {
    if (!object(parsed.messages)) invalid('messages must be an object');
    fields(parsed.messages, ['ttlMs', 'maxHops', 'maxPerMinute'], 'messages');
    for (const [key, max] of [
      ['ttlMs', 604800000],
      ['maxHops', 128],
      ['maxPerMinute', 10000],
    ] as const) {
      const value = parsed.messages[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
      )
        invalid(`Invalid messages.${key}`);
    }
  }
  if (
    parsed.approvalTtlMs !== undefined &&
    (!Number.isSafeInteger(parsed.approvalTtlMs) ||
      (parsed.approvalTtlMs as number) < 1 ||
      (parsed.approvalTtlMs as number) > 604800000)
  )
    invalid('approvalTtlMs must be an integer from 1 through 604800000');
  if (parsed.timeouts !== undefined) {
    if (!object(parsed.timeouts)) invalid('timeouts must be an object');
    fields(
      parsed.timeouts,
      ['acceptanceMs', 'turnMs', 'drainMs', 'interruptMs', 'reconcileMs'],
      'timeouts',
    );
    for (const [key, value] of Object.entries(parsed.timeouts)) {
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86400000)
        invalid(`timeouts.${key} must be an integer from 1 through 86400000`);
    }
  }
  if (parsed.shutdown !== undefined) {
    if (!object(parsed.shutdown)) invalid('shutdown must be an object');
    fields(parsed.shutdown, ['mode', 'timeoutMs'], 'shutdown');
    if (
      parsed.shutdown.mode !== undefined &&
      !['drain', 'interrupt', 'pause'].includes(parsed.shutdown.mode as string)
    )
      invalid('Invalid shutdown.mode');
    if (
      parsed.shutdown.timeoutMs !== undefined &&
      (!Number.isSafeInteger(parsed.shutdown.timeoutMs) ||
        (parsed.shutdown.timeoutMs as number) < 0 ||
        (parsed.shutdown.timeoutMs as number) > 3600000)
    )
      invalid('shutdown.timeoutMs must be an integer from 0 through 3600000');
  }
  return parsed as unknown as HostConfig;
}

export async function engineConfig(config: HostConfig): Promise<EngineConfig> {
  const adapters: RuntimeAdapter[] = [];
  for (const [provider, settings] of Object.entries(config.providers)) {
    if (provider === 'fake') {
      const { createFakeAdapter } = await import('../../engine/src/fake.ts');
      adapters.push(
        createFakeAdapter({
          delayMs: settings.delayMs as number | undefined,
          result: settings.result as string | undefined,
        }),
      );
    } else if (provider === 'claude') {
      const modulePath = '../../adapter-claude/src/index.ts';
      const { createClaudeAdapter } = await import(modulePath);
      adapters.push(await createClaudeAdapter(settings));
    } else if (provider === 'codex') {
      const modulePath = '../../adapter-codex/src/index.ts';
      const { createCodexAdapter } = await import(modulePath);
      adapters.push(await createCodexAdapter(settings));
    } else invalid(`Provider is not allowed: ${provider}`);
  }
  return {
    workspace: config.workspace,
    stateDir: config.stateDir,
    providers: config.providers,
    adapters,
    limits: config.limits,
    timeouts: config.timeouts,
    approvalTtlMs: config.approvalTtlMs,
    runtimeApprovals: config.runtimeApprovals,
    messages: config.messages,
    pricing: config.pricing,
    budget: config.budget,
    contextLimits: config.contextLimits,
    verificationRules: config.verificationRules,
    writeScopes: config.writeScopes,
    allowCrossRootReuse: config.allowCrossRootReuse,
    tools: config.tools,
    storage: config.storage,
    stores: config.stores,
  };
}
