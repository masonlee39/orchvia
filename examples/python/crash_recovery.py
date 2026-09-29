"""Offline crash recovery: a host is killed during an accepted dispatch, and a new host on the same
state directory neither resends nor forgets it. The owner reconciles it after checking.

Uses the fake runtime: no login, network request or model call. Python starts the Node host
from this checkout, so run it from the repository root:

    PYTHONPATH=python/src python3 examples/python/crash_recovery.py
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec


ROOT = Path(__file__).resolve().parents[2]


def host_command(node: str, root: Path) -> list[str]:
    return [node, str(ROOT / "packages/cli/src/main.ts"), "host", "--stdio",
            "--config", str(root / "orchestrator.json")]


async def first_host(node: str, root: Path) -> None:
    """The first host: its runtime is accepted and then works for an hour."""
    async with Orchestrator.local(engine_command=host_command(node, root)) as orch:
        task = await orch.tasks.create(TaskSpec(
            goal="Migrate the settings file", runtime=RuntimeSpec(provider="fake", model="fake-model"),
            acceptance=AcceptanceSpec(mode="human", criteria=["A reviewer read the result"])))
        async for event in orch.events(task_id=task.id):
            if event.type == "dispatch.runtime_accepted":
                # The parent kills this process group, the Node host included, once it reads this.
                print(json.dumps({"taskId": task.id}), flush=True)
                break
        await asyncio.Event().wait()


async def main(node: str, emergency_bytes: int | None) -> None:
    with tempfile.TemporaryDirectory(prefix="orchvia-crash-") as directory:
        root = Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "state").mkdir(mode=0o700)
        settings = {
            "workspace": str(root / "workspace"),
            "stateDir": str(root / "state"),
            "providers": {"fake": {"model": "fake-model", "delayMs": 3_600_000}},
        }
        if emergency_bytes is not None:
            settings["storage"] = {"emergencyBytes": emergency_bytes}
        (root / "orchestrator.json").write_text(json.dumps(settings), encoding="utf-8")

        host = await asyncio.create_subprocess_exec(
            sys.executable, __file__, "--host", str(root), "--node", node,
            stdout=asyncio.subprocess.PIPE, start_new_session=True)
        try:
            line = await asyncio.wait_for(host.stdout.readline(), 30)
            task_id = json.loads(line)["taskId"]
            os.killpg(host.pid, signal.SIGKILL)
            await host.wait()
            print("1. The host was killed while its runtime worked on the task")
        finally:
            if host.returncode is None:
                os.killpg(host.pid, signal.SIGKILL)
                await host.wait()

        async with Orchestrator.local(engine_command=host_command(node, root)) as orch:
            task = await orch.tasks.get(task_id)
            session = await orch.sessions.get(task.session_id)
            print(f"2. After the restart: task {task.status}, session {session.status}")

            # A real owner first checks that the runtime's processes ended and what they changed.
            operation = await orch.sessions.reconcile({
                "session_id": session.id,
                "expected_generation": session.generation,
                "expected_revision": session.revision,
                "expected_dispatch_id": session.active_dispatch_id,
                "expected_state": session.status,
            }, {
                "source": "owner_attestation",
                "summary": "The runtime process is gone and the settings file is unchanged",
                "local_resources": "stopped",
                "remote_execution": "stopped",
                "side_effects": "resolved",
                "outcome": "interrupted",
            })
            await operation.wait(timeout=10)
            after = await orch.tasks.get(task_id)
            paused = await orch.sessions.get(session.id)
            print(f"3. Reconciled: task {after.status} ({after.reason}), session {paused.status}")
            started = 0
            async with asyncio.timeout(10):
                async for event in orch.events(task_id=task_id):
                    if event.type == "dispatch.started":
                        started += 1
                    if event.type == "task.failed":
                        break
            # The one dispatch before the crash is the only one.
            print(f"4. Dispatches sent again: {started - 1}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--node", default=shutil.which("node"), help="Node.js 22.18+ executable")
    parser.add_argument("--emergency-bytes", type=int,
                        help="disk space the host keeps in reserve, in bytes (default 256 MiB)")
    parser.add_argument("--host", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js 22.18+ is required")
    if args.host:
        asyncio.run(first_host(args.node, Path(args.host)))
    else:
        asyncio.run(main(args.node, args.emergency_bytes))
