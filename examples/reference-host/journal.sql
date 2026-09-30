-- The reference host's journal (SPEC-0050 J01). Both hosts load this file, so that either
-- host, and the inspector, read what the other wrote. The engine's store stays authoritative for
-- tasks, scheduling and acceptance; this journal holds only what the host submitted and what it
-- has projected.
CREATE TABLE IF NOT EXISTS runs (
  runId TEXT PRIMARY KEY,
  recipeVersion TEXT NOT NULL,
  goal TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
-- One row per step. `state`: intended (intent committed, no receipt), submitted (receipt
-- committed) or attention (a person must act; `attention` says why).
CREATE TABLE IF NOT EXISTS steps (
  runId TEXT NOT NULL,
  stepId TEXT NOT NULL,
  storeId TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended', 'submitted', 'attention')),
  taskId TEXT,
  attention TEXT,
  PRIMARY KEY (runId, stepId)
);
-- One row per human decision on an approval, with the same states as steps.
CREATE TABLE IF NOT EXISTS decisions (
  runId TEXT NOT NULL,
  approvalId TEXT NOT NULL,
  storeId TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended', 'submitted', 'attention')),
  operationId TEXT,
  attention TEXT,
  PRIMARY KEY (runId, approvalId)
);
-- Owner commands that are not steps: abandon and reconcile, keyed the same way.
CREATE TABLE IF NOT EXISTS commands (
  idempotencyKey TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  storeId TEXT NOT NULL,
  method TEXT NOT NULL,
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended', 'submitted', 'attention')),
  attention TEXT
);
-- Where projection stopped, per store. Advanced only in the transaction that applies the events.
CREATE TABLE IF NOT EXISTS checkpoint (
  storeId TEXT PRIMARY KEY,
  cursor TEXT NOT NULL
);
-- The last task state projected from events, and the host's last read of `blockedBy`.
CREATE TABLE IF NOT EXISTS projection (
  storeId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  cursor TEXT NOT NULL,
  blockedBy TEXT,
  blockedByAt TEXT,
  PRIMARY KEY (storeId, taskId)
);
CREATE TABLE IF NOT EXISTS approvals (
  storeId TEXT NOT NULL,
  approvalId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  criteria TEXT,
  cursor TEXT NOT NULL,
  PRIMARY KEY (storeId, approvalId)
);
-- One row per engine usage record; a null count is unknown and never read as 0.
CREATE TABLE IF NOT EXISTS usage (
  storeId TEXT NOT NULL,
  usageRecordId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  dispatchId TEXT NOT NULL,
  inputTokens INTEGER,
  outputTokens INTEGER,
  cursor TEXT NOT NULL,
  PRIMARY KEY (storeId, usageRecordId)
);
-- Run-level attention that belongs to no step, such as an expired cursor.
CREATE TABLE IF NOT EXISTS notices (
  storeId TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (storeId, code)
);
