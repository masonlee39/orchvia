"""SPEC-0044 E04 through the Python SDK: a judge without a model, for trying the routing layer."""
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import AcceptanceSpec, Orchestrator, RuntimeSpec, TaskSpec
from orchvia.routing import RouteRuntime, Router, RuleJudge


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "tests" / "fixtures" / "routing-host.ts"
NODE = shutil.which("node")
ACCEPT = AcceptanceSpec(criteria=["Review the result"])
AGENTS = {
    "a1": {"description": "Refactor login to OAuth2 in src/auth", "status": "idle", "access": "writable"},
    "a2": {"description": "Release notes for 0.1.21", "status": "busy", "access": "read-only"},
}
YESNO = {"type": "yesno", "instructions": "yes or no"}
BEST = {"type": "choice", "instructions": "which agent", "options": {"a1": None, "a2": None, "fresh": "new"}}


def levels(count):
    return {"type": "score", "instructions": "how much", "levels": [f"level {i}" for i in range(count)]}


async def ask(goal, questions, **options):
    return (await RuleJudge(**options).evaluate({"request": {"goal": goal}, "agents": AGENTS}, questions))["answers"]


def top(answer):
    return answer["probabilities"].index(max(answer["probabilities"]))


class RuleJudgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_0044_e04_relevance_and_best_from_shared_words(self):
        answers = await ask("Fix the login redirect after OAuth2 sign-in",
                            {"best": BEST, "relevant.a1": YESNO, "relevant.a2": YESNO})
        self.assertGreaterEqual(answers["relevant.a1"]["probability"], 0.5)
        self.assertLess(answers["relevant.a2"]["probability"], 0.5)
        self.assertEqual(answers["best"]["choice"], "a1")
        self.assertLessEqual(answers["best"]["confidence"], 0.6)
        none = (await ask("Translate the landing page", {"best": BEST}))["best"]
        self.assertEqual(none["choice"], "fresh")
        self.assertLessEqual(none["confidence"], 0.6)
        verbs = await ask("Fix the release script", {"relevant.a1": YESNO})
        self.assertLess(verbs["relevant.a1"]["probability"], 0.5)

    async def test_0044_e04_writes_from_verbs_and_size_from_length(self):
        fix = await ask("Fix the login redirect", {"writes": YESNO, "size": levels(3)})
        self.assertGreaterEqual(fix["writes"]["probability"], 0.7)
        explain = await ask("Explain how the login redirect works", {"writes": YESNO})
        self.assertLessEqual(explain["writes"]["probability"], 0.3)
        long = (await ask("Migrate every service from the old configuration loader to the new one, update each "
                          "caller, move the defaults into one file, remove the environment fallbacks, and rewrite "
                          "the tests that depended on them so that the suite still covers each case",
                          {"size": levels(3)}))["size"]
        self.assertEqual(top(fix["size"]), 0)
        self.assertEqual(top(long), 2)
        for answer in (fix["size"], long):
            self.assertLessEqual(answer["confidence"], 0.6)

    async def test_0044_e04_every_question_answered_and_overridable(self):
        questions = {"best": BEST, "depends.a2": levels(3), "clash.a2": YESNO, "affects.a1": YESNO,
                     "other": YESNO, "scale": levels(5)}
        answers = await ask("Fix the login redirect", questions)
        for question_id, question in questions.items():
            self.assertEqual(answers[question_id]["type"], question["type"], question_id)
            if question["type"] == "score":
                self.assertEqual(len(answers[question_id]["probabilities"]), len(question["levels"]))
                self.assertLessEqual(answers[question_id]["confidence"], 0.6)
        seen = []

        def answer(question_id, question, state):
            seen.append(f"{question_id}:{question['type']}:{state['request']['goal']}")
            return {"type": "yesno", "probability": 1} if question_id == "other" else None

        overridden = await ask("Fix the login redirect", {"writes": YESNO, "other": YESNO}, answer=answer)
        self.assertEqual(seen, ["writes:yesno:Fix the login redirect", "other:yesno:Fix the login redirect"])
        self.assertEqual(overridden["other"]["probability"], 1)
        self.assertGreaterEqual(overridden["writes"]["probability"], 0.7)


@unittest.skipUnless(NODE and HOST.is_file(), "requires Node.js 22.18+ and the local host source")
class RuleJudgeRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_0044_e04_a_route_by_the_rule_judge_asks_for_confirmation(self):
        with tempfile.TemporaryDirectory(prefix="orch-py-rule-", dir=str(Path("/tmp").resolve())) as directory:
            base = Path(directory).resolve()
            (base / "workspace").mkdir()
            (base / "state").mkdir()
            command = [NODE, str(HOST), str(base / "workspace"), str(base / "state"), "cross-root"]
            async with Orchestrator.local(engine_command=command, poll_interval=0.005, request_timeout=5) as orch:
                runtime = RuntimeSpec("fake-write", "w-default")
                auth = await orch.tasks.create(TaskSpec("Refactor login to OAuth2", runtime, ACCEPT))
                done = await auth.settle(on_approval=lambda approval, current: "approve", timeout=5)
                router = Router(orch, RuleJudge(), writable=RouteRuntime("fake-write", "w-default"), scope="engine")
                proposal = await router.route("Fix the login redirect after OAuth2 sign-in", ACCEPT,
                                              [done.task.session_id])
                self.assertEqual(proposal.decision, {"mode": "reuse", "session_id": done.task.session_id})
                self.assertLessEqual(proposal.judge_confidence, 0.6)
                self.assertTrue(proposal.needs_confirmation)
                self.assertIn("LOW_CONFIDENCE", [reason["code"] for reason in proposal.reasons])


if __name__ == "__main__":
    unittest.main()
