import { createHash } from 'node:crypto';

export const MUTATIONS = new Set([
  'tasks.create',
  'tasks.resume',
  'tasks.cancel',
  'messages.send',
  'sessions.open',
  'sessions.fork',
  'sessions.compact',
  'sessions.rotate',
  'sessions.control',
  'sessions.steer',
  'sessions.reconcile',
  'approvals.decide',
  'scheduler.resolveConflict',
  'costs.recordOverhead',
  'host.shutdown',
  'host.shutdown.continue',
  'storage.configure',
  'storage.gc',
  'storage.pin',
  'storage.unpin',
  'storage.backup',
  'stores.rollover',
  'stores.import',
  'rules.register',
  'rules.retire',
  'handoffs.resolve',
]);
export interface RetryIdentity {
  storeId: string;
  method: string;
  scope: string;
  idempotencyKey: string;
  digestVersion: 1;
  requestDigest: string;
}

// Version 1 uses binary64 numbers and UTF-8 sorted object keys in both SDKs.
function normalize(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Only finite JSON numbers are supported');
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value);
    return `n${bytes.toString('hex')}`;
  }
  if (value === null) return 'z';
  if (typeof value === 'string') return `s${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (Array.isArray(value)) return `[${value.map(normalize).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => `${normalize(key)}:${normalize((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new TypeError('Expected JSON data');
}
export function requestDigest(method: string, params: Record<string, unknown>): string {
  const {
    expectedStoreId: _store,
    idempotencyKey: _key,
    requestDigest: _digest,
    ...payload
  } = params;
  return createHash('sha256')
    .update(`agent-orch-request-v1:${normalize({ method, payload })}`)
    .digest('hex');
}
export function requestScope(method: string, params: Record<string, unknown>): string {
  if (method.startsWith('tasks.') && method !== 'tasks.create') return String(params.taskId);
  if (method.startsWith('sessions.') && method !== 'sessions.open')
    return String((params.target as any)?.sessionId);
  if (method === 'messages.send') return String((params.spec as any)?.toSessionId);
  if (method === 'approvals.decide') return String(params.approvalId);
  if (method === 'scheduler.resolveConflict') return String(params.conflictId);
  if (method === 'handoffs.resolve') return String(params.handoffId);
  if (method === 'costs.recordOverhead') return 'host';
  return 'local';
}
