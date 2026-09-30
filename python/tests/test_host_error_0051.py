"""SPEC-0051 E02: a host that ends before it answers hands its error to the SDK as data."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from orchvia import OrchestrationError, Orchestrator


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "cli" / "src" / "main.ts"
TESTING = ROOT / "packages" / "engine" / "src" / "testing.ts"
NODE = shutil.which("node")
FEATURES = [{"name": "from-the-future", "engineVersion": "9.9.9"}]
REFUSAL = json.dumps({"code": "STORE_TOO_NEW", "message": "newer", "details": {"features": FEATURES}})


def host(script: str) -> list[str]:
    return [sys.executable, "-c", script]


class HostErrorDataTests(unittest.IsolatedAsyncioTestCase):
    async def start_error(self, command: list[str]) -> OrchestrationError:
        with self.assertRaises(OrchestrationError) as caught:
            await Orchestrator.local(engine_command=command, close_timeout=3)
        return caught.exception

    async def test_0051_e02_the_host_error_is_data(self):
        error = await self.start_error(host(
            f"import sys; sys.stderr.write('a warning\\n' + {REFUSAL!r} + '\\n'); sys.exit(1)"))
        self.assertEqual(error.code, "CONNECTION_CLOSED")
        self.assertEqual(error.data["hostError"],
                         {"code": "STORE_TOO_NEW", "message": "newer", "data": {"features": FEATURES}})
        self.assertIn("STORE_TOO_NEW", error.data["stderrTail"])

    async def test_0051_e02_output_that_is_no_error_adds_nothing(self):
        for output in ("plain text", '{"message": "no code"}', "[1, 2]"):
            error = await self.start_error(host(f"import sys; sys.stderr.write({output!r} + '\\n'); sys.exit(1)"))
            self.assertEqual(error.code, "CONNECTION_CLOSED")
            self.assertNotIn("hostError", error.data, output)

    @unittest.skipUnless(NODE and CLI.is_file(), "requires Node.js 22.18+ and the local host source")
    async def test_0051_e02_a_real_host_refuses_a_marked_store(self):
        with tempfile.TemporaryDirectory(prefix="orchvia-store-too-new-") as directory:
            base = Path(directory).resolve()
            (base / "work").mkdir()
            state = base / "state"
            state.mkdir(mode=0o700)
            config = base / "orchestrator.json"
            config.write_text(json.dumps({
                "configVersion": 1, "workspace": str(base / "work"), "stateDir": str(state),
                "storage": {"emergencyBytes": 4096},
                "providers": {"fake": {"model": "fake-model", "permissionProfile": "read-only"}}}))
            command = [NODE, str(CLI), "host", "--stdio", "--config", str(config)]
            orch = await Orchestrator.local(engine_command=command, close_timeout=3)
            await orch.close(timeout=3)
            script = (f"import {{ markStoreFeatureForTest }} from {json.dumps(TESTING.as_uri())};"
                      f"await markStoreFeatureForTest({json.dumps(str(state))}, {json.dumps(FEATURES[0])});")
            subprocess.run([NODE, "--input-type=module", "-e", script], check=True, capture_output=True)
            for opening in (command, [NODE, str(CLI), "host", "--read-only", "--state-dir", str(state), "--stdio"]):
                error = await self.start_error(opening)
                self.assertEqual(error.code, "CONNECTION_CLOSED")
                self.assertEqual(error.data["hostError"]["code"], "STORE_TOO_NEW")
                self.assertEqual(error.data["hostError"]["data"], {"features": FEATURES})


if __name__ == "__main__":
    unittest.main()
