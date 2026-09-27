import { MUTATIONS } from '../../packages/engine/src/identity.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import type {
  EventPage,
  OperationSnapshot,
  SessionControlTarget,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
const lifecycleCapability = { version: 1, reconcile: 'owner-attestation', durableDeadlines: true };
const spec = {
  goal: 'Offline lifecycle wire fixture',
  runtime: { provider: 'fake', model: 'fake-model' },
  acceptance: { mode: 'human' as const, criteria: ['Check fixture evidence'] },
};
const evidence = {
  source: 'owner_attestation' as const,
  summary: 'The fixture owner checked the original runtime completion and side effects.',
  localResources: 'stopped' as const,
  remoteExecution: 'stopped' as const,
  sideEffects: 'resolved' as const,
  outcome: 'completed' as const,
  result: 'Known late fixture result',
};
const target = (session: SessionSnapshot): SessionControlTarget => ({
  sessionId: session.id,
  expectedGeneration: session.generation,
  expectedRevision: session.revision,
  expectedDispatchId: session.activeDispatchId,
  expectedState: session.status,
});

// SPEC-0023 F01: fixture waits only detect a host that hangs. A host that starts or answers slowly on
// a loaded runner gets 10 s, as the CLI shutdown fixtures do, and a test that starts one gets 60 s.
const HOST_WAIT_MS = 10_000;

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  waitMs = 5000,
): Promise<T> {
  const end = Date.now() + waitMs;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end)
      throw new Error(`Timed out waiting for wire state: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class Wire {
  private output: Writable;
  private sequence = 0;
  private storeId?: string;
  private buffer = '';
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(output: Writable, input: Readable) {
    this.output = output;
    input.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let boundary: number;
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        const frame = JSON.parse(line);
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        if (frame.error)
          waiter.reject(
            Object.assign(new Error(frame.error.message), {
              code: frame.error.data.code,
              data: frame.error.data,
            }),
          );
        else waiter.resolve(frame.result);
      }
    });
  }
  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (MUTATIONS.has(method)) params = { expectedStoreId: this.storeId, ...params };
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No stdio response for ${method}`));
      }, HOST_WAIT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          if (method === 'initialize') this.storeId = (value as any).storeId;
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.output.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

async function stop(proc: ChildProcessWithoutNullStreams) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 1500);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext, mode: 'stdio' | 'unix') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ow-')));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const configPath = join(root, 'config.json'),
    socketPath = join(root, 'host.sock');
  await writeFile(
    configPath,
    JSON.stringify({
      workspace: join(root, 'workspace'),
      stateDir: join(root, 'state'),
      providers: { fake: { model: 'fake-model', delayMs: 450, result: evidence.result } },
      storage: { emergencyBytes: 4096 },
      timeouts: {
        acceptanceMs: 1000,
        turnMs: 3000,
        drainMs: 120,
        interruptMs: 120,
        reconcileMs: 1000,
      },
    }),
  );
  const proc = spawn(
    process.execPath,
    [
      cli,
      'host',
      '--config',
      configPath,
      ...(mode === 'stdio' ? ['--stdio'] : ['--socket', socketPath]),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(proc, 'exit');
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    await stop(proc);
    await rm(root, { recursive: true, force: true });
  });
  if (mode === 'unix')
    await eventually(
      async () => {
        if (proc.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
        return stderr;
      },
      (value) => value.includes('listening on'),
      HOST_WAIT_MS,
    );
  return { proc, socketPath, exited, stderr: () => stderr };
}

async function stdioFixture(t: TestContext) {
  const child = await fixture(t, 'stdio');
  const wire = new Wire(child.proc.stdin, child.proc.stdout);
  const info = await wire.call<{ capabilities: Record<string, unknown> }>('initialize', {
    protocolVersion: '2.0',
    sdkVersion: 'lifecycle-wire-test',
  });
  assert.deepEqual(info.capabilities.lifecycle, lifecycleCapability);
  const task = await wire.call<TaskSnapshot>('tasks.create', { spec, idempotencyKey: 'wire-task' });
  const session = await eventually(
    () => wire.call<SessionSnapshot>('sessions.get', { sessionId: task.sessionId }),
    (value) => value.status === 'running' && value.providerSessionId !== null,
  );
  return { ...child, wire, task, session };
}

test(
  '0003-A real stdio exposes durable deadline and permits owner reconcile without rerunning completed work',
  { timeout: 60_000 },
  async (t) => {
    const f = await stdioFixture(t);
    const operation = await f.wire.call<OperationSnapshot>('sessions.control', {
      target: target(f.session),
      command: { action: 'pause', mode: 'drain' },
      idempotencyKey: 'wire-pause',
    });
    assert.equal(operation.status, 'persisted');
    assert.equal(operation.lifecycle?.kind, 'drain');
    assert.equal(operation.lifecycle?.expectedDispatchId, f.session.activeDispatchId);
    assert.equal(operation.lifecycle?.expectedGeneration, f.session.generation);
    assert.equal(
      Date.parse(operation.lifecycle!.deadlineAt) - Date.parse(operation.lifecycle!.enteredAt),
      120,
    );
    const expired = await eventually(
      () => f.wire.call<OperationSnapshot>('operations.get', { operationId: operation.id }),
      (value) => value.status === 'outcome_unknown',
    );
    assert.equal(expired.lifecycle?.deadlineAt, operation.lifecycle?.deadlineAt);
    assert.ok(expired.lifecycle?.expiredAt);
    await eventually(
      () => f.wire.call<EventPage>('events.read', { taskId: f.task.id, limit: 1000 }),
      (page) => page.events.some((event) => event.type === 'dispatch.late_evidence'),
    );
    const unknown = await f.wire.call<SessionSnapshot>('sessions.get', {
      sessionId: f.task.sessionId,
    });
    assert.equal(unknown.status, 'outcome_unknown');
    const params = { target: target(unknown), evidence, idempotencyKey: 'wire-reconcile' };
    const reconciled = await f.wire.call<OperationSnapshot>('sessions.reconcile', params);
    assert.equal(reconciled.status, 'completed');
    assert.equal(reconciled.lifecycle?.kind, 'reconcile');
    assert.equal(
      (await f.wire.call<OperationSnapshot>('sessions.reconcile', params)).id,
      reconciled.id,
    );
    const original = await f.wire.call<OperationSnapshot>('operations.get', {
      operationId: operation.id,
    });
    assert.equal(original.status, 'outcome_unknown');
    assert.equal(original.resolution?.operationId, reconciled.id);
    assert.equal(
      (await f.wire.call<TaskSnapshot>('tasks.get', { taskId: f.task.id })).status,
      'paused',
    );
    await f.wire.call('tasks.resume', { taskId: f.task.id, idempotencyKey: 'wire-resume' });
    const resumed = await f.wire.call<TaskSnapshot>('tasks.get', { taskId: f.task.id });
    assert.equal(resumed.status, 'waiting_approval');
    assert.equal(resumed.result, evidence.result);
    const events = await f.wire.call<EventPage>('events.read', { taskId: f.task.id, limit: 1000 });
    assert.equal(events.events.filter((event) => event.type === 'dispatch.started').length, 1);
    assert.equal(
      (await f.wire.call<{ status: string }>('host.shutdown', { mode: 'drain', timeoutMs: 1000 }))
        .status,
      'closed',
    );
    await f.exited;
    assert.equal(f.proc.exitCode, 0, f.stderr());
  },
);

test(
  '0003-A real Unix client can inspect lifecycle but cannot attest reconciliation or stop shared host',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, 'unix');
    const client = await connectOrchestrator({ socketPath: f.socketPath });
    t.after(() => client.close());
    assert.deepEqual(client.info.capabilities.lifecycle, lifecycleCapability);
    const task = await client.tasks.create(spec, { idempotencyKey: 'socket-task' });
    const session = await eventually(
      () => client.sessions.get(task.initial.sessionId),
      (value) => value.status === 'running' && value.providerSessionId !== null,
    );
    const operation = await client.sessions.control(target(session), {
      action: 'pause',
      mode: 'drain',
    });
    assert.equal(operation.initial.lifecycle?.expectedDispatchId, session.activeDispatchId);
    const expired = await operation.wait({ timeoutMs: 2000 });
    assert.equal(expired.status, 'outcome_unknown');
    assert.ok(expired.lifecycle?.expiredAt);
    await assert.rejects(
      client.sessions.reconcile(target(await client.sessions.get(session.id)), evidence, {
        idempotencyKey: 'not-owner',
      }),
      { code: 'UNAUTHORIZED' },
    );
    await client.close();
    assert.equal(f.proc.exitCode, null);
    const second = await connectOrchestrator({ socketPath: f.socketPath });
    try {
      assert.equal((await second.tasks.get(task.id)).status, 'blocked');
    } finally {
      await second.close();
    }
  },
);

test(
  '0003-A real owner stdio shutdown remains queryable after timeout and continue closes the same operation',
  { timeout: 60_000 },
  async (t) => {
    const f = await stdioFixture(t);
    let operationId: string | undefined;
    await assert.rejects(
      f.wire.call('host.shutdown', { mode: 'drain', timeoutMs: 0 }),
      (error: unknown) => {
        const failure = error as { code?: string; data?: { operationId?: string } };
        assert.equal(failure.code, 'SHUTDOWN_INCOMPLETE');
        operationId = failure.data?.operationId;
        assert.ok(operationId);
        return true;
      },
    );
    const pending = await f.wire.call<OperationSnapshot>('operations.get', { operationId });
    assert.equal(pending.status, 'persisted');
    assert.equal(pending.lifecycle?.kind, 'shutdown');
    assert.ok(pending.lifecycle?.enteredAt);
    assert.ok(pending.lifecycle?.deadlineAt);
    const result = await f.wire.call<{ status: string; operationId: string }>(
      'host.shutdown.continue',
      {
        operationId,
        mode: 'drain',
        timeoutMs: 2000,
      },
    );
    assert.equal((result as any).status, 'closed');
    assert.equal((result as any).operationId, operationId);
    await f.exited;
    assert.equal(f.proc.exitCode, 0, f.stderr());
  },
);

const codexEofFixture = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.argv[1];
fs.appendFileSync(process.env.FIXTURE_SPAWNS, JSON.stringify({pid:process.pid}) + '\n');
setInterval(() => {}, 1000);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.writeFileSync(process.env.FIXTURE_STAGE, JSON.stringify({pid:process.pid,method:request.method}));
  if(request.method === 'initialize') {
    if(mode === 'initialize') return;
    send({id:request.id,result:{userAgent:'offline-eof-fixture'}});
  } else if(request.method === 'thread/start') {
    send({id:request.id,result:{thread:{id:'eof-thread'}}});
  }
  // turn/start deliberately has no reply; this is submitted work with unknown outcome.
});
`;

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owner EOF exceeded test cleanup deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const stalledAt of ['initialize', 'turn-start']) {
  test(
    `0003-A real owner EOF reaps its Codex ${stalledAt} child, preserves outcome on restart, and leaves another process alive`,
    { timeout: 60_000 },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'oe-')));
      const workspace = join(root, 'workspace'),
        stateDir = join(root, 'state');
      const configPath = join(root, 'config.json'),
        spawnsPath = join(root, 'spawns.jsonl'),
        stagePath = join(root, 'stage.json');
      const hosts: ChildProcessWithoutNullStreams[] = [];
      const bystander = spawn(
        process.execPath,
        ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready\\n');"],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      bystander.stderr.resume();
      const spawnedPids = async (): Promise<number[]> => {
        try {
          return (await readFile(spawnsPath, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line).pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      };
      t.after(async () => {
        try {
          for (const host of hosts) await stop(host);
          for (const pid of await spawnedPids()) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
        } finally {
          await stop(bystander);
          await rm(root, { recursive: true, force: true });
        }
      });
      await within(once(bystander.stdout, 'data'), 2000);
      bystander.stdout.resume();
      await mkdir(workspace);
      await mkdir(stateDir);
      await writeFile(
        configPath,
        JSON.stringify({
          workspace,
          stateDir,
          providers: {
            codex: {
              model: 'offline-fixture',
              command: process.execPath,
              args: ['-e', codexEofFixture, stalledAt],
              env: { FIXTURE_SPAWNS: spawnsPath, FIXTURE_STAGE: stagePath },
              requestTimeoutMs: 10000,
              turnTimeoutMs: 10000,
              closeTimeoutMs: 40,
              executionStop: 'owner-reconcile',
            },
          },
          storage: { emergencyBytes: 4096 },
          timeouts: { acceptanceMs: 10000, turnMs: 20000, interruptMs: 10000 },
        }),
      );
      const startOwner = async () => {
        const proc = spawn(process.execPath, [cli, 'host', '--config', configPath, '--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        hosts.push(proc);
        const exited = once(proc, 'exit');
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const wire = new Wire(proc.stdin, proc.stdout);
        await wire.call('initialize', { protocolVersion: '2.0', sdkVersion: 'owner-eof-fixture' });
        return { proc, wire, exited, stderr: () => stderr };
      };
      const owner = await startOwner();
      const taskSpec = { ...spec, runtime: { provider: 'codex', model: 'offline-fixture' } };
      const task = await owner.wire.call<TaskSnapshot>('tasks.create', {
        spec: taskSpec,
        idempotencyKey: 'eof-task',
      });
      const stage = await eventually(
        async () => {
          try {
            return JSON.parse(await readFile(stagePath, 'utf8')) as { pid: number; method: string };
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
              !(error instanceof SyntaxError)
            )
              throw error;
            return null;
          }
        },
        (value) => value?.method === (stalledAt === 'initialize' ? 'initialize' : 'turn/start'),
      );
      assert.ok(stage);
      const active = await owner.wire.call<SessionSnapshot>('sessions.get', {
        sessionId: task.sessionId,
      });
      assert.ok(active.activeDispatchId);
      const started = performance.now();
      owner.proc.stdin.end();
      await within(owner.exited, 5000);
      assert.ok(
        performance.now() - started < 5000,
        'EOF cleanup must not wait for the 10 second RPC deadline',
      );
      assert.equal(owner.proc.exitCode, 0, owner.stderr());
      assert.doesNotMatch(owner.stderr(), /Owner disconnect cleanup:|SHUTDOWN_INCOMPLETE/);
      assert.throws(() => process.kill(stage.pid, 0), { code: 'ESRCH' });
      assert.equal(bystander.exitCode, null);
      assert.doesNotThrow(() => process.kill(bystander.pid!, 0));

      const restored = await startOwner();
      const snapshot = await restored.wire.call<TaskSnapshot>('tasks.get', { taskId: task.id });
      const session = await restored.wire.call<SessionSnapshot>('sessions.get', {
        sessionId: task.sessionId,
      });
      assert.equal(snapshot.status, stalledAt === 'initialize' ? 'failed' : 'blocked');
      assert.equal(snapshot.result, null);
      assert.equal(snapshot.approvalId, null);
      assert.equal(session.status, stalledAt === 'initialize' ? 'idle' : 'outcome_unknown');
      assert.equal(
        session.activeDispatchId,
        stalledAt === 'initialize' ? null : active.activeDispatchId,
      );
      const replay = await restored.wire.call<TaskSnapshot>('tasks.create', {
        spec: taskSpec,
        idempotencyKey: 'eof-task',
      });
      assert.equal(replay.id, task.id);
      const page = await restored.wire.call<EventPage>('events.read', {
        taskId: task.id,
        limit: 1000,
      });
      assert.equal(page.events.filter((event) => event.type === 'dispatch.started').length, 1);
      assert.equal(page.events.filter((event) => event.type === 'task.completed').length, 0);
      await restored.wire.call('host.shutdown', { mode: 'drain', timeoutMs: 1000 });
      await within(restored.exited, 5000);
      assert.equal(restored.proc.exitCode, 0, restored.stderr());
      assert.deepEqual(
        await spawnedPids(),
        [stage.pid],
        'Restart and idempotent retry must not spawn a replacement runtime',
      );
      assert.equal(bystander.exitCode, null);
    },
  );
}
