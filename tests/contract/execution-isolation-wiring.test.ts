import { requestDigest } from '../../packages/engine/src/identity.ts';
import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, OperationHandle } from '../../packages/sdk-typescript/src/index.ts';
import { engineConfig, loadConfig } from '../../packages/cli/src/config.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';

const capability = {
  version: 1,
  resourceRelease: true,
  schedulerStatus: true,
  ownerConflictResolution: true,
  budgetVersion: 2,
};
const info = {
  protocolVersion: '2.0',
  engineVersion: 'fixture',
  schemaVersion: 2,
  instanceId: 'fixture',
  storeId: 'store',
  capabilities: { storeNamespaces: { version: 1 } },
};
const evidence = {
  source: 'owner_attestation' as const,
  summary: 'Owner checked original resources',
  localResources: 'stopped' as const,
  remoteExecution: 'stopped' as const,
  sideEffects: 'unknown' as const,
  outcome: 'unknown' as const,
};
const scheduler = {
  maxActiveSessions: 2,
  maxQuarantinedDispatches: 32,
  executionOccupied: 1,
  quarantined: 2,
  quarantineReserved: 1,
  canDispatch: false,
  reasons: ['EXECUTION_EVIDENCE_CONFLICT'],
  occupants: [
    {
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      leaseStatus: 'released',
      quarantined: true,
      lastEvidence: 'runtime_terminal',
      enteredAt: '2026-09-19T00:00:00Z',
    },
  ],
  truncated: false,
  openConflicts: 1,
  conflicts: [{ conflictId: 'conflict', revision: 2, dispatchId: 'dispatch' }],
  conflictsTruncated: false,
};
const conflict = {
  id: 'conflict',
  revision: 2,
  dispatchId: 'dispatch',
  sessionId: 'session',
  taskId: 'task',
  generation: 1,
  status: 'open',
  releaseEvidenceRef: 'sha256:old',
  conflictingEvidenceRef: 'sha256:new',
  createdAt: '2026-09-19T00:00:00Z',
};

test('A2 TS scheduler methods reject every incompatible capability before sending', async () => {
  for (const executionIsolation of [
    undefined,
    {},
    { ...capability, version: 2 },
    { ...capability, resourceRelease: false },
    { ...capability, schedulerStatus: false },
    { ...capability, ownerConflictResolution: false },
    { ...capability, budgetVersion: 1 },
  ]) {
    const sent: string[] = [];
    const client = new Orchestrator(
      {
        async call<T>(method: string): Promise<T> {
          sent.push(method);
          throw new Error('must not send');
        },
        disconnect() {},
      },
      {
        ...info,
        capabilities:
          executionIsolation === undefined
            ? { storeNamespaces: { version: 1 } }
            : { storeNamespaces: { version: 1 }, executionIsolation },
      },
      true,
    );
    for (const call of [
      () => client.scheduler.get(),
      () => client.scheduler.getConflict({ conflictId: 'conflict' }),
      () =>
        client.scheduler.resolveConflict({ conflictId: 'conflict', expectedRevision: 2, evidence }),
    ])
      await assert.rejects(async () => call(), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.deepEqual(sent, []);
  }
});

test('A2 TS scheduler reads exact wire shapes and resolves with conflict-scoped operation handles', async () => {
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const operation = {
    id: 'operation',
    method: 'scheduler.resolveConflict',
    scope: 'conflict',
    idempotencyKey: 'review',
    status: 'completed',
    targetId: 'conflict',
    result: { conflictId: 'conflict', customPayload: { taskId: 'raw' } },
    error: null,
  };
  const client = new Orchestrator(
    {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        return (
          method === 'scheduler.get'
            ? scheduler
            : method === 'scheduler.getConflict'
              ? conflict
              : operation
        ) as T;
      },
      disconnect() {},
    },
    { ...info, capabilities: { storeNamespaces: { version: 1 }, executionIsolation: capability } },
    true,
  );
  assert.deepEqual(await client.scheduler.get(), scheduler);
  assert.deepEqual(await client.scheduler.getConflict({ conflictId: 'conflict' }), conflict);
  const op = await client.scheduler.resolveConflict(
    { conflictId: 'conflict', expectedRevision: 2, evidence },
    { idempotencyKey: 'review' },
  );
  assert.ok(op instanceof OperationHandle);
  assert.deepEqual(op.initial.result, operation.result);
  assert.equal((await op.wait({ timeoutMs: 100 })).id, 'operation');
  assert.deepEqual(calls.slice(0, 3), [
    { method: 'scheduler.get', params: {} },
    { method: 'scheduler.getConflict', params: { conflictId: 'conflict' } },
    {
      method: 'scheduler.resolveConflict',
      params: {
        conflictId: 'conflict',
        expectedRevision: 2,
        evidence,
        idempotencyKey: 'review',
        expectedStoreId: info.storeId,
        requestDigest: requestDigest('scheduler.resolveConflict', {
          conflictId: 'conflict',
          expectedRevision: 2,
          evidence,
        }),
      },
    },
  ]);
});

test('A2 TS lost conflict resolution receipt retains the method scope and business key', async () => {
  const client = new Orchestrator(
    {
      async call<T>(): Promise<T> {
        throw Object.assign(new Error('disconnected'), { code: 'CONNECTION_CLOSED' });
      },
      disconnect() {},
    },
    { ...info, capabilities: { storeNamespaces: { version: 1 }, executionIsolation: capability } },
    true,
  );
  await assert.rejects(
    client.scheduler.resolveConflict(
      { conflictId: 'conflict', expectedRevision: 2, evidence },
      { idempotencyKey: 'lost-review' },
    ),
    (error: any) =>
      error.code === 'CONNECTION_CLOSED' &&
      error.data.method === 'scheduler.resolveConflict' &&
      error.data.scope === 'conflict' &&
      error.data.idempotencyKey === 'lost-review',
  );
});

test('A2 CLI accepts and validates quarantine capacity without overriding explicit provider deadlines', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-a2-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const base = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    providers: { fake: { model: 'fixture' } },
  };
  const path = join(root, 'config.json');
  const config = {
    ...base,
    limits: { maxActiveSessions: 2, maxQuarantinedDispatches: 32 },
    timeouts: { turnMs: 1800000 },
  };
  await writeFile(path, JSON.stringify(config));
  const loaded = await engineConfig(await loadConfig(path));
  assert.deepEqual(loaded.limits, config.limits);
  assert.deepEqual(loaded.timeouts, config.timeouts);
  for (const value of [0, -1, 1.5, 1025, '32', true, 1]) {
    await writeFile(path, JSON.stringify({ ...base, limits: { maxQuarantinedDispatches: value } }));
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
  }
  await writeFile(
    path,
    JSON.stringify({ ...base, limits: { maxActiveSessions: 1, maxQuarantinedDispatches: 1 } }),
  );
  assert.equal((await loadConfig(path)).limits?.maxQuarantinedDispatches, 1);
  for (const provider of ['claude', 'codex']) {
    const settings = {
      model: 'fixture',
      requestTimeoutMs: 100,
      turnTimeoutMs: 300000,
      ...(provider === 'codex' ? { executionStop: 'owner-reconcile' } : {}),
    };
    await writeFile(path, JSON.stringify({ ...base, providers: { [provider]: settings } }));
    assert.deepEqual((await loadConfig(path)).providers[provider], settings);
  }
  for (const value of [0, 1.5, true, '100']) {
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        providers: { claude: { model: 'fixture', turnTimeoutMs: value } },
      }),
    );
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
  }
});

test('A2 public schema declares scheduler, conflict, lease and budget fields with current defaults', async () => {
  const { $defs: defs } = JSON.parse(
    await readFile(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(defs.LifecycleTimeouts.properties.turnMs.default, 1800000);
  for (const name of [
    'ExecutionIsolationCapability',
    'SchedulerSnapshot',
    'ExecutionConflict',
    'ExecutionLease',
    'DispatchBudget',
    'SessionExecution',
    'SchedulerGetParams',
    'SchedulerGetConflictParams',
    'SchedulerResolveConflictParams',
    'EngineLimits',
    'SessionSnapshot',
  ])
    assert.ok(defs[name], name);
  assert.equal(defs.EngineLimits.properties.maxQuarantinedDispatches.default, 32);
  assert.equal(defs.EngineLimits.properties.maxQuarantinedDispatches.maximum, 1024);
  assert.equal(defs.SchedulerSnapshot.properties.occupants.maxItems, 16);
  assert.equal(defs.SchedulerSnapshot.properties.conflicts.maxItems, 16);
  assert.ok(defs.SchedulerResolveConflictParams.required.includes('expectedRevision'));
  assert.ok(defs.SchedulerResolveConflictParams.required.includes('idempotencyKey'));
  assert.equal(defs.SessionSnapshot.properties.execution.$ref, '#/$defs/SessionExecution');
  assert.equal(defs.ExecutionIsolationCapability.properties.budgetVersion.const, 2);
});

test(
  'A2 CLI uses provider-specific cleanup keys and passes Claude cleanup budget into execution',
  { timeout: 3000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-a2-cleanup-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'));
    const path = join(root, 'config.json');
    const write = (provider: string, settings: Record<string, unknown>) =>
      writeFile(
        path,
        JSON.stringify({
          workspace: join(root, 'workspace'),
          stateDir: join(root, 'state'),
          providers: {
            [provider]: {
              model: 'fixture',
              ...(provider === 'codex' ? { executionStop: 'owner-reconcile' } : {}),
              ...settings,
            },
          },
        }),
      );
    await write('claude', { cleanupTimeoutMs: 17 });
    const config = await loadConfig(path);
    assert.equal(config.providers.claude.cleanupTimeoutMs, 17);
    await write('claude', { interruptTimeoutMs: 29 });
    assert.equal((await loadConfig(path)).providers.claude.interruptTimeoutMs, 29);
    for (const value of [0, 1.5, true, '29', 3600001]) {
      await write('claude', { interruptTimeoutMs: value });
      await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
    }
    await write('codex', { interruptTimeoutMs: 29 });
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
    await write('claude', { closeTimeoutMs: 17 });
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
    await write('codex', { closeTimeoutMs: 17 });
    assert.equal((await loadConfig(path)).providers.codex.closeTimeoutMs, 17);
    await write('codex', { cleanupTimeoutMs: 17 });
    await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
    for (const provider of ['claude', 'codex']) {
      const name = provider === 'claude' ? 'cleanupTimeoutMs' : 'closeTimeoutMs';
      for (const value of [0, 1.5, true, '17', 3600001]) {
        await write(provider, { [name]: value });
        await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
      }
    }

    const { claudeProcess, stubbornClaudeProcess } = await import('../fixtures/claude-process.ts');
    let child: ReturnType<typeof claudeProcess> | undefined;
    let cleanupBegan!: () => void;
    let finishCleanup!: (value: IteratorResult<unknown>) => void;
    const started = new Promise<void>((resolve) => {
      cleanupBegan = resolve;
    });
    const cleanup = new Promise<IteratorResult<unknown>>((resolve) => {
      finishCleanup = resolve;
    });
    // Add an offline query seam after parsing; JSON never permits an executable query field.
    config.providers.claude.query = (request: Parameters<typeof claudeProcess>[0]) => {
      const held = stubbornClaudeProcess(request);
      child = held.child;
      return {
        close() {},
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await held.ready;
              return {
                done: false,
                value: {
                  type: 'result',
                  subtype: 'success',
                  session_id: 'cleanup-provider',
                  result: 'done',
                },
              };
            },
            return() {
              cleanupBegan();
              return cleanup;
            },
          };
        },
      };
    };
    const adapter = (await engineConfig(config)).adapters[0];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finished = false;
    const collection = (async () => {
      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute({
        taskId: 'task',
        sessionId: 'cleanup-session',
        dispatchId: 'dispatch',
        providerSessionId: null,
        model: 'fixture',
        workspace: join(root, 'workspace'),
        stateDir: join(root, 'state'),
        prompt: 'offline fixture',
        permissionProfile: 'read-only',
        signal: new AbortController().signal,
      }))
        events.push(event);
      finished = true;
      return events;
    })();
    try {
      await started;
      t.mock.timers.tick(16);
      await Promise.resolve();
      assert.equal(finished, false);
      t.mock.timers.tick(1);
      const events = await collection;
      assert.equal(events.at(-1)?.type, 'error');
      assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
      assert.equal(adapter.hasActiveResources?.('cleanup-session'), true);
    } finally {
      finishCleanup({ done: true, value: undefined });
      await collection;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(adapter.hasActiveResources?.('cleanup-session'), true);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await adapter.close?.();
    }
  },
);
