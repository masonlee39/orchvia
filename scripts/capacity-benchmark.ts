/**
 * Bounded, offline measurement on owned temporary storage; never a production capacity claim.
 * node scripts/capacity-benchmark.ts [history,...] [runs] [--artifacts N,...] [--readers N]
 * SPEC-0052 P03: `--artifacts` puts N result files in the store first, each dispatch returns a
 * different result, and `--readers` clients read while tasks run, as a user interface would.
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createEngine, createFakeAdapter } from '../packages/engine/src/index.ts';
import type { TaskSnapshot } from '../packages/engine/src/types.ts';
import type { Store } from '../packages/engine/src/store.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
};
const artifactCounts = (flag('artifacts') ?? '0').split(',').map(Number);
const readers = Number(flag('readers') ?? 0);
const counts = (argv[0] ?? '1000,10000').split(',').map(Number);
const runs = Number(argv[1] ?? 100);
if (
  counts.some((n) => !Number.isInteger(n) || n < 0 || n > 50000) ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 500 ||
  artifactCounts.some((n) => !Number.isInteger(n) || n < 0 || n > 100000) ||
  !Number.isInteger(readers) ||
  readers < 0 ||
  readers > 16
)
  throw new Error(
    'Use history 0..50000, 1..500 fixture tasks, --artifacts 0..100000 and --readers 0..16',
  );
const rows = [];
for (const history of counts)
  for (const artifacts of artifactCounts) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-benchmark-'))),
      workspace = join(root, 'work'),
      stateDir = join(root, 'state');
    mkdirSync(workspace);
    let wall = Date.now(),
      calls = 0,
      peakRss = process.memoryUsage().rss;
    const toolReadMs: number[] = [];
    const base = createFakeAdapter({ result: 'capacity fixture' });
    const engine = await createEngine({
      workspace,
      stateDir,
      storage: { emergencyBytes: 4096, minFreeBytes: 0 },
      limits: { maxLogicalSessions: 100000 },
      tools: { enabled: true, maxRepeatedCalls: 100 },
      clock: {
        wallNow: () => wall,
        monotonicNow: () => performance.now(),
        setTimer(fn, delay) {
          const timer = setTimeout(fn, delay);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
      adapters: [
        {
          ...base,
          async *execute(input) {
            calls++;
            if (calls === 1) {
              if (!input.orchestrationTools) throw new Error('Bound tools were not enabled');
              for (let sample = 0; sample < 20; sample++) {
                const readStarted = performance.now();
                await input.orchestrationTools.call('work_read', {
                  kind: 'task',
                  id: input.taskId,
                });
                toolReadMs.push(performance.now() - readStarted);
              }
            }
            // A different result each time: each dispatch leaves its own artifact file, as in use.
            yield* createFakeAdapter({ result: `capacity fixture ${calls}` }).execute(input);
          },
        },
      ],
    });
    const store = (engine as unknown as { store: Store }).store;
    const latencies: number[] = [],
      dbBegin: number[] = [];
    const spec = {
      goal: 'capacity fixture',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human' as const, criteria: ['fixed fixture output'] },
    };
    const p95 = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
    const size = (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    const call = (method: string, params: Record<string, unknown> = {}) =>
      engine.call(
        method,
        { ...('idempotencyKey' in params ? { expectedStoreId: engine.storeId } : {}), ...params },
        { owner: true },
      );
    try {
      const seeding = performance.now();
      for (let start = 0; start < history; start += 250)
        store.transaction(() => {
          for (let n = start; n < Math.min(history, start + 250); n++) {
            const id = `history-${n}`,
              sessionId = `session-${n}`,
              date = new Date(wall).toISOString();
            store.put('sessions', sessionId, {
              id: sessionId,
              taskId: id,
              taskIds: [id],
              provider: 'fake',
              model: 'fixture',
              providerSessionId: null,
              generation: 1,
              revision: 1,
              status: 'idle',
              activeDispatchId: null,
            });
            store.put('tasks', id, {
              id,
              status: 'completed',
              revision: 1,
              sessionId,
              spec,
              artifactRefs: [],
              result: 'fixture',
              reason: null,
              approvalId: null,
              createdAt: date,
              updatedAt: date,
            });
            store.saveOperation(
              {
                id: `op-${n}`,
                method: 'tasks.create',
                scope: 'local',
                idempotencyKey: id,
                status: 'completed',
                targetId: id,
                result: { taskId: id },
                error: null,
              },
              id,
            );
            store.event('task.completed', { status: 'completed' }, { taskId: id, sessionId });
          }
        });
      // Retained results of earlier tasks: files only, without their records.
      for (let n = 0; n < artifacts; n++)
        writeFileSync(
          join(stateDir, 'artifacts', `${n.toString(16).padStart(64, '0')}.txt`),
          `retained result ${n}`,
        );
      const seedMs = performance.now() - seeding;
      wall += 200 * 86400000;
      const originalExec = store.db.exec.bind(store.db);
      store.db.exec = (sql: string) => {
        const started = performance.now();
        try {
          return originalExec(sql);
        } finally {
          if (sql.startsWith('BEGIN IMMEDIATE')) dbBegin.push(performance.now() - started);
        }
      };
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      const started = performance.now();
      const reads: Record<string, number[]> = {
        'tasks.list': [],
        'events.read': [],
        'usage.byTask': [],
      };
      let running = true,
        lastTaskId: string | undefined;
      const reader = async () => {
        while (running) {
          for (const [method, params] of [
            ['tasks.list', { limit: 50 }],
            ['events.read', { limit: 100 }],
            ['usage.byTask', lastTaskId ? { taskIds: [lastTaskId] } : undefined],
          ] as const) {
            if (!params) continue;
            const t = performance.now();
            await engine.call(method, params);
            reads[method].push(performance.now() - t);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const readerLoops = Array.from({ length: readers }, reader);
      for (let n = 0; n < runs; n++) {
        const admitted = performance.now();
        const task = (await call('tasks.create', {
          spec,
          idempotencyKey: `live-${n}`,
        })) as TaskSnapshot;
        latencies.push(performance.now() - admitted);
        lastTaskId = task.id;
        const deadline = performance.now() + 10000;
        let current: TaskSnapshot;
        do {
          await new Promise((r) => setImmediate(r));
          current = (await call('tasks.get', { taskId: task.id })) as TaskSnapshot;
          if (performance.now() > deadline) throw new Error('Fixture did not reach approval');
        } while (current.status !== 'waiting_approval');
        await call('approvals.decide', {
          approvalId: current.approvalId,
          decision: { choice: 'approve', expectedRevision: 1 },
          idempotencyKey: `approve-${n}`,
        });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      const elapsedMs = performance.now() - started;
      running = false;
      await Promise.all(readerLoops);
      const eventCount =
        (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n - history;
      const snapshotStart = performance.now();
      const snapshot = (await engine.call('state.snapshot', { limit: 128 })) as any;
      const snapshotMs = performance.now() - snapshotStart;
      await engine.call('state.releaseSnapshot', { snapshotId: snapshot.snapshotId });
      const gc = [];
      for (let n = 0; n < 3; n++) {
        const t = performance.now();
        const result = (await call('storage.gc', { idempotencyKey: `gc-${n}` })) as any;
        gc.push({ ...result.result, elapsedMs: performance.now() - t });
      }
      const storage = (await engine.call('storage.status')) as any;
      lag.disable();
      rows.push({
        historyTasks: history,
        historyRecords: history * 3,
        artifactFiles: artifacts,
        readers,
        readP95Ms: Object.fromEntries(
          Object.entries(reads)
            .filter(([, values]) => values.length)
            .map(([method, values]) => [method, p95(values)]),
        ),
        fixtureTasks: runs,
        seedMs,
        elapsedMs,
        dispatchesPerSecond: (1000 * calls) / elapsedMs,
        eventsPerSecond: (1000 * eventCount) / elapsedMs,
        admissionP95Ms: p95(latencies),
        toolReadSamples: toolReadMs.length,
        toolReadMeanMs: toolReadMs.reduce((total, value) => total + value, 0) / toolReadMs.length,
        toolReadP95Ms: p95(toolReadMs),
        sqliteBeginP95Ms: p95(dbBegin),
        eventLoopP95Ms: lag.percentile(95) / 1e6,
        eventLoopMaxMs: lag.max / 1e6,
        peakObservedRssBytes: peakRss,
        walBytes: size(join(stateDir, 'store.sqlite-wal')),
        databaseBytes: size(join(stateDir, 'store.sqlite')),
        storageBytes: storage.bytes,
        storageRecords: storage.records,
        snapshotFirstPageMs: snapshotMs,
        snapshotPageItems: snapshot.items.length,
        gc,
        modelCalls: 0,
        configuredMaxLogicalSessions: 100000,
      });
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 2000 });
      rmSync(root, { recursive: true, force: true });
    }
  }
console.log(
  JSON.stringify(
    {
      environment: {
        platform: process.platform,
        release: release(),
        arch: process.arch,
        node: process.version,
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model,
        physicalMemoryBytes: totalmem(),
      },
      limits:
        'Programmatic default maxLogicalSessions=10000; this experiment sets 100000 to seed 50000 sessions. Bound tool-read latency includes local SQLite work and is not a production latency guarantee. --artifacts files are written directly into the artifacts directory, without records, as retained results would be. SQLite BEGIN timing is not multi-writer throughput; no million-record or 10-GiB claim is made.',
      rows,
    },
    null,
    2,
  ),
);
