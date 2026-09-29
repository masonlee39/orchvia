"""Offline team: a lead agent delegates to a helper, leaves it a message, and asks to hand work to
another agent. The host approves the delegation and accepts the handoff.

The runtime is a scripted fake that calls the orchestration tools a real model would call. It runs
in a custom Node host, examples/typescript/team-host.ts, that Python starts and owns. Run it from
the repository root:

    PYTHONPATH=python/src python3 examples/python/team_mailbox.py
"""
import argparse
import asyncio
from pathlib import Path
import re
import shutil
import tempfile

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskHandle, TaskSpec
from orchvia.wire_types import ContextPlan


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = RuntimeSpec(provider="fake", model="fake-model")
ACCEPTANCE = AcceptanceSpec(mode="human", criteria=["A reviewer read the result"])


async def run(orch: Orchestrator, task):
    """Runs one task to its end. A real host shows each result to a person; this demo approves it."""
    # A task that a model created has no handle yet; one can be made from its snapshot.
    handle = await orch.tasks.create(task) if isinstance(task, TaskSpec) else TaskHandle(orch, task)
    settled = await handle.settle(on_approval=lambda approval, current: "approve", timeout=10)
    if settled.reason != "terminal":
        raise RuntimeError(f"{settled.task.id} {settled.reason}")
    return settled.task


async def main(node: str) -> None:
    with tempfile.TemporaryDirectory(prefix="orchvia-team-") as directory:
        root = Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "state").mkdir(mode=0o700)
        host = [node, str(ROOT / "examples/typescript/team-host.ts"),
                str(root / "workspace"), str(root / "state")]
        async with Orchestrator.local(engine_command=host) as orch:
            editor = await run(orch, TaskSpec(goal="Keep a consistent tone", runtime=RUNTIME,
                                              acceptance=ACCEPTANCE))
            # The lead's goal names the editor's session, as a host tells an agent who is on its team.
            lead = await run(orch, TaskSpec(
                goal=f"Write the release notes. The editor works in session {editor.session_id}.",
                runtime=RUNTIME, acceptance=ACCEPTANCE))

            helper = (await orch.tasks.list(parent_task_id=lead.id)).tasks[0]
            print(f'1. The lead delegated "{helper.spec.goal}": {helper.status} for the host')
            await orch.tasks.resume(helper.id)
            checked = await run(orch, helper)
            message = re.search(r"\[Message .*\]\n(.*)", checked.result or "")
            print(f"2. The helper's prompt held the lead's message: {message and message.group(1)}")

            request = (await orch.handoffs.list(status="pending")).handoffs[0]
            # To accept, the host creates the task itself, in the editor's team and session.
            reuse: ContextPlan = {
                "requestedMode": "reuse",
                "candidateSessionId": editor.session_id,
                "independent": True,
                "dependencyTaskIds": [],
                "contextRefs": [],
                "fallbackModes": [],
                "maxQueueWaitMs": 30_000,
            }
            takeover = await orch.tasks.create(TaskSpec(
                goal=request.goal, runtime=RUNTIME, acceptance=ACCEPTANCE,
                parent_task_id=editor.id, context_plan=reuse))
            await orch.handoffs.resolve(request.handoff_id, expected_revision=request.revision,
                                        outcome="accepted", task_id=takeover.id)
            reviewed = await run(orch, await takeover.get())
            same = str(reviewed.session_id == editor.session_id).lower()
            print(f'3. The host handed "{request.goal}" to the editor: {reviewed.status}, same session: {same}')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--node", default=shutil.which("node"), help="Node.js 22.18+ executable")
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js 22.18+ is required")
    asyncio.run(main(args.node))
