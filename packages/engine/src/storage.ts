import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statfsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store, type Table } from './store.ts';
import { syncDirectory, isCodexHelperLink } from './durable-files.ts';
import { fail } from './errors.ts';
import { fields, integer, object, string } from './validation.ts';
import type {
  OperationSnapshot,
  StateSnapshotPage,
  StoragePolicy,
  StorageStatus,
  RetentionStatus,
} from './types.ts';
export type { StoragePolicy } from './types.ts';

const DAY = 86400000;
/** The largest write of the emergency reserve; the event loop runs between writes (W01). */
const RESERVE_CHUNK_BYTES = 1024 * 1024;
const defaults: StoragePolicy = {
  quotaBytes: 10 * 1024 ** 3,
  minFreeBytes: 1024 ** 3,
  emergencyBytes: 256 * 1024 ** 2,
  maxRecords: 1_000_000,
  settlementReserveRecords: 4096,
  maxSettlementPerTarget: 32,
  eventDays: 30,
  detailDays: 90,
  usageDays: 180,
};
const retainedTables = [
  'tasks',
  'sessions',
  'messages',
  'approvals',
  'dispatches',
  'artifacts',
  'usage',
  'execution_conflicts',
  'tool_calls',
  'costs',
] as const;
const terminalTasks = new Set(['completed', 'failed', 'cancelled']);
const terminalMessages = new Set([
  'consumed',
  'completed',
  'failed',
  'expired',
  'cancelled',
  'rejected',
]);
function references(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') found.add(value);
  else if (Array.isArray(value)) for (const child of value) references(child, found);
  else if (value && typeof value === 'object')
    for (const child of Object.values(value)) references(child, found);
  return found;
}
function policy(value: Partial<StoragePolicy>): StoragePolicy {
  const raw = object(value);
  fields(raw, Object.keys(defaults));
  const result = { ...defaults, ...value };
  for (const key of Object.keys(defaults) as (keyof StoragePolicy)[])
    integer(result[key], key, key === 'minFreeBytes' || key === 'emergencyBytes' ? 0 : 1);
  if (result.eventDays < 30 || result.detailDays < 90 || result.usageDays < 180)
    fail('VALIDATION_ERROR', 'Retention cannot be shorter than 30/90/180 days');
  if (result.settlementReserveRecords >= result.maxRecords)
    fail('VALIDATION_ERROR', 'Settlement reserve must fit within record capacity');
  return result;
}
export class StorageGovernance {
  readonly store: Store;
  policy: StoragePolicy;
  private snapshotDeadlines = new Map<string, number>();
  private monotonicNow: () => number;
  private reserving?: Promise<void>;
  constructor(
    store: Store,
    options: Partial<StoragePolicy> = {},
    monotonicNow = () => performance.now(),
  ) {
    this.monotonicNow = monotonicNow;
    this.store = store;
    this.policy = policy(JSON.parse(store.metadata('storagePolicy') ?? JSON.stringify(options)));
    for (const lease of store.db
      .prepare('SELECT id,created_at,expires_at FROM snapshots')
      .all() as { id: string; created_at: number; expires_at: number }[]) {
      const remaining =
        store.now() < lease.created_at
          ? 0
          : Math.max(0, Math.min(60000, lease.expires_at - store.now()));
      this.snapshotDeadlines.set(lease.id, monotonicNow() + remaining);
    }
    // Only recovery of already-recorded file actions happens at startup. Old data is not collected.
    // The owner of this object writes the emergency reserve with reserve() (SPEC-0028 W01).
    this.recoverGarbage();
  }
  /**
   * Writes a missing emergency reserve without blocking the event loop (SPEC-0028 W01, W02). Calls
   * during a write share it. The reserve is written to emergency.reserve.partial, synced, renamed
   * and its directory synced, so a file named emergency.reserve is always complete and admission's
   * check of it keeps its meaning.
   */
  reserve(): Promise<void> {
    this.reserving ??= this.writeReserve().finally(() => {
      this.reserving = undefined;
    });
    return this.reserving;
  }
  /** Resolves once no reserve write is in progress, whether or not it succeeded. */
  async settled(): Promise<void> {
    await this.reserving?.catch(() => {});
  }
  private async writeReserve(): Promise<void> {
    const path = join(this.store.stateDir, 'emergency.reserve');
    const partial = `${path}.partial`;
    const bytes = this.policy.emergencyBytes;
    // What an interrupted earlier write left is never renamed; start again.
    await rm(partial, { force: true });
    if (existsSync(path) || bytes === 0) return;
    const free = statfsSync(this.store.stateDir);
    if (free.bavail * free.bsize < bytes + this.policy.minFreeBytes) return;
    try {
      const handle = await open(partial, 'wx', 0o600);
      try {
        const chunk = Buffer.alloc(Math.min(RESERVE_CHUNK_BYTES, bytes));
        for (let offset = 0; offset < bytes; offset += chunk.length)
          await handle.write(chunk, 0, Math.min(chunk.length, bytes - offset));
        await handle.datasync();
      } finally {
        await handle.close();
      }
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    }
    const directory = await open(this.store.stateDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  status(): StorageStatus {
    const directoryBytes = (path: string): number =>
      readdirSync(path).reduce((sum, name) => {
        const child = join(path, name),
          stat = lstatSync(child);
        if (stat.isSymbolicLink()) {
          if (isCodexHelperLink(relative(this.store.stateDir, child))) return sum + stat.size;
          fail('UNTRUSTED_PATH', 'Managed storage contains a symlink');
        }
        return sum + (stat.isDirectory() ? directoryBytes(child) : stat.isFile() ? stat.size : 0);
      }, 0);
    const bytes = directoryBytes(this.store.stateDir);
    const count = this.store.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM tasks)+(SELECT COUNT(*) FROM sessions)+(SELECT COUNT(*) FROM messages)+(SELECT COUNT(*) FROM operations) AS count',
      )
      .get() as { count: number };
    const active = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE json_extract(data,'$.status') NOT IN ('completed','failed','cancelled')",
      )
      .get() as { count: number };
    const free = statfsSync(this.store.stateDir),
      availableBytes = free.bavail * free.bsize;
    const reservedRecords = Math.max(this.policy.settlementReserveRecords, active.count * 64);
    const reasons: string[] = [];
    if (bytes >= Math.floor(this.policy.quotaBytes * 0.9)) reasons.push('QUOTA');
    if (availableBytes < this.policy.minFreeBytes) reasons.push('FREE_SPACE');
    if (count.count + reservedRecords >= this.policy.maxRecords) reasons.push('RECORD_CAPACITY');
    if (this.store.metadata('admissionStopped') === 'true') reasons.push('SETTLEMENT_ONLY');
    if (this.store.degraded) reasons.push('STORAGE_DEGRADED');
    return {
      storeId: this.store.storeId,
      policy: { ...this.policy },
      bytes,
      availableBytes,
      records: count.count,
      reservedRecords,
      warning: bytes >= Math.floor(this.policy.quotaBytes * 0.8),
      backpressured: reasons.length > 0,
      reasons,
      retentionFloorCursor: this.store.metadata('retentionFloorCursor') ?? '0',
    };
  }
  admit(extraRecords = 4): void {
    this.store.assertWritable();
    const status = this.status();
    if (
      status.backpressured ||
      status.records + status.reservedRecords + extraRecords > this.policy.maxRecords
    )
      fail('STORAGE_BACKPRESSURE', 'New work cannot consume settlement capacity', { ...status });
    if (
      this.policy.emergencyBytes > 0 &&
      !existsSync(join(this.store.stateDir, 'emergency.reserve'))
    )
      fail('STORAGE_BACKPRESSURE', 'Emergency persistence reserve is unavailable');
  }
  settlement(method: string, target: string): void {
    if (!this.status().backpressured) return;
    const id = `${method}:${target}`,
      current = this.store.get<{ used: number }>('storage_reserves', id)?.used ?? 0;
    const used = this.store.db
      .prepare("SELECT COALESCE(SUM(json_extract(data,'$.used')),0) AS used FROM storage_reserves")
      .get() as { used: number };
    if (
      current >= this.policy.maxSettlementPerTarget ||
      used.used >= this.policy.settlementReserveRecords
    )
      fail(
        'SETTLEMENT_CAPACITY_EXHAUSTED',
        'Use the existing operation identity; settlement reserve is finite',
      );
    this.store.put('storage_reserves', id, { id, method, target, used: current + 1 });
  }
  configure(update: Partial<StoragePolicy>) {
    const next = policy({ ...this.policy, ...update });
    const save = () => {
      this.store.event('storage.policy_changed', {
        old: this.policy as any,
        next: next as any,
        actor: 'owner',
      });
      this.store.setMetadata('storagePolicy', JSON.stringify(next));
    };
    if (this.store.db.isTransaction) save();
    else this.store.transaction(save);
    const previous = this.policy;
    this.policy = next;
    try {
      return this.status();
    } finally {
      if (this.store.db.isTransaction) this.policy = previous;
    }
  }
  /** Takes the committed policy, and writes the reserve it asks for when missing (W02). */
  async reload(): Promise<void> {
    this.policy = policy(
      JSON.parse(this.store.metadata('storagePolicy') ?? JSON.stringify(this.policy)),
    );
    await this.reserve();
  }
  pin(ref: string, reason: string): void {
    string(ref, 'ref', 512);
    string(reason, 'reason', 2048);
    const record =
      [...retainedTables].map((table) => this.store.get<any>(table, ref)).find(Boolean) ??
      this.store.findOperationById(ref);
    const registered = !!record;
    if (record?.historyExpired)
      fail('HISTORY_EXPIRED', 'Collected detail cannot be restored by pinning');
    if (!registered) fail('NOT_FOUND', 'Only registered objects can be pinned');
    this.store.put('storage_pins', ref, { id: ref, ref, reason });
  }
  unpin(ref: string): void {
    this.store.remove('storage_pins', ref);
  }
  /**
   * Whether `id`, or a record that references it through any chain, is active or recent. A
   * session's references to its tasks are not followed (SPEC-0045 G01): a later task on the
   * session would otherwise keep every earlier task, and so the event prefix, from collection.
   */
  private isProtected(id: string): boolean {
    const row = this.store.db
      .prepare(
        `WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT refs.source_id FROM record_refs refs JOIN ancestors a ON refs.target_id=a.id
      WHERE NOT (refs.source_table='sessions' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=a.id))
    ) SELECT 1 AS protected FROM retention_records r JOIN ancestors a ON r.id=a.id
      WHERE r.active=1 OR (r.table_name IN ('tasks','messages') AND (r.terminal_at IS NULL OR r.terminal_at>?)) LIMIT 1`,
      )
      .get(id, this.store.now() - this.policy.detailDays * DAY);
    return !!row;
  }
  snapshot(
    params: { snapshotId?: string; offset?: number; limit?: number } = {},
  ): StateSnapshotPage {
    const limit = integer(params.limit ?? 64, 'limit', 1, 128),
      offset = integer(params.offset ?? 0, 'offset');
    if (!params.snapshotId && offset !== 0)
      fail('VALIDATION_ERROR', 'A page offset requires its original snapshotId');
    let id = params.snapshotId;
    if (!id) {
      if (this.activeSnapshots().length >= 64)
        fail('SNAPSHOT_LIMIT', 'At most 64 snapshot leases may be active');
      id = randomUUID();
      const snapshotId = id;
      this.snapshotDeadlines.set(id, this.monotonicNow() + 60000);
      this.store.transaction(() => {
        const cursor = String(
          (
            this.store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as {
              cursor: number;
            }
          ).cursor ||
            this.store.metadata('retentionFloorCursor') ||
            '0',
        );
        const floor = this.store.metadata('retentionFloorCursor') ?? '0';
        this.store.db
          .prepare('INSERT INTO snapshots VALUES (?,?,?,?,?)')
          .run(snapshotId, this.store.now(), this.store.now() + 60000, cursor, floor);
        let ordinal = 0;
        for (const table of ['tasks', 'sessions', 'approvals'] as const) {
          if (
            this.store.db
              .prepare(`SELECT 1 FROM ${table} WHERE length(CAST(data AS BLOB))>524200 LIMIT 1`)
              .get()
          )
            fail('FRAME_TOO_LARGE', 'Snapshot object exceeds the inline limit');
          this.store.db
            .prepare(
              `INSERT INTO snapshot_items SELECT ?, ? + row_number() OVER (ORDER BY id) - 1, json_object('kind', ?, 'value', json(data)) FROM ${table}`,
            )
            .run(snapshotId, ordinal, table);
          ordinal += (
            this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
          ).n;
        }
      });
    }
    const lease = this.store.db.prepare('SELECT * FROM snapshots WHERE id=?').get(id) as
      | { expires_at: number; cursor: string; floor: string }
      | undefined;
    if (
      !lease ||
      lease.expires_at <= this.store.now() ||
      this.monotonicNow() >= (this.snapshotDeadlines.get(id) ?? 0)
    )
      fail('SNAPSHOT_EXPIRED', 'Snapshot lease expired; start a new baseline');
    const rows = this.store.db
      .prepare(
        'SELECT ordinal,data FROM snapshot_items WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',
      )
      .all(id, offset, limit + 1) as { ordinal: number; data: string }[];
    let bytes = 0;
    const items: StateSnapshotPage['items'] = [];
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(row.data);
      if (bytes + size > 768 * 1024) break;
      bytes += size;
      items.push(JSON.parse(row.data));
    }
    return {
      snapshotId: id,
      storeId: this.store.storeId,
      cursor: lease.cursor,
      retentionFloorCursor: lease.floor,
      expiresAt: new Date(lease.expires_at).toISOString(),
      items,
      nextOffset: offset + items.length,
      done: rows.length <= items.length,
    };
  }
  releaseSnapshot(id: string): void {
    this.snapshotDeadlines.delete(id);
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM snapshot_items WHERE snapshot_id=?').run(id);
      this.store.db.prepare('DELETE FROM snapshots WHERE id=?').run(id);
    });
  }
  activeSnapshots(): string[] {
    return (
      this.store.db
        .prepare('SELECT id FROM snapshots WHERE expires_at>?')
        .all(this.store.now()) as { id: string }[]
    )
      .filter((row) => this.monotonicNow() < (this.snapshotDeadlines.get(row.id) ?? 0))
      .map((row) => row.id);
  }
  private recoverGarbage(): void {
    for (const job of this.store.all<any>('gc_jobs')) {
      if (job.status !== 'pending') continue;
      this.finishArtifact(job);
    }
  }
  private finishArtifact(job: { id: string; ref: string; sha256: string; status: string }): void {
    if (!/^[a-f0-9]{64}$/.test(job.sha256) || job.ref !== `sha256:${job.sha256}`)
      fail('ARTIFACT_CORRUPT', 'Invalid garbage job');
    const original = join(this.store.stateDir, 'artifacts', `${job.sha256}.txt`),
      quarantine = join(this.store.stateDir, 'quarantine', `${job.sha256}.txt`);
    if (this.isProtected(job.ref)) {
      if (!existsSync(quarantine) && !existsSync(original))
        fail('ARTIFACT_CORRUPT', 'Protected artifact is missing during collection recovery');
      if (existsSync(quarantine) && !existsSync(original)) {
        renameSync(quarantine, original);
        syncDirectory(join(this.store.stateDir, 'artifacts'));
      }
      this.store.put('gc_jobs', job.id, { ...job, status: 'protected' });
      return;
    }
    this.store.options.fault?.('gc.references_checked');
    if (existsSync(original)) {
      if (!lstatSync(original).isFile())
        fail('ARTIFACT_CORRUPT', 'Garbage path is not a regular file');
      renameSync(original, quarantine);
      syncDirectory(join(this.store.stateDir, 'quarantine'));
      syncDirectory(join(this.store.stateDir, 'artifacts'));
    }
    this.store.options.fault?.('gc.quarantined');
    if (existsSync(quarantine)) {
      unlinkSync(quarantine);
      syncDirectory(join(this.store.stateDir, 'quarantine'));
    }
    this.store.options.fault?.('gc.deleted');
    this.store.transaction(() => {
      const record = this.store.require<any>('artifacts', job.ref);
      this.store.put('artifacts', job.ref, {
        id: job.ref,
        sha256: job.sha256,
        sizeBytes: record.sizeBytes,
        historyExpired: true,
      });
      this.markCollected('artifacts', job.ref);
      this.store.put('gc_jobs', job.id, { ...job, status: 'completed' });
    });
    const journal = join(this.store.stateDir, 'file-commits', `${job.sha256}.json`);
    if (existsSync(journal)) unlinkSync(journal);
    this.store.options.fault?.('gc.registered');
  }
  /** SPEC-0033 S01: a record whose detail was collected is never a candidate again. */
  private markCollected(table: string, id: string): void {
    this.store.db
      .prepare('UPDATE retention_records SET collected=1 WHERE table_name=? AND id=?')
      .run(table, id);
  }
  /**
   * What collection has left, for `storage.status` only (SPEC-0033 S02, S03): counts capped at
   * 10,000, and where the next run would stop collecting events, from at most 500 events. The
   * scheduler's own checks never compute it.
   */
  retentionStatus(): RetentionStatus {
    const now = this.store.now();
    const cap = 10000;
    const eventCutoff = now - this.policy.eventDays * DAY;
    const detailCutoff = now - this.policy.detailDays * DAY;
    const events = this.store.db
      .prepare(
        `SELECT json_extract(data,'$.occurredAt') AS at FROM events ORDER BY cursor LIMIT ${cap + 1}`,
      )
      .all() as { at: string }[];
    const pastAge = events.filter((row) => Date.parse(row.at) <= eventCutoff);
    const pending = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM retention_records WHERE collected=0 AND terminal_at<=? AND table_name IN ('operations','messages','artifacts','usage') LIMIT ${cap + 1})`,
      )
      .get(detailCutoff) as { n: number };
    const oldestDetail = this.store.db
      .prepare(
        "SELECT MIN(terminal_at) AS at FROM retention_records WHERE collected=0 AND terminal_at<=? AND table_name IN ('operations','messages','artifacts','usage')",
      )
      .get(detailCutoff) as { at: number | null };
    const oldestEvent = pastAge.length ? Date.parse(pastAge[0].at) : null;
    const oldest = [oldestDetail.at, oldestEvent].filter((at): at is number => at !== null);
    return {
      eventsPastAge: Math.min(pastAge.length, cap),
      eventsPastAgeCapped: pastAge.length > cap || (events.length > cap && pastAge.length === cap),
      detailPending: Math.min(pending.n, cap),
      detailPendingCapped: pending.n > cap,
      oldestCollectableAt: oldest.length ? new Date(Math.min(...oldest)).toISOString() : null,
      eventPrefix: this.eventPrefix(eventCutoff),
    };
  }
  /** The event at which collection's continuous prefix stops, as `collect()` decides it. */
  private eventPrefix(cutoff: number): RetentionStatus['eventPrefix'] {
    const rows = this.store.db
      .prepare('SELECT cursor,taskId,data FROM events ORDER BY cursor LIMIT 500')
      .all() as { cursor: number; taskId: string | null; data: string }[];
    if (!rows.length) return { stoppedAtCursor: null, reason: null };
    const leases = this.store.db
      .prepare('SELECT cursor FROM snapshots WHERE expires_at>?')
      .all(this.store.now()) as { cursor: string }[];
    for (const row of rows) {
      const event = JSON.parse(row.data);
      const at = String(row.cursor);
      if (Date.parse(event.occurredAt) > cutoff) return { stoppedAtCursor: at, reason: 'age' };
      if (row.taskId && this.isProtected(row.taskId))
        return { stoppedAtCursor: at, reason: 'task', taskId: row.taskId };
      if (event.operationId && this.isProtected(event.operationId))
        return { stoppedAtCursor: at, reason: 'operation', operationId: event.operationId };
      if (leases.some((lease) => row.cursor > Number(lease.cursor)))
        return { stoppedAtCursor: at, reason: 'snapshot_lease' };
    }
    return { stoppedAtCursor: String(rows.at(-1)!.cursor), reason: 'scan_limit' };
  }
  collect() {
    this.store.assertWritable();
    this.recoverGarbage();
    const started = performance.now();
    let records = 0,
      bytes = 0;
    const cutoff = this.store.now() - this.policy.detailDays * DAY;
    const expired = this.store.db
      .prepare('SELECT id,expires_at FROM snapshots LIMIT 500')
      .all() as { id: string; expires_at: number }[];
    for (const lease of expired)
      if (
        lease.expires_at <= this.store.now() ||
        this.monotonicNow() >= (this.snapshotDeadlines.get(lease.id) ?? 0)
      )
        this.releaseSnapshot(lease.id);
    const candidates = this.store.db
      .prepare(
        "SELECT rowid,table_name,id FROM retention_records WHERE rowid>? AND terminal_at<=? AND collected=0 AND table_name IN ('operations','messages','artifacts','usage') ORDER BY rowid LIMIT 500",
      )
      .all(Number(this.store.metadata('gcScanCursor') ?? 0), cutoff) as {
      rowid: number;
      table_name: string;
      id: string;
    }[];
    let scanned = 0;
    const oversizedArtifacts: string[] = [];
    for (const candidate of candidates) {
      if (records >= 500 || bytes >= 8 * 1024 ** 2 || performance.now() - started > 50) break;
      scanned++;
      this.store.setMetadata('gcScanCursor', String(candidate.rowid));
      if (this.isProtected(candidate.id)) continue;
      const value =
        candidate.table_name === 'operations'
          ? this.store.findOperationById(candidate.id)
          : this.store.get<any>(candidate.table_name as Table, candidate.id);
      if (!value || value.historyExpired) {
        // Collected before its record was marked (S02), or gone: never a candidate again.
        this.markCollected(candidate.table_name, candidate.id);
        continue;
      }
      const size =
        Buffer.byteLength(JSON.stringify(value)) +
        (candidate.table_name === 'artifacts' ? Number(value.sizeBytes ?? 0) : 0);
      if (size > 8 * 1024 ** 2) {
        if (oversizedArtifacts.length < 16) oversizedArtifacts.push(candidate.id);
        continue;
      }
      if (bytes + size > 8 * 1024 ** 2) {
        // Leave the candidate for the next bounded batch rather than skipping it.
        this.store.setMetadata('gcScanCursor', String(candidate.rowid - 1));
        scanned--;
        break;
      }
      if (candidate.table_name === 'usage') {
        const age = this.store.db
          .prepare('SELECT terminal_at FROM retention_records WHERE table_name=? AND id=?')
          .get('usage', candidate.id) as { terminal_at: number };
        if (age.terminal_at > this.store.now() - this.policy.usageDays * DAY) continue;
      }
      if (candidate.table_name === 'artifacts') {
        const job = {
          id: candidate.id,
          ref: candidate.id,
          sha256: value.sha256,
          status: 'pending',
        };
        this.store.put('gc_jobs', job.id, job);
        this.store.options.fault?.('gc.marked');
        this.finishArtifact(job);
      } else {
        this.store.transaction(() => {
          if (candidate.table_name === 'operations') {
            const op = value as OperationSnapshot;
            this.store.saveOperation({
              id: op.id,
              method: op.method,
              scope: op.scope,
              idempotencyKey: op.idempotencyKey,
              status: op.status,
              targetId: op.targetId,
              result: {
                retainedRefs: [...references(op.result)].filter((ref) => ref.startsWith('sha256:')),
              },
              error: null,
              ...(op.retryIdentity ? { retryIdentity: op.retryIdentity } : {}),
              ...(op.resolution ? { resolution: op.resolution } : {}),
              historyExpired: true,
            } as OperationSnapshot);
          } else
            this.store.put(candidate.table_name as Table, candidate.id, {
              ...value,
              ...(candidate.table_name === 'messages'
                ? { summary: '', artifactRefs: [] }
                : { raw: {} }),
              historyExpired: true,
            });
          this.markCollected(candidate.table_name, candidate.id);
        });
      }
      records++;
      bytes += size;
    }
    if (scanned === candidates.length && candidates.length < 500)
      this.store.setMetadata('gcScanCursor', '0');
    // Events are collected only as a continuous prefix. A protected event stops the batch.
    const rows = this.store.db
      .prepare('SELECT cursor,taskId,data FROM events ORDER BY cursor LIMIT ?')
      .all(500 - records) as { cursor: number; taskId: string | null; data: string }[];
    const leases = this.store.db
      .prepare('SELECT cursor FROM snapshots WHERE expires_at>?')
      .all(this.store.now()) as { cursor: string }[];
    let last: number | undefined;
    for (const row of rows) {
      const event = JSON.parse(row.data),
        size = Buffer.byteLength(row.data);
      if (
        Date.parse(event.occurredAt) > this.store.now() - this.policy.eventDays * DAY ||
        (row.taskId && this.isProtected(row.taskId)) ||
        (event.operationId && this.isProtected(event.operationId)) ||
        leases.some((lease) => row.cursor > Number(lease.cursor)) ||
        bytes + size > 8 * 1024 ** 2 ||
        performance.now() - started > 50
      )
        break;
      last = row.cursor;
      records++;
      bytes += size;
    }
    if (last !== undefined)
      this.store.transaction(() => {
        this.store.db.prepare('DELETE FROM events WHERE cursor<=?').run(last!);
        this.store.setMetadata('retentionFloorCursor', String(last));
      });
    return {
      records,
      bytes,
      durationMs: performance.now() - started,
      oversizedArtifacts,
      retentionFloorCursor: this.store.metadata('retentionFloorCursor') ?? '0',
    };
  }
}
