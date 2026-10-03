import { completeMigrationBackup } from './archive.ts';
import { lstat, readFile, realpath } from 'node:fs/promises';
import {
  atomicFile,
  atomicFileAsync,
  privateDatabaseFiles,
  syncDirectory,
} from './durable-files.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  realpathSync,
  chmodSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { isAbsolute, relative, join, sep, dirname, basename, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from './errors.ts';
import { VERSION } from './version.ts';
import { samePath } from './paths.ts';
import type {
  EventEnvelope,
  EventPage,
  HandoffRequest,
  Json,
  OperationSnapshot,
  TaskSnapshot,
  UsageRecord,
} from './types.ts';

const TABLES = [
  'tasks',
  'sessions',
  'messages',
  'outbox',
  'approvals',
  'dispatches',
  'artifacts',
  'usage',
  'execution_conflicts',
  'tool_calls',
  'tool_loops',
  'costs',
  'budget_reservations',
  'storage_pins',
  'gc_jobs',
  'file_commits',
  'storage_reserves',
  'verification_rules',
  'handoffs',
] as const;
export type Table = (typeof TABLES)[number];

function isOutside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

// Resolve an existing ancestor before mkdir, including /tmp aliases and symlinks.
function futureRealpath(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

export interface StoreOptions {
  now?: () => number;
  fault?: (point: string) => void;
  fence?: () => void;
  allowStandby?: boolean;
  /** Test seam: the features this store may record and open (SPEC-0051 R02). */
  knownFeatures?: readonly string[];
}

/**
 * SPEC-0051 R02: the data features this engine can read. A store records a feature when it first
 * holds data an engine without it would read wrongly; an engine refuses a store with a feature it
 * does not know. `hostTasks`: tasks without a session (SPEC-0065 R01).
 */
export const STORE_FEATURES: readonly string[] = Object.freeze(['hostTasks']);

/** Refuses a store that recorded a feature this engine does not know (SPEC-0051 R02). */
function checkFeatures(recorded: string | undefined, known: readonly string[]): void {
  if (!recorded) return;
  let features: { name?: unknown; engineVersion?: unknown }[];
  try {
    features = JSON.parse(recorded);
    if (!Array.isArray(features)) throw new Error('not a list');
  } catch {
    return fail('STORE_TOO_NEW', 'The store records features this engine cannot read', {
      features: [],
      unreadable: recorded.slice(0, 4096),
    });
  }
  const unknown = features.filter((feature) => !known.includes(String(feature?.name)));
  if (unknown.length)
    fail(
      'STORE_TOO_NEW',
      `The store holds data of a newer engine: ${unknown
        .map((feature) => `${feature.name} (written by ${feature.engineVersion})`)
        .join(', ')}`,
      { features: unknown },
    );
}

/**
 * Opens `stateDir/store.sqlite` for reading only: no lock, no directory, table, index, metadata or
 * migration. SQLite may create or update the WAL index `store.sqlite-shm`, and create an empty
 * `store.sqlite-wal`, to read a store in WAL mode; no other file changes (SPEC-0027 R01, R02, R07).
 */
function openForReading(stateDir: string) {
  if (!isAbsolute(stateDir)) fail('VALIDATION_ERROR', 'stateDir must be absolute');
  let directory: string;
  try {
    directory = realpathSync(stateDir);
  } catch {
    return fail('NOT_FOUND', 'The state directory does not exist', { stateDir });
  }
  if (!lstatSync(directory).isDirectory())
    fail('NOT_FOUND', 'The state directory does not exist', { stateDir });
  const path = join(directory, 'store.sqlite');
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch {
    return fail('NOT_FOUND', 'The state directory holds no store', { stateDir });
  }
  if (!file.isFile() || realpathSync(path) !== path)
    fail('UNTRUSTED_PATH', 'Store database must be a regular file');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=1');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get())
      fail('NOT_FOUND', 'The state directory holds no store', { stateDir });
    const meta = (key: string) =>
      (
        db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
          | { value: string }
          | undefined
      )?.value;
    const version = meta('schemaVersion');
    if (version !== '3')
      fail(
        'SCHEMA_MISMATCH',
        version && /^[12]$/.test(version)
          ? `Store schema ${version} is older than 3; opening it once with a full engine migrates it`
          : `Unsupported store schema ${version ?? '(none)'}`,
      );
    checkFeatures(meta('storeFeatures'), STORE_FEATURES);
    const storeId = meta('storeId');
    const workspace = meta('workspace');
    if (!storeId || !workspace) fail('SCHEMA_MISMATCH', 'Store metadata is incomplete');
    return { db, storeId, workspace, stateDir: directory };
  } catch (error) {
    db.close();
    throw error;
  }
}
/** The artifact writes in progress in this process (SPEC-0057). */
const artifactWrites = new Set<Promise<void>>();
/**
 * Test seam: resolves once no artifact is being written and what waited for one has run. A turn's
 * end waits for its files, so a test that looked at the engine a few ticks after a runtime's last
 * event waits for this first.
 */
export async function artifactWritesSettled(): Promise<void> {
  do {
    await Promise.allSettled([...artifactWrites]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (artifactWrites.size);
}

/** SPEC-0053 F01: the event types an events.read leaves out when it names no filter. */
export const DEFAULT_EXCLUDED_EVENTS: readonly string[] = Object.freeze(['dispatch.progress']);
/** SPEC-0053 F02: the most events one filtered read scans. */
const EVENT_SCAN_LIMIT = 5000;

export class Store {
  readonly db: DatabaseSync;
  /** Held for the whole life of a writable store; a read-only store takes no lock (SPEC-0027 R01). */
  readonly lock: DatabaseSync | undefined;
  readonly storeId: string;
  readonly workspace: string;
  readonly stateDir: string;
  /** Told the size of each file the store writes under stateDir, before its record (SPEC-0052). */
  onFileWritten?: (bytes: number) => void;
  readonly readOnly: boolean;
  private closed = false;
  readonly now: () => number;
  /** The clock reading of the transaction in progress (SPEC-0030 B01). */
  private commitTime: number | undefined;
  readonly options: StoreOptions;
  degraded = false;

  /** A store for reads only, such as a read-only view of an engine that is not running. */
  static openReadOnly(stateDir: string): Store {
    return new Store('', stateDir, {}, true);
  }

  constructor(workspace: string, stateDir: string, options: StoreOptions = {}, readOnly = false) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.readOnly = readOnly;
    if (readOnly) {
      const opened = openForReading(stateDir);
      this.db = opened.db;
      this.lock = undefined;
      this.storeId = opened.storeId;
      this.workspace = opened.workspace;
      this.stateDir = opened.stateDir;
      return;
    }
    if (!isAbsolute(workspace) || !isAbsolute(stateDir))
      fail('VALIDATION_ERROR', 'workspace and stateDir must be absolute');
    this.workspace = realpathSync(workspace);
    const candidate = futureRealpath(stateDir);
    if (!isOutside(this.workspace, candidate) || !isOutside(candidate, this.workspace))
      fail('VALIDATION_ERROR', 'workspace and stateDir must not contain each other');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(stateDir);
    if (!isOutside(this.workspace, this.stateDir) || !isOutside(this.stateDir, this.workspace))
      fail('VALIDATION_ERROR', 'workspace and stateDir must not contain each other');
    // Reject retired/archived/registered/future stores before changing any file or journal mode.
    const existingDatabase = join(this.stateDir, 'store.sqlite');
    if (existsSync(existingDatabase)) {
      if (
        !lstatSync(existingDatabase).isFile() ||
        realpathSync(existingDatabase) !== existingDatabase
      )
        fail('UNTRUSTED_PATH', 'Store database must be a regular file');
      const probe = new DatabaseSync(existingDatabase, { readOnly: true });
      try {
        const hasMetadata = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
          .get();
        if (hasMetadata) {
          const meta = (key: string) =>
            (
              probe.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
                | { value: string }
                | undefined
            )?.value;
          const version = meta('schemaVersion'),
            role = meta('role');
          if (version && !['1', '2', '3'].includes(version))
            fail('SCHEMA_MISMATCH', `Unsupported store schema ${version}`);
          // Invariant 2: a newer store is refused before recovery or any write.
          checkFeatures(meta('storeFeatures'), options.knownFeatures ?? STORE_FEATURES);
          if (
            role === 'retired' ||
            role === 'archive' ||
            (role === 'standby' && !options.allowStandby)
          )
            fail('STORE_RETIRED', 'This store is not writable', { role });
          if (meta('controlDir') && !options.fence)
            fail('STORE_FENCED', 'Registered stores require their control owner');
        }
      } finally {
        probe.close();
      }
    }
    options.fence?.();
    chmodSync(this.stateDir, 0o700);
    this.lock = new DatabaseSync(join(this.stateDir, 'owner.sqlite'));
    try {
      this.lock.exec(
        'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (owner TEXT);',
      );
    } catch (error) {
      this.lock.close();
      if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error)))
        fail('HOST_ALREADY_RUNNING', 'Another engine owns stateDir', { stateDir: this.stateDir });
      throw error;
    }
    let database: DatabaseSync | undefined;
    try {
      // SPEC-0060 P01: the lock's journal exists now, and stays for the life of the store.
      privateDatabaseFiles(join(this.stateDir, 'owner.sqlite'));
      database = new DatabaseSync(join(this.stateDir, 'store.sqlite'));
      this.db = database;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      );
      const meta = (key: string) =>
        (
          this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
            | { value: string }
            | undefined
        )?.value;
      const version = meta('schemaVersion');
      if (version && !['1', '2', '3'].includes(version))
        fail('SCHEMA_MISMATCH', `Unsupported store schema ${version}`);
      const role = meta('role');
      if (role === 'retired' || role === 'archive' || (role === 'standby' && !options.allowStandby))
        fail('STORE_RETIRED', 'This store is not writable', { role });
      if (meta('controlDir') && !options.fence)
        fail('STORE_FENCED', 'Registered stores require their control owner');
      options.fence?.();
      const previousWorkspace = meta('workspace');
      // SPEC-0054: another spelling of the same directory is the same workspace; the record keeps
      // its spelling, so that an older engine still opens the store.
      if (previousWorkspace && !samePath(previousWorkspace, this.workspace))
        fail('WORKSPACE_MISMATCH', 'State belongs to a different workspace');
      this.storeId = meta('storeId') ?? randomUUID();
      if (version && version !== '3') {
        const backup = join(this.stateDir, `store-schema${version}-${randomUUID()}.sqlite`);
        options.fault?.('migration.backup_started');
        this.db.prepare('VACUUM INTO ?').run(backup);
        chmodSync(backup, 0o600);
        const verified = new DatabaseSync(backup, { readOnly: true });
        try {
          const check = verified.prepare('PRAGMA integrity_check').get() as {
            integrity_check: string;
          };
          const saved = verified.prepare('SELECT value FROM metadata WHERE key=?');
          if (
            check.integrity_check !== 'ok' ||
            (saved.get('schemaVersion') as { value: string }).value !== version ||
            (saved.get('storeId') as { value: string }).value !== this.storeId ||
            !samePath((saved.get('workspace') as { value: string }).value, this.workspace)
          )
            fail('SCHEMA_MIGRATION_FAILED', 'Recovery backup validation failed');
        } finally {
          verified.close();
        }
        completeMigrationBackup(backup, this.stateDir, this.storeId, version);
        options.fault?.('migration.backup_verified');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of TABLES)
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
          );
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,method TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(method,scope,key))',
        );
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT,data TEXT NOT NULL)',
        );
        this.db.exec('CREATE INDEX IF NOT EXISTS events_task_cursor ON events(taskId,cursor)');
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_status ON tasks(json_extract(data, '$.status'))",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(json_extract(data, '$.spec.parentTaskId'))",
        );
        // Host tasks that can still expire (SPEC-0065 E03).
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_host_expiry ON tasks(json_extract(data,'$.spec.expiresAt')) WHERE json_extract(data,'$.spec.expiresAt') IS NOT NULL AND json_extract(data,'$.status') NOT IN ('completed','failed','cancelled')",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_session ON tasks(json_extract(data, '$.sessionId'))",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_label ON tasks(json_extract(data,'$.spec.label'))",
        );
        // A root task's tree and a task's usage records (SPEC-0028 P04).
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_root ON tasks(json_extract(data,'$.rootTaskId')); CREATE INDEX IF NOT EXISTS usage_task ON usage(json_extract(data,'$.taskId'));",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_task ON dispatches(json_extract(data, '$.taskId'))",
        );
        // Cost queries and budget checks read only the rows they concern (SPEC-0033 P01). The
        // covering index lets the host-wide total read amounts without parsing any record.
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS costs_owner ON costs(json_extract(data,'$.costOwnerTaskId')); CREATE INDEX IF NOT EXISTS costs_root ON costs(json_extract(data,'$.rootTaskId')); CREATE INDEX IF NOT EXISTS costs_dispatch ON costs(json_extract(data,'$.dispatchId')); CREATE INDEX IF NOT EXISTS costs_overhead ON costs(json_extract(data,'$.category')) WHERE json_extract(data,'$.category')='host_overhead'; CREATE INDEX IF NOT EXISTS costs_currency_units ON costs(json_extract(data,'$.currency'),json_extract(data,'$.amountUnits')); CREATE INDEX IF NOT EXISTS reservations_held ON budget_reservations(json_extract(data,'$.rootTaskId')) WHERE json_extract(data,'$.status')='held';",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_lease ON dispatches(json_extract(data,'$.executionLease.status')); CREATE INDEX IF NOT EXISTS dispatches_quarantine ON dispatches(json_extract(data,'$.quarantined')); CREATE INDEX IF NOT EXISTS dispatches_verification ON dispatches(json_extract(data,'$.verificationPending')); CREATE INDEX IF NOT EXISTS conflicts_status ON execution_conflicts(json_extract(data,'$.status'));",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_session ON dispatches(json_extract(data, '$.sessionId'))",
        );
        // SPEC-0060 I01, I02: the tool call limit counts one dispatch's calls, and the message rate
        // limit one sender's recent messages; both read whole tables that only grow before.
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tool_calls_dispatch ON tool_calls(json_extract(data, '$.dispatchId')); CREATE INDEX IF NOT EXISTS messages_sender_created ON messages(json_extract(data,'$.fromSessionId'), json_extract(data,'$.createdAt'));",
        );
        // Only rows that can still expire, keyed by expiry: the checks before each call and in each
        // scheduler pass read no finished approval, message or handoff (SPEC-0024 X01).
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS approvals_pending_expiry ON approvals(json_extract(data,'$.expiresAt')) WHERE json_extract(data,'$.status')='pending'; CREATE INDEX IF NOT EXISTS messages_persisted_expiry ON messages(json_extract(data,'$.expiresAt')) WHERE json_extract(data,'$.status')='persisted'; CREATE INDEX IF NOT EXISTS handoffs_pending_expiry ON handoffs(json_extract(data,'$.expiresAt')) WHERE json_extract(data,'$.status')='pending';",
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS retention_records (table_name TEXT NOT NULL, id TEXT NOT NULL, changed_at INTEGER NOT NULL, terminal_at INTEGER, active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(table_name,id));
          CREATE INDEX IF NOT EXISTS retention_age ON retention_records(table_name,terminal_at);
          CREATE TABLE IF NOT EXISTS record_refs(source_table TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(source_table,source_id,target_id));
          CREATE INDEX IF NOT EXISTS refs_target ON record_refs(target_id);
          CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cursor TEXT NOT NULL, floor TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS snapshot_items (snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(snapshot_id,ordinal));`);
        const retentionColumns = (
          this.db.prepare('PRAGMA table_info(retention_records)').all() as { name: string }[]
        ).map((column) => column.name);
        if (!retentionColumns.includes('active'))
          this.db.exec(
            'ALTER TABLE retention_records ADD COLUMN active INTEGER NOT NULL DEFAULT 1',
          );
        // SPEC-0033 S01: a record whose detail was collected leaves the candidates of later runs.
        if (!retentionColumns.includes('collected'))
          this.db.exec(
            'ALTER TABLE retention_records ADD COLUMN collected INTEGER NOT NULL DEFAULT 0',
          );
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS retention_pending ON retention_records(table_name,terminal_at) WHERE collected=0',
        );
        const set = this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)');
        set.run('schemaVersion', '3');
        if (version && version !== '3')
          this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('3', 'schemaVersion');
        set.run('workspace', this.workspace);
        set.run('storeId', this.storeId);
        set.run('retentionFloorCursor', '0');
        set.run('role', 'active');
        this.db
          .prepare(
            'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run('lastEngineVersion', VERSION);
        if (meta('referenceIndexVersion') !== '1') {
          for (const table of TABLES)
            for (const row of this.db.prepare(`SELECT id,data FROM ${table}`).all() as {
              id: string;
              data: string;
            }[])
              this.track(table, row.id, JSON.parse(row.data));
          for (const row of this.db.prepare('SELECT id,data FROM operations').all() as {
            id: string;
            data: string;
          }[])
            this.track('operations', row.id, JSON.parse(row.data));
          set.run('referenceIndexVersion', '1');
        }
        if (version && version !== '3') options.fault?.('migration.before_commit');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      // SPEC-0060 P01: the database, its WAL and the WAL's index, new or left by an earlier version.
      privateDatabaseFiles(join(this.stateDir, 'store.sqlite'));
      for (const name of ['artifacts', 'file-commits', 'quarantine']) {
        const path = join(this.stateDir, name);
        if (existsSync(path) && (!lstatSync(path).isDirectory() || realpathSync(path) !== path))
          fail('UNTRUSTED_PATH', 'Managed file directory is not canonical');
      }
      mkdirSync(join(this.stateDir, 'artifacts'), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.stateDir, 'file-commits'), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.stateDir, 'quarantine'), { recursive: true, mode: 0o700 });
      this.recoverFiles();
    } catch (error) {
      database?.close();
      this.lock.close();
      throw error;
    }
  }
  /**
   * SPEC-0051 R02, invariant 1: records that the store holds data of `name`, in the transaction
   * that writes that data, so no store holds such data without its marker.
   */
  recordFeature(name: string): void {
    if (!this.db.isTransaction) throw new Error('A feature is recorded in a transaction');
    if (!(this.options.knownFeatures ?? STORE_FEATURES).includes(name))
      throw new Error(`${name} is not a known store feature`);
    const recorded = this.metadata('storeFeatures');
    const features = recorded ? (JSON.parse(recorded) as { name: string }[]) : [];
    if (features.some((feature) => feature.name === name)) return;
    this.setMetadata(
      'storeFeatures',
      JSON.stringify([...features, { name, engineVersion: VERSION }]),
    );
  }
  /**
   * The journals of the artifacts registered in the transaction in progress, with their sizes
   * (SPEC-0061 J01); undefined outside a transaction this store began.
   */
  private registered: Map<string, number> | undefined;
  /** Told the size of each file the store removes under stateDir (SPEC-0061 J01). */
  onFileRemoved?: (bytes: number) => void;
  /** `at`, when given, is the transaction's one time, read before it began (SPEC-0057). */
  transaction<T>(fn: () => T, at?: number): T {
    this.assertWritable();
    this.db.exec('BEGIN IMMEDIATE');
    // One reading for the whole transaction: every time written in it is this one (SPEC-0030 B01).
    this.commitTime = at ?? this.now();
    const registered = (this.registered = new Map<string, number>());
    let result: T;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.storageFailure(error);
      throw error;
    } finally {
      this.commitTime = undefined;
      this.registered = undefined;
    }
    this.removeJournals(registered);
    return result;
  }
  /**
   * SPEC-0061 J01: a journal has no use once the transaction that registered its artifact has
   * committed (invariant 1). Nothing here changes that transaction's result (invariant 3): a
   * journal that cannot be removed stays for the next start, which removes it (J03).
   */
  private removeJournals(journals: Map<string, number>): void {
    if (!journals.size) return;
    try {
      this.options.fault?.('artifact.committed');
    } catch {
      return; // A test stops here, as a crash would: the journals stay for the next start.
    }
    for (const [journal, bytes] of journals)
      try {
        unlinkSync(journal);
        this.onFileRemoved?.(bytes);
      } catch {
        // Gone already, or left for the next start.
      }
  }
  /** The time of a write: the reading of the transaction in progress, or a new one outside it. */
  wallTime(): number {
    return this.commitTime ?? this.now();
  }
  assertWritable(): void {
    if (this.closed) fail('CLIENT_CLOSED', 'Store is closed');
    if (this.readOnly) fail('READ_ONLY', 'This store was opened for reading only');
    this.options.fence?.();
    if (this.metadata('role') === 'retired' || this.metadata('role') === 'archive')
      fail('STORE_RETIRED', 'Store is read-only');
    if (this.degraded) fail('STORAGE_DEGRADED', 'Storage failure requires restart and recovery');
  }
  storageFailure(error: unknown): void {
    const code = (error as { code?: string; errcode?: number }).code ?? '';
    const sqlite = (error as { errcode?: number }).errcode;
    if (
      ['ENOSPC', 'EIO', 'EROFS'].includes(code) ||
      (sqlite !== undefined && [10, 13, 14].includes(sqlite & 255))
    ) {
      this.degraded = true;
      try {
        unlinkSync(join(this.stateDir, 'emergency.reserve'));
        syncDirectory(this.stateDir);
      } catch {
        /* The original failure remains authoritative. */
      }
    }
  }
  private write<T>(fn: () => T): T {
    this.assertWritable();
    if (!this.db.isTransaction) return this.transaction(fn);
    return fn();
  }
  metadata(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  setMetadata(key: string, value: string): void {
    this.write(() =>
      this.db
        .prepare(
          'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, value),
    );
  }
  private track(table: string, id: string, value: any): void {
    const settled = [
      'completed',
      'failed',
      'cancelled',
      'closed',
      'consumed',
      'expired',
      'approved',
      'rejected',
      'invalidated',
      'noop',
      'accepted',
    ].includes(value.status);
    const terminal =
      table === 'artifacts' ||
      table === 'usage' ||
      settled ||
      (value.status === 'outcome_unknown' && value.resolution);
    const active =
      table === 'tasks'
        ? !['completed', 'failed', 'cancelled'].includes(value.status)
        : ['messages', 'outbox'].includes(table)
          ? !settled
          : table === 'dispatches'
            ? value.executionLease?.status === 'held' ||
              value.quarantined ||
              value.verificationPending
            : table === 'approvals'
              ? value.status === 'pending'
              : table === 'operations'
                ? value.status === 'persisted' ||
                  (value.status === 'outcome_unknown' && !value.resolution)
                : table === 'execution_conflicts'
                  ? value.status === 'open'
                  : table === 'handoffs'
                    ? value.status === 'pending'
                    : table === 'storage_pins';
    this.db
      .prepare(
        `INSERT INTO retention_records(table_name,id,changed_at,terminal_at,active) VALUES (?,?,?,?,?)
      ON CONFLICT(table_name,id) DO UPDATE SET changed_at=excluded.changed_at,active=excluded.active,
      terminal_at=CASE WHEN excluded.terminal_at IS NULL THEN NULL ELSE COALESCE(retention_records.terminal_at,excluded.terminal_at) END`,
      )
      .run(table, id, this.wallTime(), terminal ? this.wallTime() : null, active ? 1 : 0);
    const refs = new Set<string>();
    const visit = (child: unknown, key = '') => {
      if (typeof child === 'string') {
        if (/(Id|Ids|Ref|Refs)$/.test(key) || ['id', 'ref'].includes(key)) refs.add(child);
      } else if (Array.isArray(child)) for (const item of child) visit(item, key);
      else if (child && typeof child === 'object')
        for (const [name, item] of Object.entries(child))
          if (!['raw', 'goal', 'summary', 'text', 'prompt'].includes(name)) visit(item, name);
    };
    visit(value);
    this.db.prepare('DELETE FROM record_refs WHERE source_table=? AND source_id=?').run(table, id);
    const insert = this.db.prepare('INSERT OR IGNORE INTO record_refs VALUES (?,?,?)');
    for (const ref of refs) if (ref !== id) insert.run(table, id, ref);
  }
  assertDetails(operation: OperationSnapshot): void {
    if ((operation as any).historyExpired)
      fail(
        'OPERATION_HISTORY_EXPIRED',
        'Operation detail was collected; never replay this identity',
        {
          operationId: operation.id,
          status: operation.status,
          targetId: operation.targetId,
          result: operation.result,
        },
      );
  }
  confirmFiles(): void {
    this.recoverFiles();
  }
  get isClosed(): boolean {
    return this.closed;
  }
  private recoverFiles(): void {
    for (const name of readdirSync(join(this.stateDir, 'file-commits'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const journal = join(this.stateDir, 'file-commits', name);
      const entry = JSON.parse(readFileSync(journal, 'utf8')) as {
        ref: string;
        sha256: string;
        sizeBytes: number;
      };
      if (name !== `${entry.sha256}.json` || entry.ref !== `sha256:${entry.sha256}`)
        fail('ARTIFACT_CORRUPT', 'Invalid file commit identity');
      const path = join(this.stateDir, 'artifacts', `${entry.sha256}.txt`);
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        if (
          !lstatSync(path).isFile() ||
          bytes.length !== entry.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        )
          fail('ARTIFACT_CORRUPT', 'Interrupted artifact failed verification');
        if (!this.get('artifacts', entry.ref))
          this.put('artifacts', entry.ref, {
            id: entry.ref,
            path,
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
            recoveredOrphan: true,
          });
      } else if (
        this.get<any>('artifacts', entry.ref)?.historyExpired ||
        this.get<any>('gc_jobs', entry.ref)?.status === 'pending'
      ) {
        continue;
      } else if (this.get('artifacts', entry.ref))
        fail('ARTIFACT_CORRUPT', 'Committed artifact is missing');
      unlinkSync(journal);
    }
    syncDirectory(join(this.stateDir, 'file-commits'));
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  require<T>(table: Table, id: string): T {
    const value = this.get<T>(table, id);
    if (!value) fail('NOT_FOUND', `${table} object not found`, { id });
    return value;
  }
  all<T>(table: Table): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  subtreeTasks(rootId: string): TaskSnapshot[] {
    type TaskRow = { ordinal: number; id: string; data: string };
    const root = this.db
      .prepare('SELECT rowid AS ordinal,id,data FROM tasks WHERE id=?')
      .get(rootId) as TaskRow | undefined;
    if (!root) return [];
    const children = this.db.prepare(
      "SELECT rowid AS ordinal,id,data FROM tasks WHERE json_extract(data,'$.spec.parentTaskId')=? ORDER BY rowid",
    );
    const rows = [root];
    const seen = new Set([rootId]);
    const queue = [{ id: rootId, depth: 0 }];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      if (parent.depth >= 32) continue;
      for (const child of children.all(parent.id) as TaskRow[]) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        rows.push(child);
        queue.push({ id: child.id, depth: parent.depth + 1 });
      }
    }
    rows.sort((a, b) => a.ordinal - b.ordinal);
    return rows.map((row) => JSON.parse(row.data) as TaskSnapshot);
  }
  /**
   * One page in creation order, or newest first with `desc`; `next` is the last returned rowid when
   * more rows follow. Without `after`, a page starts at the oldest, or with `desc` the newest, task.
   */
  listTasks(
    filter: { parentTaskId?: string; sessionId?: string; label?: string; status?: string[] },
    after: number | undefined,
    limit: number,
    order: 'asc' | 'desc' = 'asc',
  ): { tasks: TaskSnapshot[]; next: number | null } {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    // Each expression is that of an index: tasks_parent, tasks_session, tasks_label (SPEC-0027 L03)
    // and tasks_status (SPEC-0028 P04).
    if (filter.parentTaskId !== undefined) {
      clauses.push("json_extract(data,'$.spec.parentTaskId')=?");
      args.push(filter.parentTaskId);
    } else if (filter.sessionId !== undefined) {
      clauses.push("json_extract(data,'$.sessionId')=?");
      args.push(filter.sessionId);
    } else if (filter.label !== undefined) {
      clauses.push("json_extract(data,'$.spec.label')=?");
      args.push(filter.label);
    }
    if (filter.status !== undefined) {
      clauses.push(`json_extract(data, '$.status') IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (after !== undefined || order === 'asc') {
      clauses.push(order === 'desc' ? 'rowid<?' : 'rowid>?');
      args.push(after ?? 0);
    }
    const rows = this.db
      .prepare(
        `SELECT rowid AS ordinal,data FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY rowid ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(...args, limit + 1) as { ordinal: number; data: string }[];
    const page = rows.slice(0, limit);
    return {
      tasks: page.map((row) => JSON.parse(row.data) as TaskSnapshot),
      next: rows.length > limit ? page[page.length - 1].ordinal : null,
    };
  }
  /** The tasks among `ids` that exist, by ID (SPEC-0028 P02). */
  tasksById(ids: string[]): Map<string, TaskSnapshot> {
    const rows = this.db
      .prepare(`SELECT id,data FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: string; data: string }[];
    return new Map(rows.map((row) => [row.id, JSON.parse(row.data) as TaskSnapshot]));
  }
  /** Which of `ids` name a task (SPEC-0029 A01). */
  existingTaskIds(ids: string[]): Set<string> {
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }
  /** The usage records of the tasks `ids`, in one statement through usage_task (SPEC-0029 A02). */
  usageOfTasks(ids: string[]): UsageRecord[] {
    if (!ids.length) return [];
    return (
      this.db
        .prepare(
          `SELECT data FROM usage WHERE json_extract(data,'$.taskId') IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`,
        )
        .all(...ids) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as UsageRecord);
  }
  /** A task's usage records in recording order, through usage_task (SPEC-0028 P04). */
  taskUsage(taskId: string): UsageRecord[] {
    return (
      this.db
        .prepare("SELECT data FROM usage WHERE json_extract(data,'$.taskId')=? ORDER BY rowid")
        .all(taskId) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as UsageRecord);
  }
  /**
   * The usage records of the tasks whose rootTaskId is `rootTaskId`, through tasks_root and
   * usage_task (SPEC-0028 P03, P04).
   */
  treeUsage(rootTaskId: string): UsageRecord[] {
    return (
      this.db
        .prepare(
          // CROSS JOIN keeps tasks as the outer loop, and +t.id drops the column's text affinity,
          // which would otherwise keep usage_task from matching: without both, SQLite scans every
          // usage record and looks up its task.
          "SELECT u.data AS data FROM tasks t CROSS JOIN usage u ON json_extract(u.data,'$.taskId')=+t.id WHERE json_extract(t.data,'$.rootTaskId')=? ORDER BY u.rowid",
        )
        .all(rootTaskId) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as UsageRecord);
  }
  listHandoffs(
    filter: { status?: string; targetSessionId?: string },
    after: number,
    limit: number,
  ): { handoffs: HandoffRequest[]; next: number | null } {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.status !== undefined) {
      clauses.push("json_extract(data,'$.status')=?");
      args.push(filter.status);
    }
    if (filter.targetSessionId !== undefined) {
      clauses.push("json_extract(data,'$.targetSessionId')=?");
      args.push(filter.targetSessionId);
    }
    const rows = this.db
      .prepare(
        `SELECT rowid AS ordinal,data FROM handoffs WHERE ${clauses.map((c) => `${c} AND `).join('')}rowid>? ORDER BY rowid LIMIT ?`,
      )
      .all(...args, after, limit + 1) as { ordinal: number; data: string }[];
    const page = rows.slice(0, limit);
    return {
      handoffs: page.map((row) => JSON.parse(row.data) as HandoffRequest),
      next: rows.length > limit ? page[page.length - 1].ordinal : null,
    };
  }
  queuedTasks(): TaskSnapshot[] {
    return this.tasksInState('queued');
  }
  tasksInState(status: string): TaskSnapshot[] {
    return (
      this.db
        .prepare("SELECT data FROM tasks WHERE json_extract(data, '$.status')=? ORDER BY rowid")
        .all(status) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  dispatchCount(taskId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM dispatches WHERE json_extract(data, '$.taskId')=?")
        .get(taskId) as { count: number }
    ).count;
  }
  /** A session's most recently created dispatch other than `except`, through dispatches_session. */
  latestDispatch(sessionId: string, except: string): { id: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM dispatches WHERE json_extract(data,'$.sessionId')=? AND id<>? ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId, except) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as { id: string }) : undefined;
  }
  activeDispatches(sessionId?: string): Record<string, unknown>[] {
    const predicate =
      "(json_extract(data, '$.executionLease.status')='held' OR json_extract(data, '$.quarantined')=1 OR json_extract(data, '$.verificationPending')=1)";
    return (
      this.db
        .prepare(
          `SELECT data FROM dispatches WHERE ${predicate}${sessionId ? " AND json_extract(data, '$.sessionId')=?" : ''}`,
        )
        .all(...(sessionId ? [sessionId] : [])) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  put(table: Table, id: string, value: unknown): void {
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
        )
        .run(id, JSON.stringify(value));
      this.track(table, id, value);
    });
  }
  remove(table: Table, id: string): void {
    this.write(() => {
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      this.db.prepare('DELETE FROM retention_records WHERE table_name=? AND id=?').run(table, id);
      this.db
        .prepare('DELETE FROM record_refs WHERE source_table=? AND source_id=?')
        .run(table, id);
    });
  }
  findOperationById(id: string): any {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  operation(id: string): OperationSnapshot {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    if (!row) fail('NOT_FOUND', 'Operation not found', { id });
    const operation = JSON.parse(row.data);
    this.assertDetails(operation);
    return operation;
  }
  operations(): OperationSnapshot[] {
    return (this.db.prepare('SELECT data FROM operations').all() as { data: string }[]).map((row) =>
      JSON.parse(row.data),
    );
  }
  findOperation(
    method: string,
    scope: string,
    key: string,
  ): { operation: OperationSnapshot; digest: string } | undefined {
    const row = this.db
      .prepare('SELECT data,digest FROM operations WHERE method=? AND scope=? AND key=?')
      .get(method, scope, key) as { data: string; digest: string } | undefined;
    return row ? { operation: JSON.parse(row.data), digest: row.digest } : undefined;
  }
  saveOperation(operation: OperationSnapshot, digest?: string): void {
    this.write(() => {
      if (digest !== undefined)
        this.db
          .prepare('INSERT INTO operations(id,method,scope,key,digest,data) VALUES (?,?,?,?,?,?)')
          .run(
            operation.id,
            operation.method,
            operation.scope,
            operation.idempotencyKey,
            digest,
            JSON.stringify(operation),
          );
      else
        this.db
          .prepare('UPDATE operations SET data=? WHERE id=?')
          .run(JSON.stringify(operation), operation.id);
      this.track('operations', operation.id, operation);
    });
  }
  event(
    type: string,
    data: Record<string, Json>,
    refs: { taskId?: string; sessionId?: string | null; operationId?: string } = {},
  ): EventEnvelope {
    return this.write(() => {
      const event: EventEnvelope = {
        eventId: randomUUID(),
        cursor: '0',
        storeId: this.storeId,
        schemaVersion: 1,
        type,
        taskId: refs.taskId ?? null,
        sessionId: refs.sessionId ?? null,
        operationId: refs.operationId ?? null,
        occurredAt: new Date(this.wallTime()).toISOString(),
        data,
      };
      const row = this.db
        .prepare('INSERT INTO events(taskId,data) VALUES (?,?)')
        .run(event.taskId, JSON.stringify(event));
      event.cursor = String(row.lastInsertRowid);
      this.db
        .prepare('UPDATE events SET data=? WHERE cursor=?')
        .run(JSON.stringify(event), row.lastInsertRowid);
      return event;
    });
  }
  events(
    after: string,
    storeId: string | undefined,
    taskId: string | undefined,
    limit: number,
    filter: { types?: readonly string[]; excludeTypes?: readonly string[] } = {},
  ): EventPage {
    // A caller's mistake is a validation error; CURSOR_EXPIRED means that the reader must
    // resynchronize, and says why (SPEC-0027 C01, C02).
    if (!/^\d+$/.test(after))
      fail('VALIDATION_ERROR', 'afterCursor must be a decimal cursor from events.read');
    if (after !== '0' && storeId === undefined)
      fail('VALIDATION_ERROR', 'A cursor other than 0 needs the storeId of the page it came from');
    const last = this.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as {
      cursor: number;
    };
    const floor = this.metadata('retentionFloorCursor') ?? '0';
    const expired = (reason: string, message: string) =>
      fail('CURSOR_EXPIRED', message, {
        reason,
        retentionFloorCursor: floor,
        lastCursor: String(last.cursor),
        currentStoreId: this.storeId,
      });
    if (storeId !== undefined && storeId !== this.storeId)
      expired('store_changed', 'Cursor belongs to another store; resynchronize from this one');
    if (BigInt(after) < BigInt(floor))
      expired('below_retention_floor', 'Events after this cursor were collected; resynchronize');
    if (BigInt(after) > BigInt(Math.max(last.cursor, Number(floor))))
      expired('ahead_of_store', 'This store has fewer events than the cursor; resynchronize');
    // SPEC-0053 F01: without a filter, progress is left out, so a reader that does not ask for it
    // pages as it did before.
    const only = filter.types ? new Set(filter.types) : undefined;
    const left = new Set(filter.excludeTypes ?? (only ? [] : DEFAULT_EXCLUDED_EVENTS));
    const filtered = only !== undefined || left.size > 0;
    // A task's events come from the (taskId, cursor) index, so other tasks' events cost nothing
    // (SPEC-0024 E01).
    const query =
      taskId === undefined
        ? this.db.prepare('SELECT cursor,data FROM events WHERE cursor>? ORDER BY cursor LIMIT ?')
        : this.db.prepare(
            'SELECT cursor,data FROM events WHERE taskId=? AND cursor>? ORDER BY cursor LIMIT ?',
          );
    const events: EventEnvelope[] = [];
    let cursor = after;
    let bytes = 0;
    let full = false;
    let exhausted = false;
    let scanned = 0;
    // SPEC-0053 F02: a filtered read scans at most EVENT_SCAN_LIMIT events, then returns what it
    // found with its cursor past them.
    while (!full && !exhausted && scanned < EVENT_SCAN_LIMIT) {
      const batch = filtered ? Math.min(1000, EVENT_SCAN_LIMIT - scanned) : limit - events.length;
      const rows = (
        taskId === undefined ? query.all(cursor, batch) : query.all(taskId, cursor, batch)
      ) as { cursor: number; data: string }[];
      exhausted = rows.length < batch;
      for (const row of rows) {
        scanned++;
        const event = JSON.parse(row.data) as EventEnvelope;
        if (
          (!taskId || event.taskId === taskId) &&
          (!only || only.has(event.type)) &&
          !left.has(event.type)
        ) {
          const size = Buffer.byteLength(row.data, 'utf8') + 1;
          if (size > 768 * 1024)
            fail('FRAME_TOO_LARGE', 'Stored event exceeds the replay page limit');
          if (bytes + size > 768 * 1024) {
            full = true;
            break;
          }
          bytes += size;
          events.push(event);
        }
        // Advance only past scanned records, never past an event deferred to the next page.
        cursor = String(row.cursor);
        if (events.length === limit) {
          full = true;
          break;
        }
      }
      if (!filtered) break;
    }
    if (!filtered && !full && events.length === limit) full = true;
    // A task-filtered page that is not full returned every event of the task up to the last event;
    // the other tasks' events after its own are not the reader's (SPEC-0024 E02).
    if (taskId !== undefined && !full && exhausted && BigInt(last.cursor) > BigInt(cursor))
      cursor = String(last.cursor);
    return { events, cursor, storeId: this.storeId };
  }
  /** Digests whose journal and file this process wrote and verified, not yet registered. */
  private prepared = new Set<string>();
  /**
   * SPEC-0057 W01: writes an artifact's journal and file as `artifact()` does, in the same order
   * and with the same syncs, without blocking the event loop. `artifact()` then registers it without
   * touching the disk. A prepared artifact that is never registered is what an interrupted write
   * leaves: the next start keeps it as a recovered orphan.
   */
  async prepareArtifact(text: string): Promise<void> {
    const work = this.writeArtifact(text);
    artifactWrites.add(work);
    this.writing.add(work);
    try {
      await work;
    } finally {
      artifactWrites.delete(work);
      this.writing.delete(work);
    }
  }
  /** This store's artifact writes in progress; a close waits for them (SPEC-0057). */
  private writing = new Set<Promise<void>>();
  async writesSettled(): Promise<void> {
    while (this.writing.size) await Promise.allSettled([...this.writing]);
  }
  /** Test seam: awaited before an artifact is written off the event loop (SPEC-0057). */
  writePause?: () => Promise<void>;
  private async writeArtifact(text: string): Promise<void> {
    await this.writePause?.();
    this.assertWritable();
    const digest = createHash('sha256').update(text).digest('hex');
    if (this.prepared.has(digest)) return;
    const path = join(this.stateDir, 'artifacts', `${digest}.txt`),
      ref = `sha256:${digest}`;
    const record = { id: ref, path, sha256: digest, sizeBytes: Buffer.byteLength(text) };
    const journal = join(this.stateDir, 'file-commits', `${digest}.json`);
    for (const directory of [dirname(path), dirname(journal)])
      if ((await realpath(directory)) !== directory)
        fail('UNTRUSTED_PATH', 'Artifact directory changed');
    const journalText = JSON.stringify({ ref, ...record });
    await atomicFileAsync(journal, journalText);
    this.onFileWritten?.(Buffer.byteLength(journalText));
    this.options.fault?.('artifact.prepared');
    if (!existsSync(path)) {
      await atomicFileAsync(path, text);
      this.onFileWritten?.(record.sizeBytes);
    }
    if (
      !(await lstat(path)).isFile() ||
      (await realpath(path)) !== path ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== digest
    )
      fail('ARTIFACT_CORRUPT', 'Existing artifact failed digest verification');
    this.options.fault?.('artifact.renamed');
    if (!this.closed) this.prepared.add(digest);
  }
  artifact(text: string): string {
    this.assertWritable();
    const digest = createHash('sha256').update(text).digest('hex');
    const path = join(this.stateDir, 'artifacts', `${digest}.txt`),
      ref = `sha256:${digest}`;
    const record = { id: ref, path, sha256: digest, sizeBytes: Buffer.byteLength(text) };
    const journal = join(this.stateDir, 'file-commits', `${digest}.json`);
    const journalText = JSON.stringify({ ref, ...record });
    // SPEC-0061 J01: in a transaction of this store, which removes the journal once it committed.
    const register = () =>
      this.write(() => {
        this.put('artifacts', ref, record);
        this.registered?.set(journal, Buffer.byteLength(journalText));
      });
    // SPEC-0057 W01: already on disk, synced and verified by prepareArtifact.
    if (this.prepared.delete(digest)) {
      try {
        register();
        this.options.fault?.('artifact.registered');
        return ref;
      } catch (error) {
        this.storageFailure(error);
        throw error;
      }
    }
    for (const directory of [dirname(path), dirname(journal)])
      if (realpathSync(directory) !== directory)
        fail('UNTRUSTED_PATH', 'Artifact directory changed');
    try {
      atomicFile(journal, journalText);
      this.onFileWritten?.(Buffer.byteLength(journalText));
      this.options.fault?.('artifact.prepared');
      if (!existsSync(path)) {
        atomicFile(path, text);
        this.onFileWritten?.(record.sizeBytes);
      }
      if (
        !lstatSync(path).isFile() ||
        realpathSync(path) !== path ||
        createHash('sha256').update(readFileSync(path)).digest('hex') !== digest
      )
        fail('ARTIFACT_CORRUPT', 'Existing artifact failed digest verification');
      this.options.fault?.('artifact.renamed');
      register();
      this.options.fault?.('artifact.registered');
      // The journal is removed once the transaction that registered the artifact has committed
      // (SPEC-0061 J01), or by the next start.
      return ref;
    } catch (error) {
      this.storageFailure(error);
      throw error;
    }
  }
  artifactText(ref: string, maxBytes = 65536): string {
    const record = this.require<{
      path: string;
      sha256: string;
      sizeBytes: number;
      historyExpired?: boolean;
    }>('artifacts', ref);
    if (record.historyExpired)
      fail('ARTIFACT_HISTORY_EXPIRED', 'Artifact content was collected', { ref });
    if (record.sizeBytes > maxBytes)
      fail('ARTIFACT_TOO_LARGE', 'Artifact exceeds the requested inline limit');
    const path = join(this.stateDir, 'artifacts', `${record.sha256}.txt`);
    if (realpathSync(path) !== path)
      fail('ARTIFACT_CORRUPT', 'Artifact path must not be a symlink');
    const bytes = readFileSync(path);
    if (
      bytes.length !== record.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== record.sha256
    )
      fail('ARTIFACT_CORRUPT', 'Artifact content does not match its immutable digest');
    return bytes.toString('utf8');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock?.close();
  }
}
