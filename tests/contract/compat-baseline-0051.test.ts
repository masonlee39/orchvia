import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore The script is plain JavaScript without declarations.
import * as compat from '../../scripts/compat-baseline.mjs';

// SPEC-0051 G01 to G03: the public surface as sets of tokens, compared with the committed baseline.
const root = fileURLToPath(new URL('../../', import.meta.url));
const { buildSurface, compareSurface, textSurface, CATEGORIES, TEXTS } = compat as any;
const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const baseline = () => JSON.parse(readFileSync(join(root, 'schemas/compat-baseline.json'), 'utf8'));
const accepted = () =>
  JSON.parse(readFileSync(join(root, 'schemas/compat-accepted.json'), 'utf8')).accepted;

let built: Promise<Record<string, string[]>> | undefined;
const surface = () => (built ??= buildSurface(root));

test('AC-0051-G01 the surface has every category, and each holds what hosts rely on', async () => {
  const s = await surface();
  assert.deepEqual(Object.keys(s).sort(), [...CATEGORIES].sort());
  for (const category of CATEGORIES) {
    assert.ok(s[category].length > 0, `${category} is empty`);
    assert.deepEqual(s[category], [...new Set(s[category])].sort(), `${category} is not sorted`);
  }
  const has = (category: string, ...tokens: string[]) => {
    for (const token of tokens) assert.ok(s[category].includes(token), `${category}: ${token}`);
  };
  has(
    'exports',
    '@orchvia/sdk value createOrchestrator',
    '@orchvia/sdk value openOrchestratorReadOnly',
    '@orchvia/engine type TaskSnapshot',
    '@orchvia/adapter-codex value createCodexAdapter',
    '@orchvia/adapter-codex/hook.mjs',
    'orchvia value Orchestrator',
    'orchvia.routing value Router',
    'orchvia.Orchestrator.tasks.create',
    'orchvia.Orchestrator.sessions.steer',
  );
  has(
    'types',
    '@orchvia/engine TaskSnapshot.status',
    '@orchvia/engine TaskSnapshot.reason',
    '@orchvia/sdk Orchestrator.tasks.create',
    '@orchvia/sdk Orchestrator.sessions.steer',
    '@orchvia/sdk Orchestrator.usage.byTask',
  );
  has(
    'wire',
    'TaskStatus = "waiting_approval"',
    'TaskSnapshot.status!',
    'ApprovalRequest.purpose = "runtime_permission"',
    'WorkflowCapability.steer',
    'EventEnvelope.storeId!',
  );
  has(
    'methods',
    'tasks.create',
    'tasks.getMany',
    'sessions.steer',
    'operations.lookup',
    'events.read',
    'usage.byTask',
  );
  has(
    'events',
    'task.completed',
    'task.waiting_approval',
    'dispatch.late_accepted',
    'approval.requested',
    'handoff.requested',
    'usage.recorded',
    'execution.evidence_rejected',
  );
  has(
    'errors',
    'CURSOR_EXPIRED',
    'STEER_TURN_ENDED',
    'STEER_NOT_STEERABLE',
    'EXECUTION_EVIDENCE_CONFLICT',
    'STORE_TOO_NEW',
    'CODEX_MODEL_UNLISTED',
  );
  has(
    'reasons',
    'dependency_failed',
    'verification_failed',
    'runtime_interrupted',
    'owner_shutdown',
    'reconciled_result',
    'reconciled_*',
    'outcome_unknown: *',
    'SCHEDULING_BLOCKED',
  );
});

test('AC-0051-G01 the committed baseline is of this version and nothing in it is gone', async () => {
  const committed = baseline();
  assert.equal(committed.version, version(), 'regenerate it: node scripts/set-version.mjs');
  const result = compareSurface(committed, await surface(), {
    version: version(),
    accepted: accepted(),
  });
  assert.deepEqual(result.unaccepted, [], 'breaking changes');
  for (const entry of accepted())
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), `${entry.token}: no reason`);
  if (result.added.length)
    console.log(`Added since ${committed.version}:\n${result.added.join('\n')}`);
});

test('AC-0051-G01 the surface is the same each time it is built', async () => {
  assert.deepEqual(await buildSurface(root), await surface());
});

const base = {
  version: '0.1.26',
  surface: {
    wire: ['TaskStatus = "queued"', 'TaskStatus = "paused"', 'ThingParams.a', 'ThingParams.a!'],
    exports: ['orchvia.Orchestrator.tasks.create', 'orchvia.Orchestrator.tasks.create(spec)'],
    types: ['@orchvia/sdk Options.a', '@orchvia/sdk Snapshot.a'],
    errors: ['STEER_TURN_ENDED'],
  },
};
const compare = (surface: Record<string, string[]>, options: Record<string, unknown> = {}) =>
  compareSurface(base, surface, { version: '0.1.26', accepted: [], ...options });

test('AC-0051-G02 a removed token, a narrowed enum and a new required input are breaking', () => {
  const removed = compare({ ...base.surface, errors: [] });
  assert.deepEqual(removed.unaccepted, ['errors: STEER_TURN_ENDED (removed)']);
  const narrowed = compare({ ...base.surface, wire: base.surface.wire.slice(1) });
  assert.deepEqual(narrowed.unaccepted, ['wire: TaskStatus = "queued" (removed)']);
  const required = compare({
    ...base.surface,
    wire: [...base.surface.wire, 'ThingParams.b', 'ThingParams.b!'],
    exports: [...base.surface.exports, 'orchvia.Orchestrator.tasks.create(label)'],
    types: [...base.surface.types, '@orchvia/sdk Options.b'],
  });
  assert.deepEqual(required.unaccepted, [
    'exports: orchvia.Orchestrator.tasks.create(label) (newly required)',
    'types: @orchvia/sdk Options.b (newly required)',
    'wire: ThingParams.b! (newly required)',
  ]);
});

test('AC-0051-G02 additions pass and are named', () => {
  const result = compare({
    ...base.surface,
    wire: [...base.surface.wire, 'TaskStatus = "archived"', 'ThingParams.c', 'NewParams.x!'],
    exports: [...base.surface.exports, 'orchvia.Orchestrator.tasks.create(label=)'],
    types: [...base.surface.types, '@orchvia/sdk Options.c?', '@orchvia/sdk Snapshot.b'],
    errors: [...base.surface.errors, 'STORE_TOO_NEW'],
  });
  assert.deepEqual(result.unaccepted, []);
  assert.deepEqual(result.added, [
    'errors: STORE_TOO_NEW',
    'exports: orchvia.Orchestrator.tasks.create(label=)',
    'types: @orchvia/sdk Options.c?',
    'types: @orchvia/sdk Snapshot.b',
    'wire: NewParams.x!',
    'wire: TaskStatus = "archived"',
    'wire: ThingParams.c',
  ]);
});

test('AC-0051-G02 a breaking change passes only with a higher minor or an acceptance', () => {
  const gone = { ...base.surface, errors: [] };
  assert.equal(compare(gone).ok, false);
  assert.equal(compare(gone, { version: '0.1.27' }).ok, false);
  assert.equal(compare(gone, { version: '0.2.0' }).ok, true);
  assert.equal(compare(gone, { version: '1.0.0' }).ok, true);
  const accepted = [{ category: 'errors', token: 'STEER_TURN_ENDED', reason: 'renamed' }];
  assert.equal(compare(gone, { accepted }).ok, true);
  const other = [{ category: 'wire', token: 'STEER_TURN_ENDED', reason: 'wrong category' }];
  assert.equal(compare(gone, { accepted: other }).ok, false);
});

test('AC-0051-G03 each parsed text is in the surface while its file holds it', async (t) => {
  const texts = (await surface()).texts;
  assert.deepEqual(texts, TEXTS.map(([file, text]: string[]) => `${file}: ${text}`).sort());
  for (const [file, text] of TEXTS as string[][]) {
    const copy = await mkdtemp(join(tmpdir(), 'orch-texts-'));
    t.after(() => rm(copy, { recursive: true, force: true }));
    for (const [other] of TEXTS as string[][])
      await cp(join(root, other), join(copy, other), { force: true });
    const source = await readFile(join(root, file), 'utf8');
    await writeFile(join(copy, file), source.replaceAll(text, 'changed'));
    const without = await textSurface(copy);
    assert.ok(!without.includes(`${file}: ${text}`), `${file}: ${text}`);
    const baseline = { version: '0.1.26', surface: { texts } };
    assert.deepEqual(
      compareSurface(baseline, { texts: without }, { version: '0.1.26', accepted: [] }).unaccepted,
      [`texts: ${file}: ${text} (removed)`],
    );
  }
});
