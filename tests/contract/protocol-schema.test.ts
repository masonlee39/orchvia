import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { RuntimeAdapter } from '../../packages/engine/src/types.ts';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { schemaValidator } from '../fixtures/schema-validator.ts';

const document = JSON.parse(
  await readFile(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'),
);
const validate = schemaValidator(document);
const executeFile = promisify(execFile);

test('AC-W06 schema helper rejects invalid additionalProperties values before validating payloads', () => {
  for (const value of ['nope', 'false', null, 0, 1, [], [{}], undefined]) {
    const invalid = { type: 'object', additionalProperties: value };
    for (const [location, schema] of Object.entries({
      root: invalid,
      unused: { $defs: { unused: invalid } },
      property: { properties: { nested: invalid } },
      extra: { additionalProperties: invalid },
    })) {
      assert.throws(
        () => schemaValidator(schema),
        /Unsupported additionalProperties value/,
        `${location}: ${JSON.stringify(value)}`,
      );
    }
  }
});

test('AC-W06 schema helper preserves supported additionalProperties behavior and recursive audit', () => {
  const properties = { known: { type: 'string' } };
  const local = schemaValidator({
    $defs: {
      omitted: { type: 'object', properties },
      open: { type: 'object', properties, additionalProperties: true },
      closed: { type: 'object', properties, additionalProperties: false },
      any: { type: 'object', properties, additionalProperties: {} },
      typed: { type: 'object', properties, additionalProperties: { $ref: '#/$defs/count' } },
      count: { type: 'integer', minimum: 0 },
    },
  });
  for (const name of ['omitted', 'open', 'any']) {
    local(name, { known: 'valid', extra: null, nested: { anything: [1, 'two'] } });
    assert.throws(() => local(name, { known: 1 }), /type string/);
  }
  local('closed', { known: 'valid' });
  assert.throws(() => local('closed', { known: 'valid', extra: 1 }), /additional property extra/);
  local('typed', { known: 'valid', extra: 0 });
  assert.throws(() => local('typed', { extra: '0' }), /type integer/);
  assert.throws(() => local('typed', { extra: -1 }), /minimum/);
  assert.throws(
    () => schemaValidator({ additionalProperties: { minProperties: 1 } }),
    /Unsupported schema keyword/,
  );
});

test('AC-W04 schema helper rejects unsupported assertions and exercises nested/composed constraints', () => {
  assert.throws(
    () => schemaValidator({ $defs: { unused: { minProperties: 1 } } }),
    /Unsupported schema keyword/,
  );
  assert.throws(
    () => schemaValidator({ $defs: { broken: { $ref: '#/$defs/missing' } } }),
    /Unresolved schema reference/,
  );
  validate('EngineLimits', { maxActiveSessions: 1, maxQuarantinedDispatches: 1 });
  // SPEC-0014 C01: owners may configure up to eight active sessions.
  validate('EngineLimits', { maxActiveSessions: 8, maxQuarantinedDispatches: 8 });
  for (const invalid of [
    { maxQuarantinedDispatches: 1 },
    { maxActiveSessions: 2, maxQuarantinedDispatches: 1 },
    { maxActiveSessions: 8, maxQuarantinedDispatches: 7 },
    { maxActiveSessions: 1.5 },
    { maxActiveSessions: 9 },
    { maxActiveSessions: true },
    { unexpected: true },
  ])
    assert.throws(() => validate('EngineLimits', invalid));
  const proof = {
    source: 'owner_attestation',
    summary: 'reviewed',
    localResources: 'stopped',
    remoteExecution: 'stopped',
    sideEffects: 'resolved',
    outcome: 'completed',
    result: '',
  };
  validate('ReconcileEvidence', proof);
  const { result: _result, ...withoutResult } = proof;
  // SPEC-0045 R02: a completed attestation may leave its result to the recorded one.
  validate('ReconcileEvidence', withoutResult);
  assert.throws(() => validate('ReconcileEvidence', { ...proof, outcome: 'recorded' }));
  assert.throws(() => validate('ReconcileEvidence', { ...proof, outcome: 'unknown' }));
  validate('ReconcileEvidence', { ...withoutResult, outcome: 'unknown' });
  const local = schemaValidator({
    $defs: {
      choice: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      emoji: { type: 'string', minLength: 1, maxLength: 1, pattern: '^😀$' },
      list: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } },
    },
  });
  local('choice', 1.5);
  assert.throws(() => local('choice', 1), /oneOf/);
  local('emoji', '😀');
  for (const value of ['', 'aa', 'x']) assert.throws(() => local('emoji', value));
  local('list', [1]);
  for (const value of [[], [1, 2, 3], ['1']]) assert.throws(() => local('list', value));
});

test('0015-Q06 the schema allows seven-day queue waits and a host default', () => {
  const week = 604_800_000;
  for (const value of [0, week]) validate('EngineLimits', { defaultMaxQueueWaitMs: value });
  for (const value of [-1, week + 1, 1.5, '1000'])
    assert.throws(() => validate('EngineLimits', { defaultMaxQueueWaitMs: value }), String(value));
  const plan = { requestedMode: 'fresh', independent: true };
  validate('ContextPlan', { ...plan, maxQueueWaitMs: week });
  assert.throws(() => validate('ContextPlan', { ...plan, maxQueueWaitMs: week + 1 }));
  const routing = {
    policyVersion: 1,
    mode: 'fresh',
    candidateSessionId: 'session',
    expectedGeneration: 1,
    enqueuedAt: '2026-09-21T00:00:00.000Z',
    deadlineAt: '2026-09-28T00:00:00.000Z',
    maxQueueWaitMs: week,
    fallbackModes: [],
    reasonCode: 'ROOT_SESSION',
  };
  validate('RoutingDecision', routing);
  assert.throws(() => validate('RoutingDecision', { ...routing, maxQueueWaitMs: week + 1 }));
});

test(
  'AC-W02/W03/W05 real Unix payloads match schema and Python snapshot views',
  { timeout: 15000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'schema-')));
    const workspace = join(root, 'workspace'),
      stateDir = join(root, 'state');
    await mkdir(workspace);
    const fake = createFakeAdapter({ result: '已核验 fixture 😀' });
    const raw = { input_tokens: 7, inputTokens: 9, nested: { task_id: 'keep provider keys' } };
    const adapter: RuntimeAdapter = {
      ...fake,
      async *execute(input) {
        for await (const event of fake.execute(input)) {
          if (event.type === 'result') {
            yield {
              type: 'usage',
              usageId: 'reported',
              usage: {
                inputTokens: 7,
                cachedInputTokens: 0,
                cacheWriteInputTokens: null,
                outputTokens: 3,
                raw,
              },
            };
            yield {
              type: 'usage',
              usageId: 'unknown',
              usage: {
                inputTokens: null,
                cachedInputTokens: null,
                cacheWriteInputTokens: null,
                outputTokens: null,
                raw: null,
              },
            };
          }
          yield event;
        }
      },
    };
    const engine = await createEngine({ workspace, stateDir, adapters: [adapter] });
    let host: Awaited<ReturnType<typeof startUnixHost>> | undefined;
    let client: Awaited<ReturnType<typeof connectOrchestrator>> | undefined;
    t.after(async () => {
      await client?.close();
      if (host) await host.close({ timeoutMs: 2000 });
      else await engine.close({ timeoutMs: 2000 });
      await rm(root, { recursive: true, force: true });
    });
    const socketPath = join(root, 'host.sock');
    host = await startUnixHost(engine, { socketPath });
    client = await connectOrchestrator({ socketPath });
    const task = await client.tasks.create(
      {
        goal: 'schema fixture',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['check fixed offline output'] },
      },
      { idempotencyKey: 'schema-task' },
    );
    for await (const event of client.events({ taskId: task.id, signal: AbortSignal.timeout(3000) }))
      if (event.type === 'approval.requested') break;
    const waiting = await client.tasks.get(task.id);
    assert.equal(waiting.status, 'waiting_approval');
    const approval = await client.approvals.get(waiting.approvalId!);
    const session = await client.sessions.get(waiting.sessionId);
    // SPEC-0020 K04: a socket client that is not the owner may check context references.
    const refCheck = await client.context.checkRefs([
      { artifactRef: waiting.artifactRefs[0], version: 1 },
      { artifactRef: `sha256:${'f'.repeat(64)}`, version: 1 },
    ]);
    assert.deepEqual(
      refCheck.contextRefs.map((entry) => [
        entry.artifactRef,
        entry.admissible,
        entry.code ?? null,
      ]),
      [
        [waiting.artifactRefs[0], true, null],
        [`sha256:${'f'.repeat(64)}`, false, 'NOT_FOUND'],
      ],
    );
    const workflow = client.info.capabilities.workflow as { contextCheck?: boolean } | undefined;
    assert.equal(workflow?.contextCheck, true);
    await client.sessions.control(
      {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId,
        expectedState: session.status,
      },
      { action: 'pause' },
      { idempotencyKey: 'pause-before-mail' },
    );
    const message = await client.messages.send(
      {
        taskId: task.id,
        toSessionId: session.id,
        expectedGeneration: session.generation,
        kind: 'finding',
        summary: '留给下一轮 😀',
        artifactRefs: waiting.artifactRefs,
      },
      { idempotencyKey: 'schema-message' },
    );
    const operation = await client.approvals.decide(
      approval.approvalId,
      {
        choice: 'approve',
        expectedRevision: approval.revision,
      },
      { idempotencyKey: 'schema-approve' },
    );
    const receipt = await operation.wait({ timeoutMs: 1000 });
    const snapshot = await client.tasks.get(task.id);
    assert.equal(snapshot.status, 'paused', 'mail stays persisted in the paused session');
    const approved = await client.approvals.get(approval.approvalId);
    const usage = await client.usage.get(task.id);
    assert.equal(usage.records.length, 2);
    assert.deepEqual(usage.records[0].raw, raw);
    assert.equal(usage.records[1].raw, null);
    const currentSession = await client.sessions.get(session.id);
    const scheduler = await client.scheduler.get();
    const page = await client.events.read({ taskId: task.id, limit: 256 });
    const samples: Record<string, unknown[]> = {
      TaskSnapshot: [task.initial, waiting, snapshot],
      ApprovalRequest: [approval, approved],
      MessageSnapshot: [message],
      UsageRecord: usage.records,
      UsageRecordedData: page.events
        .filter((event) => event.type === 'usage.recorded')
        .map((event) => event.data),
      OperationSnapshot: [receipt],
      SessionSnapshot: [session, currentSession],
      SchedulerSnapshot: [scheduler],
      EventEnvelope: page.events,
      ContextRefCheck: [refCheck],
      InitializeResult: [client.info],
    };
    for (const [name, values] of Object.entries(samples)) {
      await t.test(`${name} accepts actual host snapshots`, () => {
        assert.ok(values.length > 0);
        for (const value of values) validate(name, value);
      });
    }

    await t.test(
      'AC-W04 corrupted real snapshots are rejected, optional extensions and raw JSON survive',
      () => {
        const corrupt = (name: string, change: (value: Record<string, unknown>) => void) => {
          const value = structuredClone(samples[name][0]) as Record<string, unknown>;
          change(value);
          assert.throws(() => validate(name, value), name);
        };
        for (const [name, key] of [
          ['TaskSnapshot', 'result'],
          ['ApprovalRequest', 'expiresAt'],
          ['MessageSnapshot', 'fromSessionId'],
          ['UsageRecord', 'raw'],
          ['OperationSnapshot', 'error'],
        ])
          corrupt(name, (value) => {
            delete value[key];
          });
        const required: Record<string, string[]> = {
          TaskSnapshot: [
            'id',
            'status',
            'revision',
            'sessionId',
            'spec',
            'artifactRefs',
            'result',
            'reason',
            'approvalId',
            'createdAt',
            'updatedAt',
          ],
          ApprovalRequest: [
            'approvalId',
            'taskId',
            'purpose',
            'revision',
            'status',
            'target',
            'summary',
            'evidenceRefs',
            'expiresAt',
          ],
          MessageSnapshot: [
            'id',
            'fromSessionId',
            'idempotencyKey',
            'status',
            'taskId',
            'toSessionId',
            'expectedGeneration',
            'kind',
            'summary',
          ],
          UsageRecord: [
            'id',
            'taskId',
            'dispatchId',
            'provider',
            'inputTokens',
            'cachedInputTokens',
            'cacheWriteInputTokens',
            'outputTokens',
            'raw',
          ],
          OperationSnapshot: [
            'id',
            'method',
            'scope',
            'idempotencyKey',
            'status',
            'targetId',
            'result',
            'error',
          ],
        };
        for (const [name, keys] of Object.entries(required))
          for (const key of keys)
            corrupt(name, (value) => {
              delete value[key];
            });
        corrupt('TaskSnapshot', (value) => {
          value.revision = 0;
        });
        corrupt('TaskSnapshot', (value) => {
          value.result = 7;
        });
        corrupt('TaskSnapshot', (value) => {
          value.status = 'invented';
        });
        corrupt('TaskSnapshot', (value) => {
          value.artifactRefs = [false];
        });
        corrupt('TaskSnapshot', (value) => {
          const spec = value.spec as Record<string, unknown>;
          spec.runtime = { provider: 'fake', model: null };
        });
        corrupt('ApprovalRequest', (value) => {
          value.purpose = 'automatic';
        });
        corrupt('ApprovalRequest', (value) => {
          value.status = 'completed';
        });
        corrupt('ApprovalRequest', (value) => {
          value.target = { taskId: task.id };
        });
        corrupt('ApprovalRequest', (value) => {
          (value.target as Record<string, unknown>).artifactRefs = [null];
        });
        corrupt('ApprovalRequest', (value) => {
          value.evidenceRefs = [null];
        });
        corrupt('MessageSnapshot', (value) => {
          value.expectedGeneration = 1.5;
        });
        corrupt('MessageSnapshot', (value) => {
          value.kind = 'control';
        });
        corrupt('MessageSnapshot', (value) => {
          value.status = 'queued';
        });
        corrupt('UsageRecord', (value) => {
          value.inputTokens = -1;
        });
        corrupt('UsageRecord', (value) => {
          value.cachedInputTokens = '0';
        });
        corrupt('UsageRecord', (value) => {
          value.outputTokens = 0.5;
        });
        corrupt('UsageRecord', (value) => {
          value.inputTokens = Number.MAX_SAFE_INTEGER + 1;
        });
        corrupt('UsageRecordedData', (value) => {
          value.usageRecordId = '';
        });
        corrupt('UsageRecordedData', (value) => {
          value.dispatchId = 3;
        });
        corrupt('OperationSnapshot', (value) => {
          value.status = 'done';
        });
        corrupt('OperationSnapshot', (value) => {
          value.error = { code: 'TEST' };
        });
        corrupt('OperationSnapshot', (value) => {
          value.lifecycle = { kind: 'reconcile' };
        });
        const checked = (value: Record<string, unknown>) =>
          value.contextRefs as Record<string, unknown>[];
        corrupt('ContextRefCheck', (value) => {
          delete checked(value)[0].admissible;
        });
        corrupt('ContextRefCheck', (value) => {
          checked(value)[1].code = 'SOMETHING_ELSE';
        });
        corrupt('ContextRefCheck', (value) => {
          checked(value)[0].bytes = -1;
        });
        corrupt('ContextRefCheck', (value) => {
          value.contextRefs = [];
        });
        corrupt('ContextRefCheck', (value) => {
          delete value.contextRefs;
        });
        for (const [name, values] of Object.entries(samples))
          if (name !== 'EventEnvelope')
            validate(name, { ...(values[0] as object), futureExtension: { unknown: true } });
        const { artifactRefs: _refs, ...withoutRefs } = message;
        validate('MessageSnapshot', withoutRefs);
        validate('UsageRecord', {
          ...usage.records[0],
          raw: ['provider', null, { custom_key: 1 }],
        });
        validate('OperationSnapshot', {
          ...receipt,
          result: null,
          error: { code: 'KNOWN', message: 'details' },
        });
        assert.throws(() => validate('MessageSpec', message), /additional property/);
      },
    );

    await t.test(
      'AC-W05 Python reads the same stable wire objects and preserves raw keys',
      async () => {
        const { stdout } = await executeFile(
          'python3',
          [
            '-c',
            `
import asyncio, json, sys
from orchvia import Orchestrator
from orchvia.types import Snapshot, to_wire

def export(value):
    if isinstance(value, Snapshot):
        return {next(iter(to_wire({key: None}))): export(item) for key, item in value.items()}
    if isinstance(value, list):
        return [export(item) for item in value]
    return value  # raw result/provider dictionaries retain their keys

async def main():
    async with Orchestrator.connect(socket_path=sys.argv[1]) as orch:
        task = await orch.tasks.get(sys.argv[2])
        approval = await orch.approvals.get(sys.argv[3])
        message = await orch.messages.get(sys.argv[4])
        operation = await orch.operations.get(sys.argv[5])
        usage = await orch.usage.get(task.id)
        exact = await orch.usage.get_record(usage.records[0].id)
        check = await orch.context.check_refs([{'artifact_ref': sys.argv[6], 'version': 1},
                                               {'artifact_ref': 'sha256:' + 'f' * 64, 'version': 1}])
        assert check.context_refs[0]['admissible'] is True and check.context_refs[1]['code'] == 'NOT_FOUND'
        assert exact.as_dict() == usage.records[0].as_dict()
        notifications = []
        async for event in orch.events(task_id=task.id):
            if event.type == 'usage.recorded':
                assert event.data.usage_record_id
                notifications.append(event.data)
            if len(notifications) == 2:
                break
        assert task.session_id == message.to_session_id
        assert task.approval_id == approval.approval_id
        assert approval.target.task_id == task.id and approval.target.task_revision >= 1
        assert message.from_session_id == 'client:local' and message.expected_generation == 1
        assert operation.idempotency_key == 'schema-approve'
        assert operation.result['taskId'] == task.id and 'task_id' not in operation.result
        assert usage.records[0].input_tokens == 7
        assert usage.records[0].cache_write_input_tokens is None
        assert usage.records[1].input_tokens is None
        assert usage.records[0].raw == {'input_tokens': 7, 'inputTokens': 9, 'nested': {'task_id': 'keep provider keys'}}
        print(json.dumps({name: export(value) for name, value in {
            'TaskSnapshot': task, 'ApprovalRequest': approval,
            'MessageSnapshot': message, 'OperationSnapshot': operation,
            'UsageRecord': usage.records,
            'UsageRecordedData': notifications, 'ContextRefCheck': check,
        }.items()}))
asyncio.run(main())
`,
            socketPath,
            task.id,
            approval.approvalId,
            message.id,
            receipt.id,
            waiting.artifactRefs[0],
          ],
          {
            env: { ...process.env, PYTHONPATH: join(process.cwd(), 'python/src') },
            timeout: 5000,
          },
        );
        const actual = JSON.parse(stdout);
        assert.deepEqual(actual, {
          TaskSnapshot: snapshot,
          ApprovalRequest: approved,
          MessageSnapshot: message,
          OperationSnapshot: receipt,
          UsageRecord: usage.records,
          UsageRecordedData: page.events
            .filter((event) => event.type === 'usage.recorded')
            .map((event) => event.data),
          ContextRefCheck: refCheck,
        });
        for (const [name, value] of Object.entries(actual))
          for (const item of ['UsageRecord', 'UsageRecordedData'].includes(name)
            ? (value as unknown[])
            : [value])
            validate(name, item);
      },
    );
  },
);
