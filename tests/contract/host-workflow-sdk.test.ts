import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  connectOrchestrator,
  createOrchestrator,
  validateWire,
} from '../../packages/sdk-typescript/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const info = {
  protocolVersion: '2.0' as const,
  engineVersion: 'fixture',
  schemaVersion: 3,
  instanceId: 'fixture',
  storeId: 'store',
  capabilities: { storeNamespaces: { version: 1 } },
};
const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});
const rule = {
  id: 'lint',
  version: '1',
  argv: ['/usr/bin/true'],
  cwdRelative: '.',
  timeoutMs: 1000,
  permissionProfile: 'read-only' as const,
  success: { exitCode: 0 },
};

test('0014-X01 both workflow feature checks run before any request is sent', async () => {
  const calls: string[] = [];
  const client = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        return {} as T;
      },
      disconnect() {},
    },
    info,
    true,
  );
  for (const attempt of [
    () => client.tasks.list(),
    () => client.tasks.create(spec('x', { writeScope: 'a', writePath: 'a/b' }) as never),
    () =>
      client.sessions.open({
        runtime: { provider: 'fake', model: 'fixture' },
        writeScope: 'a',
        writePath: 'a/b',
      }),
    () => client.approvals.decide('a', { choice: 'revise', expectedRevision: 1, comment: 'x' }),
    () => client.approvals.decide('a', { choice: 'approve', expectedRevision: 1, comment: 'x' }),
    () => client.handoffs.get('h'),
    () => client.handoffs.list(),
    () => client.handoffs.resolve('h', { expectedRevision: 1, outcome: 'rejected' }),
    () => client.rules.register(rule),
    () => client.rules.list(),
  ])
    await assert.rejects(attempt(), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.deepEqual(calls, []);
});

test('0014-X02 workflow methods round-trip over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-workflow-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/owf-'));
  await mkdir(join(root, 'workspace'));
  const fake = createFakeAdapter();
  let target = '';
  let failure: unknown;
  const adapter: RuntimeAdapter = {
    ...fake,
    async *execute(input: RuntimeInput) {
      if (input.prompt.startsWith('requester'))
        try {
          await (
            input as RuntimeInput & {
              orchestrationTools: { call(name: string, args: unknown): Promise<unknown> };
            }
          ).orchestrationTools.call('work_delegate', {
            goal: 'review this',
            contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: target },
            idempotencyKey: 'handoff',
          });
        } catch (error) {
          failure = error;
        }
      yield* fake.execute(input);
    },
  };
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [adapter],
    tools: { enabled: true, handoffs: true },
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  const waitFor = async (id: string, status: string) => {
    let task = await client.tasks.get(id);
    for (let i = 0; i < 400 && task.status !== status; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      task = await client.tasks.get(id);
    }
    assert.equal(task.status, status);
    return task;
  };
  try {
    assert.deepEqual(client.info.capabilities.workflow, {
      version: 1,
      dependencyResults: true,
      revise: true,
      delegationApproval: true,
      handoffs: true,
      writePath: true,
      runtimeRules: true,
      taskList: true,
      contextCheck: true,
      labels: true,
      taskQueries: true,
      queueReasons: true,
      pauseClose: true,
      ruleRetirement: true,
      usageByTask: true,
      reasoningEfforts: true,
    });
    const agent = await client.tasks.create(spec('agent b'));
    let pending = await waitFor(agent.id, 'waiting_approval');
    let approval = await client.approvals.get(pending.approvalId!);
    await client.approvals.decide(approval.approvalId, {
      choice: 'revise',
      expectedRevision: approval.revision,
      comment: 'Please tighten the summary',
    });
    const revised = await client.approvals.get(approval.approvalId);
    validateWire('ApprovalRequest', revised);
    assert.equal(revised.status, 'revised');
    assert.equal(revised.comment, 'Please tighten the summary');
    pending = await waitFor(agent.id, 'waiting_approval');
    approval = await client.approvals.get(pending.approvalId!);
    await client.approvals.decide(approval.approvalId, {
      choice: 'approve',
      expectedRevision: approval.revision,
    });
    const done = await waitFor(agent.id, 'completed');
    validateWire('TaskSnapshot', done);
    target = done.sessionId;
    const requester = await client.tasks.create(spec('requester'));
    await waitFor(requester.id, 'waiting_approval');
    if (failure) throw failure;
    const page = await client.tasks.list({ limit: 1 });
    validateWire('TaskListResult', page);
    assert.equal(page.tasks[0].id, agent.id);
    assert.equal(typeof page.nextCursor, 'string');
    const listed = await client.handoffs.list({ status: 'pending' });
    validateWire('HandoffListResult', listed);
    const [handoff] = listed.handoffs;
    validateWire('HandoffRequest', await client.handoffs.get(handoff.handoffId));
    const takeover = (await client.tasks.create(
      spec('handed off', {
        parentTaskId: agent.id,
        contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: target },
      }) as never,
    )) as unknown as TaskSnapshot;
    await client.handoffs.resolve(handoff.handoffId, {
      expectedRevision: handoff.revision,
      outcome: 'accepted',
      taskId: takeover.id,
    });
    assert.equal((await client.handoffs.get(handoff.handoffId)).status, 'accepted');
    // Socket clients are not the owner, so runtime rule registration is refused.
    await assert.rejects(client.rules.register(rule), { code: 'UNAUTHORIZED' });
    validateWire('RuleListResult', await client.rules.list());
  } finally {
    await client.close();
    await host.close({ mode: 'interrupt', timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
});

test('0014-X02 the in-process owner registers and lists runtime rules', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-workflow-rules-')));
  await mkdir(join(root, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
  });
  try {
    await orch.rules.register(rule);
    const listed = await orch.rules.list();
    validateWire('RuleListResult', listed);
    assert.deepEqual(
      listed.rules.map((item) => [item.id, item.version, item.source]),
      [['lint', '1', 'runtime']],
    );
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(root, { recursive: true, force: true });
  }
});
