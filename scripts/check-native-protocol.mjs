/** Exact-version, non-model protocol checks. Never reads login credentials. */
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sdk = process.argv[2] ?? require.resolve('@anthropic-ai/claude-agent-sdk');
const codex = process.argv[3] ?? join(root, 'node_modules/.bin/codex');
const sdkVersion = JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8')).version;
// SPEC-0043 A02: the drift workflow names the versions it installed; CI checks the pinned ones.
const expectedSdk = process.env.ORCH_EXPECT_CLAUDE_SDK || '0.3.283';
const expectedCodex = process.env.ORCH_EXPECT_CODEX || '0.157.1';
assert.equal(
  sdkVersion,
  expectedSdk,
  'Run a separate drift review before changing the supported SDK candidate',
);
const cliVersion = execFileSync(codex, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
assert.equal(cliVersion, `codex-cli ${expectedCodex}`);
const directory = await mkdtemp(join(tmpdir(), 'orch-native-protocol-'));
try {
  execFileSync(codex, ['app-server', 'generate-ts', '--out', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  for (const [name, field] of [
    ['ThreadForkParams', 'lastTurnId'],
    ['ThreadCompactStartParams', 'threadId'],
    ['ThreadReadParams', 'includeTurns'],
  ])
    assert.ok(
      (await readFile(join(directory, 'v2', `${name}.ts`), 'utf8')).includes(field),
      `${name}.${field}`,
    );
  for (const args of [
    ['tests/fixtures/claude-native-mcp-smoke.ts', sdk],
    ['tests/fixtures/native-mcp-engine-smoke.ts', 'claude', sdk],
  ])
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 20000 });
  console.log(
    JSON.stringify({ sdkVersion, cliVersion, modelsInvoked: 0, credentialsInspected: false }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
