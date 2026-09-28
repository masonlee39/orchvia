import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestDigest } from '../../packages/engine/src/identity.ts';

// SPEC-0021 N: one public name, and protocol identifiers that never change with it.
const root = fileURLToPath(new URL('../../', import.meta.url));
const text = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(text(path)) as Record<string, unknown>;
const PACKAGES: Record<string, string> = {
  engine: 'engine',
  'sdk-typescript': 'sdk',
  'adapter-claude': 'adapter-claude',
  'adapter-codex': 'adapter-codex',
  cli: 'cli',
};

test('0021-N01 packages, command, Python distribution and import use the name orchvia', () => {
  for (const [directory, name] of Object.entries(PACKAGES))
    assert.equal(json(`packages/${directory}/package.json`).name, `@orchvia/${name}`);
  assert.deepEqual(Object.keys(json('packages/cli/package.json').bin as object), ['orchvia']);
  assert.match(text('python/pyproject.toml'), /^name = "orchvia"$/m);
  assert.ok(existsSync(join(root, 'python/src/orchvia/__init__.py')));
  assert.ok(!existsSync(join(root, 'python/src/agent_orch')));
});

test('0021-N02 no current file uses the old package, import or command names', () => {
  const old =
    /@agent-orch\/|\b(?:from|import)\s+agent_orch\b|python\/src\/agent_orch|\bagent-orch (?:host|doctor|submit|run|attach|status|approve|control)\b/;
  const found = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)))
    // Specifications and TDD records are history; the changelog records the rename; the naming
    // tests name the old names on purpose.
    .filter((file) => !/^docs\/(?:specs|tdd)\//.test(file) && file !== 'CHANGELOG.md')
    .filter(
      (file) => !['tests/contract/naming.test.ts', 'python/tests/test_naming.py'].includes(file),
    )
    .filter((file) => !/\.(?:png|jpe?g|gif|ico|pdf|zip|gz|sqlite)$/i.test(file))
    .filter((file) => old.test(text(file)));
  assert.deepEqual(found, []);
});

test('0021-N06 protocol identifiers stay the same after the rename', () => {
  // Stored idempotency digests of existing stores must keep matching retries.
  assert.equal(
    requestDigest('tasks.create', {
      spec: { goal: 'golden', runtime: { provider: 'fake', model: 'fixture' } },
      idempotencyKey: 'golden-key',
    }),
    '1c80623de78828db9bac7c2b57dd9bb31969bdb70f2b2f5627795bf28232dc42',
  );
  assert.equal(json('schemas/protocol.schema.json').$id, 'urn:agent-orch:protocol:2.0');
  // Native histories and host allowlists name tools as mcp__agent_orch__<tool>.
  assert.match(text('packages/adapter-claude/src/mcp.ts'), /name: 'agent_orch'/);
  assert.match(text('packages/adapter-codex/src/index.ts'), /`agent_orch=\{command=/);
  assert.match(text('packages/engine/src/tool-bridge.ts'), /AGENT_ORCH_BRIDGE_TOKEN/);
});
