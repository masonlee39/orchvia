import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0043 A01, A02: the weekly drift preflight and the protocol check's expected versions.

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const SMOKES = [
  'scripts/check-native-protocol.mjs',
  'scripts/native-gateway-smoke.mjs claude',
  'scripts/native-usage-smoke.mjs',
  'scripts/native-stop-smoke.mjs claude',
  'scripts/native-read-fence-smoke.mjs',
  'scripts/native-stop-restart-smoke.mjs',
  'scripts/native-gateway-smoke.mjs codex',
  'scripts/native-stop-smoke.mjs codex',
  'scripts/native-codex-security-smoke.mjs',
  'scripts/native-codex-local-smoke.mjs',
];

test('AC-0043-A01 the drift workflow runs every Monday and on demand, on three runners', () => {
  const workflow = read('.github/workflows/drift.yml');
  assert.match(workflow, /schedule:\n\s+- cron: '0 6 \* \* 1'/);
  assert.match(
    workflow,
    /workflow_dispatch:\n\s+inputs:\n\s+codexVersion:[\s\S]*claudeSdkVersion:/,
  );
  assert.match(workflow, /os: \[ubuntu-24\.04, macos-14, macos-15-intel\]/);
  // It reads the repository and nothing more: no issue, no push.
  assert.match(workflow, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(workflow, /issues: write|git push|gh issue/);
  // Inputs reach the shell through the environment, and must be versions.
  assert.doesNotMatch(workflow, /run:.*\$\{\{\s*inputs\./);
  assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
});

test('AC-0043-A01 every smoke runs, whatever the others do, and the summary fails the run', () => {
  const workflow = read('.github/workflows/drift.yml');
  const steps = workflow.split(/\n\s+- (?=name:|uses:|run:)/);
  const ids: string[] = [];
  for (const smoke of SMOKES) {
    const step = steps.find((text) => text.includes(`node ${smoke}`));
    assert.ok(step, `runs ${smoke}`);
    assert.match(step, /continue-on-error: true/, `${smoke} does not stop the rest`);
    const id = /\bid: (\w+)/.exec(step)?.[1];
    assert.ok(id, `${smoke} has an id`);
    ids.push(id);
  }
  const summary = steps.find((text) => text.startsWith('name: Summary'));
  assert.ok(summary, 'a summary step');
  assert.match(summary, /if: \$\{\{ always\(\) \}\}/);
  for (const id of ids)
    assert.ok(summary.includes(`steps.${id}.outcome`), `the summary reads ${id}`);
  assert.match(summary, /GITHUB_STEP_SUMMARY/);
  assert.match(summary, /exit "\$failed"/);
  // No internet checks: the drift is upstream's, not the network's.
  assert.doesNotMatch(workflow, /ORCH_INTERNET/);
});

test('AC-0043-A02 the protocol check takes its expected versions from the environment', () => {
  const script = read('scripts/check-native-protocol.mjs');
  assert.match(script, /process\.env\.ORCH_EXPECT_CLAUDE_SDK \|\| '0\.3\.283'/);
  assert.match(script, /process\.env\.ORCH_EXPECT_CODEX \|\| '0\.157\.1'/);
  const workflow = read('.github/workflows/drift.yml');
  assert.match(workflow, /ORCH_EXPECT_CODEX: \$\{\{ steps\.versions\.outputs\.codex \}\}/);
});
