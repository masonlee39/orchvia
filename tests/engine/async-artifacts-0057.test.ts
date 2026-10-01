import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../fixtures/engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { Store } from '../../packages/engine/src/store.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0057: artifact files are written off the event loop, before the transaction that registers
// them.

async function dirs(t: any) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-async-artifacts-')));
  await mkdir(join(dir, 'workspace'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { workspace: join(dir, 'workspace'), stateDir: join(dir, 'state') };
}
const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
});
const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) => {
  for (let i = 0; i < 2000; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('AC-0057-W01 a prepared artifact registers without a write, and another text writes', async (t) => {
  const { workspace, stateDir } = await dirs(t);
  const store = new Store(workspace, stateDir);
  t.after(() => store.close());
  const writes: number[] = [];
  store.onFileWritten = (bytes) => writes.push(bytes);
  await store.prepareArtifact('prepared text');
  assert.equal(writes.length, 2, 'the journal and the file');
  const ref = store.transaction(() => store.artifact('prepared text'));
  assert.equal(writes.length, 2, 'registering wrote nothing');
  assert.equal(store.artifactText(ref), 'prepared text');
  store.transaction(() => store.artifact('another text'));
  assert.equal(writes.length, 4, 'a text that was not prepared is written as before');
});

test('AC-0057-W01 a prepared artifact that was never registered is a recovered orphan', async (t) => {
  const { workspace, stateDir } = await dirs(t);
  const first = new Store(workspace, stateDir);
  await first.prepareArtifact('left behind');
  first.close();
  const second = new Store(workspace, stateDir);
  t.after(() => second.close());
  second.confirmFiles();
  const orphans = second
    .all<{ recoveredOrphan?: boolean; sizeBytes: number }>('artifacts')
    .filter((artifact) => artifact.recoveredOrphan);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.sizeBytes, 'left behind'.length);
});

test('AC-0057-W02 a task ends without writing a file inside a transaction', async (t) => {
  const engine: any = await createEngine({ ...(await dirs(t)), adapters: [createFakeAdapter()] });
  t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }));
  const store = engine.store;
  const noted = store.onFileWritten;
  let inTransaction = 0,
    files = 0;
  store.onFileWritten = (bytes: number) => {
    files++;
    if (store.db.isTransaction) inTransaction++;
    noted?.(bytes);
  };
  const task = (await engine.call('tasks.create', {
    spec: spec('work'),
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const done = await until(
    () => engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>,
    (current) => current.status === 'waiting_approval',
    'the task to wait for acceptance',
  );
  // The lease is released in the same pass.
  await until(
    async () => (await engine.call('scheduler.get', {})) as { executionOccupied: number },
    (scheduler) => scheduler.executionOccupied === 0,
    'the lease to be released',
  );
  assert.ok(files >= 6, `the result, the terminal evidence and the release evidence: ${files}`);
  assert.equal(inTransaction, 0, 'file writes inside a transaction');
  assert.equal(store.artifactText(done.artifactRefs![0]!), done.result);
});

/** An engine whose artifact writes wait for `open()`, with a runtime that says when it has ended. */
async function gated(t: any, config: Record<string, unknown> = {}) {
  const fake = createFakeAdapter();
  let ended!: () => void;
  const runtimeEnded = new Promise<void>((resolve) => (ended = resolve));
  const adapter = {
    ...fake,
    async *execute(input: any) {
      for await (const event of fake.execute(input)) {
        // The engine stops reading at the terminal event: say so before it is handed over.
        if (event.type !== 'accepted' && event.type !== 'usage') ended();
        yield event;
      }
    },
  };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-async-artifacts-')));
  await mkdir(join(dir, 'workspace'));
  const paths = { workspace: join(dir, 'workspace'), stateDir: join(dir, 'state') };
  let engine: any = await createEngine({ ...paths, adapters: [adapter as never], ...config });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  engine.store.writePause = () => gate;
  // The engine closes before its directory is removed.
  t.after(async () => {
    open();
    await engine.close({ mode: 'interrupt', timeoutMs: 2000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const task = (await engine.call('tasks.create', {
    spec: spec('work'),
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const get = () => engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>;
  const occupied = async () =>
    ((await engine.call('scheduler.get', {})) as { executionOccupied: number }).executionOccupied;
  return {
    get engine() {
      return engine;
    },
    paths,
    adapter,
    task,
    get,
    occupied,
    open,
    runtimeEnded,
    reopen: async () => (engine = await createEngine({ ...paths, adapters: [adapter as never] })),
  };
}

test('AC-0057-W03 the terminal waits for the evidence reported before it', async (t) => {
  const g = await gated(t);
  await g.runtimeEnded;
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The evidence's file is not written yet: nothing of the turn's end has taken effect.
  assert.equal((await g.get()).status, 'running');
  assert.equal(g.engine.store.all('dispatches')[0].evidenceSequence, undefined);
  g.open();
  const done = await until(g.get, (task) => task.status !== 'running', 'the turn to settle');
  assert.equal(done.status, 'waiting_approval');
  assert.equal(g.engine.store.all('dispatches')[0].evidenceSequence, 1);
  assert.equal(await g.occupied(), 0, 'the stop proof was read after the evidence');
});

test('AC-0057-T01 a deadline that passes while the files are written does not expire the turn', async (t) => {
  const g = await gated(t, { timeouts: { turnMs: 300 } });
  await g.runtimeEnded;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await g.get()).status, 'running', 'no deadline expires during the writes');
  g.open();
  const done = await until(g.get, (task) => task.status !== 'running', 'the turn to settle');
  assert.equal(done.status, 'waiting_approval');
  assert.equal(done.reason, null);
});

test('AC-0057-T01 a close that times out while the files are written waits for them', async (t) => {
  const g = await gated(t);
  await g.runtimeEnded;
  const closing = g.engine.close({ mode: 'interrupt', timeoutMs: 200 });
  let outcome: unknown;
  closing.then(
    (value: unknown) => (outcome = value),
    (error: unknown) => (outcome = error),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    outcome,
    undefined,
    'the close neither failed nor finished while a file was written',
  );
  g.open();
  assert.equal((await closing).status, 'closed');
  const engine = await g.reopen();
  const task = (await engine.call('tasks.get', { taskId: g.task.id })) as TaskSnapshot;
  // The turn's result was kept: the close waited for it instead of leaving it unknown.
  assert.equal(task.status, 'waiting_approval');
});

test('AC-0057-T01 a cancel that arrives while the files are written settles', async (t) => {
  const g = await gated(t);
  await g.runtimeEnded;
  const op = (await g.engine.call('tasks.cancel', {
    taskId: g.task.id,
    idempotencyKey: 'cancel',
  })) as { id: string; status: string };
  g.open();
  const done = await until(g.get, (task) => task.status !== 'running', 'the turn to settle');
  const settled = await until(
    () => g.engine.call('operations.get', { operationId: op.id }) as Promise<{ status: string }>,
    (operation) => operation.status !== 'persisted',
    'the cancel to settle',
  );
  // As a cancel during verification: the cancel wins, and the lease is released.
  assert.equal(done.status, 'cancelled');
  assert.equal(done.reason, 'cancelled_by_client');
  assert.equal(settled.status, 'completed');
  assert.equal(await g.occupied(), 0);
});

// SPEC-0058 E01: evidence reported before the terminal takes effect before the terminal is
// recorded, as it did when it was applied synchronously.
for (const type of ['error', 'result'] as const)
  test(`AC-0058-E01 a dispatch whose turn ended with ${type} keeps terminal_${type} as its last evidence`, async (t) => {
    const base = createFakeAdapter();
    const adapter = {
      ...base,
      async *execute(input: any) {
        const terminal =
          type === 'error'
            ? { type: 'error' as const, message: 'boom', outcome: 'failed' as const }
            : { type: 'result' as const, text: 'done' };
        input.reportExecutionEvidence?.({
          version: 1,
          sequence: 1,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation,
          provider: 'fake',
          providerSessionId: 'native-1',
          source: 'runtime_terminal',
          observedAt: new Date().toISOString(),
          localResources: 'stopped',
          remoteExecution: 'stopped',
          detail: 'fixture',
          terminal,
        });
        yield terminal;
      },
    };
    const engine: any = await createEngine({ ...(await dirs(t)), adapters: [adapter as any] });
    t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }));
    const task = (await engine.call('tasks.create', {
      spec: spec('evidence order'),
      idempotencyKey: type,
    })) as TaskSnapshot;
    await until(
      () => engine.call('tasks.get', { taskId: task.id }) as Promise<TaskSnapshot>,
      (now) => !['queued', 'running'].includes(now.status),
      'the turn to end',
    );
    const [dispatch] = engine.store.all('dispatches') as { lastEvidence: string }[];
    assert.equal(dispatch!.lastEvidence, `terminal_${type}`);
  });
