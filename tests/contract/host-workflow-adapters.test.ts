import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import { createEngine } from '../fixtures/engine.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';
import type {
  EventPage,
  ExecutionEvidence,
  RuntimeEvent,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// One offline native turn: init, one main-thread assistant message and a successful result.
const scripted = () =>
  withClaudeProcess(() =>
    (async function* () {
      const session_id = `native-${crypto.randomUUID()}`;
      yield { type: 'system', subtype: 'init', session_id };
      yield {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        session_id,
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      };
      yield { type: 'result', subtype: 'success', session_id, result: 'done' };
    })(),
  );

test('0014-P01 adapters use a configured provider name everywhere', async () => {
  assert.equal(createClaudeAdapter().provider, 'claude');
  assert.equal(createCodexAdapter({ executionStop: 'owner-reconcile' }).provider, 'codex');
  const claude = createClaudeAdapter({ provider: 'claude-write', query: scripted() });
  assert.equal(claude.provider, 'claude-write');
  assert.equal(claude.capabilities().provider, 'claude-write');
  const codex = createCodexAdapter({ executionStop: 'owner-reconcile', provider: 'codex.b' });
  assert.equal(codex.provider, 'codex.b');
  assert.equal(codex.capabilities().provider, 'codex.b');
  for (const provider of ['', ' claude', '-claude', 'claude write', 'x'.repeat(129), 7])
    for (const create of [createClaudeAdapter, createCodexAdapter])
      assert.throws(() => create({ provider } as never), { code: 'INVALID_ADAPTER_CONFIG' });
  const evidence: ExecutionEvidence[] = [];
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of claude.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'offline',
      workspace: process.cwd(),
      stateDir: '/private/tmp/unused-provider-name-state',
      prompt: 'fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      reportExecutionEvidence: (item) => evidence.push(item),
    }))
      events.push(event);
  } finally {
    await claude.close();
  }
  assert.equal(events.at(-1)?.type, 'result');
  assert.ok(evidence.length > 0);
  assert.deepEqual([...new Set(evidence.map((item) => item.provider))], ['claude-write']);
});

test('0014-P02 one engine runs two named Claude adapters and releases both leases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-provider-names-'));
  await mkdir(join(dir, 'workspace'));
  await assert.rejects(
    createEngine({
      workspace: join(dir, 'workspace'),
      stateDir: join(dir, 'duplicate'),
      adapters: [
        createClaudeAdapter({ provider: 'claude-read' }),
        createClaudeAdapter({ provider: 'claude-read' }),
      ],
    }),
    { code: 'VALIDATION_ERROR' },
  );
  const adapters = [
    createClaudeAdapter({ provider: 'claude-read', query: scripted() }),
    createClaudeAdapter({ provider: 'claude-second', query: scripted() }),
  ];
  const engine = await createEngine({
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters,
    providers: { 'claude-read': { model: 'm' }, 'claude-second': { model: 'm' } },
  });
  try {
    for (const provider of ['claude-read', 'claude-second']) {
      const task = (await engine.call('tasks.create', {
        spec: {
          goal: `Task on ${provider}`,
          runtime: { provider, model: 'm' },
          acceptance: { mode: 'human', criteria: ['review'] },
        },
        idempotencyKey: provider,
      })) as TaskSnapshot;
      let current = task;
      for (let i = 0; i < 400 && current.status !== 'waiting_approval'; i++) {
        assert.ok(!['blocked', 'failed'].includes(current.status), JSON.stringify(current));
        await new Promise((resolve) => setTimeout(resolve, 5));
        current = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
      }
      assert.equal(current.status, 'waiting_approval', JSON.stringify(current));
      let types: string[] = [];
      for (let i = 0; i < 400 && !types.includes('execution.released'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const page = (await engine.call('events.read', {
          taskId: task.id,
          limit: 1000,
        })) as EventPage;
        types = page.events.map((event) => event.type);
      }
      assert.ok(types.includes('execution.released'), `${provider}: ${types}`);
      assert.ok(!types.includes('execution.evidence_rejected'), `${provider}: ${types}`);
    }
    const scheduler = (await engine.call('scheduler.get')) as { executionOccupied: number };
    assert.equal(scheduler.executionOccupied, 0);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 2000 });
    for (const adapter of adapters) await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

type Hook = (
  input: Record<string, unknown>,
  id: string,
  context: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
type Captured = Record<string, unknown> & {
  hooks: { PreToolUse: { hooks: Hook[] }[] };
  sandbox?: { filesystem: { denyRead: string[]; allowRead?: string[] } };
};

/** Runs one offline dispatch and returns the native options plus a guard probe. */
async function guardOf(
  config: Record<string, unknown>,
  profile: 'read-only' | 'workspace-write' = 'read-only',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-read-fence-')));
  const workspace = join(root, 'workspace'),
    stateDir = join(root, 'state'),
    outside = join(root, 'outside'),
    extra = join(root, 'extra');
  for (const dir of [workspace, stateDir, outside, extra, join(workspace, 'secrets')])
    await mkdir(dir, { recursive: true });
  await symlink(outside, join(workspace, 'outside-link'));
  let captured!: Captured;
  const events: RuntimeEvent[] = [];
  const adapter = createClaudeAdapter({
    permissionProfile: profile,
    // The read fence is what these cases check; leases are the owner's (SPEC-0027 A02).
    executionStop: 'owner-reconcile',
    ...config,
    ...(config.readRoots === 'extra' ? { readRoots: [extra] } : {}),
    query: withClaudeProcess((request) => {
      captured = request.options as unknown as Captured;
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 'native', result: 'ok' };
      })();
    }),
  } as never);
  try {
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      generation: 1,
      providerSessionId: null,
      model: 'offline',
      workspace,
      stateDir,
      prompt: 'fixture',
      permissionProfile: profile,
      signal: new AbortController().signal,
    }))
      events.push(event);
  } finally {
    await adapter.close();
  }
  const denied = async (tool_name: string, tool_input: Record<string, unknown>) =>
    (
      await Promise.all(
        captured.hooks.PreToolUse.flatMap((matcher) => matcher.hooks).map((hook) =>
          hook({ tool_name, tool_input }, 'call', { signal: new AbortController().signal }),
        ),
      )
    ).some(
      (result) =>
        (result.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision ===
        'deny',
    );
  return { root, workspace, stateDir, outside, extra, captured, denied, adapter, events };
}

test('0014-F01 the default read fence keeps Read, Glob and Grep inside readable roots', async () => {
  const g = await guardOf({ readRoots: 'extra', denyRead: ['secrets'] });
  try {
    const read = (file_path: string) => g.denied('Read', { file_path });
    assert.equal(await read(join(g.workspace, 'notes.txt')), false);
    assert.equal(await read(join(g.extra, 'shared.txt')), false);
    assert.equal(await read(join(g.outside, 'secret.txt')), true);
    assert.equal(await read(join(g.workspace, 'outside-link', 'secret.txt')), true);
    assert.equal(await read(join(g.workspace, 'secrets', 'key')), true);
    assert.equal(await read(join(g.stateDir, 'store.sqlite')), true);
    assert.equal(await read('/etc/hosts'), true);
    assert.equal(await g.denied('Grep', { pattern: 'x', path: g.outside }), true);
    assert.equal(await g.denied('Grep', { pattern: 'x', path: g.root }), true);
    assert.equal(await g.denied('Grep', { pattern: 'x', path: join(g.workspace, 'src') }), false);
    assert.equal(await g.denied('Glob', { pattern: '*.ts', path: g.extra }), false);
    assert.equal(await g.denied('Glob', { pattern: '*.ts', path: g.outside }), true);
    assert.equal(g.adapter.capabilities().readFence, true);
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
  const open = await guardOf({ readFence: false });
  try {
    assert.equal(await open.denied('Read', { file_path: join(open.outside, 'secret.txt') }), false);
    assert.equal(await open.denied('Read', { file_path: join(open.stateDir, 'x') }), true);
    assert.equal(open.adapter.capabilities().readFence, false);
  } finally {
    await rm(open.root, { recursive: true, force: true });
  }
});

test('0014-F02 read fence configuration is validated and declared', async () => {
  for (const config of [
    { readRoots: ['relative/path'] },
    { readRoots: ['/definitely/missing/orch-root'] },
    { readRoots: '/tmp' },
    { denyRead: [7] },
    { readFence: 'yes' },
  ])
    assert.throws(() => createClaudeAdapter(config as never), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
  assert.equal(createClaudeAdapter().capabilities().readFence, true);
  assert.equal(
    createCodexAdapter({ executionStop: 'owner-reconcile' }).capabilities().readFence,
    false,
  );
});

test('0014-F03 the writable sandbox denies home reads except the workspace and read roots', async () => {
  const g = await guardOf({ readRoots: 'extra', denyRead: ['secrets'] }, 'workspace-write');
  try {
    const filesystem = g.captured.sandbox!.filesystem;
    for (const path of [await realpath(homedir()), g.stateDir, join(g.workspace, 'secrets')])
      assert.ok(filesystem.denyRead.includes(path), `${path} in ${filesystem.denyRead}`);
    assert.deepEqual(filesystem.allowRead, [g.workspace, g.extra]);
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
  const open = await guardOf({ readFence: false }, 'workspace-write');
  try {
    const filesystem = open.captured.sandbox!.filesystem;
    assert.deepEqual(filesystem.denyRead, [open.stateDir]);
    assert.equal(filesystem.allowRead, undefined);
  } finally {
    await rm(open.root, { recursive: true, force: true });
  }
  // A host allowRead that would re-open private state stops the dispatch before any native call.
  const reopened = await guardOf(
    { options: { sandbox: { filesystem: { allowRead: ['..'] } } } },
    'workspace-write',
  );
  try {
    assert.equal(reopened.captured, undefined);
    assert.equal(reopened.events.at(-1)?.type, 'error', JSON.stringify(reopened.events));
  } finally {
    await rm(reopened.root, { recursive: true, force: true });
  }
});
