import { insidePath, samePath } from './paths.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  renameSync,
  copyFileSync,
} from 'node:fs';
import { join, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { StorageGovernance } from './storage.ts';
import { atomicFile, fileDigest, privateDatabaseFiles, syncDirectory } from './durable-files.ts';
import { createArchive, verifyArchive, archiveArtifact } from './archive.ts';
import { requestDigest, type RetryIdentity } from './identity.ts';
import { fail } from './errors.ts';
import { fields, object, string, integer } from './validation.ts';
import { ruleKey } from './verification.ts';

export interface StoreDirectories {
  controlDir: string;
  storesRoot: string;
  archiveRoot: string;
}
export type RolloverPhase =
  | 'preparing'
  | 'archiving'
  | 'archive_verified'
  | 'new_prepared'
  | 'old_retired'
  | 'committed';
export interface RolloverRecord {
  rolloverId: string;
  oldStoreId: string;
  oldStateDir: string;
  archiveId: string;
  archiveDirectory: string;
  newDirectory: string;
  newStoreId?: string;
  phase: RolloverPhase;
  status: 'pending' | 'completed';
  originalWriterEpoch: string;
  nextWriterEpoch: string;
  retryIdentity: RetryIdentity;
  blockers: { id: string; reason: string }[];
  completedPhases: RolloverPhase[];
  backupId?: string;
}
interface Registration {
  storeId: string;
  stateDir: string;
  role: 'active' | 'retired' | 'standby';
}
interface ArchiveRegistration {
  archiveId: string;
  directory: string;
  manifestDigest: string;
}
interface Manifest {
  version: 1;
  activeStoreId: string | null;
  writerEpoch: string;
  stores: Record<string, Registration>;
  archives: Record<string, ArchiveRegistration>;
  rollovers: Record<string, RolloverRecord>;
  backups: Record<
    string,
    ArchiveRegistration & {
      storeId: string;
      retryIdentity: RetryIdentity;
      status: 'pending' | 'completed';
    }
  >;
}
const phases: RolloverPhase[] = [
  'preparing',
  'archiving',
  'archive_verified',
  'new_prepared',
  'old_retired',
  'committed',
];
const settledTasks = new Set(['completed', 'failed', 'cancelled']);
const settledMessages = new Set(['completed', 'failed', 'expired', 'cancelled']);
function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}
function privateDirectory(path: string, workspace: string): void {
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !outside(workspace, path) ||
    !outside(path, workspace) ||
    // SPEC-0054: the same directory in another spelling overlaps too.
    insidePath(workspace, path) ||
    insidePath(path, workspace)
  )
    fail(
      'INVALID_CONFIG',
      'Store management directories must be canonical absolute paths outside workspace',
    );
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    fail(
      'INVALID_CONFIG',
      'Store management directories must be private and owned by the current user',
    );
}
function managed(root: string, name: string): string {
  if (!/^(store|archive|backup|stage)-[a-f0-9-]{36}$/.test(name))
    fail('UNTRUSTED_PATH', 'Invalid managed directory identity');
  const path = join(root, name);
  if (existsSync(path) && (realpathSync(path) !== path || !lstatSync(path).isDirectory()))
    fail('UNTRUSTED_PATH', 'Managed directory was replaced');
  return path;
}
/** Registered rules in a verified backup; backups taken before SPEC-0014 have no table. */
function storedRules(path: string): unknown[] {
  const db = new DatabaseSync(join(path, 'store.sqlite'), { readOnly: true });
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verification_rules'")
        .get()
    )
      return [];
    return (
      db.prepare('SELECT data FROM verification_rules ORDER BY rowid').all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  } finally {
    db.close();
  }
}
export function storeBlockers(store: Store, now = Date.now()): { id: string; reason: string }[] {
  const result: { id: string; reason: string }[] = [];
  for (const task of store.all<any>('tasks'))
    if (!settledTasks.has(task.status)) result.push({ id: task.id, reason: `task:${task.status}` });
  for (const dispatch of store.all<any>('dispatches'))
    if (
      dispatch.executionLease?.status === 'held' ||
      dispatch.quarantined ||
      dispatch.verificationPending
    )
      result.push({ id: dispatch.id, reason: 'unsettled_execution' });
  for (const conflict of store.all<any>('execution_conflicts'))
    if (conflict.status === 'open') result.push({ id: conflict.id, reason: 'execution_conflict' });
  for (const approval of store.all<any>('approvals'))
    if (approval.status === 'pending')
      result.push({ id: approval.approvalId, reason: 'pending_approval' });
  for (const table of ['messages', 'outbox'] as const)
    for (const message of store.all<any>(table))
      if (!settledMessages.has(message.status))
        result.push({ id: message.id, reason: `unsettled_${table}` });
  for (const op of store.operations())
    if (op.status === 'persisted' || (op.status === 'outcome_unknown' && !op.resolution))
      result.push({ id: op.id, reason: 'unsettled_operation' });
  for (const job of store.all<any>('gc_jobs'))
    if (job.status === 'pending') result.push({ id: job.id, reason: 'unfinished_gc' });
  for (const row of store.db.prepare('SELECT id FROM snapshots WHERE expires_at>?').all(now) as {
    id: string;
  }[])
    result.push({ id: row.id, reason: 'snapshot_lease' });
  return result;
}
export class ControlPlane {
  readonly directories: StoreDirectories;
  readonly workspace: string;
  readonly initialStateDir: string;
  private lock: DatabaseSync;
  private manifest: Manifest;
  private ownedEpoch: string;
  private closed = false;
  private fault?: (point: string) => void;
  /** Throws when registered rules conflict with the host's configuration (SPEC-0014 W04). */
  private checkRules?: (stored: unknown[]) => void;
  constructor(
    workspace: string,
    stateDir: string,
    directories: StoreDirectories,
    fault?: (point: string) => void,
    checkRules?: (stored: unknown[]) => void,
  ) {
    this.workspace = realpathSync(workspace);
    this.initialStateDir = realpathSync(stateDir);
    this.directories = directories;
    this.fault = fault;
    this.checkRules = checkRules;
    fields(object(directories), ['controlDir', 'storesRoot', 'archiveRoot']);
    const paths = Object.values(directories);
    for (const path of paths) privateDirectory(path, this.workspace);
    for (let i = 0; i < paths.length; i++)
      for (let j = i + 1; j < paths.length; j++)
        if (!outside(paths[i], paths[j]) || !outside(paths[j], paths[i]))
          fail('INVALID_CONFIG', 'Store management directories must not overlap');
    this.lock = new DatabaseSync(join(directories.controlDir, 'owner.sqlite'));
    try {
      this.lock.exec(
        'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership(owner TEXT)',
      );
    } catch {
      this.lock.close();
      fail('HOST_ALREADY_RUNNING', 'Another host owns the control directory');
    }
    privateDatabaseFiles(join(directories.controlDir, 'owner.sqlite'));
    try {
      this.manifest = existsSync(this.path())
        ? this.read()
        : {
            version: 1,
            activeStoreId: null,
            writerEpoch: randomUUID(),
            stores: {},
            archives: {},
            rollovers: {},
            backups: {},
          };
      this.ownedEpoch = this.manifest.writerEpoch;
      // The OS lock is the takeover proof. Epochs are never reused by a new owner.
      this.manifest.writerEpoch = randomUUID();
      this.ownedEpoch = this.manifest.writerEpoch;
      this.persist(false);
      const pending = Object.values(this.manifest.rollovers).find(
        (record) => record.status !== 'completed' && record.phase !== 'preparing',
      );
      if (pending) {
        if (pending.phase === 'committed' && this.manifest.activeStoreId === pending.newStoreId)
          pending.nextWriterEpoch = this.ownedEpoch;
        this.advance(pending);
      }
      if (this.manifest.activeStoreId) {
        const active = this.manifest.stores[this.manifest.activeStoreId];
        if (!active || active.role !== 'active')
          fail('STORE_FENCED', 'Manifest has no registered active store');
        this.checkStatePath(active.stateDir);
        const db = new DatabaseSync(join(active.stateDir, 'store.sqlite'), { readOnly: true });
        try {
          if (
            (db.prepare("SELECT value FROM metadata WHERE key='role'").get() as any)?.value ===
            'retired'
          )
            fail('STORE_RETIRED', 'An old manifest cannot revive a retired store');
        } finally {
          db.close();
        }
      }
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }
  private path(): string {
    return join(this.directories.controlDir, 'manifest.json');
  }
  private read(): Manifest {
    if (realpathSync(this.path()) !== this.path() || !lstatSync(this.path()).isFile())
      fail('STORE_FENCED', 'Control manifest is not a regular file');
    const value = JSON.parse(readFileSync(this.path(), 'utf8'));
    if (
      value.version !== 1 ||
      typeof value.writerEpoch !== 'string' ||
      !value.stores ||
      !value.archives ||
      !value.rollovers ||
      !value.backups
    )
      fail('STORE_FENCED', 'Invalid control manifest');
    return value;
  }
  private persist(check = true): void {
    if (check) this.assertOwner();
    atomicFile(this.path(), JSON.stringify(this.manifest));
  }
  assertOwner(): void {
    if (this.closed || this.read().writerEpoch !== this.ownedEpoch)
      fail('STORE_FENCED', 'Writer epoch no longer belongs to this owner');
  }
  private checkStatePath(path: string): void {
    if (
      !samePath(path, this.initialStateDir) &&
      (!path.startsWith(this.directories.storesRoot + sep) ||
        relative(this.directories.storesRoot, path).includes(sep))
    )
      fail('STORE_FENCED', 'Manifest store is outside configured roots');
    if (realpathSync(path) !== path) fail('STORE_FENCED', 'Registered store directory changed');
  }
  get activeStateDir(): string {
    return this.manifest.activeStoreId
      ? this.manifest.stores[this.manifest.activeStoreId].stateDir
      : this.initialStateDir;
  }
  get activeStoreId(): string | null {
    return this.manifest.activeStoreId;
  }
  get hasPendingRollover(): boolean {
    return Object.values(this.manifest.rollovers).some((record) => record.status !== 'completed');
  }
  get switching(): boolean {
    return Object.values(this.manifest.rollovers).some(
      (record) => record.status !== 'completed' && record.phase !== 'preparing',
    );
  }
  fence(stateDir: string): () => void {
    return () => {
      this.assertOwner();
      if (this.activeStateDir !== stateDir)
        fail('STORE_FENCED', 'This directory is not the active store');
    };
  }
  bind(store: Store): void {
    this.assertOwner();
    if (this.manifest.activeStoreId && this.manifest.activeStoreId !== store.storeId)
      fail('STORE_FENCED', 'Active store identity changed');
    store.transaction(() => {
      store.setMetadata('controlDir', this.directories.controlDir);
      store.setMetadata('writerEpoch', this.ownedEpoch);
      if (this.hasPendingRollover) store.setMetadata('admissionStopped', 'true');
    });
    this.manifest.activeStoreId = store.storeId;
    this.manifest.stores[store.storeId] = {
      storeId: store.storeId,
      stateDir: store.stateDir,
      role: 'active',
    };
    this.persist();
  }
  rolloverRecord(id: string): RolloverRecord {
    this.assertOwner();
    const record = this.manifest.rollovers[id];
    if (!record) fail('NOT_FOUND', 'Rollover not found');
    return structuredClone(record);
  }
  archiveId(storeId: string): string | null {
    return this.manifest.archives[storeId]?.archiveId ?? null;
  }
  private retry(raw: Record<string, unknown>, method: string): RetryIdentity {
    const storeId = string(raw.expectedStoreId, 'expectedStoreId', 128),
      idempotencyKey = string(raw.idempotencyKey, 'idempotencyKey', 256),
      hash = requestDigest(method, raw);
    if (raw.requestDigest !== undefined && raw.requestDigest !== hash)
      fail('IDEMPOTENCY_CONFLICT', 'Management payload changed');
    return {
      storeId,
      method,
      scope: 'local',
      idempotencyKey,
      digestVersion: 1,
      requestDigest: hash,
    };
  }
  rollover(
    store: Store,
    raw: Record<string, unknown>,
    runtimeBlockers: { id: string; reason: string }[],
    method = 'stores.rollover',
  ): RolloverRecord {
    fields(
      raw,
      method === 'stores.import'
        ? ['expectedStoreId', 'idempotencyKey', 'requestDigest', 'backupId']
        : ['expectedStoreId', 'idempotencyKey', 'requestDigest'],
    );
    this.assertOwner();
    const identity = this.retry(raw, method);
    let record = Object.values(this.manifest.rollovers).find(
      (record) =>
        record.retryIdentity.storeId === identity.storeId &&
        record.retryIdentity.method === identity.method &&
        record.retryIdentity.idempotencyKey === identity.idempotencyKey,
    );
    if (record) {
      if (record.retryIdentity.requestDigest !== identity.requestDigest)
        fail('IDEMPOTENCY_CONFLICT', 'Rollover identity changed');
      if (record.status === 'completed') return structuredClone(record);
    } else {
      if (identity.storeId !== this.manifest.activeStoreId)
        fail('STORE_NAMESPACE_MISMATCH', 'Management request belongs to another store', {
          expectedStoreId: identity.storeId,
          currentStoreId: this.manifest.activeStoreId,
          archiveId: this.archiveId(identity.storeId),
        });
      if (Object.values(this.manifest.rollovers).some((item) => item.status !== 'completed'))
        fail('ROLLOVER_IN_PROGRESS', 'Continue the original management identity');
      const backupId =
        method === 'stores.import' ? string(raw.backupId, 'backupId', 128) : undefined;
      // Refuse an unusable backup before anything changes (SPEC-0014 W04).
      if (backupId) this.checkRules?.(storedRules(this.backupSource(backupId).path));
      const id = randomUUID();
      record = {
        rolloverId: id,
        oldStoreId: store.storeId,
        oldStateDir: store.stateDir,
        archiveId: randomUUID(),
        archiveDirectory: `archive-${id}`,
        newDirectory: `store-${id}`,
        phase: 'preparing',
        status: 'pending',
        originalWriterEpoch: this.ownedEpoch,
        nextWriterEpoch: randomUUID(),
        retryIdentity: identity,
        blockers: [],
        completedPhases: [],
        ...(backupId ? { backupId, newStoreId: randomUUID() } : {}),
      };
      this.manifest.rollovers[id] = record;
      this.persist();
    }
    if (record.phase === 'preparing') {
      this.fault?.('rollover.preparing.before');
      store.setMetadata('admissionStopped', 'true');
      store.confirmFiles();
      record.blockers = [
        ...storeBlockers(store, store.now()),
        ...runtimeBlockers,
        ...Object.entries(this.manifest.backups)
          .filter(([, backup]) => backup.status === 'pending')
          .map(([id]) => ({ id, reason: 'unfinished_backup' })),
      ];
      this.persist();
      if (record.blockers.length)
        fail('ROLLOVER_BLOCKED', 'Settle every original object before switching', {
          rolloverId: record.rolloverId,
          blockers: record.blockers,
        });
      store.setMetadata('rolloverPrepared', record.rolloverId);
      if (!record.completedPhases.includes('preparing')) record.completedPhases.push('preparing');
      this.persist();
      this.fault?.('rollover.preparing.after');
    }
    this.advance(record, store);
    return structuredClone(record);
  }
  private advance(record: RolloverRecord, supplied?: Store): void {
    let old: Store | undefined = supplied && !supplied.isClosed ? supplied : undefined;
    let owned = false;
    const getOld = () => {
      if (old) return old;
      old = new Store(this.workspace, record.oldStateDir, { fence: () => this.assertOwner() });
      owned = true;
      return old;
    };
    try {
      const start = Math.max(1, phases.indexOf(record.phase));
      for (const phase of phases.slice(start)) {
        if (record.completedPhases.includes(phase)) continue;
        record.phase = phase;
        this.persist();
        this.fault?.(`rollover.${phase}.before`);
        if (phase === 'archiving') {
          const source = getOld();
          if (
            source.metadata('rolloverPrepared') !== record.rolloverId ||
            storeBlockers(source, source.now()).length
          )
            fail('ROLLOVER_BLOCKED', 'Prepared store no longer satisfies settlement prerequisites');
          createArchive(
            source,
            managed(this.directories.archiveRoot, `stage-${record.rolloverId}`),
            record.rolloverId,
          );
        } else if (phase === 'archive_verified') {
          const staging = managed(this.directories.archiveRoot, `stage-${record.rolloverId}`),
            final = managed(this.directories.archiveRoot, record.archiveDirectory);
          if (!existsSync(final)) {
            verifyArchive(staging, { storeId: record.oldStoreId }, true);
            renameSync(staging, final);
            syncDirectory(this.directories.archiveRoot);
          }
          verifyArchive(final, { storeId: record.oldStoreId }, true);
        } else if (phase === 'new_prepared') {
          const path = managed(this.directories.storesRoot, record.newDirectory);
          if (record.backupId) this.prepareImport(path, record);
          const next = new Store(this.workspace, path, {
            allowStandby: true,
            fence: () => this.assertOwner(),
          });
          try {
            const prior = next.metadata('rolloverId');
            if (prior && prior !== record.rolloverId)
              fail('STORE_FENCED', 'Standby store belongs to another rollover');
            // SPEC-0014 W04: a rollover carries registered rules forward; an import keeps the backup's.
            const rules = record.backupId
              ? next.all<{ id: string; version: string }>('verification_rules')
              : getOld().all<{ id: string; version: string }>('verification_rules');
            this.checkRules?.(rules);
            next.transaction(() => {
              next.setMetadata('role', 'standby');
              next.setMetadata('originStoreId', record.oldStoreId);
              next.setMetadata('rolloverId', record.rolloverId);
              next.setMetadata('controlDir', this.directories.controlDir);
              next.setMetadata('writerEpoch', record.nextWriterEpoch);
              next.setMetadata('admissionStopped', 'true');
              if (!record.backupId)
                for (const rule of rules)
                  next.put('verification_rules', ruleKey(rule.id, rule.version), rule);
            });
            record.newStoreId = next.storeId;
            this.manifest.stores[next.storeId] = {
              storeId: next.storeId,
              stateDir: path,
              role: 'standby',
            };
          } finally {
            next.close();
          }
        } else if (phase === 'old_retired') {
          const final = managed(this.directories.archiveRoot, record.archiveDirectory);
          verifyArchive(final, { storeId: record.oldStoreId }, true);
          const nextPath = managed(this.directories.storesRoot, record.newDirectory);
          this.verifyStandby(nextPath, record);
          const probe = new DatabaseSync(join(record.oldStateDir, 'store.sqlite'), {
            readOnly: true,
          });
          let retired: boolean;
          try {
            retired =
              (probe.prepare("SELECT value FROM metadata WHERE key='role'").get() as any)?.value ===
              'retired';
          } finally {
            probe.close();
          }
          if (!retired) {
            const source = getOld();
            source.assertWritable();
            source.db.exec('BEGIN IMMEDIATE');
            try {
              const set = source.db.prepare(
                'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              );
              set.run('role', 'retired');
              set.run('writerEpoch', `retired:${record.rolloverId}`);
              set.run('archiveId', record.archiveId);
              source.db.exec('COMMIT');
            } catch (error) {
              if (source.db.isTransaction) source.db.exec('ROLLBACK');
              throw error;
            }
            source.close();
            old = undefined;
          }
          this.manifest.stores[record.oldStoreId].role = 'retired';
        } else if (phase === 'committed') {
          const final = managed(this.directories.archiveRoot, record.archiveDirectory);
          verifyArchive(final, { storeId: record.oldStoreId }, true);
          const nextPath = managed(this.directories.storesRoot, record.newDirectory);
          this.verifyStandby(nextPath, record);
          this.manifest.archives[record.oldStoreId] = {
            archiveId: record.archiveId,
            directory: record.archiveDirectory,
            manifestDigest: fileDigest(join(final, 'archive.json')),
          };
          this.manifest.activeStoreId = record.newStoreId!;
          this.manifest.stores[record.newStoreId!].role = 'active';
          // Commit the namespace first. An incomplete activation is recoverable from this manifest.
          this.manifest.writerEpoch = record.nextWriterEpoch;
          this.ownedEpoch = record.nextWriterEpoch;
          this.persist(false);
          this.fault?.('rollover.committed.manifest_committed');
          this.activate(nextPath, record);
          record.status = 'completed';
        }
        this.fault?.(`rollover.${phase}.after_action`);
        record.completedPhases.push(phase);
        this.persist();
        this.fault?.(`rollover.${phase}.after`);
      }
    } finally {
      if (owned && old && !old.isClosed) old.close();
    }
  }
  private verifyStandby(path: string, record: RolloverRecord): void {
    const db = new DatabaseSync(join(path, 'store.sqlite'), { readOnly: true });
    try {
      const meta = (key: string) =>
        (db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as any)?.value;
      if (
        (db.prepare('PRAGMA integrity_check').get() as any).integrity_check !== 'ok' ||
        meta('storeId') !== record.newStoreId ||
        meta('rolloverId') !== record.rolloverId ||
        !['standby', 'active'].includes(meta('role')) ||
        (!record.backupId &&
          (db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as any).count !== 0)
      )
        fail('STORE_FENCED', 'Prepared new store failed integrity/identity checks');
    } finally {
      db.close();
    }
  }
  private activate(path: string, record: RolloverRecord): void {
    const next = new Store(this.workspace, path, {
      allowStandby: true,
      fence: () => this.assertOwner(),
    });
    try {
      next.transaction(() => {
        next.setMetadata('role', 'active');
        next.setMetadata('writerEpoch', this.ownedEpoch);
        next.setMetadata('admissionStopped', 'false');
      });
    } finally {
      next.close();
    }
  }
  backup(
    store: Store,
    raw: Record<string, unknown>,
    runtimeBlockers: { id: string; reason: string }[],
  ) {
    fields(raw, ['expectedStoreId', 'idempotencyKey', 'requestDigest']);
    this.assertOwner();
    const identity = this.retry(raw, 'storage.backup');
    let entry = Object.entries(this.manifest.backups).find(
      ([, backup]) =>
        backup.retryIdentity.storeId === identity.storeId &&
        backup.retryIdentity.idempotencyKey === identity.idempotencyKey,
    );
    if (entry && entry[1].retryIdentity.requestDigest !== identity.requestDigest)
      fail('IDEMPOTENCY_CONFLICT', 'Backup payload changed');
    if (entry?.[1].status === 'completed') return { backupId: entry[0], ...entry[1] };
    if (identity.storeId !== store.storeId)
      fail('STORE_NAMESPACE_MISMATCH', 'Backup request belongs to another store');
    if (runtimeBlockers.length || store.activeDispatches().length)
      fail('BACKUP_BLOCKED', 'Managed native history must be quiescent before backup', {
        blockers: runtimeBlockers,
      });
    if (!entry) {
      const id = randomUUID();
      this.manifest.backups[id] = {
        archiveId: id,
        directory: `backup-${id}`,
        manifestDigest: '',
        storeId: store.storeId,
        retryIdentity: identity,
        status: 'pending',
      };
      entry = [id, this.manifest.backups[id]];
      this.persist();
    }
    const [id, backup] = entry,
      final = managed(this.directories.archiveRoot, backup.directory),
      staging = managed(this.directories.archiveRoot, `stage-${id}`);
    if (!existsSync(final)) {
      createArchive(store, staging, id);
      renameSync(staging, final);
      syncDirectory(this.directories.archiveRoot);
    }
    verifyArchive(final, { storeId: backup.storeId }, true);
    backup.manifestDigest = fileDigest(join(final, 'archive.json'));
    backup.status = 'completed';
    this.persist();
    return { backupId: id, ...backup };
  }
  private backupSource(id: string) {
    const backup = this.manifest.backups[id];
    if (!backup || backup.status !== 'completed')
      fail('ARCHIVE_NOT_FOUND', 'A registered completed backup is required');
    const path = managed(this.directories.archiveRoot, backup.directory);
    const manifest = verifyArchive(
      path,
      { storeId: backup.storeId, manifestDigest: backup.manifestDigest },
      true,
    );
    return { backup, path, manifest };
  }
  private prepareImport(path: string, record: RolloverRecord): void {
    const { backup, path: source, manifest } = this.backupSource(record.backupId!);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const marker = join(path, 'import-ready.json');
    if (existsSync(marker)) {
      const saved = JSON.parse(readFileSync(marker, 'utf8'));
      if (saved.rolloverId !== record.rolloverId || saved.newStoreId !== record.newStoreId)
        fail('STORE_FENCED', 'Imported store belongs to another operation');
      return;
    }
    // The unpublished standby copy is reconstructible solely from the verified backup.
    for (const file of manifest.files) {
      const target = join(path, file.path);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      atomicFile(target, readFileSync(join(source, file.path)));
    }
    const db = new DatabaseSync(join(path, 'store.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      const set = db.prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      set.run('storeId', record.newStoreId!);
      set.run('role', 'standby');
      set.run('controlDir', this.directories.controlDir);
      set.run('writerEpoch', record.nextWriterEpoch);
      set.run('rolloverId', record.rolloverId);
      set.run('admissionStopped', 'true');
      set.run('retentionFloorCursor', '0');
      set.run(
        'importProvenance',
        JSON.stringify({
          backupId: record.backupId,
          sourceStoreId: backup.storeId,
          manifestDigest: backup.manifestDigest,
          importedAt: new Date().toISOString(),
        }),
      );
      const unresolved = new Set<string>();
      for (const row of db.prepare('SELECT id,data FROM tasks').all() as {
        id: string;
        data: string;
      }[]) {
        const task = JSON.parse(row.data);
        if (!settledTasks.has(task.status)) {
          task.status = 'blocked';
          task.reason = 'backup_import_requires_reconciliation';
          task.revision++;
          unresolved.add(task.sessionId);
          db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), row.id);
        }
      }
      for (const row of db.prepare('SELECT id,data FROM sessions').all() as {
        id: string;
        data: string;
      }[]) {
        const session = JSON.parse(row.data);
        if (unresolved.has(row.id)) {
          session.status = 'outcome_unknown';
          if (!session.activeDispatchId) {
            // A backup cannot prove actions performed after its capture. Give the owner an
            // exact reconciliation target even when no dispatch existed at capture time.
            const id = randomUUID(),
              enteredAt = new Date().toISOString();
            session.activeDispatchId = id;
            db.prepare('INSERT INTO dispatches(id,data) VALUES (?,?)').run(
              id,
              JSON.stringify({
                id,
                taskId: session.taskId,
                sessionId: session.id,
                generation: session.generation,
                provider: session.provider,
                providerSessionId: session.providerSessionId,
                status: 'outcome_unknown',
                quarantined: true,
                quarantinedAt: enteredAt,
                executionLease: { version: 1, status: 'held', acquiredAt: enteredAt },
                mayHaveBeenSent: true,
                lastEvidence: 'backup_import_unknown',
                writePaths: session.writePaths ?? [],
                messageIds: [],
                importBoundary: true,
              }),
            );
          }
          session.revision++;
          db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), row.id);
        }
      }
      for (const table of ['messages', 'outbox', 'approvals', 'operations', 'handoffs']) {
        // Backups from before SPEC-0014 have no handoffs table.
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          continue;
        for (const row of db.prepare(`SELECT id,data FROM ${table}`).all() as {
          id: string;
          data: string;
        }[]) {
          const value = JSON.parse(row.data);
          if (['approvals', 'handoffs'].includes(table) && value.status === 'pending') {
            value.status = 'invalidated';
            value.revision++;
          } else if (['messages', 'outbox'].includes(table) && !settledMessages.has(value.status))
            value.status = 'outcome_unknown';
          else if (table === 'operations' && value.status === 'persisted') {
            value.status = 'outcome_unknown';
            value.error = {
              code: 'BACKUP_IMPORT',
              message: 'Imported history cannot prove later side effects',
            };
          }
          db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), row.id);
        }
      }
      db.prepare("DELETE FROM metadata WHERE key='referenceIndexVersion'").run();
      // Original cursors remain in the immutable backup; the new namespace starts a fresh log.
      db.exec(
        "DELETE FROM events; DELETE FROM sqlite_sequence WHERE name='events'; DELETE FROM snapshots; DELETE FROM snapshot_items; COMMIT;",
      );
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
    }
    atomicFile(
      marker,
      JSON.stringify({
        rolloverId: record.rolloverId,
        newStoreId: record.newStoreId,
        backupId: record.backupId,
      }),
    );
  }
  archiveLookup(raw: Record<string, unknown>) {
    fields(raw, ['storeId', 'method', 'scope', 'idempotencyKey', 'requestDigest']);
    const storeId = string(raw.storeId, 'storeId', 128),
      registration = this.manifest.archives[storeId];
    if (!registration) fail('ARCHIVE_NOT_FOUND', 'Store is not registered as an archive');
    const path = managed(this.directories.archiveRoot, registration.directory);
    verifyArchive(path, { storeId, manifestDigest: registration.manifestDigest });
    const db = new DatabaseSync(join(path, 'store.sqlite'), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT data,digest FROM operations WHERE method=? AND scope=? AND key=?')
        .get(
          string(raw.method, 'method', 128),
          string(raw.scope, 'scope', 128),
          string(raw.idempotencyKey, 'idempotencyKey', 256),
        ) as { data: string; digest: string } | undefined;
      if (!row) fail('NOT_FOUND', 'No original operation exists in the verified archive');
      const op = JSON.parse(row.data);
      if (
        raw.requestDigest !== undefined &&
        raw.requestDigest !== (op.retryIdentity?.requestDigest ?? row.digest)
      )
        fail('IDEMPOTENCY_CONFLICT', 'Original archived payload differs');
      if (op.historyExpired)
        fail('OPERATION_HISTORY_EXPIRED', 'Archived operation retains only its lifetime identity', {
          operationId: op.id,
          status: op.status,
          targetId: op.targetId,
          result: op.result,
        });
      return op;
    } finally {
      db.close();
    }
  }
  readArchiveArtifact(raw: Record<string, unknown>) {
    fields(raw, ['storeId', 'artifactRef', 'maxBytes']);
    const storeId = string(raw.storeId, 'storeId', 128),
      registration = this.manifest.archives[storeId];
    if (!registration) fail('ARCHIVE_NOT_FOUND', 'Store archive is not registered');
    const path = managed(this.directories.archiveRoot, registration.directory),
      manifest = verifyArchive(path, { storeId, manifestDigest: registration.manifestDigest });
    return {
      storeId,
      artifactRef: raw.artifactRef,
      text: archiveArtifact(
        path,
        manifest,
        string(raw.artifactRef, 'artifactRef'),
        integer(raw.maxBytes ?? 65536, 'maxBytes', 1, 524288),
      ),
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lock.close();
  }
}
