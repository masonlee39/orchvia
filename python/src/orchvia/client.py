"""Standard-library asyncio SDK for the single local orchestration engine."""
import asyncio
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
import inspect
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple, cast
from uuid import uuid4

from .identity import request_digest
from .errors import OrchestrationError, ShutdownIncomplete, unsupported
from .transport import RpcTransport
from .types import ReconcileEvidence, Snapshot, TaskSpec, snapshot, to_wire
from ._version import VERSION as SDK_VERSION
# SPEC-0033 Y02: results are Snapshots at run time; their views describe them to type checkers.
from .views import (ApprovalRequestView, ExecutionConflictView, HandoffListResultView, HandoffRequestView,
                    InitializeResultView, MessageReceiptView, MessageSnapshotView, OperationReceiptView,
                    OperationSnapshotView, RuleListResultView, SessionReceiptView, TaskReceiptView,
                    RuntimeInspectionView, SchedulerSnapshotView, SessionSnapshotView, SnapshotPageView,
                    TaskGetManyResultView, TaskListResultView, TaskSnapshotView, UsageByTaskResultView,
                    UsageRecordView, UsageSummaryView)


PROTOCOL_VERSION = "2.0"
_TASK_TERMINAL = {"completed", "failed", "cancelled"}
_OPERATION_TERMINAL = {"completed", "noop", "rejected", "failed", "outcome_unknown"}


def _duration(value: float, name: str, *, zero: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise OrchestrationError("VALIDATION_ERROR", f"{name} must be a finite number")
    if value < 0 or (value == 0 and not zero):
        raise OrchestrationError("VALIDATION_ERROR", f"{name} must be {'nonnegative' if zero else 'positive'}")
    return float(value)


if TYPE_CHECKING:
    # Only for type checkers: at run time a Protocol base would hide the Snapshot's fields.
    class _TaskBase(Snapshot, TaskReceiptView): ...
    class _OperationBase(Snapshot, OperationReceiptView): ...
else:
    _TaskBase = _OperationBase = Snapshot


class SettledTask(NamedTuple):
    """Where settling a task stopped (SPEC-0044 T01): `reason` is terminal, waiting_approval, paused
    or blocked; `approval` is the undecided pending approval, `session` a blocked task's session."""
    task: TaskSnapshotView
    reason: str
    approval: ApprovalRequestView | None = None
    session: SessionSnapshotView | None = None


class TaskHandle(_TaskBase):
    __slots__ = ("_client",)
    def __init__(self, client: "Orchestrator", value: Snapshot):
        super().__init__(value)
        self._client = client

    async def get(self) -> TaskSnapshotView:
        return await self._client.tasks.get(self.id)

    async def cancel(self, *, idempotency_key: str | None = None):
        return await self._client.tasks.cancel(self.id, idempotency_key=idempotency_key)

    async def resume(self, *, idempotency_key: str | None = None):
        return await self._client.tasks.resume(self.id, idempotency_key=idempotency_key)

    async def wait(self, *, timeout: float | None = None) -> TaskSnapshotView:
        return cast(TaskSnapshotView, await self._client._wait(lambda: self._client.tasks.get(self.id), _TASK_TERMINAL, timeout))

    async def settle(self, *, on_approval: Callable[..., Any] | None = None,
                     timeout: float | None = None) -> SettledTask:
        """Reads the task until it ends, is paused or blocked, or waits for an approval that no handler
        decides (SPEC-0044 T). `on_approval(approval, task)` is called once per pending approval and
        revision; returning "approve" or "deny" submits it and settling goes on, anything else ends
        settling. It never decides by itself, and never retries, resends or reconciles anything."""
        client = self._client
        handled: set[str] = set()
        if timeout is not None:
            _duration(timeout, "timeout", zero=True)
        try:
            async with asyncio.timeout(timeout):
                while True:
                    task = await client.tasks.get(self.id)
                    if task.status in _TASK_TERMINAL:
                        return SettledTask(task, "terminal")
                    if task.status == "paused":
                        return SettledTask(task, "paused")
                    if task.status == "blocked":
                        return SettledTask(task, "blocked", session=await client.sessions.get(task.session_id))
                    approval_id = getattr(task, "approval_id", None)
                    if task.status == "waiting_approval" and approval_id:
                        approval = await client.approvals.get(approval_id)
                        identity = f"{approval.approval_id}:{approval.revision}"
                        if approval.status == "pending":
                            if on_approval is None or identity in handled:
                                return SettledTask(task, "waiting_approval", approval=approval)
                            handled.add(identity)
                            choice = on_approval(approval, task)
                            if inspect.isawaitable(choice):
                                choice = await choice
                            if choice not in ("approve", "deny"):
                                return SettledTask(task, "waiting_approval", approval=approval)
                            await client.approvals.decide(approval.approval_id,
                                                          {"choice": choice, "expected_revision": approval.revision})
                            continue
                    await asyncio.sleep(client._poll_interval)
        except TimeoutError:
            raise OrchestrationError("TIMEOUT", "Local settle timed out; remote task was not cancelled") from None


class OperationHandle(_OperationBase):
    __slots__ = ("_client",)
    def __init__(self, client: "Orchestrator", value: Snapshot):
        super().__init__(value)
        self._client = client

    async def wait(self, *, timeout: float | None = None) -> OperationSnapshotView:
        return cast(OperationSnapshotView, await self._client._wait(lambda: self._client.operations.get(self.id), _OPERATION_TERMINAL, timeout))


# Engine errors that can follow a commit, or whose commit is unknown: a retry identity that meets
# one is kept, so that a retry goes to the original request's store (SPEC-0027 K04).
_KEEP_IDENTITY = frozenset({
    "RESOURCE_CLEANUP_INCOMPLETE", "ROLLOVER_IN_PROGRESS", "ROLLOVER_BLOCKED", "STORE_SWITCH_IN_PROGRESS",
    "SHUTDOWN_INCOMPLETE", "OUTCOME_UNKNOWN", "OPERATION_HISTORY_EXPIRED", "IDEMPOTENCY_CONFLICT",
    "INTERNAL_ERROR", "STORAGE_DEGRADED",
})
# Retry identities kept per client; the least recently used goes first (SPEC-0027 K03).
_MAX_IDENTITIES = 10_000


class _Tasks:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def create(self, spec: TaskSpec | Mapping[str, Any], *, idempotency_key: str | None = None) -> TaskHandle:
        wire = to_wire(spec)
        if "writePath" in wire:
            await self._client._require_workflow("write_path")
        if "label" in wire or "metadata" in wire:
            await self._client._require_workflow("labels")
        return TaskHandle(self._client, await self._client._mutate("tasks.create", {"spec": wire}, idempotency_key))

    async def get(self, task_id: str) -> TaskSnapshotView:
        return cast(TaskSnapshotView, await self._client._call("tasks.get", {"taskId": task_id}))

    async def list(self, *, parent_task_id: str | None = None, session_id: str | None = None,
                   label: str | None = None, status: Sequence[str] | None = None, order: str | None = None,
                   limit: int | None = None, after_cursor: str | None = None) -> TaskListResultView:
        """A page in creation order, or newest first with order="desc"; set at most one of
        parent_task_id, session_id and label, and optionally status (SPEC-0028 P01)."""
        await self._client._require_workflow("task_list")
        if label is not None:
            await self._client._require_workflow("labels")
        if status is not None or order is not None:
            await self._client._require_workflow("task_queries")
        params = {"parentTaskId": parent_task_id, "sessionId": session_id, "label": label,
                  "status": None if status is None else list(status), "order": order,
                  "limit": limit, "afterCursor": after_cursor}
        return cast(TaskListResultView, await self._client._call("tasks.list", {k: v for k, v in params.items() if v is not None}))

    async def get_many(self, task_ids: Sequence[str]) -> TaskGetManyResultView:
        """1 to 100 tasks by ID, in the order requested, and the IDs not found (SPEC-0028 P02)."""
        await self._client._require_workflow("task_queries")
        return cast(TaskGetManyResultView, await self._client._call("tasks.getMany", {"taskIds": list(task_ids)}))

    async def resume(self, task_id: str, *, idempotency_key: str | None = None) -> OperationHandle:
        return OperationHandle(self._client, await self._client._mutate("tasks.resume", {"taskId": task_id}, idempotency_key))

    async def cancel(self, task_id: str, *, idempotency_key: str | None = None) -> OperationHandle:
        return OperationHandle(self._client, await self._client._mutate("tasks.cancel", {"taskId": task_id}, idempotency_key))


class _Sessions:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, session_id: str) -> SessionSnapshotView:
        return cast(SessionSnapshotView, await self._client._call("sessions.get", {"sessionId": session_id}))

    async def inspect(self, session_id: str, *, timeout_ms: int = 5000, limit: int = 16) -> RuntimeInspectionView:
        return cast(RuntimeInspectionView, await self._client._call("sessions.inspect", {"sessionId": session_id, "timeoutMs": timeout_ms, "limit": limit}))

    async def control(self, target: Mapping[str, Any], command: Mapping[str, Any], *,
                      idempotency_key: str | None = None) -> OperationHandle:
        if command.get("action") not in {"pause", "resume", "stop"}:
            raise unsupported(str(command.get("action", "session control")))
        return OperationHandle(self._client, await self._client._mutate(
            "sessions.control", {"target": to_wire(target), "command": to_wire(command)}, idempotency_key))

    async def reconcile(self, target: Mapping[str, Any], evidence: ReconcileEvidence | Mapping[str, Any], *,
                        idempotency_key: str | None = None) -> OperationHandle:
        """Submit explicit owner evidence; the host authorizes and validates it."""
        await self._client.start()
        assert self._client.info is not None
        capabilities = self._client.info.get("capabilities")
        lifecycle = capabilities.get("lifecycle") if isinstance(capabilities, Mapping) else None
        if (not isinstance(lifecycle, Mapping) or type(lifecycle.get("version")) is not int or
            lifecycle.get("version") != 1 or lifecycle.get("reconcile") != "owner-attestation" or
            lifecycle.get("durable_deadlines") is not True):
            raise OrchestrationError("UNSUPPORTED_CAPABILITY", "Host has not negotiated lifecycle version 1 reconciliation")
        wire_evidence = to_wire(evidence)
        # SPEC-0045 R02, R03: an attestation may leave its result, or its outcome, to the record.
        if wire_evidence.get("outcome") == "recorded" or (
                wire_evidence.get("outcome") == "completed" and "result" not in wire_evidence):
            self._client._check_workflow("reconcile_recorded_result")
        return OperationHandle(self._client, await self._client._mutate(
            "sessions.reconcile", {"target": to_wire(target), "evidence": wire_evidence}, idempotency_key))

    async def open(self, spec: Mapping[str, Any], *, idempotency_key: str | None = None) -> SessionReceiptView:
        await self._client.start()
        capability = self._client.info.capabilities.get("session_lifecycle", {})
        if not isinstance(capability, Mapping) or capability.get("open") is not True:
            raise unsupported("sessions.open")
        wire = to_wire(spec)
        if "writePath" in wire:
            await self._client._require_workflow("write_path")
        if "label" in wire or "metadata" in wire:
            await self._client._require_workflow("labels")
        return cast(SessionReceiptView, await self._client._mutate("sessions.open", {"spec": wire}, idempotency_key))

    async def fork(self, target: Mapping[str, Any], snapshot_ref: str | None = None, *, model: str | None = None,
                   acknowledge_cache_loss: bool | None = None, idempotency_key: str | None = None) -> SessionReceiptView:
        """Prepare a fork; another allowed model loses prompt-cache reuse and must be acknowledged."""
        await self._client.start()
        capability = self._client.info.capabilities.get("session_lifecycle", {})
        if not isinstance(capability, Mapping) or capability.get("fork") is not True:
            raise unsupported("sessions.fork")
        if model is not None and capability.get("fork_model") is not True:
            raise OrchestrationError("UNSUPPORTED_CAPABILITY", "Host does not support model-changing forks")
        params: dict[str, Any] = {"target": to_wire(target), "snapshotRef": snapshot_ref}
        if model is not None:
            params["model"] = model
        if acknowledge_cache_loss is not None:
            params["acknowledgeCacheLoss"] = acknowledge_cache_loss
        return cast(SessionReceiptView, await self._client._mutate("sessions.fork", params, idempotency_key))

    async def compact(self, target: Mapping[str, Any], *, idempotency_key: str | None = None) -> OperationHandle:
        return OperationHandle(self._client, await self._client._mutate("sessions.compact", {"target": to_wire(target)}, idempotency_key))

    async def rotate(self, target: Mapping[str, Any], *, idempotency_key: str | None = None) -> OperationHandle:
        return OperationHandle(self._client, await self._client._mutate("sessions.rotate", {"target": to_wire(target)}, idempotency_key))

    async def stop(self, target: Mapping[str, Any], *, mode: str = "drain", idempotency_key: str | None = None) -> OperationHandle:
        return await self.control(target, {"action": "stop", "mode": mode}, idempotency_key=idempotency_key)


class _Scheduler:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def _require_capability(self) -> None:
        await self._client.start()
        assert self._client.info is not None
        capabilities = self._client.info.get("capabilities")
        isolation = capabilities.get("execution_isolation") if isinstance(capabilities, Mapping) else None
        if (not isinstance(isolation, Mapping) or type(isolation.get("version")) is not int or
            isolation.get("version") != 1 or isolation.get("resource_release") is not True or
            isolation.get("scheduler_status") is not True or isolation.get("owner_conflict_resolution") is not True or
            type(isolation.get("budget_version")) is not int or isolation.get("budget_version") != 2):
            raise OrchestrationError("UNSUPPORTED_CAPABILITY",
                "Host has not negotiated execution isolation version 1 with budget policy version 2")

    async def get(self) -> SchedulerSnapshotView:
        await self._require_capability()
        return cast(SchedulerSnapshotView, await self._client._call("scheduler.get", {}))

    async def get_conflict(self, conflict_id: str) -> ExecutionConflictView:
        await self._require_capability()
        return cast(ExecutionConflictView, await self._client._call("scheduler.getConflict", {"conflictId": conflict_id}))

    async def resolve_conflict(self, conflict_id: str, evidence: ReconcileEvidence | Mapping[str, Any], *,
                               expected_revision: int, idempotency_key: str | None = None) -> OperationHandle:
        """Submit owner evidence for the current conflict revision; the host authorizes it."""
        await self._require_capability()
        return OperationHandle(self._client, await self._client._mutate("scheduler.resolveConflict", {
            "conflictId": conflict_id, "expectedRevision": expected_revision, "evidence": to_wire(evidence)},
            idempotency_key))


class _Messages:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def send(self, spec: Mapping[str, Any], *, idempotency_key: str | None = None) -> MessageReceiptView:
        return cast(MessageReceiptView, await self._client._mutate("messages.send", {"spec": to_wire(spec)}, idempotency_key))

    async def get(self, message_id: str) -> MessageSnapshotView:
        return cast(MessageSnapshotView, await self._client._call("messages.get", {"messageId": message_id}))


class _Operations:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, operation_id: str) -> OperationSnapshotView:
        return cast(OperationSnapshotView, await self._client._call("operations.get", {"operationId": operation_id}))

    async def lookup(self, key_spec: Mapping[str, Any] | None = None, *, method: str | None = None,
                     scope: str = "local", idempotency_key: str | None = None) -> OperationSnapshotView:
        params = to_wire(key_spec) if key_spec is not None else {
            "method": method, "scope": scope, "idempotencyKey": idempotency_key}
        return cast(OperationSnapshotView, await self._client._call("operations.lookup", params))


class _Approvals:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, approval_id: str) -> ApprovalRequestView:
        return cast(ApprovalRequestView, await self._client._call("approvals.get", {"approvalId": approval_id}))

    async def decide(self, approval_id: str, decision: Mapping[str, Any], *,
                     idempotency_key: str | None = None) -> OperationHandle:
        """`choice` is approve, deny or revise; revise requires `comment` for the next dispatch."""
        wire = to_wire(decision)
        if wire.get("choice") == "revise" or "comment" in wire:
            await self._client._require_workflow("revise")
        return OperationHandle(self._client, await self._client._mutate(
            "approvals.decide", {"approvalId": approval_id, "decision": wire}, idempotency_key))


class _Handoffs:
    """Model requests to hand work to another session; each grants nothing until resolved."""
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, handoff_id: str) -> HandoffRequestView:
        await self._client._require_workflow("handoffs")
        return cast(HandoffRequestView, await self._client._call("handoffs.get", {"handoffId": handoff_id}))

    async def list(self, *, status: str | None = None, target_session_id: str | None = None,
                   limit: int | None = None, after_cursor: str | None = None) -> HandoffListResultView:
        await self._client._require_workflow("handoffs")
        params = {"status": status, "targetSessionId": target_session_id, "limit": limit,
                  "afterCursor": after_cursor}
        return cast(HandoffListResultView, await self._client._call("handoffs.list", {k: v for k, v in params.items() if v is not None}))

    async def resolve(self, handoff_id: str, *, expected_revision: int, outcome: str, task_id: str | None = None,
                      comment: str | None = None, idempotency_key: str | None = None) -> OperationHandle:
        """Accepting links a task the host created; the engine never creates it."""
        await self._client._require_workflow("handoffs")
        params: dict[str, Any] = {"handoffId": handoff_id, "expectedRevision": expected_revision, "outcome": outcome}
        if task_id is not None:
            params["taskId"] = task_id
        if comment is not None:
            params["comment"] = comment
        return OperationHandle(self._client, await self._client._mutate("handoffs.resolve", params, idempotency_key))


class _Rules:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def register(self, rule: Mapping[str, Any], *, idempotency_key: str | None = None) -> OperationHandle:
        """Owner only; appends a verification rule version for tasks admitted afterwards."""
        await self._client._require_workflow("runtime_rules")
        return OperationHandle(self._client, await self._client._mutate(
            "rules.register", {"rule": to_wire(rule)}, idempotency_key))

    async def retire(self, rule_id: str, version: str, *, idempotency_key: str | None = None) -> OperationHandle:
        """Owner only; retires a rule registered at runtime (SPEC-0028 U01)."""
        await self._client._require_workflow("rule_retirement")
        return OperationHandle(self._client, await self._client._mutate(
            "rules.retire", {"id": rule_id, "version": version}, idempotency_key))

    async def list(self, *, include_retired: bool | None = None) -> RuleListResultView:
        """The effective rules; with include_retired, the retired ones after them (SPEC-0028 U04)."""
        await self._client._require_workflow("runtime_rules")
        if include_retired is None:
            return cast(RuleListResultView, await self._client._call("rules.list", {}))
        await self._client._require_workflow("rule_retirement")
        return cast(RuleListResultView, await self._client._call("rules.list", {"includeRetired": include_retired}))


class _Usage:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, task_id: str) -> Snapshot:
        return await self._client._call("usage.get", {"taskId": task_id})

    async def get_record(self, usage_record_id: str) -> UsageRecordView:
        return cast(UsageRecordView, await self._client._call("usage.getRecord", {"usageRecordId": usage_record_id}))

    async def summary(self, root_task_id: str) -> UsageSummaryView:
        """Token totals of a root task and every task under it, by model (SPEC-0028 P03)."""
        await self._client._require_workflow("task_queries")
        result = await self._client._call("usage.summary", {"rootTaskId": root_task_id})
        return cast(UsageSummaryView, Snapshot({**result, "totals": snapshot(result["totals"])}))

    async def by_task(self, task_ids: Sequence[str]) -> UsageByTaskResultView:
        """Each of 1 to 100 tasks' own token totals by model, in order, and the missing IDs
        (SPEC-0029 A)."""
        await self._client._require_workflow("usage_by_task")
        result = await self._client._call("usage.byTask", {"taskIds": list(task_ids)})
        return cast(UsageByTaskResultView, Snapshot({**result, "tasks": [Snapshot({**entry, "totals": snapshot(entry["totals"])})
                                             for entry in result["tasks"]]}))


class _Costs:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def get(self, task_id: str | None = None, *, scope: str = "direct") -> Snapshot:
        return await self._client._call("costs.get", {"scope": scope, **({"taskId": task_id} if task_id else {})})

    async def record_overhead(self, record: Mapping[str, Any], *, idempotency_key: str | None = None) -> OperationHandle:
        return OperationHandle(self._client, await self._client._mutate("costs.recordOverhead", to_wire(record), idempotency_key))


class _Context:
    def __init__(self, client: "Orchestrator"):
        self._client = client

    async def estimate(self, assumptions: Mapping[str, Any]) -> Snapshot:
        return await self._client._call("context.estimate", to_wire(assumptions))

    async def check_refs(self, context_refs: Sequence[Mapping[str, Any]]) -> Snapshot:
        """What task admission would decide now for each context reference (SPEC-0020).

        Read-only; the content is never returned, and admission checks again when a task is submitted.
        """
        return await self._client._call("context.checkRefs", {"contextRefs": [to_wire(ref) for ref in context_refs]})


class Stores:
    def __init__(self, client):
        self._client = client

    async def rollover(self, *, idempotency_key=None):
        return await self._client._mutate("stores.rollover", {}, idempotency_key)

    async def import_backup(self, backup_id, *, idempotency_key=None):
        return await self._client._mutate("stores.import", {"backupId": backup_id}, idempotency_key)

    async def rollover_status(self, rollover_id):
        return await self._client._call("rollovers.get", {"rolloverId": rollover_id})


class Archives:
    def __init__(self, client):
        self._client = client

    async def lookup(self, *, store_id, method, scope, idempotency_key, request_digest=None):
        return await self._client._call("archives.lookup", {"storeId": store_id, "method": method, "scope": scope,
            "idempotencyKey": idempotency_key, **({"requestDigest": request_digest} if request_digest is not None else {})})

    async def read_artifact(self, *, store_id, artifact_ref, max_bytes=65536):
        return await self._client._call("archives.readArtifact", {"storeId": store_id, "artifactRef": artifact_ref, "maxBytes": max_bytes})


class Storage:
    def __init__(self, client):
        self._client = client

    async def backup(self, *, idempotency_key=None):
        return await self._client._mutate("storage.backup", {}, idempotency_key)

    async def status(self):
        return await self._client._call("storage.status", {})

    async def configure(self, policy, *, idempotency_key=None):
        return OperationHandle(self._client, await self._client._mutate("storage.configure", {"policy": to_wire(policy)}, idempotency_key))

    async def collect(self, *, idempotency_key=None):
        return OperationHandle(self._client, await self._client._mutate("storage.gc", {}, idempotency_key))

    async def pin(self, ref, reason, *, idempotency_key=None):
        return OperationHandle(self._client, await self._client._mutate("storage.pin", {"ref": ref, "reason": reason}, idempotency_key))

    async def unpin(self, ref, *, idempotency_key=None):
        return OperationHandle(self._client, await self._client._mutate("storage.unpin", {"ref": ref}, idempotency_key))


class State:
    def __init__(self, client):
        self._client = client

    async def snapshot(self, *, snapshot_id=None, offset=0, limit=64) -> SnapshotPageView:
        return cast(SnapshotPageView, await self._client._call("state.snapshot", {"offset": offset, "limit": limit, **({"snapshotId": snapshot_id} if snapshot_id is not None else {})}))

    async def release_snapshot(self, snapshot_id):
        return await self._client._call("state.releaseSnapshot", {"snapshotId": snapshot_id})


class Orchestrator:
    def __init__(self, *, engine_command: Sequence[str] | None = None, socket_path: str | None = None,
                 close_timeout: float = 30.0, request_timeout: float = 30.0,
                 poll_interval: float = 0.05, env: Mapping[str, str] | None = None):
        self._command = list(engine_command) if engine_command is not None else None
        self._socket = socket_path
        self._env = env
        self._owner = engine_command is not None
        self._close_timeout = _duration(close_timeout, "close_timeout", zero=True)
        self._request_timeout = _duration(request_timeout, "request_timeout")
        self._poll_interval = _duration(poll_interval, "poll_interval")
        self._transport: RpcTransport | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._closed = False
        self._shutdown_operation_id: str | None = None
        self.info: InitializeResultView | None = None
        self._identities: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.stores = Stores(self)
        self.archives = Archives(self)
        self.storage = Storage(self)
        self.state = State(self)
        self.tasks = _Tasks(self)
        self.sessions = _Sessions(self)
        self.scheduler = _Scheduler(self)
        self.messages = _Messages(self)
        self.operations = _Operations(self)
        self.approvals = _Approvals(self)
        self.handoffs = _Handoffs(self)
        self.rules = _Rules(self)
        self.usage = _Usage(self)
        self.costs = _Costs(self)
        self.context = _Context(self)

    @classmethod
    def local(cls, *, engine_command: Sequence[str], **options: Any) -> "Orchestrator":
        if (isinstance(engine_command, (str, bytes)) or not engine_command or
            any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in engine_command)):
            raise OrchestrationError("VALIDATION_ERROR", "engine_command must be a nonempty argument array")
        return cls(engine_command=engine_command, **options)

    @classmethod
    def connect(cls, *, socket_path: str, **options: Any) -> "Orchestrator":
        if not isinstance(socket_path, str) or not Path(socket_path).is_absolute():
            raise OrchestrationError("VALIDATION_ERROR", "socket_path must be an absolute local path")
        return cls(socket_path=socket_path, **options)

    def __await__(self):
        return self.start().__await__()

    async def __aenter__(self) -> "Orchestrator":
        return await self.start()

    async def __aexit__(self, exc_type: Any, exc: BaseException | None, traceback: Any) -> bool:
        cleanup = asyncio.create_task(self.close(), name="orchvia-context-close")
        cancelled: asyncio.CancelledError | None = None
        while True:
            try:
                await asyncio.shield(cleanup)
                break
            except asyncio.CancelledError as error:
                if cleanup.cancelled():
                    raise
                cancelled = error
            except BaseException as error:
                if exc is not None:
                    raise error from exc
                if cancelled is not None:
                    raise error from cancelled
                raise
        if cancelled is not None:
            raise cancelled
        return False

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def stderr_tail(self) -> str:
        return self._transport.stderr_tail if self._transport is not None else ""

    async def start(self) -> "Orchestrator":
        async with self._lifecycle_lock:
            if self._closed:
                raise OrchestrationError("CONNECTION_CLOSED", "This client has already closed")
            if self.info is not None:
                return self
            if self._command is not None:
                factory = RpcTransport.stdio(self._command, env=self._env,
                                             request_timeout=self._request_timeout)
            elif self._socket is not None:
                factory = RpcTransport.unix(self._socket, request_timeout=self._request_timeout)
            else:
                raise OrchestrationError("VALIDATION_ERROR", "Use Orchestrator.local or Orchestrator.connect")
            # A subprocess may already exist before its async factory returns. Do not
            # cancel that factory and lose ownership of resources it has created.
            opening = asyncio.create_task(factory, name="orchvia-open-transport")
            try:
                self._transport = await asyncio.shield(opening)
                result = await self._transport.request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION, "sdkVersion": SDK_VERSION})
                if not isinstance(result, dict) or result.get("protocolVersion") != PROTOCOL_VERSION:
                    raise OrchestrationError("PROTOCOL_MISMATCH", "Engine protocol must be 2.0")
                if not all(isinstance(result.get(key), str) and result[key] for key in ("instanceId", "storeId")):
                    raise OrchestrationError("PROTOCOL_ERROR", "Handshake is missing instance/store identity")
                if type(result.get("capabilities", {}).get("storeNamespaces", {}).get("version")) is not int or result["capabilities"]["storeNamespaces"]["version"] != 1:
                    raise OrchestrationError("UNSUPPORTED_CAPABILITY", "Host must support namespace-bound writes")
                self.info = cast(InitializeResultView, snapshot(result))
            except BaseException as startup_error:
                cleanup = asyncio.create_task(self._cleanup_failed_start(opening),
                                              name="orchvia-start-cleanup")
                while True:
                    try:
                        await asyncio.shield(cleanup)
                        break
                    except asyncio.CancelledError:
                        if cleanup.cancelled():
                            raise startup_error
                        # Keep ownership until cleanup finishes, even if the caller
                        # cancels startup again while its first cancellation is handled.
                    except BaseException as cleanup_error:
                        raise startup_error from cleanup_error
                self._closed = True
                explained = self._with_host_output(startup_error)
                if explained is startup_error:
                    raise
                raise explained from startup_error
            return self

    def _with_host_output(self, error: BaseException) -> BaseException:
        """SPEC-0023 E01: an owned host that ended before it answered says why."""
        tail = self._transport.stderr_tail if self._command is not None and self._transport else ""
        if (not isinstance(error, OrchestrationError) or error.code not in {"CONNECTION_CLOSED", "PROTOCOL_ERROR"}
                or not tail.strip()):
            return error
        return OrchestrationError(error.code, f"{error}. The host's error output ends with:\n{tail.strip()[-2000:]}",
                                  data={**error.data, "stderrTail": tail})

    async def _cleanup_failed_start(self, opening: asyncio.Task[RpcTransport]) -> None:
        if self._transport is None:
            try:
                self._transport = await opening
            except BaseException:
                return  # The factory failed before returning an owned transport.
        # This deliberately bypasses close()/disconnect() on the client: start still
        # owns the lifecycle lock, and no business requests have been accepted.
        await self._transport.disconnect(terminate_owned=True)

    async def _call(self, method: str, params: dict[str, Any], *, timeout: float | None = None) -> Snapshot:
        await self.start()
        return await self._call_transport(method, params, timeout=timeout)

    async def _require_workflow(self, feature: str) -> None:
        """Fails before sending when the host did not advertise a SPEC-0014 workflow feature."""
        await self.start()
        self._check_workflow(feature)

    def _check_workflow(self, feature: str) -> None:
        assert self.info is not None
        workflow = self.info.capabilities.get("workflow")
        if not isinstance(workflow, Mapping) or workflow.get("version") != 1 or workflow.get(feature) is not True:
            raise OrchestrationError("UNSUPPORTED_CAPABILITY", f"Host does not support {feature}")

    async def _call_transport(self, method: str, params: dict[str, Any], *,
                              timeout: float | None = None) -> Snapshot:
        assert self._transport is not None
        result = await self._transport.request(method, params, timeout=timeout)
        if not isinstance(result, dict):
            raise OrchestrationError("PROTOCOL_ERROR", f"{method} returned a non-object result")
        return snapshot(result)

    async def _mutate(self, method: str, params: dict[str, Any], key: str | None, *, retry_identity: dict[str, Any] | None = None) -> Snapshot:
        if key is not None and (not isinstance(key, str) or not key):
            raise OrchestrationError("VALIDATION_ERROR", "idempotency_key must be a nonempty string")
        key = key or str(uuid4())
        scope = "local"
        if method in {"tasks.resume", "tasks.cancel"}:
            scope = params.get("taskId")
        elif method in {"sessions.control", "sessions.reconcile", "sessions.fork", "sessions.compact", "sessions.rotate"}:
            target = params.get("target")
            scope = target.get("sessionId") if isinstance(target, Mapping) else None
        elif method == "messages.send":
            spec = params.get("spec")
            scope = spec.get("toSessionId") if isinstance(spec, Mapping) else None
        elif method == "approvals.decide":
            scope = params.get("approvalId")
        elif method == "scheduler.resolveConflict":
            scope = params.get("conflictId")
        elif method == "handoffs.resolve":
            scope = params.get("handoffId")
        elif method == "costs.recordOverhead":
            scope = "host"
        await self.start()
        identity_key = (method, scope, key)
        existing = self._identities.get(identity_key)
        # This call claims the key only when nothing held it before (SPEC-0027 K01, K02).
        claimed = retry_identity is None and existing is None
        identity = dict(retry_identity) if retry_identity is not None else existing or {
            "storeId": self.info.store_id, "method": method, "scope": scope,
            "idempotencyKey": key, "digestVersion": 1, "requestDigest": request_digest(method, params)}
        stored = dict(identity)
        # Re-inserting marks the identity as the most recently used one (SPEC-0027 K03).
        self._identities.pop(identity_key, None)
        self._identities[identity_key] = stored
        if len(self._identities) > _MAX_IDENTITIES:
            self._identities.pop(next(iter(self._identities)))
        key = identity["idempotencyKey"]
        try:
            if (identity["method"] != method or identity["scope"] != scope or identity["digestVersion"] != 1
                    or identity["requestDigest"] != request_digest(method, params)):
                raise OrchestrationError("IDEMPOTENCY_CONFLICT", "Retry identity or payload changed")
            result = await self._call(method, {**params, "idempotencyKey": key,
                "expectedStoreId": identity["storeId"], "requestDigest": identity["requestDigest"]})
            if method in {"stores.rollover", "stores.import"} and result.status == "completed":
                await self.refresh()
            # Keep the original immutable identity on every receipt.
            return Snapshot({"method": method, "scope": scope, **result, "idempotency_key": key, "retry_identity": snapshot(identity)})
        except OrchestrationError as error:
            # An engine error carries its code in its data too; the SDK's and the transport's own
            # errors do not. The engine committed nothing for a rejection outside _KEEP_IDENTITY, so
            # the key this call claimed is free again for a corrected request (SPEC-0027 K01).
            if (claimed and error.data.get("code") == error.code and error.code not in _KEEP_IDENTITY
                    and self._identities.get(identity_key) is stored):
                del self._identities[identity_key]
            error.retry_identity = dict(identity)
            if isinstance(error, OrchestrationError):
                error.data["retryIdentity"] = dict(identity)
            error.idempotency_key = key
            error.method = method
            error.scope = scope
            raise
        except asyncio.CancelledError as error:
            # Preserve cancellation semantics while retaining recovery information.
            error.retry_identity = dict(identity)
            if isinstance(error, OrchestrationError):
                error.data["retryIdentity"] = dict(identity)
            error.idempotency_key = key
            error.method = method
            error.scope = scope
            raise

    async def refresh(self) -> InitializeResultView:
        info = await self._call("initialize", {"protocolVersion": PROTOCOL_VERSION, "sdkVersion": SDK_VERSION})
        if info.protocol_version != PROTOCOL_VERSION or info.capabilities.store_namespaces.version != 1:
            raise OrchestrationError("PROTOCOL_MISMATCH", "Refreshed host lacks namespace support")
        self.info = info
        return cast(InitializeResultView, info)

    def forget_idempotency_key(self, idempotency_key: str) -> int:
        """Forget the retry identities of a key for every method and scope; return how many there were.

        The engine still refuses another request under a key it committed (SPEC-0027 K03)."""
        forgotten = [key for key, identity in self._identities.items()
                     if identity.get("idempotencyKey") == idempotency_key]
        for key in forgotten:
            del self._identities[key]
        return len(forgotten)

    async def retry(self, identity: Mapping[str, Any], params: Mapping[str, Any]) -> Snapshot:
        """Retry the exact original wire payload without rebinding its store."""
        wire = to_wire(dict(identity))
        return await self._mutate(wire["method"], dict(params), wire["idempotencyKey"], retry_identity=wire)

    async def _wait(self, get_snapshot: Any, terminal: set[str], timeout: float | None) -> Snapshot:
        if timeout is not None:
            _duration(timeout, "timeout", zero=True)
        try:
            async with asyncio.timeout(timeout):
                while True:
                    current = await get_snapshot()
                    if current.status in terminal:
                        return current
                    await asyncio.sleep(self._poll_interval)
        except TimeoutError:
            raise OrchestrationError("TIMEOUT", "Local wait timed out; remote task was not cancelled") from None

    async def capabilities(self, *, provider: str | None = None) -> Snapshot:
        return await self._call("capabilities.get", {"provider": provider} if provider is not None else {})

    async def events(self, *, task_id: str | None = None, after_cursor: str | None = None,
                     store_id: str | None = None, limit: int = 128) -> AsyncIterator[Snapshot]:
        cursor = "0" if after_cursor is None else after_cursor
        if (not isinstance(cursor, str) or not cursor.isascii() or not cursor.isdecimal() or
            (cursor != "0" and store_id is None)):
            raise OrchestrationError("VALIDATION_ERROR", "A nonzero decimal cursor requires its store_id")
        if type(limit) is not int or not 1 <= limit <= 256:
            raise OrchestrationError("VALIDATION_ERROR", "Event page limit must be between 1 and 256")
        await self.start()
        assert self.info is not None
        expected_store = store_id or self.info.store_id
        seen: set[str] = set()
        order: deque[str] = deque()
        while True:
            params: dict[str, Any] = {"afterCursor": cursor, "storeId": expected_store, "limit": limit}
            if task_id is not None:
                params["taskId"] = task_id
            page = await self._call("events.read", params)
            if page.store_id != expected_store:
                raise OrchestrationError("PROTOCOL_ERROR", "Event page changed store identity")
            if (not isinstance(page.cursor, str) or not page.cursor.isascii() or
                not page.cursor.isdecimal() or int(page.cursor) < int(cursor)):
                raise OrchestrationError("PROTOCOL_ERROR", "Event cursor moved backwards or is malformed")
            if not isinstance(page.events, list) or len(page.events) > limit:
                raise OrchestrationError("PROTOCOL_ERROR", "Event page exceeded the requested bound")
            for event in page.events:
                if event.event_id in seen:
                    continue
                seen.add(event.event_id)
                order.append(event.event_id)
                if len(order) > 2048:
                    seen.remove(order.popleft())
                yield event
            cursor = page.cursor
            if not page.events:
                await asyncio.sleep(self._poll_interval)

    async def close(self, *, mode: str | None = None, timeout: float | None = None,
                    operation_id: str | None = None) -> Snapshot | None:
        async with self._lifecycle_lock:
            if self._closed:
                return None
            if not self._owner:
                if mode is not None or operation_id is not None:
                    raise OrchestrationError("UNAUTHORIZED", "A connected client cannot shut down the shared host")
                await self._disconnect_locked()
                return None
            if self._transport is None:
                self._closed = True
                return None
            mode = mode or "drain"
            if mode not in {"drain", "interrupt", "pause"}:
                raise OrchestrationError("VALIDATION_ERROR", "close mode must be drain, interrupt or pause")
            if mode == "pause":
                # Refused before sending, and the client stays open (SPEC-0028 S04). The lock this
                # method holds is the one start() takes, so the started client's info is checked.
                self._check_workflow("pause_close")
            duration = self._close_timeout if timeout is None else _duration(timeout, "timeout", zero=True)
            operation_id = operation_id or self._shutdown_operation_id
            params: dict[str, Any] = {"mode": mode, "timeoutMs": math.ceil(duration * 1000), "expectedStoreId": self.info.store_id}
            method = "host.shutdown"
            if operation_id is not None:
                method = "host.shutdown.continue"
                params["operationId"] = operation_id
            try:
                result = await self._call_transport(method, params,
                                                    timeout=max(self._request_timeout, duration + 1.0))
            except ShutdownIncomplete as error:
                error.client = self
                self._shutdown_operation_id = error.operation_id
                raise
            except OrchestrationError as error:
                if (error.code == "STORAGE_DEGRADED_CLOSED" and error.data.get("status") == "closed"
                        and error.data.get("durableReceipt") is False):
                    await self._disconnect_locked(terminate_owned=True)
                raise
            if result.status != "closed":
                raise OrchestrationError("PROTOCOL_ERROR", "Host did not confirm completed shutdown")
            await self._disconnect_locked(terminate_owned=True)
            return result

    async def disconnect(self) -> None:
        """Drop this transport, e.g. after a framing failure; does not claim task completion.

        Local owners should normally use close(). Dropping their pipe invokes the
        host's EOF recovery policy and cannot undo already executed side effects.
        """
        async with self._lifecycle_lock:
            await self._disconnect_locked()

    async def _disconnect_locked(self, *, terminate_owned: bool = False) -> None:
        if self._transport is not None:
            await self._transport.disconnect(terminate_owned=terminate_owned)
        self._closed = True
