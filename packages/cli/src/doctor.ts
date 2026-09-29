import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostConfig } from './config.ts';

const execute = promisify(execFile);
export async function doctor(config: HostConfig) {
  const checks: {
    name: string;
    ok: boolean;
    version?: string;
    tested?: boolean;
    code?: string;
    message?: string;
  }[] = [];
  async function check(name: string, action: () => Promise<string | void>) {
    try {
      const version = await action();
      checks.push({ name, ok: true, ...(version ? { version } : {}) });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        code: 'RUNTIME_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await check('node', async () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major! < 22 || (major === 22 && minor! < 18))
      throw new Error('Node.js 22.18 or newer is required');
    return process.versions.node;
  });
  await check('sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      return String(
        (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
      );
    } finally {
      db.close();
    }
  });
  await check('workspace-readable', () => access(config.workspace, constants.R_OK));
  await check('state-directory-writable', () =>
    access(config.stateDir, constants.R_OK | constants.W_OK),
  );
  for (const [provider, options] of Object.entries(config.providers)) {
    if (provider === 'fake') {
      checks.push({ name: 'fake-explicit', ok: true, version: '1' });
      continue;
    }
    if (provider === 'codex')
      await check('codex-cli', async () => {
        const result = await execute(String(options.command ?? 'codex'), ['--version'], {
          timeout: 3000,
          maxBuffer: 16384,
          encoding: 'utf8',
        });
        const version = result.stdout.trim();
        if (!/^codex-cli \d+\.\d+\.\d+/.test(version))
          throw new Error('Configured command did not identify itself as codex-cli');
        return version;
      });
    // SPEC-0043 A03: whether CI runs this version; reported, never failing the check.
    const codexRow = checks.find((row) => row.name === 'codex-cli' && row.ok && row.version);
    if (provider === 'codex' && codexRow) {
      const modulePath = '../../adapter-codex/src/index.ts';
      const { TESTED_CODEX_VERSIONS } = (await import(modulePath)) as {
        TESTED_CODEX_VERSIONS: readonly string[];
      };
      codexRow.tested = TESTED_CODEX_VERSIONS.includes(/\d+\.\d+\.\d+/.exec(codexRow.version!)![0]);
    }
    if (provider === 'claude')
      await check('claude-sdk', async () => {
        const require = createRequire(
          new URL('../../adapter-claude/src/index.ts', import.meta.url),
        );
        const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
        const manifest = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8'));
        if (typeof manifest.version !== 'string')
          throw new Error('Claude SDK package version is missing');
        return manifest.version;
      });
  }
  return {
    ok: checks.every((row) => row.ok),
    mode: 'offline-preflight',
    workspace: config.workspace,
    stateDir: config.stateDir,
    providers: Object.keys(config.providers),
    checks,
    runtimeAcceptance: 'not_run',
    authentication: 'not_inspected',
    sandboxEnforcement: 'not_verified',
  };
}
