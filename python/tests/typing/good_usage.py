"""SPEC-0033 Y05: typed use of the Python SDK that mypy --strict accepts."""
from orchvia import Orchestrator


async def statuses(orch: Orchestrator) -> list[str]:
    task = await orch.tasks.get("task-id")
    goal: str = task.spec.goal
    page = await orch.tasks.list()
    names: list[str] = [item.status for item in page.tasks]
    session = await orch.sessions.get(task.session_id or "")
    generation: int = session.generation
    usage = await orch.usage.summary(task.id)
    tokens: int = usage.totals.input_tokens
    done = await (await orch.tasks.create({"goal": goal})).wait()
    return [task.status, done.status, *names, str(generation), str(tokens)]
