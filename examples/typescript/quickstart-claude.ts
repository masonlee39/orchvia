// Quickstart with real Claude: two tasks on one warm Claude Code session.
// Needs Claude Code signed in (`claude auth login`) and makes two small model calls.
// node examples/typescript/quickstart-claude.ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';

const model = process.env.ORCHVIA_MODEL ?? 'claude-sonnet-5';
const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-claude-quickstart-')));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await mkdir(join(root, 'state'), { mode: 0o700 });
await writeFile(
  join(workspace, 'notes.md'),
  '# Team notes\n\n- The release is on Friday.\n- The login page is slow on mobile.\n- Docs need a quickstart.\n',
);
const orch = await createOrchestrator({
  workspace,
  stateDir: join(root, 'state'),
  // The default Claude profile only reads: Read, Glob and Grep inside the workspace.
  adapters: [createClaudeAdapter()],
  providers: { claude: { model } },
  // One team per engine: a new request may reuse any idle agent.
  allowCrossRootReuse: true,
});
type Spec = Parameters<typeof orch.tasks.create>[0];
const acceptance = { mode: 'human' as const, criteria: ['A reviewer read the answer'] };

/** Runs one task to completion. A real host shows the answer to a person; this demo accepts it. */
async function run(spec: Spec) {
  const task = await orch.tasks.create(spec);
  // A failed or blocked task stops settling too, so the demo never waits on it.
  const settled = await task.settle({ onApproval: () => 'approve', timeoutMs: 300_000 });
  return settled.task;
}

try {
  const runtime = { provider: 'claude', model };
  const first = await run({
    goal: 'Read notes.md and list its three topics, one per line.',
    runtime,
    acceptance,
  });
  console.log(`1. ${first.status}, session ${first.sessionId}\n${first.result}`);
  const second = await run({
    goal: 'Of the topics you just listed, which one is the most urgent? Answer in one line.',
    runtime,
    acceptance,
    contextPlan: {
      requestedMode: 'reuse',
      candidateSessionId: first.sessionId!,
      independent: true,
      dependencyTaskIds: [],
      contextRefs: [],
      fallbackModes: [],
      maxQueueWaitMs: 30_000,
    },
  });
  console.log(`2. ${second.status}, session ${second.sessionId}\n${second.result}`);
  console.log(
    `The second task reused the first agent's session: ${second.sessionId === first.sessionId}`,
  );
} finally {
  await orch.close();
  await rm(root, { recursive: true, force: true });
}
