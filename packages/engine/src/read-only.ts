import { randomUUID } from 'node:crypto';
import { fail } from './errors.ts';
import { SHARED_READS, readCall } from './reads.ts';
import { recoveryPending } from './recovery.ts';
import { Store } from './store.ts';
import { fields, object, string } from './validation.ts';
import { effectiveRules } from './verification.ts';
import { VERSION } from './version.ts';
import type { CallContext, Engine, RegisteredVerificationRule } from './types.ts';

/** What `store.info` returns for a store opened read-only (SPEC-0027 R05, R07). */
export interface ReadOnlyStoreInfo {
  storeId: string;
  schemaVersion: 3;
  role: 'active' | 'standby' | 'retired' | 'archive';
  workspace: string;
  /** Whether starting an engine on this store would change rows during recovery. */
  recoveryPending: boolean;
}

/** An engine that answers reads from a store it opened read-only (SPEC-0027 R). */
export interface ReadOnlyEngine extends Engine {
  readonly readOnly: true;
}

class ReadOnlyView implements ReadOnlyEngine {
  readonly readOnly = true;
  readonly instanceId = randomUUID();
  readonly storeId: string;
  private readonly store: Store;
  private readonly shutdownId = randomUUID();
  private closed = false;
  constructor(store: Store) {
    this.store = store;
    this.storeId = store.storeId;
  }

  async call(
    method: string,
    raw: Record<string, unknown> = {},
    context: CallContext = {},
  ): Promise<unknown> {
    if (this.closed) fail('CLIENT_CLOSED', 'This read-only view is closed');
    const p = object(raw);
    switch (method) {
      case 'initialize':
        fields(p, ['protocolVersion', 'sdkVersion']);
        if (p.protocolVersion !== '2.0') fail('PROTOCOL_MISMATCH', 'Expected protocolVersion 2.0');
        string(p.sdkVersion, 'sdkVersion', 128);
        return {
          protocolVersion: '2.0',
          engineVersion: VERSION,
          schemaVersion: 3,
          instanceId: this.instanceId,
          storeId: this.storeId,
          capabilities: {
            readOnly: { version: 1 },
            events: 'cursor-pull',
            storeNamespaces: { version: 1, digestVersion: 1 },
            workflow: {
              version: 1,
              handoffs: true,
              runtimeRules: true,
              taskList: true,
              contextCheck: true,
              labels: true,
              // The reads of SPEC-0028 P and U; a view has no scheduler, so no queue reasons (B03).
              taskQueries: true,
              ruleRetirement: true,
              usageByTask: true,
              reasoningEfforts: true,
            },
          },
        };
      case 'host.shutdown':
      case 'host.shutdown.continue':
        if (!context.owner) fail('UNAUTHORIZED', 'Only the host owner can close the engine');
        if (p.expectedStoreId !== undefined && p.expectedStoreId !== this.storeId)
          fail('STORE_NAMESPACE_MISMATCH', 'Request belongs to another store', {
            expectedStoreId: p.expectedStoreId,
            currentStoreId: this.storeId,
          });
        return this.close();
      case 'store.info':
        fields(p, []);
        return this.read(
          (): ReadOnlyStoreInfo => ({
            storeId: this.storeId,
            schemaVersion: 3,
            role: (this.store.metadata('role') ?? 'active') as ReadOnlyStoreInfo['role'],
            workspace: this.store.workspace,
            recoveryPending: recoveryPending(this.store),
          }),
        );
      case 'rules.list':
        // Offline, only the rules registered at runtime are known; a configuration's are not.
        fields(p, ['includeRetired']);
        if (p.includeRetired !== undefined && typeof p.includeRetired !== 'boolean')
          fail('VALIDATION_ERROR', 'includeRetired must be a boolean');
        return this.read(() => {
          const { rules, retired } = effectiveRules(
            this.store.workspace,
            undefined,
            this.store.all('verification_rules'),
          );
          return {
            rules: [...rules, ...(p.includeRetired ? retired : [])].map(
              (rule): RegisteredVerificationRule => ({ ...rule, source: 'runtime' }),
            ),
          };
        });
      default:
        if (SHARED_READS.has(method)) return this.read(() => readCall(this.store, method, p));
        return fail(
          'READ_ONLY',
          `${method} needs a running engine; a store opened read-only answers reads only`,
          { method },
        );
    }
  }

  /** One read transaction per call, so that a call sees one snapshot (SPEC-0027 R03). */
  private read<T>(fn: () => T): T {
    this.store.db.exec('BEGIN');
    try {
      return fn();
    } finally {
      if (this.store.db.isTransaction) this.store.db.exec('COMMIT');
    }
  }

  async close(): Promise<{ status: 'closed'; operationId: string }> {
    if (!this.closed) {
      this.closed = true;
      this.store.close();
    }
    return { status: 'closed', operationId: this.shutdownId };
  }
}

/**
 * Opens a store for reading without an engine: no lock, recovery, scheduler, adapters, reserve or
 * write of any kind (SPEC-0027 R01). Writes and live-host reads fail with READ_ONLY (R06).
 */
export async function openReadOnlyEngine(options: { stateDir: string }): Promise<ReadOnlyEngine> {
  return new ReadOnlyView(Store.openReadOnly(options.stateDir));
}
