"""SPEC-0033 Y05: mistakes that mypy --strict must report, one per marked line."""
from orchvia import Orchestrator


async def mistakes(orch: Orchestrator) -> None:
    task = await orch.tasks.get("task-id")
    count: int = task.status  # expect: assignment
    task.no_such_field  # expect: attr-defined
    session = await orch.sessions.get("session-id")
    name: bool = session.provider  # expect: assignment
