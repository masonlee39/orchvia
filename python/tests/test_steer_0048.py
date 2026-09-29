"""SPEC-0048 W01 through the Python SDK and a real host: steering a running turn."""
import asyncio
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "steer-host.ts"
NODE = shutil.which("node")


class SteerTests(unittest.IsolatedAsyncioTestCase):
    async def test_0048_w01_without_the_flag_the_sdk_refuses_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "normal"],
                                      poll_interval=0.005) as orch:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.steer({"session_id": "s", "expected_generation": 1,
                                           "expected_dispatch_id": "d"}, "x")
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")

    @unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
    async def test_0048_w01_a_steer_reaches_the_running_turn(self):
        with tempfile.TemporaryDirectory(prefix="orch-py-steer-", dir=str(Path("/tmp").resolve())) as directory:
            base = Path(directory).resolve()
            (base / "workspace").mkdir()
            (base / "state").mkdir()
            async with Orchestrator.local(engine_command=[NODE, str(HOST), str(base / "workspace"), str(base / "state")],
                                          poll_interval=0.005, request_timeout=5) as orch:
                task = await orch.tasks.create(TaskSpec("work", RuntimeSpec("fake", "fixture"),
                                                        AcceptanceSpec(criteria=["Review"])))
                session = await orch.sessions.get(task.session_id)
                for _ in range(400):
                    if session.get("active_dispatch_id") and session.get("provider_session_id"):
                        break
                    await asyncio.sleep(0.005)
                    session = await orch.sessions.get(task.session_id)
                op = await orch.sessions.steer({"session_id": session.id, "expected_generation": session.generation,
                                                "expected_dispatch_id": session.active_dispatch_id},
                                               "keep the old API", idempotency_key="steer-1")
                done = await op.wait(timeout=5)
                self.assertEqual(done.status, "completed")
                message = await orch.messages.get(done.result["messageId"])
                self.assertEqual(message.kind, "steer")
                self.assertEqual(message.summary, "keep the old API")
                with self.assertRaises(OrchestrationError) as raised:
                    await orch.sessions.steer({"session_id": session.id, "expected_generation": session.generation,
                                               "expected_dispatch_id": "gone"}, "late")
                self.assertEqual(raised.exception.code, "STEER_TURN_ENDED")
                self.assertEqual(raised.exception.data["turnOutcome"], "unknown")


if __name__ == "__main__":
    unittest.main()
