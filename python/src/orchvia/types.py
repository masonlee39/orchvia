"""Public request types and attribute-access views of known wire objects."""
from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field, is_dataclass
from types import MappingProxyType
from typing import Any, Literal


@dataclass(frozen=True)
class RuntimeSpec:
    provider: str
    model: str


@dataclass(frozen=True)
class AcceptanceSpec:
    mode: str = "human"
    criteria: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CheckAcceptanceSpec:
    rule_refs: list[dict[str, str]]
    mode: str = "checks"
    max_repairs: int = 0


@dataclass(frozen=True)
class TaskSpec:
    goal: str
    runtime: RuntimeSpec
    acceptance: AcceptanceSpec | CheckAcceptanceSpec
    dependency_task_ids: list[str] = field(default_factory=list)
    parent_task_id: str | None = None
    write_scope: str | None = None
    write_path: str | None = None
    context_plan: dict[str, Any] | None = None
    budget: dict[str, Any] | None = None
    context_estimate: dict[str, Any] | None = None
    # The host's own filterable label and JSON object (SPEC-0027 L01); metadata keys are sent as written.
    label: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class ReconcileEvidence:
    """Owner-authored attestation, not independent runtime inspection."""
    source: Literal["owner_attestation"]
    summary: str
    local_resources: Literal["stopped", "unknown"]
    remote_execution: Literal["stopped", "unknown"]
    side_effects: Literal["resolved", "unknown"]
    outcome: Literal["not_executed", "completed", "failed", "interrupted", "unknown"]
    result: str | None = None


@dataclass(frozen=True)
class LifecycleTimeouts:
    """Owner host-config durations in milliseconds; unrelated to SDK wait timeouts.

    Use to_wire() when writing a host JSON config. Orchestrator.local passes its
    engine_command unchanged and does not install these values automatically.
    """
    acceptance_ms: int = 30000
    turn_ms: int = 1800000
    drain_ms: int = 300000
    interrupt_ms: int = 30000
    reconcile_ms: int = 60000


_WIRE_TO_PYTHON = {
    "maxCost": "max_cost", "reservePerDispatch": "reserve_per_dispatch", "contextEstimate": "context_estimate",
    "outputReserveTokens": "output_reserve_tokens", "toolReserveTokens": "tool_reserve_tokens",
    "costOwnerTaskId": "cost_owner_task_id", "billingId": "billing_id", "pricingVersion": "pricing_version",
    "settlementIncomplete": "settlement_incomplete", "unknownRecords": "unknown_records", "recordCount": "record_count",
    "keepHistoryTokens": "keep_history_tokens", "compactHistoryTokens": "compact_history_tokens", "growthTokens": "growth_tokens",
    "retainedPrefixTokens": "retained_prefix_tokens", "intervalsMs": "intervals_ms",
    "replyToMessageId": "reply_to_message_id", "hopCount": "hop_count",
    "providerTurnId": "provider_turn_id", "requestId": "request_id", "toolName": "tool_name",
    "requestDigest": "request_digest", "runtimeApprovals": "runtime_approvals", "ttlMs": "ttl_ms",
    "sessionLifecycle": "session_lifecycle", "forkModel": "fork_model",
    "writePath": "write_path", "revisionRequest": "revision_request",
    "dependencyResultsDelivered": "dependency_results_delivered", "dependencyResults": "dependency_results",
    "delegationApproval": "delegation_approval", "runtimeRules": "runtime_rules", "taskList": "task_list",
    "contextCheck": "context_check", "taskQueries": "task_queries", "queueReasons": "queue_reasons",
    "pauseClose": "pause_close", "ruleRetirement": "rule_retirement",
    "blockedBy": "blocked_by", "byModel": "by_model", "recordedAt": "recorded_at", "retiredAt": "retired_at",
    "includeRetired": "include_retired", "usageByTask": "usage_by_task", "deliveredAt": "delivered_at",
    "pausedByClose": "paused_by_close", "wasRunning": "was_running",
    "handoffId": "handoff_id", "targetSessionId": "target_session_id", "fromTaskId": "from_task_id",
    "fromSessionId": "from_session_id", "fromDispatchId": "from_dispatch_id",
    "fromGeneration": "from_generation", "resolvedAt": "resolved_at", "nextCursor": "next_cursor",
    "contextPlan": "context_plan", "requestedMode": "requested_mode", "candidateSessionId": "candidate_session_id",
    "contextRefs": "context_refs", "artifactRef": "artifact_ref", "snapshotRef": "snapshot_ref",
    "fallbackModes": "fallback_modes", "maxQueueWaitMs": "max_queue_wait_ms", "enqueuedAt": "enqueued_at",
    "reasonCode": "reason_code", "submittedAt": "submitted_at", "taskIds": "task_ids",
    "permissionProfile": "permission_profile",
    "dependencyTaskIds": "dependency_task_ids", "parentTaskId": "parent_task_id",
    "rootTaskId": "root_task_id", "writeScope": "write_scope", "writePaths": "write_paths",
    "ruleRefs": "rule_refs", "maxRepairs": "max_repairs", "verificationRules": "verification_rules",
    "verificationAttempts": "verification_attempts", "cwdRelative": "cwd_relative",
    "maxOutputBytes": "max_output_bytes", "baselinePaths": "baseline_paths",
    "taskId": "task_id", "sessionId": "session_id", "approvalId": "approval_id",
    "operationId": "operation_id", "messageId": "message_id", "eventId": "event_id",
    "dispatchId": "dispatch_id", "storeId": "store_id", "instanceId": "instance_id",
    "usageRecordId": "usage_record_id",
    "providerSessionId": "provider_session_id", "activeDispatchId": "active_dispatch_id",
    "pauseOrigin": "pause_origin",
    "targetId": "target_id", "artifactRefs": "artifact_refs", "evidenceRefs": "evidence_refs",
    "idempotencyKey": "idempotency_key", "createdAt": "created_at", "updatedAt": "updated_at",
    "expiresAt": "expires_at", "occurredAt": "occurred_at", "taskRevision": "task_revision",
    "expectedGeneration": "expected_generation", "expectedRevision": "expected_revision",
    "expectedDispatchId": "expected_dispatch_id", "expectedState": "expected_state",
    "toSessionId": "to_session_id", "fromSessionId": "from_session_id",
    "backupId": "backup_id", "rolloverId": "rollover_id", "oldStoreId": "old_store_id", "newStoreId": "new_store_id",
    "archiveId": "archive_id", "manifestDigest": "manifest_digest",
    "snapshotId": "snapshot_id", "nextOffset": "next_offset", "retentionFloorCursor": "retention_floor_cursor",
    "eventsPastAge": "events_past_age", "eventsPastAgeCapped": "events_past_age_capped",
    "detailPending": "detail_pending", "detailPendingCapped": "detail_pending_capped",
    "oldestCollectableAt": "oldest_collectable_at", "eventPrefix": "event_prefix",
    "stoppedAtCursor": "stopped_at_cursor",
    "quotaBytes": "quota_bytes", "minFreeBytes": "min_free_bytes", "emergencyBytes": "emergency_bytes",
    "maxRecords": "max_records", "settlementReserveRecords": "settlement_reserve_records",
    "maxSettlementPerTarget": "max_settlement_per_target", "eventDays": "event_days", "detailDays": "detail_days", "usageDays": "usage_days",
    "retryIdentity": "retry_identity", "requestDigest": "request_digest",
    "digestVersion": "digest_version", "expectedStoreId": "expected_store_id", "storeNamespaces": "store_namespaces",
    "schemaVersion": "schema_version", "protocolVersion": "protocol_version",
    "engineVersion": "engine_version", "sdkVersion": "sdk_version",
    "afterCursor": "after_cursor", "timeoutMs": "timeout_ms",
    "inputTokens": "input_tokens", "cachedInputTokens": "cached_input_tokens",
    "cacheWriteInputTokens": "cache_write_input_tokens", "outputTokens": "output_tokens",
    "cacheWrite5mInputTokens": "cache_write_5m_input_tokens",
    "cacheWrite1hInputTokens": "cache_write_1h_input_tokens",
    "durableDeadlines": "durable_deadlines", "enteredAt": "entered_at",
    "deadlineAt": "deadline_at", "expiredAt": "expired_at", "policyVersion": "policy_version",
    "mayHaveBeenSent": "may_have_been_sent", "lastEvidence": "last_evidence",
    "localResources": "local_resources", "remoteExecution": "remote_execution",
    "sideEffects": "side_effects", "acceptanceMs": "acceptance_ms", "turnMs": "turn_ms",
    "drainMs": "drain_ms", "interruptMs": "interrupt_ms", "reconcileMs": "reconcile_ms",
    "executionIsolation": "execution_isolation", "resourceRelease": "resource_release",
    "schedulerStatus": "scheduler_status", "ownerConflictResolution": "owner_conflict_resolution",
    "budgetVersion": "budget_version", "maxActiveSessions": "max_active_sessions",
    "maxQuarantinedDispatches": "max_quarantined_dispatches", "executionOccupied": "execution_occupied",
    "quarantineReserved": "quarantine_reserved", "canDispatch": "can_dispatch",
    "leaseStatus": "lease_status", "openConflicts": "open_conflicts",
    "conflictId": "conflict_id", "conflictsTruncated": "conflicts_truncated",
    "releaseEvidenceRef": "release_evidence_ref", "conflictingEvidenceRef": "conflicting_evidence_ref",
    "evidenceRef": "evidence_ref", "acquiredAt": "acquired_at", "releasedAt": "released_at",
    "releaseReason": "release_reason", "acceptanceDeadlineAt": "acceptance_deadline_at",
    "effectiveAcceptanceMs": "effective_acceptance_ms", "effectiveTurnMs": "effective_turn_ms",
    "acceptanceSource": "acceptance_source", "turnSource": "turn_source",
}
_PYTHON_TO_WIRE = {value: key for key, value in _WIRE_TO_PYTHON.items()}
_OBJECT_FIELDS = {"spec", "runtime", "acceptance", "target", "data", "error", "capabilities",
                  "lifecycle", "resolution", "evidence", "timeouts", "executionIsolation",
                  "execution", "lease", "budget", "routing", "contextPlan", "sessionLifecycle", "retryIdentity", "storeNamespaces",
                  "workflow", "revisionRequest", "blockedBy", "pausedByClose", "retention", "eventPrefix"}
_OBJECT_LIST_FIELDS = {"records", "events", "occupants", "conflicts", "tasks", "handoffs", "rules", "byModel"}


class Snapshot(Mapping[str, Any]):
    """An immutable outer view; raw/provider/user JSON keeps its original keys."""
    __slots__ = ("_fields",)
    def __init__(self, fields: Mapping[str, Any]):
        self._fields = MappingProxyType(dict(fields))

    def __getitem__(self, key: str) -> Any:
        return self._fields[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._fields)

    def __len__(self) -> int:
        return len(self._fields)

    def __getattr__(self, key: str) -> Any:
        try:
            return self._fields[key]
        except KeyError:
            raise AttributeError(key) from None

    def __repr__(self) -> str:
        return f"Snapshot({dict(self._fields)!r})"

    def as_dict(self) -> dict[str, Any]:
        def unwrap(value: Any) -> Any:
            if isinstance(value, Snapshot):
                return {key: unwrap(item) for key, item in value.items()}
            if isinstance(value, list):
                return [unwrap(item) for item in value]
            return value
        return unwrap(self)


def snapshot(fields: Mapping[str, Any]) -> Snapshot:
    converted = {}
    for key, value in fields.items():
        name = _WIRE_TO_PYTHON.get(key, key)
        if key in _OBJECT_FIELDS and isinstance(value, Mapping):
            value = snapshot(value)
        elif key in _OBJECT_LIST_FIELDS and isinstance(value, list):
            value = [snapshot(item) if isinstance(item, Mapping) else item for item in value]
        # Deliberately do not recurse into unknown fields, operation result or raw usage.
        converted[name] = value
    return Snapshot(converted)


def to_wire(value: Any) -> Any:
    if isinstance(value, ReconcileEvidence):
        value = {key: item for key, item in asdict(value).items() if key != "result" or item is not None}
    elif isinstance(value, TaskSpec):
        value = {key: item for key, item in asdict(value).items() if item is not None}
    elif is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    if isinstance(value, Mapping):
        # Host metadata is opaque JSON: its keys are never renamed (SPEC-0027 L01).
        return {_PYTHON_TO_WIRE.get(key, key): item if key == "metadata" else to_wire(item)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_wire(item) for item in value]
    return value
