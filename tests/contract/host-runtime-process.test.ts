import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectOrchestrator, type Orchestrator } from '../../packages/sdk-typescript/src/index.ts';

const execute = promisify(execFile);
const ownerScript = fileURLToPath(new URL('../fixtures/host-runtime-owner.ts', import.meta.url));
const example = fileURLToPath(new URL('../../examples/typescript/hosted.ts', import.meta.url));

function start(args: string[]) {
  const child = spawn(process.execPath, [ownerScript, ...args], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const messages: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  return {
    process: child,
    async next() {
      const deadline = performance.now() + 5000;
      while (!messages.length) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Fixture exited: ${stderr}`);
        if (performance.now() >= deadline) throw new Error(`Fixture response timed out: ${stderr}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return messages.shift()!;
    },
  };
}
async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const fallback = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(fallback);
  }
}

test(
  'AC-H08 host process crash preserves unknown ownership for TypeScript and Python without replay',
  { timeout: 20000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'h6-')));
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const socketPath = join(root, 'host.sock');
    await mkdir(workspace);
    const crashed = start(['crash', workspace, stateDir, socketPath]);
    let restarted: ReturnType<typeof start> | undefined;
    let client: Orchestrator | undefined;
    try {
      const original = await crashed.next();
      assert.equal(original.kind, 'dispatch');
      await stop(crashed.process, 'SIGKILL');
      restarted = start(['serve', workspace, stateDir, socketPath]);
      assert.deepEqual(await restarted.next(), { kind: 'ready', submissions: 0 });
      client = await connectOrchestrator({ socketPath });
      const task = await client.tasks.get(original.taskId as string);
      const session = await client.sessions.get(task.sessionId);
      const scheduler = await client.scheduler.get();
      assert.equal(task.status, 'blocked');
      assert.equal(session.status, 'outcome_unknown');
      assert.equal(session.activeDispatchId, original.dispatchId);
      assert.equal(session.providerSessionId, original.nativeId);
      assert.equal(scheduler.executionOccupied, 1);
      assert.equal(scheduler.quarantined, 1);
      await assert.rejects(
        client.sessions.reconcile(
          {
            sessionId: session.id,
            expectedGeneration: session.generation,
            expectedRevision: session.revision,
            expectedDispatchId: session.activeDispatchId,
            expectedState: session.status,
          },
          {
            source: 'owner_attestation',
            summary: 'Socket client cannot attest ownership',
            localResources: 'stopped',
            remoteExecution: 'stopped',
            sideEffects: 'unknown',
            outcome: 'unknown',
          },
        ),
        { code: 'UNAUTHORIZED' },
      );
      const { stdout } = await execute(
        'python3',
        [
          '-c',
          `
import asyncio, json, sys
from orchvia import Orchestrator

async def main():
    async with Orchestrator.connect(socket_path=sys.argv[1]) as client:
        task = await client.tasks.get(sys.argv[2])
        session = await client.sessions.get(task.session_id)
        state = await client.scheduler.get()
        caps = await client.capabilities(provider='offline-host')
        assert caps['executionBudget']['version'] == 2
        assert caps['executionEvidence']['terminalCoversExecution'] is True
        assert caps['hostBoundary'] == {'fixture': True, 'persistentBindings': False}
        print(json.dumps({'taskId': task.id, 'task': task.status, 'session': session.status,
            'dispatchId': session.active_dispatch_id, 'nativeId': session.provider_session_id,
            'executionOccupied': state.execution_occupied, 'quarantined': state.quarantined}))
asyncio.run(main())
`,
          socketPath,
          task.id,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: fileURLToPath(new URL('../../python/src', import.meta.url)),
          },
          timeout: 5000,
        },
      );
      assert.deepEqual(JSON.parse(stdout), {
        taskId: task.id,
        task: 'blocked',
        session: 'outcome_unknown',
        dispatchId: original.dispatchId,
        nativeId: original.nativeId,
        executionOccupied: 1,
        quarantined: 1,
      });
      restarted.process.stdin.write('inspect\n');
      assert.deepEqual(await restarted.next(), { kind: 'inspect', submissions: 0 });
      await client.close();
      client = undefined;
      const exited = once(restarted.process, 'exit');
      restarted.process.stdin.write('close\n');
      assert.equal((await exited)[0], 0);
    } finally {
      await client?.close();
      await stop(crashed.process);
      if (restarted) await stop(restarted.process);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'AC-H09 runnable offline host example completes only after simulated task review',
  { timeout: 70_000 },
  async () => {
    // A watchdog only. The example writes the production 256 MiB emergency reserve (SPEC-0011 R10),
    // and a loaded runner can make that many times slower (SPEC-0023 F05).
    const { stdout } = await execute(process.execPath, [example], { timeout: 60_000 });
    assert.deepEqual(JSON.parse(stdout), {
      runtime: 'offline-host',
      nativeIdWhileQueued: null,
      beforeApproval: 'waiting_approval',
      approval: 'simulated-fixture-review',
      status: 'completed',
      dispatches: 1,
      executionOccupied: 0,
    });
  },
);

test(
  'AC-H06 reusable suite detects a bridge that falsely equates main-turn result with full stop',
  { timeout: 90000 },
  async () => {
    const negative = fileURLToPath(
      new URL('../fixtures/host-contract-negative.ts', import.meta.url),
    );
    const env = { ...process.env };
    // Start a fresh test runner rather than inheriting the parent's node:test worker context.
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(
      execute(process.execPath, ['--test', '--test-name-pattern=AC-H06', negative], {
        // The suite gives a step eight seconds before it says that the bridge is wrong.
        timeout: 60000,
        env,
      }),
      (error) => {
        const failure = error as Error & { code: number; stdout: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stdout, /Runtime contract timed out: background work retention/);
        return true;
      },
    );
  },
);
