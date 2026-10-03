"""SPEC-0065 H10 through the Python SDK and a real host: tasks that the host completes."""
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec
from orchvia.types import to_wire


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "host-tasks-host.ts"
NODE = shutil.which("node")


class HostTaskTests(unittest.IsolatedAsyncioTestCase):
    def test_0065_h01_a_host_task_spec_has_no_runtime_fields_on_the_wire(self):
        self.assertEqual(to_wire(TaskSpec("wait", executor="host", expires_at="2030-01-01T00:00:00Z")),
                         {"goal": "wait", "executor": "host", "expiresAt": "2030-01-01T00:00:00Z"})
        wire = to_wire(TaskSpec("work", RuntimeSpec("fake", "fixture"), AcceptanceSpec(criteria=["Review"])))
        self.assertEqual(wire["runtime"], {"provider": "fake", "model": "fixture"})
        self.assertNotIn("executor", wire)

    async def test_0065_h10_without_the_flag_the_sdk_refuses_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "normal"],
                                      poll_interval=0.005) as orch:
            for attempt in (lambda: orch.tasks.create(TaskSpec("wait", executor="host")),
                            lambda: orch.tasks.complete("task", outcome="completed")):
                with self.assertRaises(OrchestrationError) as raised:
                    await attempt()
                self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")

    @unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
    async def test_0065_h04_a_host_task_is_completed_and_releases_what_depends_on_it(self):
        with tempfile.TemporaryDirectory(prefix="orch-py-host-", dir=str(Path("/tmp").resolve())) as directory:
            base = Path(directory).resolve()
            (base / "workspace").mkdir()
            (base / "state").mkdir()
            async with Orchestrator.local(engine_command=[NODE, str(HOST), str(base / "workspace"), str(base / "state")],
                                          poll_interval=0.005, request_timeout=5) as orch:
                gate = await orch.tasks.create(TaskSpec("wait for a person", executor="host", label="step:approve"))
                self.assertEqual(gate.status, "waiting_host")
                self.assertIsNone(gate.session_id)
                self.assertEqual(gate.spec["executor"], "host")
                after = await orch.tasks.create(TaskSpec("after", RuntimeSpec("fake", "fixture"),
                                                         AcceptanceSpec(criteria=["Review"]),
                                                         dependency_task_ids=[gate.id]))
                settled = await gate.settle(timeout=2)
                self.assertEqual(settled.reason, "waiting_host")
                self.assertIsNone(settled.session)
                op = await gate.complete(outcome="completed", result="approved by Alex", idempotency_key="done")
                done = await op.wait(timeout=5)
                self.assertEqual(done.status, "completed")
                # Raw JSON keeps the wire's names.
                self.assertEqual(done.result, {"taskId": gate.id, "status": "completed"})
                ended = await gate.get()
                self.assertEqual(ended.status, "completed")
                self.assertEqual(ended.result, "approved by Alex")
                self.assertIsNotNone(ended.delivered_at)
                self.assertEqual((await after.settle(timeout=5)).reason, "waiting_approval")
                with self.assertRaises(OrchestrationError) as raised:
                    await orch.tasks.complete(gate.id, outcome="failed")
                self.assertEqual(raised.exception.code, "STALE_TARGET")
                failing = await orch.tasks.create(TaskSpec("ticket", executor="host"))
                await (await failing.complete(outcome="failed", result="rejected")).wait(timeout=5)
                failed = await failing.get()
                self.assertEqual((failed.status, failed.reason), ("failed", "host_reported_failure"))


if __name__ == "__main__":
    unittest.main()
