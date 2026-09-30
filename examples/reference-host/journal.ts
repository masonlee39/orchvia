/**
 * The reference host's journal (SPEC-0050 J01): what the host submitted, keyed so that a resend is
 * the same request, and what it projected from the engine's events. The schema is `journal.sql`,
 * shared with the Python host.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type StepState = 'intended' | 'submitted' | 'attention';
export interface Step {
  runId: string;
  stepId: string;
  storeId: string;
  idempotencyKey: string;
  request: string;
  state: StepState;
  taskId: string | null;
  attention: string | null;
}
export interface Decision {
  runId: string;
  approvalId: string;
  storeId: string;
  idempotencyKey: string;
  request: string;
  state: StepState;
  operationId: string | null;
  attention: string | null;
}
export interface Command {
  idempotencyKey: string;
  runId: string;
  storeId: string;
  method: string;
  request: string;
  state: StepState;
  attention: string | null;
}
export interface Run {
  runId: string;
  recipeVersion: string;
  goal: string;
  createdAt: string;
}
export interface Projected {
  storeId: string;
  taskId: string;
  status: string;
  reason: string | null;
  cursor: string;
  blockedBy: string | null;
  blockedByAt: string | null;
}

const schema = readFileSync(new URL('./journal.sql', import.meta.url), 'utf8');

export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) return;
    // Every commit reaches the disk before the host sends what it recorded (invariant 1).
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(schema);
  }
  close() {
    this.db.close();
  }
  /** Runs `body` in one transaction; a throw rolls everything back. */
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  run(runId: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE runId=?').get(runId) as Run | undefined;
  }
  runs(): Run[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY createdAt, runId')
      .all() as unknown as Run[];
  }
  addRun(run: Run) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO runs (runId, recipeVersion, goal, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(run.runId, run.recipeVersion, run.goal, run.createdAt);
  }
  step(runId: string, stepId: string): Step | undefined {
    return this.db.prepare('SELECT * FROM steps WHERE runId=? AND stepId=?').get(runId, stepId) as
      | Step
      | undefined;
  }
  steps(runId?: string): Step[] {
    return (runId === undefined
      ? this.db.prepare('SELECT * FROM steps ORDER BY runId, rowid').all()
      : this.db
          .prepare('SELECT * FROM steps WHERE runId=? ORDER BY rowid')
          .all(runId)) as unknown as Step[];
  }
  intendStep(step: Omit<Step, 'state' | 'taskId' | 'attention'>) {
    this.db
      .prepare(
        "INSERT INTO steps (runId, stepId, storeId, idempotencyKey, request, state) VALUES (?, ?, ?, ?, ?, 'intended')",
      )
      .run(step.runId, step.stepId, step.storeId, step.idempotencyKey, step.request);
  }
  submitStep(runId: string, stepId: string, taskId: string) {
    this.db
      .prepare(
        "UPDATE steps SET state='submitted', taskId=?, attention=NULL WHERE runId=? AND stepId=?",
      )
      .run(taskId, runId, stepId);
  }
  stepAttention(runId: string, stepId: string, reason: string) {
    this.db
      .prepare("UPDATE steps SET state='attention', attention=? WHERE runId=? AND stepId=?")
      .run(reason, runId, stepId);
  }
  decision(runId: string, approvalId: string): Decision | undefined {
    return this.db
      .prepare('SELECT * FROM decisions WHERE runId=? AND approvalId=?')
      .get(runId, approvalId) as Decision | undefined;
  }
  decisions(runId?: string): Decision[] {
    return (runId === undefined
      ? this.db.prepare('SELECT * FROM decisions ORDER BY rowid').all()
      : this.db
          .prepare('SELECT * FROM decisions WHERE runId=? ORDER BY rowid')
          .all(runId)) as unknown as Decision[];
  }
  intendDecision(decision: Omit<Decision, 'state' | 'operationId' | 'attention'>) {
    this.db
      .prepare(
        "INSERT INTO decisions (runId, approvalId, storeId, idempotencyKey, request, state) VALUES (?, ?, ?, ?, ?, 'intended')",
      )
      .run(
        decision.runId,
        decision.approvalId,
        decision.storeId,
        decision.idempotencyKey,
        decision.request,
      );
  }
  submitDecision(runId: string, approvalId: string, operationId: string) {
    this.db
      .prepare(
        "UPDATE decisions SET state='submitted', operationId=? WHERE runId=? AND approvalId=?",
      )
      .run(operationId, runId, approvalId);
  }
  decisionAttention(runId: string, approvalId: string, reason: string) {
    this.db
      .prepare("UPDATE decisions SET state='attention', attention=? WHERE runId=? AND approvalId=?")
      .run(reason, runId, approvalId);
  }
  command(key: string): Command | undefined {
    return this.db.prepare('SELECT * FROM commands WHERE idempotencyKey=?').get(key) as
      | Command
      | undefined;
  }
  commands(runId?: string): Command[] {
    return (runId === undefined
      ? this.db.prepare('SELECT * FROM commands ORDER BY rowid').all()
      : this.db
          .prepare('SELECT * FROM commands WHERE runId=? ORDER BY rowid')
          .all(runId)) as unknown as Command[];
  }
  intendCommand(command: Omit<Command, 'state' | 'attention'>) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO commands (idempotencyKey, runId, storeId, method, request, state) VALUES (?, ?, ?, ?, ?, 'intended')",
      )
      .run(command.idempotencyKey, command.runId, command.storeId, command.method, command.request);
  }
  settleCommand(key: string, state: 'submitted' | 'attention', attention: string | null = null) {
    this.db
      .prepare('UPDATE commands SET state=?, attention=? WHERE idempotencyKey=?')
      .run(state, attention, key);
  }
  checkpoint(storeId: string): string | undefined {
    return (
      this.db.prepare('SELECT cursor FROM checkpoint WHERE storeId=?').get(storeId) as
        | { cursor: string }
        | undefined
    )?.cursor;
  }
  checkpoints(): { storeId: string; cursor: string }[] {
    return this.db.prepare('SELECT * FROM checkpoint').all() as unknown as {
      storeId: string;
      cursor: string;
    }[];
  }
  setCheckpoint(storeId: string, cursor: string) {
    this.db
      .prepare(
        'INSERT INTO checkpoint (storeId, cursor) VALUES (?, ?) ON CONFLICT(storeId) DO UPDATE SET cursor=excluded.cursor',
      )
      .run(storeId, cursor);
  }
  /** A task's state from an event; an older cursor never overwrites a newer one. */
  projectTask(
    storeId: string,
    taskId: string,
    status: string,
    reason: string | null,
    cursor: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO projection (storeId, taskId, status, reason, cursor) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(storeId, taskId) DO UPDATE SET status=excluded.status, reason=excluded.reason,
           cursor=excluded.cursor WHERE CAST(excluded.cursor AS INTEGER) > CAST(projection.cursor AS INTEGER)`,
      )
      .run(storeId, taskId, status, reason, cursor);
  }
  setBlockedBy(storeId: string, taskId: string, blockedBy: string | null, at: string) {
    this.db
      .prepare('UPDATE projection SET blockedBy=?, blockedByAt=? WHERE storeId=? AND taskId=?')
      .run(blockedBy, at, storeId, taskId);
  }
  projected(storeId: string, taskId: string): Projected | undefined {
    return this.db
      .prepare('SELECT * FROM projection WHERE storeId=? AND taskId=?')
      .get(storeId, taskId) as Projected | undefined;
  }
  projectApproval(
    storeId: string,
    approvalId: string,
    taskId: string,
    revision: number,
    criteria: string | null,
    cursor: string,
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO approvals (storeId, approvalId, taskId, revision, criteria, cursor) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(storeId, approvalId, taskId, revision, criteria, cursor);
  }
  approvals(storeId: string, taskId: string) {
    return this.db
      .prepare(
        'SELECT * FROM approvals WHERE storeId=? AND taskId=? ORDER BY CAST(cursor AS INTEGER)',
      )
      .all(storeId, taskId) as unknown as {
      approvalId: string;
      taskId: string;
      revision: number;
      criteria: string | null;
      cursor: string;
    }[];
  }
  projectUsage(
    storeId: string,
    usageRecordId: string,
    taskId: string,
    dispatchId: string,
    inputTokens: number | null,
    outputTokens: number | null,
    cursor: string,
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO usage (storeId, usageRecordId, taskId, dispatchId, inputTokens, outputTokens, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(storeId, usageRecordId, taskId, dispatchId, inputTokens, outputTokens, cursor);
  }
  usage(storeId: string, taskIds: string[]) {
    if (!taskIds.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM usage WHERE storeId=? AND taskId IN (${taskIds.map(() => '?').join(',')})`,
      )
      .all(storeId, ...taskIds) as unknown as {
      usageRecordId: string;
      taskId: string;
      dispatchId: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }[];
  }
  notice(storeId: string, code: string, detail: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO notices (storeId, code, detail) VALUES (?, ?, ?)')
      .run(storeId, code, detail);
  }
  notices(): { storeId: string; code: string; detail: string }[] {
    return this.db.prepare('SELECT * FROM notices').all() as unknown as {
      storeId: string;
      code: string;
      detail: string;
    }[];
  }
}
