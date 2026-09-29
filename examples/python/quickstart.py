"""Offline quickstart: two tasks on one warm session, each accepted before it counts as done.

Uses the fake runtime: no login, network request or model call. Python starts the Node host
from this checkout, so run it from the repository root:

    PYTHONPATH=python/src python3 examples/python/quickstart.py
"""
import argparse
import asyncio
import json
from pathlib import Path
import shutil
import tempfile

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec
from orchvia.wire_types import ContextPlan


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = RuntimeSpec(provider="fake", model="fake-model")
ACCEPTANCE = AcceptanceSpec(mode="human", criteria=["A reviewer read the result"])


async def run(orch: Orchestrator, spec: TaskSpec):
    """Runs one task to completion. A real host shows the result to a person; this demo approves it."""
    task = await orch.tasks.create(spec)
    settled = await task.settle(on_approval=lambda approval, current: "approve", timeout=10)
    return settled.task


async def main(node: str, emergency_bytes: int | None) -> None:
    with tempfile.TemporaryDirectory(prefix="orchvia-quickstart-") as directory:
        root = Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "state").mkdir(mode=0o700)
        settings = {
            "workspace": str(root / "workspace"),
            "stateDir": str(root / "state"),
            "providers": {"fake": {"model": "fake-model"}},
            # One team per engine: a new request may reuse any idle agent.
            "allowCrossRootReuse": True,
        }
        if emergency_bytes is not None:
            settings["storage"] = {"emergencyBytes": emergency_bytes}
        config = root / "orchestrator.json"
        config.write_text(json.dumps(settings), encoding="utf-8")
        host = [node, str(ROOT / "packages/cli/src/main.ts"), "host", "--stdio", "--config", str(config)]
        async with Orchestrator.local(engine_command=host) as orch:
            draft = await run(orch, TaskSpec(goal="Draft the release notes", runtime=RUNTIME,
                                             acceptance=ACCEPTANCE))
            print(f'1. "{draft.spec.goal}": {draft.status}, session {draft.session_id}')
            reuse: ContextPlan = {
                "requestedMode": "reuse",
                "candidateSessionId": draft.session_id,
                "independent": True,
                "dependencyTaskIds": [],
                "contextRefs": [],
                "fallbackModes": [],
                "maxQueueWaitMs": 30_000,
            }
            review = await run(orch, TaskSpec(goal="Tighten the draft you just wrote", runtime=RUNTIME,
                                              acceptance=ACCEPTANCE, context_plan=reuse))
            print(f'2. "{review.spec.goal}": {review.status}, session {review.session_id}')
            reused = review.session_id == draft.session_id
            print(f"The second task reused the first agent's session: {str(reused).lower()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--node", default=shutil.which("node"), help="Node.js 22.18+ executable")
    parser.add_argument("--emergency-bytes", type=int,
                        help="disk space the host keeps in reserve, in bytes (default 256 MiB)")
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js 22.18+ is required")
    asyncio.run(main(args.node, args.emergency_bytes))
