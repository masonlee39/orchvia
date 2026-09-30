import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0051 B01: npm installs the `orchvia` command as a symbolic link to the CLI's entry, and a
// host started through that link must run.
const main = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));

test('AC-0051-B01 the CLI runs when started through a symbolic link, as npm installs it', async (t) => {
  const bin = await mkdtemp(join(tmpdir(), 'orch-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await symlink(main, join(bin, 'orchvia'));
  const run = spawnSync(
    process.execPath,
    [join(bin, 'orchvia'), 'doctor', '--config', '/nonexistent/orchestrator.json'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /"code":"INVALID_CONFIG"/);
});
