# orchvia: Python SDK

The Python SDK for [Orchvia](https://github.com/masonlee39/orchvia), which runs Claude Code and Codex agents as a team from your own application: warm sessions that keep their history, a durable mailbox, human approval of results, and per-task token records.

```sh
pip install orchvia
npm install @orchvia/cli @orchvia/engine @orchvia/adapter-claude
```

The SDK uses only the Python standard library and supports Python 3.11+. It talks to one Node host (Node.js 22.18+ from `@orchvia/cli`), which owns the scheduler, the SQLite state and the agent runtimes; Python starts that host as a child process or connects to a running one. Python does not implement another scheduler, open the database, or call model APIs.

With the npm packages installed in the current directory, the host program is `node_modules/@orchvia/cli/dist/main.js`; pass it as `cli_source` below. Orchvia is alpha software: see its [status](https://github.com/masonlee39/orchvia/blob/main/docs/status.md) for what is and is not verified. The tests below use the explicit `fake` provider; they are not acceptance with real models.

## Run from this checkout

From the repository root:

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
```

The example creates temporary, separate workspace/state directories, starts the real
Node stdio host with only the fake provider, approves exact known fixture evidence,
checks the completed task, shuts down its host, and removes its own temporary files.
It makes no model calls and does not read login credentials.

Tests include a separate Python protocol fixture and the real Node host. Unix socket
tests require permission to create local sockets. The Node integration class is skipped
only if Node or the local CLI source is unavailable; a test skip is not integration proof.

For an editable development install, use a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ./python
```

Setuptools is a build dependency, not a runtime dependency. This command may need access
to your configured package index for build tooling.

## Own a local host

Use the real absolute workspace/state paths and an explicit provider in the host config.
The current local entry point accepts an argument array containing the CLI configuration:

```python
from orchvia import Orchestrator

async with Orchestrator.local(
    engine_command=[node_executable, cli_source, "host", "--stdio", "--config", config_file],
    close_timeout=30.0,
) as orch:
    print(orch.info.instance_id, orch.info.store_id)
    capabilities = await orch.capabilities(provider="fake")
```

All arguments are passed without a shell. `await Orchestrator.local(...)` also starts and
returns an owner when an application wants to manage `close()` explicitly.
The host's stdout is reserved for JSON-RPC. The SDK continuously reads stdout and stderr,
retaining only the last 16 KiB of stderr bytes (`orch.stderr_tail`) without printing logs.

Host deadlines belong in the caller's JSON configuration passed by `--config`; `local()`
does not accept a `timeouts` option or rewrite `engine_command`. The optional `timeouts`
object uses `acceptanceMs=30000`, `turnMs=1800000`, `drainMs=300000`,
`interruptMs=30000`, and `reconcileMs=60000` by default. Each override must be an integer
from 1 through 86400000 milliseconds. `LifecycleTimeouts` exposes snake_case fields;
`orchvia.types.to_wire(LifecycleTimeouts(...))` produces that JSON object. These
deadlines are independent of local SDK wait timeouts and do not reset on retry/restart.
`LifecycleTimeouts().turn_ms` is therefore 1800000. This total budget starts at dispatch
and includes adapter startup, initialization and acceptance waiting. Acceptance and
ordinary output do not restart it. The effective budget is the smaller of the host
limit and any explicit provider cap; acceptance waiting also fits within the total.
The engine and adapters use the same monotonic remaining budget. Persisted UTC times
support diagnosis and recovery; cleanup has its own bounded wait.

The owner JSON configuration also accepts `limits.maxQuarantinedDispatches`, default 32,
an integer from 1 through 1024 and at least the effective `limits.maxActiveSessions`
(default 2, range 1 through 2). Clients cannot increase these limits through the SDK.
Changing a limit requires a host restart; existing records and deadlines are retained.

An owner closes via `host.shutdown`. `ShutdownIncomplete` leaves the connection alive:

```python
from orchvia import ShutdownIncomplete

try:
    await orch.close(timeout=30)
except ShutdownIncomplete as pending:
    # Select drain or interrupt according to the caller's authorized shutdown policy.
    await pending.client.close(
        operation_id=pending.operation_id, mode="drain", timeout=30,
    )
```

An additional timeout still requires handling. Do not exit the event loop and report the
host as closed while shutdown remains incomplete. `async with` uses bounded drain and
preserves a body exception as the cause if cleanup also fails. Applications should retain
their business result/error separately when they continue cleanup outside the context.
The executable example demonstrates that pattern. The SDK installs no global signal handlers.

### Writable members: start your own Node host

The JSON configuration of `orchvia host` cannot pass a stop observer, so there a writable
Claude member or a Codex member needs `"executionStop": "owner-reconcile"`, and each of its
dispatches waits blocked until you reconcile it. To let these members prove their dispatches
stopped, start a small Node host of your own instead: `startStdioHost(engine)` from
`@orchvia/cli` serves any engine over stdin and stdout, with Python as its owner. The
repository's [writable-host.ts](https://github.com/masonlee39/orchvia/blob/main/examples/typescript/writable-host.ts)
builds one with writable Claude and Codex members that share a stop-marker directory:

```python
host = [node, "examples/typescript/writable-host.ts", workspace, state_dir, marker_dir, codex_home]
async with Orchestrator.local(engine_command=host) as orch:
    ...
```

The offline [team_mailbox.py](https://github.com/masonlee39/orchvia/blob/main/examples/python/team_mailbox.py)
starts such a host with a scripted runtime and needs no model.

## Connect to an existing local host

```python
async with Orchestrator.connect(socket_path="/absolute/private/host.sock") as orch:
    state = await orch.tasks.get(task_id)
    print(state.status)
```

Connection-mode `close()` only disconnects. It does not send host shutdown or cancel tasks.
Explicit owner shutdown options on a connected client raise `UNAUTHORIZED`.
The same connection cannot submit owner reconciliation: `sessions.reconcile` returns
`UNAUTHORIZED` for ordinary socket clients even when the host advertises the capability.
The scheduler's `get` and `get_conflict` methods are read-only and available on these
connections; `resolve_conflict` is owner-only and also returns `UNAUTHORIZED`.

## Tasks, approvals, handles and events

```python
from orchvia import AcceptanceSpec, RuntimeSpec, TaskSpec

task = await orch.tasks.create(
    TaskSpec(
        goal="Inspect the approved workspace",
        runtime=RuntimeSpec(provider="fake", model="fake-model"),
        acceptance=AcceptanceSpec(mode="human", criteria=["Evidence reviewed"]),
    ),
    idempotency_key="my-persisted-business-key",
)
```

The returned `TaskHandle` is an attribute-access creation snapshot with an ID and
`await task.wait(timeout=...)`. Creating a task only confirms persistence. An approval
consumer must read `approval.requested`, query `approvals.get`, display current evidence,
and call `approvals.decide(approval_id, {"choice": ..., "expected_revision": ...})` using
an authorized decision. The task does not become completed just because a model returns.
`tasks.get` returns a fresh snapshot; `task.wait` returns a completed/failed/cancelled snapshot.
Paused or blocked tasks require explicit caller handling and are not successful results.

`await task.settle(on_approval=None, timeout=None)` returns as soon as a task needs no more
waiting, as a `SettledTask(task, reason, approval, session)`: `reason` is `terminal`,
`waiting_approval` (with the undecided pending approval), `paused` or `blocked` (with the
task's session, whose status may be `outcome_unknown`). `on_approval(approval, task)`, plain or
async, sees each pending approval once per revision and returns `"approve"`, `"deny"`, or
`None` to stop at the approval. `settle` never decides, resends or reconciles anything by
itself. For a task that a model created, use `TaskHandle(orch, await orch.tasks.get(task_id))`.

```python
settled = await task.settle(on_approval=ask_reviewer, timeout=600)
if settled.reason == "blocked":
    ...  # check what ran, then reconcile (below)
```

Task/session mutations and approval decisions return operation handles where specified:
`await operation.wait(timeout=...)` returns completed/noop/rejected/failed/outcome_unknown.
Use `operations.get` or `operations.lookup(method=..., scope=..., idempotency_key=...)`
to resolve a lost receipt. Mutation receipts and errors retain all three lookup fields.
`tasks.create` uses scope `local`; task changes use the task ID, session controls the session
ID, messages the recipient session ID, and approval decisions the approval ID. Explicit
business keys are required for cross-process recovery. Generated keys are also retained on
locally cancelled mutation calls.
`scheduler.resolveConflict` uses the conflict ID as its operation scope.

`events` uses bounded read-only `events.read` pages (128 by default, at most 256) and sleeps
50 ms on empty pages. It does not generate model requests or accumulate an unbounded queue:

```python
async for event in orch.events(task_id=task_id):
    print(event.type, event.cursor)
```

Persist both `event.cursor` and `event.store_id` when implementing restartable consumers.
For continuation, pass `after_cursor=...` and `store_id=...`; a nonzero cursor without its
store identity is rejected. Known protocol fields use snake_case. Raw usage and unknown
user dictionaries, including `operation.result`, preserve their original keys.
`Snapshot.as_dict()` returns plain data.

Cancelling a wait/iterator or receiving `TIMEOUT` only stops local waiting. Use
`tasks.cancel(task_id)` for remote cancellation. Concurrent requests are bounded to 64 and
UTF-8 JSON frames to 1 MiB. Exceeding either produces a stable error rather than a silent retry.

## Inspect execution capacity and resource conflicts

All three scheduler methods require the complete `initialize.capabilities.executionIsolation`
contract: integer `version=1`, `resourceRelease=true`, `schedulerStatus=true`,
`ownerConflictResolution=true`, and integer `budgetVersion=2`. Python exposes this object
as `orch.info.capabilities.execution_isolation` with snake_case fields. Missing or
incompatible values raise `UNSUPPORTED_CAPABILITY` before a scheduler request is sent;
the SDK does not fall back to an older host's behavior. Lifecycle version 1 remains separate.

```python
scheduler = await orch.scheduler.get()
print(scheduler.execution_occupied, scheduler.quarantined, scheduler.quarantine_reserved)
print(scheduler.can_dispatch, scheduler.reasons)
if scheduler.conflicts:
    conflict = await orch.scheduler.get_conflict(scheduler.conflicts[0].conflict_id)
    print(conflict.id, conflict.revision, conflict.dispatch_id, conflict.status)
```

The counts are per dispatch: A (`execution_occupied`) counts held execution leases;
Q (`quarantined`) counts business outcomes still isolated; R (`quarantine_reserved`)
counts held leases not yet quarantined, including initialization and pending cleanup.
A new dispatch needs both A < `max_active_sessions` and Q + R <
`max_quarantined_dispatches`. A and Q can overlap. Confirmed execution stop and cleanup
can release A while Q remains; only final business reconciliation removes Q.

At the Q + R limit, new work is rejected with `QUARANTINE_CAPACITY_EXCEEDED` and queued
work stops dispatching. Original idempotent requests still return their receipts.
Queries, reconciliation, cancellation, approval and shutdown remain available; resuming
a saved result only to request acceptance is also allowed. Other scheduler reasons are
`EXECUTION_CAPACITY_EXHAUSTED`, `HOST_STOPPING`, `RESOURCE_CLEANUP_PENDING` and
`EXECUTION_EVIDENCE_CONFLICT`. Tolerate additional reason strings in future versions.
A/Q/R and conflict data are read in one database transaction; `can_dispatch` and
`reasons` also reflect this host's shutdown flag and in-memory cleanup records.
`RESOURCE_CLEANUP_PENDING` blocks new dispatches until the owner explicitly continues
an incomplete reconciliation cleanup, as described below. These reads do not run cleanup.
`occupants` and `conflicts` contain at most 16 examples each; check `truncated` and
`conflicts_truncated` alongside `open_conflicts`.

`sessions.get(session_id)` includes optional `execution` while an active dispatch is
associated with the session. Its `lease.status` is `held` or `released`;
`quarantined` is the independent business flag. Optional `execution.budget` reports
`policy_version=2`, `entered_at`, `acceptance_deadline_at`, `deadline_at`,
`effective_acceptance_ms`, `effective_turn_ms`, `acceptance_source` and `turn_source`.
Remaining-time callbacks are internal Node capabilities and never enter the Python wire.

To resolve a specific resource conflict, the owner supplies reviewed stop evidence and
the latest conflict revision. This example accepts evidence already checked by the caller:

```python
async def resolve_reviewed_conflict(owner, conflict_id, evidence, business_key):
    conflict = await owner.scheduler.get_conflict(conflict_id)
    operation = await owner.scheduler.resolve_conflict(
        conflict.id, evidence, expected_revision=conflict.revision,
        idempotency_key=business_key,
    )
    return await operation.wait(timeout=10)
```

Use `ReconcileEvidence(source="owner_attestation", ...)` with both `local_resources`
and `remote_execution` set to `stopped` and a review summary. Its business `side_effects`
and `outcome` may remain `unknown`. Active observation/cleanup handles, an old revision,
or insufficient stop evidence prevent resolution. The conflict ID remains usable after
the session clears its active dispatch. Conflicts survive restart and all open conflicts
must be resolved before dispatch resumes; resolution does not rewrite business outcomes
or acceptance history. Keep the same key when recovering a lost receipt.

## Reconcile an unknown outcome as the owner

`await orch.sessions.reconcile(target, evidence, idempotency_key=...)` returns an
`OperationHandle`. It is available to the owner created by `Orchestrator.local`, after
negotiating lifecycle version 1 with `reconcile="owner-attestation"` and
`durableDeadlines=true`. Read this as `orch.info.capabilities.lifecycle.durable_deadlines`.
Missing or incompatible capability produces `UNSUPPORTED_CAPABILITY` before sending.

Use a fresh session's ID, generation, revision, active dispatch and state as the exact
target. `ReconcileEvidence` records an explicit human owner's review of local resources,
remote execution, side effects and outcome. It does not inspect upstream history for you.
Unknown business evidence keeps the dispatch isolated. In A2, both resource fields being
`stopped`, with no active observation/cleanup handle or open execution-evidence conflict,
allow a partial reconciliation to release the execution lease while `side_effects` or
`outcome` remains `unknown`. The task stays blocked, the session stays `outcome_unknown`,
the active dispatch identity and Q are retained, and no acceptance or rerun is created.
Only one stopped resource field is insufficient. A live execution or observed child
process rejects a stop claim. R04 permits a narrow exception for a sealed adapter record
whose observation ended without ever observing a process, with an exact matching target;
it does not turn an owner declaration into observed exit evidence. A complete business
attestation must also agree with recorded terminal evidence.

The completed reconciliation operation reports resource and business decisions separately.
Its result is raw JSON, so read the camelCase key exactly:

```python
receipt = await operation.wait(timeout=10)  # operation returned by sessions.reconcile
print(receipt.result["executionReleased"], receipt.result["resolved"])
```

A resource-only reconciliation returns `executionReleased=True` and `resolved=False`.
The operation's `completed` status confirms that the declaration and any required
adapter-record cleanup were acknowledged; it does not mean the task completed.
`execution_released` is not a key in `receipt.result`.

R04 also reports `receipt.result["unobservedResourcesReconciled"]`: true only after the
unobserved adapter records have been retired and completion acknowledged. It is false
when no such cleanup was needed or while cleanup remains pending. Optional
`receipt.result["resourceCleanup"]` contains `status` (`pending` or `completed`) and
`ownerInstanceId`; the object is absent when no such cleanup was required. All of these
keys remain camelCase inside raw `result`.

If `sessions.reconcile` raises `OrchestrationError` with code
`RESOURCE_CLEANUP_INCOMPLETE`, `error.operation_id` identifies the saved operation and
`error.data["auditCommitted"]` is true. The declaration and its business/resource
decisions are already committed; this error does not roll them back. Keep the original
target, evidence and idempotency key, saved before the first request.

```python
# operation_id was saved from error.operation_id in the exception handler.
receipt = await owner.operations.get(operation_id)
print(receipt.status, receipt.result.get("resourceCleanup"))

# Later, explicitly continue the original attempt on the same live owner.
# original_target/evidence/key are the saved original values, not a freshly read target.
operation = await owner.sessions.reconcile(
    original_target, original_evidence, idempotency_key=original_key,
)
receipt = await operation.wait(timeout=10)
```

`operations.get` and `operations.lookup` return snapshots; `OperationHandle.wait()`
only polls. They do not execute a finalizer, so waiting on a `persisted` cleanup receipt
alone will reach the local timeout. An explicit same-key reconcile retries the original
cleanup, or only acknowledges it if cleanup already ran. If it fails again, retain the
same recovery information; do not retry in a blind loop or change the key. After owner
restart, the original in-memory finalizer is unavailable: the saved operation becomes
`outcome_unknown`, and retry still reports `RESOURCE_CLEANUP_INCOMPLETE`. Neither the
absence of a scheduler blocker nor `wait()` returning that unknown status means success.

For `completed`, include the reviewed full result string (an empty string is valid; maximum
length 524288): reconciliation saves it and leaves the
task paused, and an explicit `tasks.resume` only requests acceptance again. `not_executed`
allows explicit requeueing; `failed`/`interrupted` make the original task failed.
The earlier unknown operation retains its status and gains a `resolution` reference.
Keep a stable business key and use `operations.lookup` after a lost receipt instead of
submitting a new key. The complete
[TS/Python examples](https://github.com/masonlee39/orchvia/blob/main/docs/guide.md#114-implemented-owner-attestation)
show the target and evidence mapping. [Python TDD evidence](https://github.com/masonlee39/orchvia/blob/main/docs/tdd/0003-a-python.md)
and [increment evidence](https://github.com/masonlee39/orchvia/blob/main/docs/tdd/0003-a-evidence.md) distinguish fixture verification
from unperformed real-model acceptance.

## Host upgrade and adapter compatibility

Wire protocol is `2.0`; database schema is 3 (`orch.info.schema_version`). The host verifies a legacy recovery database and a full bundle of retained artifacts/managed native history before migrating schema 1/2. Migration failure prevents startup. Old wire 1.0 clients are rejected. Existing deadlines and unknown work are not refreshed or replayed.

Mutation receipts and transport errors expose `retry_identity` with immutable store/method/scope/key/digest. Save it before reconnecting. `await orch.refresh()` intentionally observes a new active namespace; `await orch.retry(identity, original_params)` retains the original namespace and rejects a changed payload. Read old receipts with `archives.lookup` after rollover, not a new-key resubmission.

Node adapters must advertise `executionBudget={version:2, acceptanceCapMs:..., turnCapMs:...}`.
Each cap is either `null` for no explicit provider cap or an integer from 1 through
86400000; an omitted version or any version other than 2 makes new `tasks.create` calls
fail with `UNSUPPORTED_CAPABILITY` before task persistence or adapter execution. The
host also validates this contract before dispatch. Built-in fake, Claude and Codex
adapters implement it; explicit provider timeouts remain effective when shorter.
Adapters must consume the supplied monotonic budget and report matching execution and
cleanup evidence. Missing or unverified terminal coverage cannot release a lease merely
because an iterator ended. These adapter hooks are internal Node contracts, not new
Python `local()` arguments. Offline fixtures do not prove real-provider stop guarantees.

## Implemented boundary

SPEC-0007 adds `await orch.usage.get_record(usage_record_id)` and durable `usage.recorded`
events. For example, inside `async for event in orch.events(store_id=saved_store,
after_cursor=saved_cursor)`, read `event.data.usage_record_id` and
`event.data.dispatch_id`, then retrieve the exact record. Persist it to the host's
outbox/ledger before advancing the checkpoint; deduplicate by `(event.store_id, record.id)`.
Raw usage retains its provider keys. Missing record IDs return `NOT_FOUND`; malformed
IDs return `VALIDATION_ERROR`. Historical usage rows are not backfilled into events.
See the [offline durable forwarding example](https://github.com/masonlee39/orchvia/blob/main/examples/typescript/usage-forwarding.ts).

Python can consume usage from an embedded TypeScript host over the existing socket.
It cannot serialize Claude native callbacks or `observeExecutionStop` into JSON configuration.
Stock CLI providers remain read-only; serializable Codex `networkAccess`/`webSearch`
settings are supported. Native tool approval remains separate from engine task acceptance.

Implemented namespaces include tasks, session open/fork/compact/rotate/stop/inspect/control/reconcile, scheduler, messages, approvals, operations, usage, costs, context estimates, storage policy/GC/pins/backups, leased state snapshots, stores rollover/import, read-only archives, capabilities/events and owner/connection lifecycle. Owner-only administration is rejected over ordinary Unix connections.

`TaskSpec` accepts dependencies, `context_plan`, `write_scope`, budgets and context estimates; `CheckAcceptanceSpec` selects owner-registered verification rules. Task acceptance and runtime permission approval have different `purpose` values. Consumers must inspect the purpose and exact target before deciding. Provider options, native callbacks and permissions remain host configuration.

Generated `orchvia.wire_types` uses camelCase wire field names. Public dataclasses/methods use snake_case. `validate_wire(definition, payload)` validates raw wire JSON against the shipped audited schema subset. Operation results, cost reports and raw native observations intentionally preserve their wire JSON keys.

Build a wheel/sdist with the root README commands and install a local wheel using `python -m pip install --no-index --no-deps /absolute/path/orchvia-0.1.0-py3-none-any.whl`. A local owner additionally needs the Node host and selected adapter; the Python package never downloads or implements an engine. See the [current wiring guide](https://github.com/masonlee39/orchvia/blob/main/docs/guide.md), [completion matrix](https://github.com/masonlee39/orchvia/blob/main/docs/specs/0009-complete-design.md#completion-matrix), and [native acceptance boundary](https://github.com/masonlee39/orchvia/blob/main/docs/acceptance/README.md).
