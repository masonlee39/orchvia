"""The Python reference host (SPEC-0050): the same workflow, journal and recovery as host.ts.

It starts its engine through the JSON CLI (`orchvia host --stdio`), which names its providers
`fake`, `claude` and `codex` and allows `workspace-write` only for `fake`. Both steps therefore run
on the one fake provider here, and a Python host cannot run the change step on a real model today
(SPEC-0050 D-0050-4). See README.md for how to run it.

    python3 examples/reference-host/host.py start --root DIR --run ID --goal TEXT
    python3 examples/reference-host/host.py advance|abandon --root DIR --run ID
    python3 examples/reference-host/host.py decide --root DIR --run ID --choice approve|deny|revise [--comment TEXT]
    python3 examples/reference-host/host.py reconcile --root DIR --run ID --outcome interrupted --summary TEXT
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import sys
import time
from typing import Any, Iterator, Mapping

from orchvia import Orchestrator, OrchestrationError

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RECIPE_VERSION = "1"
NEVER_RESEND = {"IDEMPOTENCY_CONFLICT", "OPERATION_HISTORY_EXPIRED", "STORE_NAMESPACE_MISMATCH",
                "OUTCOME_UNKNOWN", "VALIDATION_ERROR", "UNSUPPORTED_CAPABILITY", "UNAUTHORIZED",
                "STALE_TARGET"}
NEXT_STEP = {
    "running": "none: the engine is working",
    "attention": "a person: see the attention reason",
    "tests_failed": "a person: the tests failed after the repairs; abandon the run or start a new one",
    "needs_reconcile": "the owner: check what ran, then reconcile; never resend",
    "awaiting_review": "the reviewer: approve, deny or revise",
    "done": "none: accepted",
    "rejected": "none: the reviewer denied the result",
    "abandoned": "none: abandoned",
    "ended": "a person: the run ended without a result; start a new one",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def step_key(run_id: str, step_id: str) -> str:
    return f"refhost/{run_id}/{step_id}"


def change_spec(run_id: str, goal: str) -> dict[str, Any]:
    return {"goal": f"Change the code: {goal}", "runtime": {"provider": "fake", "model": "fixture"},
            "acceptance": {"mode": "checks", "ruleRefs": [{"id": "tests", "version": "1"}], "maxRepairs": 1},
            "label": f"refhost:{run_id}",
            "metadata": {"runId": run_id, "stepId": "change", "recipeVersion": RECIPE_VERSION}}


def review_spec(run_id: str, change_task_id: str) -> dict[str, Any]:
    return {"goal": f"Review the change of task {change_task_id}: name each problem with its evidence",
            "runtime": {"provider": "fake", "model": "fixture"},
            "acceptance": {"mode": "human", "criteria": ["Each problem the review names comes with its evidence"]},
            "dependencyTaskIds": [change_task_id],
            "contextPlan": {"requestedMode": "fresh", "independent": True, "dependencyTaskIds": [change_task_id],
                            "contextRefs": [], "fallbackModes": [], "maxQueueWaitMs": 600000},
            "label": f"refhost:{run_id}",
            "metadata": {"runId": run_id, "stepId": "review", "recipeVersion": RECIPE_VERSION}}


def run_state(steps: list[dict[str, Any]], tasks: Mapping[str, Mapping[str, Any] | None]) -> str:
    """The same states as recipe.ts runState()."""
    if any(step["state"] == "attention" for step in steps):
        return "attention"
    change, review = tasks.get("change"), tasks.get("review")
    for task in (change, review):
        if task and task["status"] == "blocked" and str(task["reason"] or "").startswith("outcome_unknown"):
            return "needs_reconcile"
    if change and change["status"] == "blocked" and change["reason"] == "verification_failed":
        return "tests_failed"
    if change and change["status"] == "cancelled" and (not review or review["status"] == "cancelled"):
        return "abandoned"
    if change and change["status"] in ("failed", "cancelled"):
        if not review or review["status"] in ("blocked", "cancelled"):
            return "ended"
    if not review:
        return "running"
    return {"waiting_approval": "awaiting_review", "completed": "done", "failed": "rejected",
            "cancelled": "abandoned", "blocked": "ended"}.get(review["status"], "running")


def field(value: Mapping[str, Any], camel: str, snake: str) -> Any:
    """The Python SDK renames known wire fields; raw JSON keeps its keys."""
    return value.get(snake, value.get(camel))


class Journal:
    """The journal of journal.sql (SPEC-0050 J01), shared with host.ts and inspect.ts."""

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        # Every commit reaches the disk before the host sends what it recorded (invariant 1).
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript((HERE / "journal.sql").read_text(encoding="utf-8"))

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def one(self, sql: str, *args: Any) -> dict[str, Any] | None:
        row = self.db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.execute(sql, args).fetchall()]

    def x(self, sql: str, *args: Any) -> None:
        self.db.execute(sql, args)

    def step(self, run_id: str, step_id: str):
        return self.one("SELECT * FROM steps WHERE runId=? AND stepId=?", run_id, step_id)

    def steps(self, run_id: str | None = None):
        if run_id is None:
            return self.all("SELECT * FROM steps ORDER BY runId, rowid")
        return self.all("SELECT * FROM steps WHERE runId=? ORDER BY rowid", run_id)

    def step_attention(self, run_id: str, step_id: str, reason: str) -> None:
        self.x("UPDATE steps SET state='attention', attention=? WHERE runId=? AND stepId=?", reason, run_id, step_id)

    def submit_step(self, run_id: str, step_id: str, task_id: str) -> None:
        self.x("UPDATE steps SET state='submitted', taskId=?, attention=NULL WHERE runId=? AND stepId=?",
               task_id, run_id, step_id)

    def projected(self, store_id: str, task_id: str):
        return self.one("SELECT * FROM projection WHERE storeId=? AND taskId=?", store_id, task_id)

    def checkpoint(self, store_id: str) -> str | None:
        row = self.one("SELECT cursor FROM checkpoint WHERE storeId=?", store_id)
        return row["cursor"] if row else None


def code(error: BaseException) -> str:
    return getattr(error, "code", "") or ""


async def resolve_step(journal: Journal, client: Any, step: Mapping[str, Any]) -> None:
    """Invariant 4, as resolveStep() in host.ts."""
    run_id, step_id = step["runId"], step["stepId"]
    if step["storeId"] != client.info.store_id:
        journal.step_attention(run_id, step_id, f"store_changed: recorded in store {step['storeId']}, "
                               f"the host now has {client.info.store_id}; never resend it")
        return
    try:
        found = await client.operations.lookup(method="tasks.create", scope="local",
                                               idempotency_key=step["idempotencyKey"])
    except OrchestrationError as error:
        if error.code == "NOT_FOUND":
            found = None
        elif error.code in NEVER_RESEND:
            journal.step_attention(run_id, step_id, f"{error.code}: {error}")
            return
        else:
            raise
    if found is not None:
        if found["status"] == "completed":
            journal.submit_step(run_id, step_id, field(found, "targetId", "target_id"))
        else:
            journal.step_attention(run_id, step_id, f"OUTCOME_UNKNOWN: the create's operation is {found['status']}")
        return
    await send_step(journal, client, step)


async def _nothing(task_id: str) -> None:
    return None


async def send_step(journal: Journal, client: Any, step: Mapping[str, Any], after_send=_nothing) -> None:
    try:
        task = await client.tasks.create(json.loads(step["request"]), idempotency_key=step["idempotencyKey"])
    except OrchestrationError as error:
        if error.code not in NEVER_RESEND:
            raise
        journal.step_attention(step["runId"], step["stepId"], f"{error.code}: {error}")
        return
    await after_send(task.id)
    journal.submit_step(step["runId"], step["stepId"], task.id)


class ReferenceHost:
    def __init__(self, root: Path, node: str, emergency_bytes: int | None, fault: str | None):
        self.root, self.node, self.emergency_bytes, self.fault_point = root, node, emergency_bytes, fault
        (root / "workspace").mkdir(parents=True, exist_ok=True)
        (root / "state").mkdir(mode=0o700, parents=True, exist_ok=True)
        self.journal = Journal(root / "journal.sqlite")
        self.orch: Any = None
        self.store_id = ""
        self.engine_restarts = 0

    def fault(self, point: str) -> None:
        """Ends the host and its engine at once at a named point, as a crash would (SPEC-0050 F)."""
        if self.fault_point == point:
            os.killpg(os.getpgrp(), signal.SIGKILL)

    def config(self) -> Path:
        hold = self.fault_point in ("during-dispatch", "engine-exit", "after-send")
        settings: dict[str, Any] = {
            "workspace": str(self.root / "workspace"), "stateDir": str(self.root / "state"),
            "providers": {"fake": {"model": "fixture", "permissionProfile": "workspace-write",
                                   "usage": {"inputTokens": 100, "outputTokens": 20},
                                   # F02, F04 and F06 hold the change's dispatch; a restarted engine does not.
                                   "delayMs": 3600000 if hold and not self.engine_restarts else 0}},
            "verificationRules": [{"id": "tests", "version": "1",
                                   "argv": [self.node, "-e", "process.exit(require('node:fs').existsSync('tests-pass') ? 0 : 1)"],
                                   "cwdRelative": ".", "timeoutMs": 10000, "permissionProfile": "read-only",
                                   "success": {"exitCode": 0}}],
            "approvalTtlMs": 604800000,
        }
        if self.emergency_bytes is not None:
            settings["storage"] = {"emergencyBytes": self.emergency_bytes}
        path = self.root / "host.json"
        path.write_text(json.dumps(settings), encoding="utf-8")
        return path

    async def open(self) -> None:
        command = [self.node, str(ROOT / "packages/cli/src/main.ts"), "host", "--stdio", "--config", str(self.config())]
        if self.fault_point == "engine-exit":
            # Records the engine's process ID so that F06 can end the engine alone.
            command = ["sh", "-c", 'echo $$ > "$0"; exec "$@"', str(self.root / "engine.pid"), *command]
        self.orch = await Orchestrator.local(engine_command=command, poll_interval=0.02, close_timeout=3)
        self.store_id = self.orch.info.store_id

    async def close(self) -> None:
        try:
            await self.orch.close(mode="interrupt", timeout=3)
        except OrchestrationError:
            pass

    async def recover(self) -> None:
        for step in self.journal.steps():
            if step["state"] == "intended":
                await resolve_step(self.journal, self.orch, step)
        for decision in self.journal.all("SELECT * FROM decisions WHERE state='intended'"):
            await self.resolve_decision(decision["runId"], decision["approvalId"])
        for command in self.journal.all("SELECT * FROM commands WHERE state='intended'"):
            await self.resolve_command(command["idempotencyKey"])
        await self.project()

    async def project(self) -> None:
        """Invariant 5: each event and the checkpoint after it commit together. The Python SDK reads
        events through an iterator, so the unit of commit is one event."""
        cursor = self.journal.checkpoint(self.store_id) or "0"
        events = self.orch.events(after_cursor=cursor, store_id=self.store_id, limit=256).__aiter__()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(events.__anext__(), timeout=0.2)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    return
                except OrchestrationError as error:
                    if error.code != "CURSOR_EXPIRED":
                        raise
                    reason = error.data.get("reason", "unknown")
                    self.journal.x("INSERT OR REPLACE INTO notices (storeId, code, detail) VALUES (?, ?, ?)",
                                   self.store_id, "CURSOR_EXPIRED", f"CURSOR_EXPIRED: {reason} at {cursor}")
                    return
                # F03 fires on the event that asks for the review's decision, when nothing runs.
                if event.type == "approval.requested":
                    self.fault("before-projection-commit")
                with self.journal.transaction():
                    accepted = self.apply(event)
                    self.journal.x("INSERT INTO checkpoint (storeId, cursor) VALUES (?, ?) ON CONFLICT(storeId) "
                                   "DO UPDATE SET cursor=excluded.cursor", self.store_id, event.cursor)
                if accepted:
                    self.fault("during-dispatch")
                    if self.fault_point == "engine-exit" and not self.engine_restarts:
                        os.kill(int((self.root / "engine.pid").read_text().strip()), signal.SIGKILL)
        finally:
            try:
                await events.aclose()
            except (OrchestrationError, RuntimeError):
                pass

    def apply(self, event: Any) -> bool:
        data, task_id, cursor = event.data, event.task_id, event.cursor
        if event.type.startswith("task.") and task_id:
            self.journal.x(
                "INSERT INTO projection (storeId, taskId, status, reason, cursor) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(storeId, taskId) DO UPDATE SET status=excluded.status, reason=excluded.reason, "
                "cursor=excluded.cursor WHERE CAST(excluded.cursor AS INTEGER) > CAST(projection.cursor AS INTEGER)",
                self.store_id, task_id, data["status"], data.get("reason"), cursor)
        elif event.type == "approval.requested" and task_id and field(data, "approvalId", "approval_id"):
            self.journal.x("INSERT OR IGNORE INTO approvals (storeId, approvalId, taskId, revision, criteria, cursor) "
                           "VALUES (?, ?, ?, ?, ?, ?)", self.store_id, field(data, "approvalId", "approval_id"),
                           task_id, int(data["revision"]), json.dumps(data.get("summary")), cursor)
        elif event.type == "usage.recorded" and task_id:
            self.journal.x("INSERT OR IGNORE INTO usage (storeId, usageRecordId, taskId, dispatchId, inputTokens, "
                           "outputTokens, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)", self.store_id,
                           field(data, "usageRecordId", "usage_record_id"), task_id,
                           field(data, "dispatchId", "dispatch_id"), field(data, "inputTokens", "input_tokens"),
                           field(data, "outputTokens", "output_tokens"), cursor)
        return event.type == "dispatch.runtime_accepted" and any(
            step["stepId"] == "change" and step["taskId"] == task_id for step in self.journal.steps())

    def state(self, run_id: str) -> str:
        if self.journal.one("SELECT 1 FROM notices WHERE storeId=?", self.store_id):
            return "attention"
        steps = self.journal.steps(run_id)
        tasks = {step["stepId"]: self.journal.projected(self.store_id, step["taskId"]) for step in steps if step["taskId"]}
        return run_state(steps, tasks)

    async def intend_and_send(self, run_id: str, step_id: str, request: dict[str, Any]) -> None:
        self.journal.x("INSERT INTO steps (runId, stepId, storeId, idempotencyKey, request, state) "
                       "VALUES (?, ?, ?, ?, ?, 'intended')", run_id, step_id, self.store_id,
                       step_key(run_id, step_id), json.dumps(request))
        self.fault("after-intent")
        async def after_send(task_id: str) -> None:
            if self.fault_point != "after-send":
                return
            # F02: the engine committed and started the task; the receipt is not yet on disk.
            while (await self.orch.tasks.get(task_id)).status != "running":
                await asyncio.sleep(0.01)
            self.fault("after-send")

        await send_step(self.journal, self.orch, self.journal.step(run_id, step_id), after_send)

    async def advance(self, run_id: str, timeout: float = 60) -> str:
        """Drives a run until a person must act or it ended. F06: when the engine child dies, calls in
        flight are unknown; the host starts the engine again and recovers before going on."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                return await self._advance(run_id, deadline)
            except OrchestrationError as error:
                if error.code != "CONNECTION_CLOSED" or self.engine_restarts >= 3:
                    raise
                self.engine_restarts += 1
                await self.close()
                await self.open()
                await self.recover()

    async def _advance(self, run_id: str, deadline: float) -> str:
        run = self.journal.one("SELECT * FROM runs WHERE runId=?", run_id)
        if run is None:
            raise RuntimeError(f"No run {run_id}")
        state = "running"
        while time.monotonic() < deadline:
            await self.project()
            change, review = self.journal.step(run_id, "change"), self.journal.step(run_id, "review")
            if change is None:
                await self.intend_and_send(run_id, "change", change_spec(run_id, run["goal"]))
            # Invariant 3: the review waits for the change's receipt; the engine holds it until the
            # change completes (W02).
            elif change["state"] == "submitted" and review is None:
                await self.intend_and_send(run_id, "review", review_spec(run_id, change["taskId"]))
            state = self.state(run_id)
            if state != "running":
                break
            await asyncio.sleep(0.02)
        await self.record_blocked_by(run_id)
        return state

    async def record_blocked_by(self, run_id: str) -> None:
        ids = [step["taskId"] for step in self.journal.steps(run_id) if step["taskId"]]
        if not ids:
            return
        # The events of a step sent in the last pass are projected first, so that each has its row.
        await self.project()
        result = await self.orch.tasks.get_many(ids)
        at = now()
        with self.journal.transaction():
            for task in result.tasks:
                blocked = task.get("blocked_by")
                self.journal.x("UPDATE projection SET blockedBy=?, blockedByAt=? WHERE storeId=? AND taskId=?",
                               json.dumps(_plain(blocked)) if blocked else None, at, self.store_id, task.id)

    async def start(self, run_id: str, goal: str) -> str:
        self.journal.x("INSERT OR IGNORE INTO runs (runId, recipeVersion, goal, createdAt) VALUES (?, ?, ?, ?)",
                       run_id, RECIPE_VERSION, goal, now())
        return await self.advance(run_id)

    async def decide(self, run_id: str, choice: str, comment: str | None) -> str:
        review = self.journal.step(run_id, "review")
        if not review or not review["taskId"] or \
                (self.journal.projected(self.store_id, review["taskId"]) or {}).get("status") != "waiting_approval":
            raise RuntimeError(f"Run {run_id} has no review waiting for a decision")
        approval = self.journal.all("SELECT * FROM approvals WHERE storeId=? AND taskId=? ORDER BY CAST(cursor AS INTEGER)",
                                    self.store_id, review["taskId"])[-1]
        if not self.journal.one("SELECT 1 FROM decisions WHERE runId=? AND approvalId=?", run_id, approval["approvalId"]):
            decision = {"choice": choice, "expectedRevision": approval["revision"],
                        **({"comment": comment} if comment is not None else {})}
            self.journal.x("INSERT INTO decisions (runId, approvalId, storeId, idempotencyKey, request, state) "
                           "VALUES (?, ?, ?, ?, ?, 'intended')", run_id, approval["approvalId"], self.store_id,
                           f"refhost/{run_id}/{approval['approvalId']}/decide", json.dumps(decision))
            await self.send_decision(run_id, approval["approvalId"])
        return await self.advance(run_id)

    async def send_decision(self, run_id: str, approval_id: str) -> None:
        decision = self.journal.one("SELECT * FROM decisions WHERE runId=? AND approvalId=?", run_id, approval_id)
        try:
            operation = await self.orch.approvals.decide(approval_id, json.loads(decision["request"]),
                                                         idempotency_key=decision["idempotencyKey"])
        except OrchestrationError as error:
            if error.code not in NEVER_RESEND:
                raise
            self.journal.x("UPDATE decisions SET state='attention', attention=? WHERE runId=? AND approvalId=?",
                           f"{error.code}: {error}", run_id, approval_id)
            return
        self.fault("after-decide-send")
        self.journal.x("UPDATE decisions SET state='submitted', operationId=? WHERE runId=? AND approvalId=?",
                       operation.id, run_id, approval_id)

    async def resolve_decision(self, run_id: str, approval_id: str) -> None:
        decision = self.journal.one("SELECT * FROM decisions WHERE runId=? AND approvalId=?", run_id, approval_id)
        if decision["storeId"] != self.store_id:
            self.journal.x("UPDATE decisions SET state='attention', attention=? WHERE runId=? AND approvalId=?",
                           "store_changed: never resend it", run_id, approval_id)
            return
        try:
            found = await self.orch.operations.lookup(method="approvals.decide", scope=approval_id,
                                                      idempotency_key=decision["idempotencyKey"])
        except OrchestrationError as error:
            if error.code == "NOT_FOUND":
                await self.send_decision(run_id, approval_id)
                return
            if error.code not in NEVER_RESEND:
                raise
            self.journal.x("UPDATE decisions SET state='attention', attention=? WHERE runId=? AND approvalId=?",
                           f"{error.code}: {error}", run_id, approval_id)
            return
        self.journal.x("UPDATE decisions SET state='submitted', operationId=? WHERE runId=? AND approvalId=?",
                       found["id"], run_id, approval_id)

    async def command(self, run_id: str, key: str, method: str, request: dict[str, Any]) -> None:
        self.journal.x("INSERT OR IGNORE INTO commands (idempotencyKey, runId, storeId, method, request, state) "
                       "VALUES (?, ?, ?, ?, ?, 'intended')", key, run_id, self.store_id, method, json.dumps(request))
        if self.journal.one("SELECT state FROM commands WHERE idempotencyKey=?", key)["state"] == "intended":
            await self.resolve_command(key)

    async def resolve_command(self, key: str) -> None:
        command = self.journal.one("SELECT * FROM commands WHERE idempotencyKey=?", key)
        settle = lambda state, attention=None: self.journal.x(
            "UPDATE commands SET state=?, attention=? WHERE idempotencyKey=?", state, attention, key)
        if command["storeId"] != self.store_id:
            settle("attention", "store_changed: never resend it")
            return
        request = json.loads(command["request"])
        scope = request["taskId"] if command["method"] == "tasks.cancel" else request["target"]["sessionId"]
        try:
            await self.orch.operations.lookup(method=command["method"], scope=scope, idempotency_key=key)
            settle("submitted")
            return
        except OrchestrationError as error:
            if error.code != "NOT_FOUND":
                if error.code not in NEVER_RESEND:
                    raise
                settle("attention", f"{error.code}: {error}")
                return
        try:
            if command["method"] == "tasks.cancel":
                operation = await self.orch.tasks.cancel(request["taskId"], idempotency_key=key)
            else:
                operation = await self.orch.sessions.reconcile(request["target"], request["evidence"], idempotency_key=key)
            await operation.wait(timeout=10)
            settle("submitted")
        except OrchestrationError as error:
            if error.code not in NEVER_RESEND:
                raise
            settle("attention", f"{error.code}: {error}")

    async def abandon(self, run_id: str) -> str:
        for step_id in ("change", "review"):
            step = self.journal.step(run_id, step_id)
            if step and step["taskId"]:
                await self.command(run_id, f"refhost/{run_id}/cancel-{step_id}", "tasks.cancel", {"taskId": step["taskId"]})
        return await self.advance(run_id)

    async def reconcile(self, run_id: str, outcome: str, summary: str) -> str:
        for step in self.journal.steps(run_id):
            if not step["taskId"]:
                continue
            task = await self.orch.tasks.get(step["taskId"])
            if task.status != "blocked" or not str(task.reason or "").startswith("outcome_unknown"):
                continue
            session = await self.orch.sessions.get(task.session_id)
            await self.command(run_id, f"refhost/{run_id}/reconcile-{step['stepId']}-{session.active_dispatch_id}",
                               "sessions.reconcile", {
                                   "target": {"sessionId": session.id, "expectedGeneration": session.generation,
                                              "expectedRevision": session.revision,
                                              "expectedDispatchId": session.active_dispatch_id,
                                              "expectedState": session.status},
                                   "evidence": {"source": "owner_attestation", "summary": summary,
                                                "localResources": "stopped", "remoteExecution": "stopped",
                                                "sideEffects": "resolved", "outcome": outcome}})
        return await self.advance(run_id)

    def report(self, run_id: str, state: str) -> dict[str, Any]:
        steps = []
        for step in self.journal.steps(run_id):
            projected = self.journal.projected(self.store_id, step["taskId"]) if step["taskId"] else None
            steps.append({"step": step["stepId"], "state": step["state"], "taskId": step["taskId"],
                          **(projected or {}), "attention": step["attention"]})
        return {"run": run_id, "state": state, "next": NEXT_STEP[state], "steps": steps,
                "notices": self.journal.all("SELECT * FROM notices")}


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["start", "advance", "decide", "abandon", "reconcile"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--goal", default="the requested change")
    parser.add_argument("--choice", choices=["approve", "deny", "revise"])
    parser.add_argument("--comment")
    parser.add_argument("--outcome", default="interrupted")
    parser.add_argument("--summary", default="")
    parser.add_argument("--fault")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--emergency-bytes", type=int)
    args = parser.parse_args()
    if not args.node:
        raise SystemExit("Node.js 22.18+ is required")
    host = ReferenceHost(Path(args.root).resolve(), args.node, args.emergency_bytes, args.fault)
    await host.open()
    try:
        await host.recover()
        if args.command == "start":
            state = await host.start(args.run, args.goal)
        elif args.command == "decide":
            state = await host.decide(args.run, args.choice, args.comment)
        elif args.command == "abandon":
            state = await host.abandon(args.run)
        elif args.command == "reconcile":
            state = await host.reconcile(args.run, args.outcome, args.summary)
        else:
            state = await host.advance(args.run)
        print(json.dumps(host.report(args.run, state)))
    finally:
        await host.close()


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
