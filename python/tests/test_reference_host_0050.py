"""SPEC-0050 T04: the Python reference host resolves an intended step as the TypeScript host does.

The workflow, the injected faults and the inspector run in tests/contract/reference-host-0050.test.ts
for both hosts; this test covers each recovery answer with a stand-in client."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from orchvia import OrchestrationError

HOST = Path(__file__).resolve().parents[2] / "examples/reference-host/host.py"
_spec = importlib.util.spec_from_file_location("reference_host", HOST)
reference_host = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reference_host)


class Client:
    def __init__(self, lookup, create=None):
        self.calls = []
        self.info = SimpleNamespace(store_id="s1")
        self._lookup, self._create = lookup, create
        client = self

        class Operations:
            async def lookup(self, *, method, scope, idempotency_key):
                client.calls.append("lookup")
                return client._lookup()

        class Tasks:
            async def create(self, spec, *, idempotency_key):
                client.calls.append(f"create {idempotency_key} {json.dumps(spec)}")
                return client._create() if client._create else SimpleNamespace(id="created")

        self.operations, self.tasks = Operations(), Tasks()


def raises(code):
    def fail():
        raise OrchestrationError(code, code)
    return fail


class ResolveStepTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = reference_host.Journal(Path(self.directory.name) / "journal.sqlite")
        self.n = 0

    def tearDown(self):
        self.journal.db.close()
        self.directory.cleanup()

    def intend(self, store_id="s1"):
        self.n += 1
        step_id = f"step-{self.n}"
        self.journal.x("INSERT INTO steps (runId, stepId, storeId, idempotencyKey, request, state) "
                       "VALUES ('r', ?, ?, ?, ?, 'intended')", step_id, store_id, f"refhost/r/{step_id}",
                       json.dumps({"goal": "x"}))
        return self.journal.step("r", step_id)

    async def test_0050_T04_found_is_recorded_and_not_sent(self):
        client, step = Client(lambda: {"status": "completed", "target_id": "t1"}), self.intend()
        await reference_host.resolve_step(self.journal, client, step)
        after = self.journal.step("r", step["stepId"])
        self.assertEqual((after["state"], after["taskId"]), ("submitted", "t1"))
        self.assertEqual(client.calls, ["lookup"])

    async def test_0050_T04_not_found_sends_the_frozen_request_under_the_same_key(self):
        client, step = Client(raises("NOT_FOUND")), self.intend()
        await reference_host.resolve_step(self.journal, client, step)
        self.assertEqual(self.journal.step("r", step["stepId"])["taskId"], "created")
        self.assertEqual(client.calls, ["lookup", f'create {step["idempotencyKey"]} {{"goal": "x"}}'])

    async def test_0050_T04_other_answers_need_a_person_and_send_nothing_again(self):
        for client, reason in [
            (Client(raises("OPERATION_HISTORY_EXPIRED")), "OPERATION_HISTORY_EXPIRED"),
            (Client(lambda: {"status": "outcome_unknown", "target_id": ""}), "OUTCOME_UNKNOWN"),
            (Client(raises("NOT_FOUND"), raises("IDEMPOTENCY_CONFLICT")), "IDEMPOTENCY_CONFLICT"),
        ]:
            step = self.intend()
            await reference_host.resolve_step(self.journal, client, step)
            after = self.journal.step("r", step["stepId"])
            self.assertEqual(after["state"], "attention", reason)
            self.assertIn(reason, after["attention"])
            self.assertLessEqual(sum(call.startswith("create") for call in client.calls), 1)
        client, step = Client(lambda: {"status": "completed", "target_id": "t1"}), self.intend("another-store")
        await reference_host.resolve_step(self.journal, client, step)
        self.assertIn("store_changed", self.journal.step("r", step["stepId"])["attention"])
        self.assertEqual(client.calls, [])

    async def test_0050_T04_an_outcome_free_failure_keeps_the_intent(self):
        client, step = Client(raises("CONNECTION_CLOSED")), self.intend()
        with self.assertRaises(OrchestrationError):
            await reference_host.resolve_step(self.journal, client, step)
        self.assertEqual(self.journal.step("r", step["stepId"])["state"], "intended")


if __name__ == "__main__":
    unittest.main()
