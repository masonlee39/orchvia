import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  createCodexAdapter,
  type CodexAdapterConfig,
} from '../../packages/adapter-codex/src/index.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';

const fixture = fileURLToPath(new URL('../fixtures/codex-policy.ts', import.meta.url));
for (const profile of ['read-only', 'workspace-write'] as const) {
  for (const resume of [false, true]) {
    test(`AC-P04 actual Codex child receives ${profile} and independent network/search: resume=${resume}`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-policy-')));
      const workspace = join(root, 'workspace'),
        stateDir = join(root, 'state');
      await mkdir(workspace);
      await mkdir(stateDir);
      const networkAccess = resume,
        webSearch = resume ? 'disabled' : 'live';
      const config = {
        command: process.execPath,
        args: [fixture],
        permissionProfile: profile,
        networkAccess,
        webSearch,
        observeExecutionStop: () => true,
      };
      const adapter = createCodexAdapter(config as CodexAdapterConfig);
      const evidence: ExecutionEvidence[] = [];
      const observations: RuntimeEvent[] = [];
      const value: RuntimeInput = {
        taskId: 'task',
        sessionId: 'session',
        dispatchId: 'dispatch',
        generation: 1,
        providerSessionId: resume ? 'thread-fixture' : null,
        model: 'offline',
        workspace,
        stateDir,
        prompt: 'fixture',
        permissionProfile: profile,
        signal: new AbortController().signal,
        reportExecutionEvidence: (proof) => evidence.push(proof),
        reportUsage: (event) => observations.push(event),
      };
      try {
        assert.deepEqual(adapter.capabilities().permissionProfiles, [profile]);
        const events: RuntimeEvent[] = [];
        for await (const event of adapter.execute(value)) events.push(event);
        const result = events.at(-1);
        assert.equal(result?.type, 'result');
        if (result?.type !== 'result') throw new Error('Missing fixture result');
        const payload = JSON.parse(result.text);
        assert.equal(payload.thread.method, resume ? 'thread/resume' : 'thread/start');
        assert.equal(payload.thread.sandbox, profile);
        assert.equal(payload.turn.sandboxPolicy.networkAccess, networkAccess);
        assert.equal(
          payload.turn.sandboxPolicy.type,
          profile === 'read-only' ? 'readOnly' : 'workspaceWrite',
        );
        if (profile === 'workspace-write') {
          assert.deepEqual(payload.turn.sandboxPolicy.writableRoots, [workspace]);
          assert.equal(payload.turn.sandboxPolicy.excludeTmpdirEnvVar, true);
          assert.equal(payload.turn.sandboxPolicy.excludeSlashTmp, true);
        }
        assert.ok(payload.args.includes(`web_search="${webSearch}"`));
        assert.ok(payload.args.includes('mcp_servers={}'));
        assert.equal(payload.managedHome, join(stateDir, 'runtime', 'codex'));
        assert.equal(observations.length, 1);
        assert.ok(
          evidence.some(
            (proof) => proof.localResources === 'stopped' && proof.remoteExecution === 'stopped',
          ),
        );
      } finally {
        await adapter.close?.();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('AC-P04 invalid Codex host policy is rejected at construction', () => {
  for (const config of [
    { permissionProfile: 'full-access' },
    { networkAccess: 'true' },
    { webSearch: 'yes' },
    { observeExecutionStop: true },
  ])
    assert.throws(() => createCodexAdapter(config as CodexAdapterConfig), {
      code: 'INVALID_ADAPTER_CONFIG',
    });
});

test('AC-P04 JSON CLI accepts explicit Codex network/search while host callbacks/write stay embedded-only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-policy-json-')));
  const workspace = join(root, 'workspace'),
    stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  const path = join(root, 'config.json');
  const base = {
    workspace,
    stateDir,
    providers: {
      codex: {
        model: 'offline',
        networkAccess: true,
        webSearch: 'cached',
        executionStop: 'owner-reconcile',
      },
    },
  };
  try {
    await writeFile(path, JSON.stringify(base));
    assert.equal((await loadConfig(path)).providers.codex.networkAccess, true);
    for (const extra of [
      { networkAccess: 'true' },
      { webSearch: 'unknown' },
      { observeExecutionStop: true },
      { permissionProfile: 'workspace-write' },
    ]) {
      await writeFile(
        path,
        JSON.stringify({ ...base, providers: { codex: { ...base.providers.codex, ...extra } } }),
      );
      await assert.rejects(loadConfig(path), { code: 'INVALID_CONFIG' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
