import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeOptions } from '../../packages/adapter-claude/src/options.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';
import type { RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0054: a workspace registered in another case than the one on disk, on a case-insensitive
// volume (macOS by default): paths inside it must not be refused as outside it.

async function volume(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orch-case-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'Project-x', 'WS'), { recursive: true });
  await mkdir(join(base, 'state'));
  return { base, insensitive: existsSync(join(base, 'project-x', 'ws')) };
}

test('AC-0054-A01 a Claude write inside a workspace registered in another case is allowed', async (t) => {
  const { base, insensitive } = await volume(t);
  if (!insensitive) return t.skip('the volume is case-sensitive');
  const registered = join(base, 'project-x', 'WS');
  const options = buildClaudeOptions(
    {
      taskId: 't',
      sessionId: 's',
      dispatchId: 'd',
      providerSessionId: null,
      model: 'm',
      workspace: registered,
      stateDir: join(base, 'state'),
      prompt: 'p',
      permissionProfile: 'workspace-write',
      writePaths: [registered],
      signal: new AbortController().signal,
    } as RuntimeInput,
    {},
    {} as never,
  ) as any;
  const guard = options.hooks.PreToolUse[0].hooks[0];
  const decide = async (tool: string, file: string) =>
    (
      await guard({
        tool_name: tool,
        tool_input: tool === 'Glob' ? { path: file, pattern: '*.md' } : { file_path: file },
      })
    )?.hookSpecificOutput?.permissionDecision ?? 'allow';
  // The case on disk, as Claude's working directory and the model name it.
  assert.equal(await decide('Write', join(base, 'Project-x', 'WS', 'a.md')), 'allow');
  assert.equal(await decide('Edit', join(base, 'Project-x', 'WS', 'a.md')), 'allow');
  assert.equal(await decide('Read', join(base, 'Project-x', 'WS', 'a.md')), 'allow');
  assert.equal(await decide('Glob', join(base, 'Project-x', 'WS')), 'allow');
  // The case the host registered.
  assert.equal(await decide('Write', join(base, 'project-x', 'WS', 'a.md')), 'allow');
  // Still refused: outside the workspace.
  assert.equal(await decide('Write', join(base, 'Project-x', 'other.md')), 'deny');
});

test('AC-0054-A02 a Codex file change inside a workspace registered in another case is approved', async (t) => {
  const { base, insensitive } = await volume(t);
  if (!insensitive) return t.skip('the volume is case-sensitive');
  const registered = join(base, 'project-x', 'WS');
  const adapter = createCodexAdapter({
    executionStop: 'owner-reconcile',
    permissionProfile: 'workspace-write',
    command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/codex-file-change.ts', import.meta.url))],
    env: {
      // Codex names the file as the volume does.
      FIXTURE_CHANGES: JSON.stringify([
        { path: join(base, 'Project-x', 'WS', 'a.md'), kind: { type: 'add' }, diff: '+x\n' },
      ]),
    },
  });
  t.after(() => adapter.close?.());
  let decision: string | undefined;
  let asked = 0;
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    workspace: registered,
    stateDir: join(base, 'state'),
    model: 'offline',
    prompt: 'change a file',
    permissionProfile: 'workspace-write',
    writePaths: [registered],
    signal: new AbortController().signal,
    async requestPermission() {
      asked++;
      return true;
    },
  }))
    if (event.type === 'result') decision = event.text;
  assert.equal(asked, 1, 'the host was asked');
  assert.equal(decision, 'accept');
});
