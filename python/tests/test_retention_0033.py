"""SPEC-0033 S04 through the Python SDK and a real host: the retention status of storage.status."""
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import Orchestrator


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class RetentionStatusTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-0033-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        self.workspace = directory / "workspace"
        self.workspace.mkdir()
        self.state = directory / "state"
        self.state.mkdir()

    async def test_0033_s04_python_reads_the_retention_status(self):
        async with Orchestrator.local(engine_command=[NODE, str(HOST), str(self.workspace), str(self.state)],
                                      poll_interval=0.005, request_timeout=5) as orch:
            status = await orch.storage.status()
            retention = status.retention
            self.assertEqual(retention.events_past_age, 0)
            self.assertIs(retention.events_past_age_capped, False)
            self.assertEqual(retention.detail_pending, 0)
            self.assertIs(retention.detail_pending_capped, False)
            self.assertIsNone(retention.oldest_collectable_at)
            self.assertIn(retention.event_prefix.reason, (None, "age"))
            self.assertIn("stopped_at_cursor", retention.event_prefix)


if __name__ == "__main__":
    unittest.main()
