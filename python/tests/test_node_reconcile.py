"""SPEC-0003-A against the real Node host with temporary fake-runtime state."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import (AcceptanceSpec, LifecycleTimeouts, OrchestrationError, Orchestrator,
                        ReconcileEvidence, RuntimeSpec, TaskSpec)
from orchvia.types import to_wire


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
class NodeReconcileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-reconcile-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        workspace = self.directory / "workspace"
        workspace.mkdir()
        state = self.directory / "state"
        state.mkdir()
        self.config = self.directory / "config.json"
        self.config.write_text(json.dumps({"configVersion": 1, "workspace": str(workspace),
            "stateDir": str(state), "providers": {"fake": {"model": "fake-model",
            "delayMs": 300, "result": "late fake result", "permissionProfile": "read-only"}},
            "limits": {"maxActiveSessions": 1}, "shutdown": {"timeoutMs": 1000},
            "storage": {"emergencyBytes": 4096},
            "timeouts": to_wire(LifecycleTimeouts(acceptance_ms=1000, turn_ms=2000, drain_ms=40))}),
            encoding="utf-8")

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(CLI), "host", "--stdio", "--config", str(self.config)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    def spec():
        return TaskSpec(goal="only the deterministic fake runtime", runtime=RuntimeSpec("fake", "fake-model"),
                        acceptance=AcceptanceSpec(criteria=["inspect fixture result"]))

    @staticmethod
    def target(session):
        return {"session_id": session.id, "expected_generation": session.generation,
                "expected_revision": session.revision, "expected_dispatch_id": session.active_dispatch_id,
                "expected_state": session.status}

    @staticmethod
    def evidence():
        return ReconcileEvidence(source="owner_attestation", summary="Owner checked the fake runtime fixture",
            local_resources="stopped", remote_execution="stopped", side_effects="resolved",
            outcome="completed", result="late fake result")

    async def event(self, orch, task_id, kind):
        async with asyncio.timeout(5):
            stream = orch.events(task_id=task_id)
            try:
                async for event in stream:
                    if event.type == kind:
                        return event
            finally:
                await stream.aclose()
        self.fail("Missing event " + kind)

    async def test_a_stdio_deadline_reconcile_and_resume_do_not_repeat_execution(self):
        async with self.local() as orch:
            self.assertEqual(orch.info.capabilities.lifecycle.reconcile, "owner-attestation")
            self.assertTrue(orch.info.capabilities.lifecycle.durable_deadlines)
            task = await orch.tasks.create(self.spec(), idempotency_key="deadline-task")
            async with asyncio.timeout(5):
                while (await orch.tasks.get(task.id)).status != "running":
                    await asyncio.sleep(0.005)
            session = await orch.sessions.get(task.session_id)
            pause = await orch.sessions.control(self.target(session), {"action": "pause", "mode": "drain"},
                                                idempotency_key="deadline-pause")
            timed_out = await pause.wait(timeout=3)
            self.assertEqual(timed_out.status, "outcome_unknown")
            self.assertEqual(timed_out.lifecycle.kind, "drain")
            self.assertTrue(timed_out.lifecycle.expired_at)
            deadline = timed_out.lifecycle.deadline_at
            await self.event(orch, task.id, "dispatch.late_evidence")
            self.assertEqual((await orch.tasks.get(task.id)).status, "blocked")
            session = await orch.sessions.get(task.session_id)
            self.assertEqual(session.status, "outcome_unknown")
            target = self.target(session)
            reconciled = await orch.sessions.reconcile(target, self.evidence(), idempotency_key="owner-reconcile")
            self.assertEqual((await reconciled.wait(timeout=2)).status, "completed")
            self.assertEqual((await orch.tasks.get(task.id)).status, "paused")
            duplicate = await orch.sessions.reconcile(target, self.evidence(), idempotency_key="owner-reconcile")
            self.assertEqual(duplicate.id, reconciled.id)
            original = await orch.operations.get(pause.id)
            self.assertEqual(original.status, "outcome_unknown")
            self.assertEqual(original.resolution.operation_id, reconciled.id)
            await orch.tasks.resume(task.id, idempotency_key="resume-for-acceptance")
            approval_event = await self.event(orch, task.id, "approval.requested")
            approval = await orch.approvals.get(approval_event.data.approval_id)
            await orch.approvals.decide(approval.approval_id,
                {"choice": "approve", "expected_revision": approval.revision}, idempotency_key="accept-reconciled")
            self.assertEqual((await task.wait(timeout=2)).status, "completed")
            started = 0
            async with asyncio.timeout(5):
                stream = orch.events(task_id=task.id)
                try:
                    async for event in stream:
                        started += event.type == "dispatch.started"
                        if event.type == "task.completed":
                            break
                finally:
                    await stream.aclose()
            self.assertEqual(started, 1, "resume after owner reconciliation must not rerun the model")
        async with self.local() as restarted:
            original = await restarted.operations.get(pause.id)
            self.assertEqual(original.status, "outcome_unknown")
            self.assertEqual(original.lifecycle.deadline_at, deadline)
            self.assertEqual(original.resolution.operation_id, reconciled.id)
            self.assertEqual((await restarted.tasks.get(task.id)).status, "completed")

    async def test_0012_r01_client_pause_origin_survives_python_host_restart(self):
        async with self.local() as orch:
            task = await orch.tasks.create(self.spec(), idempotency_key="origin-task")
            async with asyncio.timeout(5):
                while (await orch.tasks.get(task.id)).status != "waiting_approval":
                    await asyncio.sleep(0.005)
            session = await orch.sessions.get(task.session_id)
            await orch.sessions.control(self.target(session), {"action": "pause"},
                                        idempotency_key="origin-pause")
            paused = await orch.sessions.get(task.session_id)
            self.assertEqual(paused.pause_origin, "client")
            self.assertEqual(paused.status, "paused")
        async with self.local() as restarted:
            persisted = await restarted.sessions.get(task.session_id)
            self.assertEqual(persisted.pause_origin, "client")
            await restarted.sessions.control(self.target(persisted), {"action": "resume"},
                                             idempotency_key="origin-resume")
            resumed = await restarted.sessions.get(task.session_id)
            self.assertNotIn("pause_origin", resumed.as_dict())

    @staticmethod
    async def accepts(path):
        try:
            _, writer = await asyncio.open_unix_connection(path)
        except OSError:
            return False
        writer.close()
        await writer.wait_closed()
        return True

    async def test_a_socket_client_cannot_submit_owner_attestation(self):
        socket_path = str(self.directory / "host.sock")
        process = await asyncio.create_subprocess_exec(NODE, str(CLI), "host", "--config", str(self.config),
            "--socket", socket_path, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            # SPEC-0040 R01: the socket file exists from bind(), before listen() accepts, so wait for
            # a connection the host accepts rather than for the file.
            async with asyncio.timeout(5):
                while not await self.accepts(socket_path):
                    if process.returncode is not None:
                        self.fail((await process.stderr.read()).decode())
                    await asyncio.sleep(0.01)
            async with Orchestrator.connect(socket_path=socket_path, poll_interval=0.005) as client:
                task = await client.tasks.create(self.spec(), idempotency_key="socket-task")
                session = await client.sessions.get(task.session_id)
                with self.assertRaises(OrchestrationError) as raised:
                    await client.sessions.reconcile(self.target(session), self.evidence(), idempotency_key="not-owner")
                self.assertEqual(raised.exception.code, "UNAUTHORIZED")
                self.assertEqual(raised.exception.scope, session.id)
                self.assertEqual(raised.exception.idempotency_key, "not-owner")
            self.assertIsNone(process.returncode)
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
