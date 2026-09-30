import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { Store } from '../../packages/engine/src/store.ts';
import { VERSION } from '../../packages/engine/src/version.ts';
import { openOrchestratorReadOnly } from '../../packages/sdk-typescript/src/index.ts';

// SPEC-0051 R02: a store records the data features an older engine cannot read, and an engine
// refuses a store with a feature it does not know.

async function store(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-features-'));
  await mkdir(join(dir, 'workspace'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter()],
  };
  const engine = await createEngine(config);
  await engine.close();
  const meta = (key: string) => {
    const db = new DatabaseSync(join(dir, 'state', 'store.sqlite'), { readOnly: true });
    try {
      return (
        db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
          | { value: string }
          | undefined
      )?.value;
    } finally {
      db.close();
    }
  };
  const set = (key: string, value: string) => {
    const db = new DatabaseSync(join(dir, 'state', 'store.sqlite'));
    try {
      db.prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, value);
    } finally {
      db.close();
    }
  };
  return { config, meta, set, stateDir: join(dir, 'state'), workspace: join(dir, 'workspace') };
}

const future = [{ name: 'from-the-future', engineVersion: '9.9.9' }];

test('AC-0051-R02 an engine records its version when it opens a store', async (t) => {
  const s = await store(t);
  assert.equal(s.meta('lastEngineVersion'), VERSION);
});

test('AC-0051-R02 a store with an unknown feature is refused before anything changes', async (t) => {
  const s = await store(t);
  s.set('storeFeatures', JSON.stringify(future));
  s.set('lastEngineVersion', '9.9.9');
  const refusal = {
    code: 'STORE_TOO_NEW',
    details: { features: future },
  };
  await assert.rejects(createEngine(s.config), refusal);
  await assert.rejects(openOrchestratorReadOnly({ stateDir: s.stateDir }), refusal);
  // Refused before recovery or any write: the newer engine's marks are untouched.
  assert.equal(s.meta('lastEngineVersion'), '9.9.9');
});

test('AC-0051-R02 a known feature is recorded once, in the transaction that needs it', async (t) => {
  const s = await store(t);
  const opened = new Store(s.workspace, s.stateDir, { knownFeatures: ['kept-data'] });
  try {
    assert.throws(() => opened.recordFeature('kept-data'), /transaction/);
    opened.transaction(() => opened.recordFeature('kept-data'));
    opened.transaction(() => opened.recordFeature('kept-data'));
    assert.throws(
      () => opened.transaction(() => opened.recordFeature('never-declared')),
      /not a known store feature/,
    );
  } finally {
    opened.close();
  }
  assert.deepEqual(JSON.parse(s.meta('storeFeatures')!), [
    { name: 'kept-data', engineVersion: VERSION },
  ]);
  // An engine that knows the feature opens the store; the default engine, which does not, refuses.
  await assert.rejects(createEngine(s.config), { code: 'STORE_TOO_NEW' });
});
