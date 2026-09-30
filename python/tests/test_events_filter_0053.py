"""SPEC-0053 F03: the Python SDK passes events.read's type filter."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
class EventsFilterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="orchvia-events-filter-")
        base = Path(self.directory.name).resolve()
        (base / "work").mkdir()
        (base / "state").mkdir(mode=0o700)
        config = base / "orchestrator.json"
        config.write_text(json.dumps({
            "configVersion": 1, "workspace": str(base / "work"), "stateDir": str(base / "state"),
            "storage": {"emergencyBytes": 4096},
            "providers": {"fake": {"model": "fake-model", "permissionProfile": "read-only"}}}))
        self.orch = await Orchestrator.local(
            engine_command=[NODE, str(CLI), "host", "--stdio", "--config", str(config)], close_timeout=3)
        self.task = await self.orch.tasks.create(
            TaskSpec(goal="filter", runtime=RuntimeSpec(provider="fake", model="fake-model"),
                     acceptance=AcceptanceSpec(criteria=["fixture"])), idempotency_key="filter")
        async with asyncio.timeout(10):
            while (await self.orch.tasks.get(self.task.id)).status != "waiting_approval":
                await asyncio.sleep(0.02)

    async def asyncTearDown(self):
        await self.orch.close(timeout=3)
        self.directory.cleanup()

    async def first(self, **options):
        found = []
        async with asyncio.timeout(5):
            async for event in self.orch.events(task_id=self.task.id, **options):
                found.append(event.type)
                if len(found) == 1:
                    break
        return found

    async def test_0053_f03_types_and_exclude_types(self):
        self.assertEqual(await self.first(types=["task.waiting_approval"]), ["task.waiting_approval"])
        excluded = await self.first(exclude_types=["task.created"])
        self.assertNotIn("task.created", excluded)
        self.assertEqual(await self.first(), ["task.created"])


if __name__ == "__main__":
    unittest.main()
