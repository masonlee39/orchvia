"""Executable local wiring example: fake runtime only; no model or credentials."""
import argparse
import asyncio
import json
from pathlib import Path
import shutil
import tempfile

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, ShutdownIncomplete, TaskSpec


ROOT = Path(__file__).resolve().parents[2]


async def run(node: str, emergency_bytes: int | None = None) -> dict:
    with tempfile.TemporaryDirectory(prefix="orch-python-example-") as directory:
        base = Path(directory).resolve()
        workspace = base / "workspace"
        state = base / "state"
        workspace.mkdir()
        state.mkdir()
        config = base / "orchestrator.json"
        expected = "deterministic Python example result"
        settings = {
            "configVersion": 1, "workspace": str(workspace), "stateDir": str(state),
            "providers": {"fake": {"model": "fake-model", "result": expected,
                                    "permissionProfile": "read-only"}},
        }
        if emergency_bytes is not None:
            settings["storage"] = {"emergencyBytes": emergency_bytes}
        config.write_text(json.dumps(settings), encoding="utf-8")
        orch = await Orchestrator.local(engine_command=[node, str(ROOT / "packages/cli/src/main.ts"),
            "host", "--stdio", "--config", str(config)], close_timeout=3)
        result = None
        business_error = None
        try:
            task = await orch.tasks.create(
                TaskSpec(goal="exercise a deterministic, non-model fixture",
                         runtime=RuntimeSpec(provider="fake", model="fake-model"),
                         acceptance=AcceptanceSpec(criteria=["exact fixture output"])),
                idempotency_key="python-example-task")
            # This automated decision is restricted to the known fake test fixture.
            # Real runtime applications must collect their authorized user's decision.
            async with asyncio.timeout(5):
                async for event in orch.events(task_id=task.id):
                    if event.type == "approval.requested":
                        request = await orch.approvals.get(event.data.approval_id)
                        current = await orch.tasks.get(task.id)
                        if request.status != "pending" or current.result != expected:
                            raise RuntimeError("Unexpected fixture evidence; no approval was sent")
                        await orch.approvals.decide(request.approval_id,
                            {"choice": "approve", "expected_revision": request.revision},
                            idempotency_key="python-example-approval")
                        break
            final = await task.wait(timeout=5)
            if final.status != "completed":
                raise RuntimeError(f"Fixture was not accepted: {final.status}")
            result = {"runtime": "fake", "task_id": final.id, "status": final.status,
                      "result": final.result, "model_calls": "none"}
        except BaseException as error:
            business_error = error
        try:
            try:
                await orch.close(timeout=3)
            except ShutdownIncomplete as pending:
                # The example owns only a fake fixture, so this explicit policy is safe.
                await pending.client.close(operation_id=pending.operation_id, mode="interrupt", timeout=3)
        except BaseException as close_error:
            if business_error is not None:
                raise business_error from close_error
            raise
        if business_error is not None:
            raise business_error
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"), help="Node.js 22.18+ executable")
    parser.add_argument("--emergency-bytes", type=int,
                        help="disk space the host keeps in reserve, in bytes (default 256 MiB)")
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js 22.18+ is required")
    print(json.dumps(asyncio.run(run(args.node, args.emergency_bytes)), ensure_ascii=False, indent=2))
