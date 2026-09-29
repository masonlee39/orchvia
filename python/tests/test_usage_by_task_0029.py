"""SPEC-0029 through the Python SDK and a real host: usage by task, deliveredAt, reactivating rules and
tasks that a close paused."""
import asyncio
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
READ = RuntimeSpec("fake-read", "r-default")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])
RULE = {"id": "lint", "version": "1", "argv": ["/usr/bin/true"], "cwd_relative": ".",
        "timeout_ms": 1000, "permission_profile": "read-only", "success": {"exitCode": 0}}


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class UsageByTaskTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0029-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    @staticmethod
    async def wait(orch, task_id, status):
        async with asyncio.timeout(5):
            while (task := await orch.tasks.get(task_id)).status != status:
                await asyncio.sleep(0.005)
        return task

    async def test_0029_a04_b03_python_reads_usage_by_task_and_delivery_time(self):
        async with self.local() as orch:
            self.assertTrue(orch.info.capabilities.workflow.get("usage_by_task"))
            first = await orch.tasks.create(TaskSpec("First", READ, ACCEPT))
            second = await orch.tasks.create(TaskSpec("Second", READ, ACCEPT))
            delivered = await self.wait(orch, first.id, "waiting_approval")
            await self.wait(orch, second.id, "waiting_approval")
            self.assertIsInstance(delivered.delivered_at, str)
            result = await orch.usage.by_task([second.id, "missing", first.id])
            self.assertEqual([entry.task_id for entry in result.tasks], [second.id, first.id])
            self.assertEqual(result.missing, ["missing"])
            entry = result.tasks[0]
            self.assertEqual(entry.by_model, [])
            self.assertEqual(entry.totals.records, 0)
            self.assertEqual(entry.totals.unknown_records, 0)
            self.assertEqual(entry.completeness, "unknown")
            # SPEC-0042 E05: the efforts it ran with, none for a task without records.
            self.assertTrue(orch.info.capabilities.workflow.get("reasoning_efforts"))
            self.assertEqual(entry.reasoning_efforts, [])
            with self.assertRaises(OrchestrationError) as raised:
                await orch.usage.by_task([])
            self.assertEqual(raised.exception.code, "VALIDATION_ERROR")

    async def test_0029_c01_d04_python_reactivates_rules_and_reads_close_marks(self):
        orch = self.local()
        await orch.start()
        try:
            await orch.rules.register(RULE, idempotency_key="lint-1")
            await orch.rules.retire("lint", "1", idempotency_key="retire-1")
            again = await orch.rules.register(RULE, idempotency_key="lint-1-again")
            # Raw result JSON keeps its camelCase keys.
            self.assertTrue(again.result["reactivated"])
            root = await orch.tasks.create(TaskSpec("Root", READ, ACCEPT))
            waiting = await self.wait(orch, root.id, "waiting_approval")
            child = await orch.tasks.create(TaskSpec(
                "Child", READ, ACCEPT, parent_task_id=root.id,
                context_plan={"requested_mode": "reuse", "independent": True,
                              "candidate_session_id": waiting.session_id}))
            self.assertEqual((await orch.tasks.get(child.id)).status, "queued")
            closed = await orch.close(mode="pause", timeout=2)
        finally:
            await orch.close()
        async with self.local() as reopened:
            paused = await reopened.tasks.get(child.id)
            self.assertEqual((paused.status, paused.reason), ("paused", "owner_shutdown"))
            self.assertEqual(paused.paused_by_close.operation_id, closed.operation_id)
            self.assertFalse(paused.paused_by_close.was_running)


class UsageByTaskNegotiationTests(unittest.IsolatedAsyncioTestCase):
    async def test_0029_a04_python_checks_the_feature_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "workflow-0.1.4"],
                                      poll_interval=0.005) as orch:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.usage.by_task(["a"])
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
            self.assertTrue(str(raised.exception).startswith("Host does not support"), str(raised.exception))


if __name__ == "__main__":
    unittest.main()
