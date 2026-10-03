// Offline crash recovery: a host is killed during an accepted dispatch, and a new host on the same
// state directory neither resends nor forgets it. The owner reconciles it after checking.
// Uses the fake runtime: no login, network request or model call.
// node examples/typescript/crash-recovery.ts
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { RuntimeAdapter } from '../../packages/engine/src/types.ts';

/** Opens an engine on `root` whose runtime counts the dispatches it is sent. */
function open(root: string, adapter: RuntimeAdapter) {
  return createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [adapter],
    providers: { fake: { model: 'fake-model' } },
  });
}

if (process.argv[2] === '--host') {
  // The first host: its runtime is accepted and then works for an hour.
  const orch = await open(process.argv[3]!, createFakeAdapter({ delayMs: 3_600_000 }));
  const task = await orch.tasks.create({
    goal: 'Migrate the settings file',
    runtime: { provider: 'fake', model: 'fake-model' },
    acceptance: { mode: 'human', criteria: ['A reviewer read the result'] },
  });
  for await (const event of orch.events({ taskId: task.id })) {
    if (event.type !== 'dispatch.runtime_accepted') continue;
    // The parent kills this process once it reads this line.
    process.stdout.write(JSON.stringify({ taskId: task.id }) + '\n');
    break;
  }
  await new Promise(() => {});
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-crash-')));
await mkdir(join(root, 'workspace'));
await mkdir(join(root, 'state'), { mode: 0o700 });
const host = spawn(process.execPath, [fileURLToPath(import.meta.url), '--host', root], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
try {
  const [line] = (await once(createInterface({ input: host.stdout! }), 'line')) as [string];
  const { taskId } = JSON.parse(line) as { taskId: string };
  const exited = once(host, 'exit');
  host.kill('SIGKILL');
  await exited;
  console.log('1. The host was killed while its runtime worked on the task');

  // The second host counts what it is asked to run.
  const fake = createFakeAdapter();
  let dispatches = 0;
  const orch = await open(root, {
    ...fake,
    async *execute(input) {
      dispatches++;
      yield* fake.execute(input);
    },
  });
  try {
    const task = await orch.tasks.get(taskId);
    const session = await orch.sessions.get(task.sessionId!);
    console.log(`2. After the restart: task ${task.status}, session ${session.status}`);

    // A real owner first checks that the runtime's processes ended and what they changed.
    const operation = await orch.sessions.reconcile(
      {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId!,
        expectedState: session.status,
      },
      {
        source: 'owner_attestation',
        summary: 'The runtime process is gone and the settings file is unchanged',
        localResources: 'stopped',
        remoteExecution: 'stopped',
        sideEffects: 'resolved',
        outcome: 'interrupted',
      },
    );
    await operation.wait({ timeoutMs: 10_000 });
    const after = await orch.tasks.get(taskId);
    const paused = await orch.sessions.get(session.id);
    console.log(`3. Reconciled: task ${after.status} (${after.reason}), session ${paused.status}`);
    console.log(`4. Dispatches sent again: ${dispatches}`);
  } finally {
    await orch.close();
  }
} finally {
  if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
