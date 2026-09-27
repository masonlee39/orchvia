"""SPEC-0033 Y (#47): typed read-only views of the Python SDK's results."""
import asyncio
import importlib.util
from pathlib import Path
import shutil
import tempfile
import typing
import unittest

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec
from orchvia.client import OperationHandle, TaskHandle, _Approvals, _Operations, _Scheduler, _Sessions, _Tasks, _Usage


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
READ = RuntimeSpec("fake-read", "r-default")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])


def generator():
    spec = importlib.util.spec_from_file_location("generate_python_views", ROOT / "scripts" / "generate-python-views.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GeneratedViewTests(unittest.TestCase):
    def test_0033_y01_views_are_generated_from_the_schema(self):
        self.assertEqual((ROOT / "python" / "src" / "orchvia" / "views.py").read_text(), generator().render())

    def test_0033_y02_methods_name_their_views(self):
        expected = {
            (_Tasks, "get"): "TaskSnapshotView", (_Tasks, "list"): "TaskListResultView",
            (_Tasks, "get_many"): "TaskGetManyResultView", (_Sessions, "get"): "SessionSnapshotView",
            (_Sessions, "inspect"): "RuntimeInspectionView", (_Scheduler, "get"): "SchedulerSnapshotView",
            (_Operations, "get"): "OperationSnapshotView", (_Approvals, "get"): "ApprovalRequestView",
            (_Usage, "summary"): "UsageSummaryView", (_Usage, "by_task"): "UsageByTaskResultView",
            (TaskHandle, "wait"): "TaskSnapshotView", (OperationHandle, "wait"): "OperationSnapshotView",
        }
        for (owner, name), view in expected.items():
            hints = typing.get_type_hints(getattr(owner, name))
            self.assertEqual(getattr(hints["return"], "__name__", None), view, f"{owner.__name__}.{name}")


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class ViewConformanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orch-py-views-", dir=str(Path("/tmp").resolve()))
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name).resolve()
        (directory / "workspace").mkdir()
        (directory / "state").mkdir()
        self.command = [NODE, str(HOST), str(directory / "workspace"), str(directory / "state")]

    def conforms(self, value, view):
        from orchvia import views
        fields = views.FIELDS[view]
        extra = set(value.keys()) - set(fields)
        # Capabilities grow by design; every other result must hold only what its view names, so
        # that a field missing from the schema fails here even where the schema allows others.
        if view != "InitializeResultCapabilitiesView":
            self.assertFalse(extra, f"{view} lacks {sorted(extra)}")
        missing = {name for name, required in fields.items() if required and name not in value}
        self.assertFalse(missing, f"{view} requires {sorted(missing)}")
        for name, nested in views.NESTED.get(view, {}).items():
            items = value[name] if name in value else None  # TaskHandle.get() re-reads the task.
            for item in (items if isinstance(items, list) else [items] if items is not None else []):
                self.conforms(item, nested)

    async def test_0033_y04_results_of_a_real_host_match_their_views(self):
        async with Orchestrator.local(engine_command=self.command, poll_interval=0.005, request_timeout=5) as orch:
            self.conforms(orch.info, "InitializeResultView")
            task = await orch.tasks.create(TaskSpec("Typed", READ, ACCEPT))
            self.conforms(task, "TaskReceiptView")
            async with asyncio.timeout(5):
                while (current := await orch.tasks.get(task.id)).status != "waiting_approval":
                    await asyncio.sleep(0.005)
            self.conforms(current, "TaskSnapshotView")
            self.conforms(await orch.tasks.list(), "TaskListResultView")
            self.conforms(await orch.tasks.get_many([task.id, "missing"]), "TaskGetManyResultView")
            self.conforms(await orch.sessions.get(current.session_id), "SessionSnapshotView")
            self.conforms(await orch.approvals.get(current.approval_id), "ApprovalRequestView")
            self.conforms(await orch.scheduler.get(), "SchedulerSnapshotView")
            self.conforms(await orch.usage.summary(task.id), "UsageSummaryView")
            self.conforms(await orch.usage.by_task([task.id]), "UsageByTaskResultView")
            session = await orch.sessions.get(current.session_id)
            message = await orch.messages.send({"task_id": task.id, "to_session_id": session.id,
                                                "expected_generation": session.generation,
                                                "kind": "finding", "summary": "Note"})
            self.conforms(message, "MessageReceiptView")
            self.conforms(await orch.messages.get(message.id), "MessageSnapshotView")
            self.conforms(await orch.handoffs.list(), "HandoffListResultView")
            self.conforms(await orch.rules.list(), "RuleListResultView")
            page = await orch.state.snapshot()
            self.conforms(page, "SnapshotPageView")
            await orch.state.release_snapshot(page.snapshot_id)
            operation = await orch.tasks.cancel(task.id)
            self.conforms(operation, "OperationReceiptView")
            self.conforms(await orch.operations.get(operation.id), "OperationSnapshotView")
            self.conforms(await orch.operations.lookup(method="tasks.cancel", scope=task.id,
                                                       idempotency_key=operation.idempotency_key),
                          "OperationSnapshotView")


if __name__ == "__main__":
    unittest.main()
