import { Store } from './store.ts';
import {
  moneyUnits,
  moneyString,
  priceUsage,
  validateBudget,
  validatePricing,
} from './accounting.ts';
import { fail } from './errors.ts';
import type {
  CostRecord,
  CostSummary,
  EngineConfig,
  TaskSnapshot,
  Pricing,
  UsageRecord,
  Json,
} from './types.ts';
type Cost = CostRecord;
interface Reservation {
  id: string;
  taskId: string;
  rootTaskId: string;
  currency: string;
  initialUnits: string;
  remainingUnits: string;
  status: 'held' | 'settled';
}
export class CostLedger {
  private store: Store;
  private config: EngineConfig;
  readonly pricing: Pricing[];
  constructor(store: Store, config: EngineConfig) {
    this.store = store;
    this.config = config;
    this.pricing = (config.pricing ?? []).map(validatePricing);
    if (new Set(this.pricing.map((p) => `${p.provider}:${p.model}`)).size !== this.pricing.length)
      fail('VALIDATION_ERROR', 'Duplicate provider/model pricing');
    if (config.budget) validateBudget(config.budget);
    for (const limit of Object.values(config.contextLimits ?? {}))
      if (
        !Number.isSafeInteger(limit.windowTokens) ||
        limit.windowTokens < 1 ||
        !Number.isSafeInteger(limit.safetyTokens) ||
        limit.safetyTokens < 0 ||
        limit.safetyTokens >= limit.windowTokens
      )
        fail('VALIDATION_ERROR', 'Invalid context capacity reserve');
  }
  private root(task: TaskSnapshot): TaskSnapshot {
    return this.store.require('tasks', task.rootTaskId ?? task.id);
  }
  /**
   * The amounts in `currency` spent and still reserved, host-wide or under one root task. Each
   * reads its rows through an index (SPEC-0033 P02, P03); amounts are summed as integers of
   * 10^-18, which exceed SQLite's integers, so the sum stays in JavaScript.
   */
  private occupied(currency: string, rootTaskId?: string): bigint {
    let total = 0n;
    if (rootTaskId) {
      for (const row of costRows(this.store, 'rootTaskId', rootTaskId))
        if (row.currency === currency && row.amountUnits !== null) total += BigInt(row.amountUnits);
    } else
      for (const { units } of this.store.db
        .prepare(
          "SELECT json_extract(data,'$.amountUnits') AS units FROM costs WHERE json_extract(data,'$.currency')=? AND json_extract(data,'$.amountUnits') IS NOT NULL",
        )
        .all(currency) as { units: string }[])
        total += BigInt(units);
    for (const row of heldReservations(this.store))
      if (row.currency === currency && (!rootTaskId || row.rootTaskId === rootTaskId))
        total += BigInt(row.remainingUnits);
    return total;
  }
  policy(task: TaskSnapshot): {
    reason: string | null;
    pricing?: Pricing;
    reserve?: string;
    currency?: string;
  } {
    // Only a task that a runtime runs is dispatched, so it has a runtime (SPEC-0065 H02).
    const runtime = task.spec.runtime!;
    const pricing = this.pricing.find(
      (p) => p.provider === runtime.provider && p.model === runtime.model,
    );
    const context = this.config.contextLimits?.[`${runtime.provider}/${runtime.model}`];
    if (context) {
      const estimate = task.spec.contextEstimate;
      if (!estimate) return { reason: 'CONTEXT_ESTIMATE_REQUIRED' };
      if (
        estimate.inputTokens +
          estimate.outputReserveTokens +
          estimate.toolReserveTokens +
          context.safetyTokens >
        context.windowTokens
      )
        return { reason: 'CONTEXT_CAPACITY' };
    }
    const root = this.root(task),
      budget = root.spec.budget,
      host = this.config.budget;
    const effective = task.spec.budget ?? budget ?? host;
    if (!effective) return { reason: null, pricing };
    if (
      !pricing ||
      pricing.currency !== effective.currency ||
      (host && host.currency !== effective.currency) ||
      (budget && budget.currency !== effective.currency)
    )
      return { reason: 'BUDGET_PRICE_UNKNOWN' };
    const reserve = moneyUnits(effective.reservePerDispatch);
    if (host && this.occupied(host.currency) + reserve > moneyUnits(host.maxCost))
      return { reason: 'HOST_BUDGET_EXHAUSTED' };
    if (budget && this.occupied(budget.currency, root.id) + reserve > moneyUnits(budget.maxCost))
      return { reason: 'TASK_BUDGET_EXHAUSTED' };
    if (task.id !== root.id && task.spec.budget) {
      let direct = 0n;
      for (const row of costRows(this.store, 'costOwnerTaskId', task.id))
        if (row.amountUnits !== null) direct += BigInt(row.amountUnits);
      for (const row of heldReservations(this.store))
        if (row.taskId === task.id) direct += BigInt(row.remainingUnits);
      if (direct + reserve > moneyUnits(task.spec.budget.maxCost))
        return { reason: 'TASK_BUDGET_EXHAUSTED' };
    }
    return { reason: null, pricing, reserve: reserve.toString(), currency: effective.currency };
  }
  reserve(
    task: TaskSnapshot,
    dispatchId: string,
  ): { costOwnerTaskId: string; rootTaskId: string; pricing?: Pricing } {
    const policy = this.policy(task);
    if (policy.reason) fail(policy.reason, 'Cost/context admission changed before dispatch');
    const rootTaskId = task.rootTaskId ?? task.id;
    if (policy.reserve)
      this.store.put('budget_reservations', dispatchId, {
        id: dispatchId,
        taskId: task.id,
        rootTaskId,
        currency: policy.currency!,
        initialUnits: policy.reserve,
        remainingUnits: policy.reserve,
        status: 'held',
      } satisfies Reservation);
    return {
      costOwnerTaskId: task.id,
      rootTaskId,
      ...(policy.pricing ? { pricing: policy.pricing } : {}),
    };
  }
  record(usage: UsageRecord, dispatch: Record<string, unknown>, createdAt: string): void {
    const dispatchPricing = dispatch.pricing as Pricing | undefined;
    // SPEC-0031 B03: a record of another model takes that model's registered price, in the
    // dispatch's currency; without one its cost is unknown.
    const pricing =
      !dispatchPricing || usage.model === undefined || usage.model === dispatchPricing.model
        ? dispatchPricing
        : this.pricing.find(
            (p) =>
              p.provider === usage.provider &&
              p.model === usage.model &&
              p.currency === dispatchPricing.currency,
          );
    const priced = pricing
      ? priceUsage(usage, pricing)
      : {
          amount: null,
          amountUnits: null,
          currency: null,
          pricingVersion: null,
          completeness: 'unknown',
          reason: 'pricing_not_registered',
        };
    const cost: Cost = {
      id: usage.id,
      usageRecordId: usage.id,
      dispatchId: usage.dispatchId,
      costOwnerTaskId: String(dispatch.costOwnerTaskId ?? usage.taskId),
      rootTaskId: String(dispatch.rootTaskId ?? usage.taskId),
      category: 'task',
      createdAt,
      ...(priced as unknown as Record<string, Json>),
      currency: priced.currency,
      amount: priced.amount,
      amountUnits: priced.amountUnits,
    };
    this.store.put('costs', cost.id, cost);
    this.settle(usage.dispatchId);
  }
  settle(dispatchId: string): void {
    const reserve = this.store.get<Reservation>('budget_reservations', dispatchId);
    if (!reserve) return;
    const dispatch = this.store.require<Record<string, unknown>>('dispatches', dispatchId);
    const records = costRows(this.store, 'dispatchId', dispatchId);
    const spent = records.reduce((n, row) => n + BigInt(row.amountUnits ?? '0'), 0n);
    const terminal = dispatch.terminalEvidence as { usageComplete?: boolean } | undefined;
    const complete =
      terminal?.usageComplete === true &&
      records.length > 0 &&
      records.every((r) => r.amountUnits !== null);
    const unsent = !!dispatch.preSubmissionEvidenceRef && dispatch.runtimeAccepted !== true;
    reserve.status = complete || unsent ? 'settled' : 'held';
    reserve.remainingUnits =
      reserve.status === 'settled'
        ? '0'
        : (BigInt(reserve.initialUnits) > spent
            ? BigInt(reserve.initialUnits) - spent
            : 0n
          ).toString();
    this.store.put('budget_reservations', dispatchId, reserve);
  }
  summary(taskId: string | undefined, scope: 'direct' | 'tree' | 'host_overhead'): CostSummary {
    return costSummary(this.store, taskId, scope);
  }
}
/** The cost records whose `field` is `value`, in recording order, through its index (P01). */
function costRows(
  store: Store,
  field: 'costOwnerTaskId' | 'rootTaskId' | 'dispatchId',
  value: string,
): Cost[] {
  return (
    store.db
      .prepare(`SELECT data FROM costs WHERE json_extract(data,'$.${field}')=? ORDER BY rowid`)
      .all(value) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as Cost);
}
/**
 * Reservations still held, in creation order, through the partial index `reservations_held`. The
 * few held rows are ordered here: `ORDER BY rowid` makes SQLite scan the table instead.
 */
function heldReservations(store: Store): Reservation[] {
  return (
    store.db
      .prepare(
        "SELECT rowid AS ordinal, data FROM budget_reservations WHERE json_extract(data,'$.status')='held'",
      )
      .all() as { ordinal: number; data: string }[]
  )
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => JSON.parse(row.data) as Reservation);
}
/** The result of `costs.get`, for the engine and a read-only view (SPEC-0027 R03). */
export function costSummary(
  store: Store,
  taskId: string | undefined,
  scope: 'direct' | 'tree' | 'host_overhead',
): CostSummary {
  if (taskId) store.require('tasks', taskId);
  // SPEC-0033 P02: a task's tree at any depth through tasks_parent, then the records of its tasks
  // through costs_owner, in recording order.
  const tree =
    "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON json_extract(t.data,'$.spec.parentTaskId')=tree.id)";
  const descendants = new Set<string>(taskId ? [taskId] : []);
  if (taskId && scope === 'tree')
    for (const { id } of store.db.prepare(`${tree} SELECT id FROM tree`).all(taskId) as {
      id: string;
    }[])
      descendants.add(id);
  const parsed = (statement: string, ...args: string[]) =>
    (store.db.prepare(statement).all(...args) as { data: string }[]).map(
      (row) => JSON.parse(row.data) as Cost,
    );
  const rows =
    scope === 'host_overhead'
      ? parsed(
          "SELECT data FROM costs WHERE json_extract(data,'$.category')='host_overhead' ORDER BY rowid",
        )
      : !taskId
        ? store.all<Cost>('costs').filter((row) => row.category === 'task')
        : (scope === 'tree'
            ? parsed(
                `${tree} SELECT data FROM costs WHERE json_extract(data,'$.costOwnerTaskId') IN (SELECT id FROM tree) ORDER BY rowid`,
                taskId,
              )
            : costRows(store, 'costOwnerTaskId', taskId)
          ).filter((row) => row.category === 'task');
  const totals: Record<string, bigint> = {};
  for (const row of rows)
    if (row.amountUnits !== null && row.currency)
      totals[row.currency] = (totals[row.currency] ?? 0n) + BigInt(row.amountUnits);
  const reservations =
    scope === 'host_overhead'
      ? []
      : heldReservations(store).filter((row) => !taskId || descendants.has(row.taskId));
  return {
    scope,
    totals: Object.fromEntries(
      Object.entries(totals).map(([currency, n]) => [currency, moneyString(n)]),
    ),
    unknownRecords: rows.filter((row) => row.amountUnits === null).length,
    records: rows.slice(0, 500),
    recordsTruncated: rows.length > 500,
    recordCount: rows.length,
    reservations: reservations
      .slice(0, 100)
      .map((row) => ({ ...row, remaining: moneyString(BigInt(row.remainingUnits)) })),
    reservationsTruncated: reservations.length > 100,
    basis: 'registered-price estimate; not a provider bill',
    settlementIncomplete: reservations.length > 0,
  };
}
