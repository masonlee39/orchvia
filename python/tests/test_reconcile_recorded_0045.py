"""SPEC-0045 R02 through the Python SDK: a completed attestation without result needs the flag."""
from pathlib import Path
import sys
import unittest

from orchvia import OrchestrationError, Orchestrator


TARGET = {"session_id": "s", "expected_generation": 1, "expected_revision": 1,
          "expected_dispatch_id": "d", "expected_state": "outcome_unknown"}
EVIDENCE = {"source": "owner_attestation", "summary": "checked", "local_resources": "stopped",
            "remote_execution": "stopped", "side_effects": "resolved", "outcome": "completed"}


class ReconcileRecordedTests(unittest.IsolatedAsyncioTestCase):
    async def test_0045_r02_without_the_flag_the_sdk_refuses_before_sending(self):
        fixture = Path(__file__).with_name("fake_protocol_server.py")
        async with Orchestrator.local(engine_command=[sys.executable, str(fixture), "--mode", "lifecycle"],
                                      poll_interval=0.005) as orch:
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.reconcile(TARGET, EVIDENCE, idempotency_key="k")
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")
            with self.assertRaises(OrchestrationError) as raised:
                await orch.sessions.reconcile(TARGET, {**EVIDENCE, "outcome": "recorded"}, idempotency_key="r")
            self.assertEqual(raised.exception.code, "UNSUPPORTED_CAPABILITY")


if __name__ == "__main__":
    unittest.main()
