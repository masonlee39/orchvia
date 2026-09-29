"""SPEC-0044 T through the Python SDK and a real host: settling a task without waiting forever."""
import asyncio
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, OrchestrationError, Orchestrator, RuntimeSpec, SettledTask, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
READ = RuntimeSpec("fake-read", "r-default")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class SettleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0044-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    def local(self):
        return Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                  poll_interval=0.005, request_timeout=5)

    async def test_0044_t01_t02_without_a_handler_nothing_is_decided(self):
        async with self.local() as orch:
            task = await orch.tasks.create(TaskSpec("Review me", READ, ACCEPT))
            settled = await task.settle(timeout=5)
            self.assertIsInstance(settled, SettledTask)
            self.assertEqual(settled.reason, "waiting_approval")
            self.assertEqual(settled.approval.status, "pending")
            self.assertEqual((await orch.approvals.get(settled.approval.approval_id)).status, "pending")

    async def test_0044_t02_a_handler_decides_once(self):
        async with self.local() as orch:
            task = await orch.tasks.create(TaskSpec("Approve me", READ, ACCEPT))
            seen = []

            async def decide(approval, current):
                seen.append((approval.approval_id, current.status))
                return "approve"

            settled = await task.settle(on_approval=decide, timeout=5)
            self.assertEqual(settled.reason, "terminal")
            self.assertEqual(settled.task.status, "completed")
            self.assertEqual(len(seen), 1)
            other = await orch.tasks.create(TaskSpec("Undecided", READ, ACCEPT))
            asked = []
            undecided = await other.settle(on_approval=lambda approval, current: asked.append(1), timeout=5)
            self.assertEqual(undecided.reason, "waiting_approval")
            self.assertEqual(asked, [1])

    async def test_0044_t03_a_timeout_leaves_the_task(self):
        async with self.local() as orch:
            task = await orch.tasks.create(TaskSpec("Review me", READ, ACCEPT))
            await task.settle(timeout=5)
            # Decided by no one, a settle that waits on a handler that never answers times out.
            never = asyncio.Event()

            async def wait_forever(approval, current):
                await never.wait()

            with self.assertRaises(OrchestrationError) as raised:
                await task.settle(on_approval=wait_forever, timeout=0.2)
            self.assertEqual(raised.exception.code, "TIMEOUT")
            self.assertEqual((await task.get()).status, "waiting_approval")


if __name__ == "__main__":
    unittest.main()
