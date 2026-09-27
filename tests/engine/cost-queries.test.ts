import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/engine/src/store.ts';
import { CostLedger, costSummary } from '../../packages/engine/src/cost-ledger.ts';
import { moneyString, moneyUnits } from '../../packages/engine/src/accounting.ts';
import type { CostRecord, TaskSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0033 P (#43): cost queries and budget checks read only the rows they concern, with the
// results of 0.1.8. The reference functions below are 0.1.8's, which read whole tables.

type Reservation = {
  id: string;
  taskId: string;
  rootTaskId: string;
  currency: string;
  initialUnits: string;
  remainingUnits: string;
  status: 'held' | 'settled';
};
function referenceSummary(
  store: Store,
  taskId: string | undefined,
  scope: 'direct' | 'tree' | 'host_overhead',
) {
  const descendants = new Set<string>(taskId ? [taskId] : []);
  if (taskId && scope === 'tree') {
    const tasks = store.all<TaskSnapshot>('tasks');
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks)
        if (
          task.spec.parentTaskId &&
          descendants.has(task.spec.parentTaskId) &&
          !descendants.has(task.id)
        ) {
          descendants.add(task.id);
          changed = true;
        }
    }
  }
  const rows = store
    .all<CostRecord>('costs')
    .filter((row) =>
      scope === 'host_overhead'
        ? row.category === 'host_overhead'
        : row.category === 'task' && (!taskId || descendants.has(row.costOwnerTaskId!)),
    );
  const totals: Record<string, bigint> = {};
  for (const row of rows)
    if (row.amountUnits !== null && row.currency)
      totals[row.currency] = (totals[row.currency] ?? 0n) + BigInt(row.amountUnits);
  const reservations = store
    .all<Reservation>('budget_reservations')
    .filter(
      (row) =>
        scope !== 'host_overhead' &&
        (!taskId || descendants.has(row.taskId)) &&
        row.status === 'held',
    );
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
function referenceOccupied(store: Store, currency: string, rootTaskId?: string): bigint {
  let total = 0n;
  for (const row of store.all<CostRecord>('costs'))
    if (
      row.currency === currency &&
      row.amountUnits !== null &&
      (!rootTaskId || row.rootTaskId === rootTaskId)
    )
      total += BigInt(row.amountUnits);
  for (const row of store.all<Reservation>('budget_reservations'))
    if (
      row.currency === currency &&
      row.status === 'held' &&
      (!rootTaskId || row.rootTaskId === rootTaskId)
    )
      total += BigInt(row.remainingUnits);
  return total;
}

/** A deterministic pseudo-random store: a deep chain, a wide tree, three currencies, unknowns. */
function seeded(rows: number) {
  const base = mkdtempSync(join(tmpdir(), 'orch-cost-queries-'));
  const workspace = join(base, 'workspace'),
    stateDir = join(base, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const store = new Store(workspace, stateDir, {});
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const tasks: TaskSnapshot[] = [];
  const task = (id: string, parent: TaskSnapshot | undefined): TaskSnapshot =>
    ({
      id,
      rootTaskId: parent ? (parent.rootTaskId ?? parent.id) : null,
      status: 'completed',
      spec: {
        runtime: { provider: 'p', model: 'm' },
        parentTaskId: parent?.id ?? null,
      },
    }) as unknown as TaskSnapshot;
  store.transaction(() => {
    // A chain deeper than any depth limit, and a wide second root.
    let parent: TaskSnapshot | undefined;
    for (let i = 0; i < 40; i++) {
      parent = task(`chain-${i}`, parent);
      tasks.push(parent);
    }
    const wide = task('wide', undefined);
    tasks.push(wide);
    for (let i = 0; i < 30; i++) tasks.push(task(`wide-${i}`, tasks[41 + next(i + 1)] ?? wide));
    for (const t of tasks) store.put('tasks', t.id, t);
    const currencies = ['USD', 'EUR', 'JPY'];
    for (let i = 0; i < rows; i++) {
      const owner = tasks[next(tasks.length)];
      const unknown = next(9) === 0;
      const overhead = next(23) === 0;
      store.put('costs', `c${i}`, {
        id: `c${i}`,
        usageRecordId: overhead ? null : `u${i}`,
        dispatchId: overhead ? null : `d${next(rows)}`,
        costOwnerTaskId: overhead ? null : owner.id,
        rootTaskId: overhead ? null : (owner.rootTaskId ?? owner.id),
        category: overhead ? 'host_overhead' : 'task',
        createdAt: '2026-09-27T00:00:00.000Z',
        currency: unknown ? null : currencies[next(3)],
        amount: null,
        amountUnits: unknown ? null : String(BigInt(next(10 ** 6)) * 10n ** 13n),
        pricingVersion: 'v1',
        completeness: unknown ? 'unknown' : 'estimated',
      });
      if (next(3) === 0)
        store.put('budget_reservations', `d${i}`, {
          id: `d${i}`,
          taskId: owner.id,
          rootTaskId: owner.rootTaskId ?? owner.id,
          currency: currencies[next(3)],
          initialUnits: String(10n ** 18n),
          remainingUnits: String(BigInt(next(1000)) * 10n ** 15n),
          status: next(4) === 0 ? 'held' : 'settled',
        } satisfies Reservation);
    }
  });
  return {
    store,
    tasks,
    close() {
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('0033-P02 costs.get has the results of 0.1.8 in every scope', () => {
  const f = seeded(3000);
  try {
    for (const scope of ['direct', 'tree', 'host_overhead'] as const)
      for (const taskId of [undefined, 'chain-0', 'chain-5', 'chain-39', 'wide', 'wide-3'])
        assert.deepEqual(
          costSummary(f.store, taskId, scope),
          referenceSummary(f.store, taskId, scope),
          `${scope} ${taskId}`,
        );
  } finally {
    f.close();
  }
});

test('0033-P03 budget checks have the decisions of 0.1.8', () => {
  const f = seeded(3000);
  const seen = new Set<string | null>();
  try {
    for (const [maxCost, reserve] of [
      ['1000', '1'],
      ['1', '0.5'],
      ['50', '0.25'],
      ['5000', '100'],
    ])
      for (const [currency, hostMax] of [
        ['USD', maxCost],
        ['EUR', '1000000'],
      ])
        for (const t of f.tasks.filter((_, i) => i % 7 === 0)) {
          const budget = { currency, maxCost, reservePerDispatch: reserve };
          const host = { currency, maxCost: hostMax, reservePerDispatch: reserve };
          const root = f.tasks.find((candidate) => candidate.id === (t.rootTaskId ?? t.id))!;
          const withBudgets = (task: TaskSnapshot, own: boolean) =>
            ({ ...task, spec: { ...task.spec, ...(own ? { budget } : {}) } }) as TaskSnapshot;
          f.store.put('tasks', root.id, withBudgets(root, true));
          const probe = withBudgets(t, t.id !== root.id);
          const ledger = new CostLedger(f.store, {
            workspace: '',
            stateDir: '',
            pricing: [
              {
                provider: 'p',
                model: 'm',
                currency,
                version: 'v1',
                inputTokenMode: 'uncached',
                perMillion: { input: '1', output: '1' },
              },
            ],
            budget: host,
          } as never);
          const expected = (() => {
            const units = moneyUnits(reserve);
            if (referenceOccupied(f.store, currency) + units > moneyUnits(hostMax))
              return 'HOST_BUDGET_EXHAUSTED';
            if (referenceOccupied(f.store, currency, root.id) + units > moneyUnits(maxCost))
              return 'TASK_BUDGET_EXHAUSTED';
            if (probe.id !== root.id) {
              let direct = 0n;
              for (const row of f.store.all<CostRecord>('costs'))
                if (row.costOwnerTaskId === probe.id && row.amountUnits !== null)
                  direct += BigInt(row.amountUnits);
              for (const row of f.store.all<Reservation>('budget_reservations'))
                if (row.taskId === probe.id && row.status === 'held')
                  direct += BigInt(row.remainingUnits);
              if (direct + units > moneyUnits(maxCost)) return 'TASK_BUDGET_EXHAUSTED';
            }
            return null;
          })();
          assert.equal(ledger.policy(probe).reason, expected, `${t.id} ${currency} ${maxCost}`);
          seen.add(expected);
          f.store.put('tasks', root.id, root);
        }
    assert.deepEqual(
      [...seen].sort(),
      ['HOST_BUDGET_EXHAUSTED', 'TASK_BUDGET_EXHAUSTED', null].sort(),
      'the data reaches every decision',
    );
  } finally {
    f.close();
  }
});

test('0033-P01 the cost and reservation queries use their indexes', () => {
  const f = seeded(10);
  try {
    const plan = (sql: string, ...args: unknown[]) =>
      (
        f.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join('; ');
    for (const [sql, index] of [
      ["SELECT data FROM costs WHERE json_extract(data,'$.costOwnerTaskId')=?", 'costs_owner'],
      ["SELECT data FROM costs WHERE json_extract(data,'$.rootTaskId')=?", 'costs_root'],
      ["SELECT data FROM costs WHERE json_extract(data,'$.dispatchId')=?", 'costs_dispatch'],
      [
        "SELECT data FROM costs WHERE json_extract(data,'$.category')='host_overhead'",
        'costs_overhead',
      ],
      [
        "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON json_extract(t.data,'$.spec.parentTaskId')=tree.id) SELECT data FROM costs WHERE json_extract(data,'$.costOwnerTaskId') IN (SELECT id FROM tree) ORDER BY rowid",
        'costs_owner',
      ],
      [
        "SELECT json_extract(data,'$.amountUnits') FROM costs WHERE json_extract(data,'$.currency')=? AND json_extract(data,'$.amountUnits') IS NOT NULL",
        'costs_currency_units',
      ],
      [
        "SELECT rowid AS ordinal, data FROM budget_reservations WHERE json_extract(data,'$.status')='held'",
        'reservations_held',
      ],
    ] as const)
      assert.match(
        plan(sql, ...(sql.includes('?') ? ['x'] : [])),
        new RegExp(`USING (COVERING )?INDEX ${index}\\b`),
        sql,
      );
  } finally {
    f.close();
  }
});

test('0033-P03 a root budget counts only its own tree’s held reservations', () => {
  const f = seeded(0);
  try {
    const budget = { currency: 'USD', maxCost: '1', reservePerDispatch: '0.5' };
    const root = { ...f.tasks[0], spec: { ...f.tasks[0].spec, budget } } as TaskSnapshot;
    f.store.put('tasks', root.id, root);
    const reserve = (id: string, rootTaskId: string, units: bigint) =>
      f.store.put('budget_reservations', id, {
        id,
        taskId: rootTaskId,
        rootTaskId,
        currency: 'USD',
        initialUnits: String(units),
        remainingUnits: String(units),
        status: 'held',
      } satisfies Reservation);
    reserve('other', 'wide', 9n * 10n ** 17n);
    const ledger = new CostLedger(f.store, {
      pricing: [
        {
          provider: 'p',
          model: 'm',
          currency: 'USD',
          version: 'v1',
          inputTokenMode: 'uncached',
          perMillion: { input: '1', output: '1' },
        },
      ],
    } as never);
    assert.equal(ledger.policy(root).reason, null, 'another root’s 0.9 does not count');
    reserve('own', root.id, 6n * 10n ** 17n);
    assert.equal(ledger.policy(root).reason, 'TASK_BUDGET_EXHAUSTED', 'its own 0.6 does');
  } finally {
    f.close();
  }
});
