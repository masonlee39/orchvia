import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  connectOrchestrator,
  type SessionSnapshot,
  type TaskSnapshot,
} from '../../packages/sdk-typescript/src/index.ts';

const execute = promisify(execFile);
const pauseTarget = (s: SessionSnapshot) => ({
  sessionId: s.id,
  expectedGeneration: s.generation,
  expectedRevision: s.revision,
  expectedDispatchId: s.activeDispatchId,
  expectedState: s.status,
});
async function host(t: TestContext, mode = 'startup') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'i8-')));
  const workspace = join(root, 'ws'),
    stateDir = join(root, 'state'),
    socketPath = join(root, 'host.sock'),
    audit = join(root, 'audit');
  await mkdir(workspace);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../fixtures/claude-interrupt-owner.ts', import.meta.url)),
      workspace,
      stateDir,
      socketPath,
      audit,
      mode,
    ],
    { stdio: 'pipe' },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), 5000);
    createInterface({ input: child.stdout }).once('line', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(stderr));
    });
  });
  const client = await connectOrchestrator({ socketPath });
  t.after(() => client.close());
  const task = await client.tasks.create({
    goal: 'Hold this offline turn',
    runtime: { provider: 'claude', model: 'offline' },
    acceptance: { mode: 'human', criteria: ['Review'] },
  });
  async function waitTask(status: TaskSnapshot['status']) {
    const end = Date.now() + 3000;
    while (true) {
      const snapshot = await client.tasks.get(task.id);
      if (snapshot.status === status) return snapshot;
      assert.ok(Date.now() < end, `Task stuck in ${snapshot.status}, expected ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await waitTask('running');
  // Acceptance of the native session changes the session's revision after the task runs, so a
  // control target is read only once it happened (SPEC-0023 F04). The deadline detects a hang.
  const accepted = Date.now() + 3000;
  while (!(await client.sessions.get(task.initial.sessionId!)).providerSessionId) {
    assert.ok(Date.now() < accepted, 'The native session was not accepted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { client, child, socketPath, task, audit, waitTask };
}

test(
  'AC-I04 TypeScript interrupt pause, message revision and resume keep one native session',
  { timeout: 10000 },
  async (t) => {
    const h = await host(t);
    const initial = await h.client.sessions.get(h.task.initial.sessionId!);
    const pause = await h.client.sessions.control(pauseTarget(initial), {
      action: 'pause',
      mode: 'interrupt',
    });
    assert.equal((await pause.wait({ timeoutMs: 3000 })).status, 'completed');
    await h.waitTask('paused');
    const paused = await h.client.sessions.get(initial.id);
    assert.ok(paused.providerSessionId);
    assert.equal(paused.generation, initial.generation);
    await h.client.messages.send({
      taskId: h.task.id,
      toSessionId: paused.id,
      expectedGeneration: paused.generation,
      kind: 'finding',
      summary: 'Finish after revision',
    });
    const resume = await h.client.tasks.resume(h.task.id);
    assert.equal((await resume.wait({ timeoutMs: 3000 })).status, 'completed');
    await h.waitTask('waiting_approval');
    const final = await h.client.sessions.get(initial.id);
    assert.equal(final.providerSessionId, paused.providerSessionId);
    assert.equal(final.generation, paused.generation);
    const audit = (await readFile(h.audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const prompts = audit.filter((item) => item.kind === 'prompt');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].resume, paused.providerSessionId);
    assert.match(prompts[1].message.message.content, /Finish after revision/);
    assert.notEqual(prompts[0].message.uuid, prompts[1].message.uuid);
    assert.deepEqual(
      audit.filter((item) => item.subtype === 'interrupt').map((item) => item.started),
      [true],
    );
    assert.equal((await h.client.usage.get(h.task.id)).records.length, 2);
  },
);

test(
  'AC-I04 real Python client pauses, resumes and cancels the Claude offline child',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t);
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
        target = dict(session_id=session.id, expected_generation=session.generation, expected_revision=session.revision, expected_dispatch_id=session.active_dispatch_id, expected_state=session.status)
        op = await client.sessions.control(target, dict(action='pause', mode='interrupt'))
        stopped = await op.wait(timeout=5)
        assert stopped.status == 'completed', dict(operation=stopped, task=await client.tasks.get(task.id))
        paused = await client.sessions.get(session.id)
        assert (await client.tasks.get(task.id)).status == 'paused'
        resume = await client.tasks.resume(task.id)
        resumed_op = await resume.wait(timeout=5)
        assert resumed_op.status == 'completed', resumed_op
        for _ in range(300):
            resumed = await client.tasks.get(task.id)
            if resumed.status == 'running': break
            await asyncio.sleep(.01)
        assert resumed.status == 'running', resumed
        cancel = await client.tasks.cancel(task.id)
        cancelled = await cancel.wait(timeout=5)
        assert cancelled.status == 'completed', dict(operation=cancelled, task=await client.tasks.get(task.id))
        assert (await client.tasks.get(task.id)).status == 'cancelled'
        final = await client.sessions.get(session.id)
        assert final.provider_session_id == paused.provider_session_id
        assert len((await client.usage.get(task.id)).records) == 2
        print(json.dumps(dict(status='cancelled', native_session=final.provider_session_id)))
asyncio.run(main())
`,
        h.socketPath,
        h.task.id,
      ],
      {
        timeout: 12000,
        env: {
          ...process.env,
          PYTHONPATH: fileURLToPath(new URL('../../python/src', import.meta.url)),
        },
      },
    );
    assert.equal(JSON.parse(stdout).status, 'cancelled');
    const audit = (await readFile(h.audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(audit.filter((item) => item.kind === 'prompt').length, 2);
    assert.deepEqual(
      audit.filter((item) => item.subtype === 'interrupt').map((item) => item.started),
      [true, true],
    );
  },
);

test(
  'AC-I04 late native terminal releases capacity without completing expired pause or replaying',
  { timeout: 10000 },
  async (t) => {
    const h = await host(t, 'late');
    const session = await h.client.sessions.get(h.task.initial.sessionId!);
    const op = await h.client.sessions.control(pauseTarget(session), {
      action: 'pause',
      mode: 'interrupt',
    });
    assert.equal((await op.wait({ timeoutMs: 3000 })).status, 'outcome_unknown');
    await h.waitTask('blocked');
    assert.equal((await op.get()).status, 'outcome_unknown');
    assert.equal((await h.client.tasks.get(h.task.id)).status, 'blocked');
    const end = Date.now() + 3000;
    let scheduler = await h.client.scheduler.get();
    while (scheduler.executionOccupied !== 0 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler = await h.client.scheduler.get();
    }
    assert.equal(scheduler.executionOccupied, 0);
    assert.equal(scheduler.quarantined, 1);
    const audit = (await readFile(h.audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(audit.filter((item) => item.kind === 'prompt').length, 1);
    assert.equal((await h.client.usage.get(h.task.id)).records.length, 1);
  },
);
