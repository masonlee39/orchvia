"""Optional routing layer (SPEC-0018), mirroring ``@orchvia/sdk/routing``.

A pluggable judge answers typed questions about a request and the agents of one group;
deterministic policy turns the answers into an ordinary declaration that the engine validates and
executes as before. Nothing here changes the engine or the wire. Standard library only.
"""
from __future__ import annotations

import asyncio
import http.client
import json
import math
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol, Sequence

from .errors import OrchestrationError
from .types import AcceptanceSpec, CheckAcceptanceSpec, RuntimeSpec, Snapshot, TaskSpec

JudgeErrorCode = Literal["JUDGE_AUTH", "JUDGE_INVALID_REQUEST", "JUDGE_RATE_LIMITED",
                         "JUDGE_UNAVAILABLE", "JUDGE_TIMEOUT", "JUDGE_PROTOCOL"]


class JudgeError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


RoutingErrorCode = Literal["ROUTING_ROOT_MISMATCH", "ROUTING_SOURCE_NOT_MEMBER"]


class RoutingError(Exception):
    """A request that would leave the router's group. It is refused before the judge is asked."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Judge(Protocol):
    """Any model or rule set that answers typed questions with probabilities.

    Questions are ``{"type": "choice", "instructions", "options"}``, ``{"type": "yesno",
    "instructions"}`` or ``{"type": "score", "instructions", "levels"}``. The result is
    ``{"answers": {id: answer}, "model"?, "usage"?}`` with answers shaped like the TypeScript SDK's.
    """

    async def evaluate(self, state: Any, questions: Mapping[str, Mapping[str, Any]]) -> Mapping[str, Any]: ...


def _probability(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            and 0 <= value <= 1)


def _checked_answers(questions: Mapping[str, Mapping[str, Any]], raw: Any, jev: bool) -> dict[str, dict[str, Any]]:
    """Checks that every question came back answered with its own kind, and returns the answers."""
    def protocol(message: str):
        raise JudgeError("JUDGE_PROTOCOL", message)

    if not isinstance(raw, Mapping):
        protocol("The judge returned no answers object")
    result: dict[str, dict[str, Any]] = {}
    for question_id, question in questions.items():
        answer = raw.get(question_id)
        if not isinstance(answer, Mapping):
            protocol(f"The judge did not answer {question_id}")
        if question["type"] == "choice":
            options = question["options"]
            probabilities = answer.get("probabilities")
            if (answer.get("type") != "choice" or not isinstance(answer.get("choice"), str)
                    or answer["choice"] not in options or not isinstance(probabilities, Mapping)
                    or any(option not in options or not _probability(value)
                           for option, value in probabilities.items())
                    or not _probability(answer.get("confidence"))):
                protocol(f"Answer {question_id} is not a valid choice")
            result[question_id] = {"type": "choice", "choice": answer["choice"],
                                   "probabilities": dict(probabilities), "confidence": answer["confidence"]}
        elif question["type"] == "yesno":
            value = answer.get("noul") if jev else answer.get("probability")
            if answer.get("type") != ("noul" if jev else "yesno") or not _probability(value):
                protocol(f"Answer {question_id} is not a valid yes/no probability")
            result[question_id] = {"type": "yesno", "probability": value}
        else:
            levels = len(question["levels"])
            if jev:
                by_level = answer.get("probabilities")
                if isinstance(by_level, Mapping):
                    values = [by_level.get(str(level), 0) for level in range(levels)]
                elif isinstance(answer.get("score"), (int, float)) and math.isfinite(answer["score"]):
                    level = min(levels - 1, max(0, round(answer["score"])))
                    values = [1 if index == level else 0 for index in range(levels)]
                else:
                    values = []
            else:
                values = list(answer.get("probabilities") or [])
            if (answer.get("type") != "score" or len(values) != levels or not all(map(_probability, values))
                    or not _probability(answer.get("confidence"))):
                protocol(f"Answer {question_id} is not a valid score")
            result[question_id] = {"type": "score", "probabilities": values, "confidence": answer["confidence"]}
    return result


def _jev_question(question: Mapping[str, Any]) -> dict[str, Any]:
    if question["type"] == "choice":
        return {"type": "choice", "instructions": question["instructions"], "criteria": question["options"]}
    if question["type"] == "score":
        return {"type": "score", "instructions": question["instructions"], "criteria": question["levels"]}
    criteria = {key: question[name] for key, name in (("true", "yes"), ("false", "no")) if name in question}
    return {"type": "noul", "instructions": question["instructions"], **({"criteria": criteria} if criteria else {})}


class _Abandoned(TimeoutError):
    """The waiting coroutine gave up on the request; the worker stops at its next step."""


def _shutdown(sock: socket.socket) -> None:
    try:
        # The plain socket call: it also ends a TLS read that another thread is blocked in.
        socket.socket.shutdown(sock, socket.SHUT_RDWR)
    except OSError:
        pass


def _settle(future: asyncio.Future, value: Any, error: BaseException | None) -> None:
    if not future.done():
        if error is None:
            future.set_result(value)
        else:
            future.set_exception(error)


class _Exchange:
    """One HTTP request on a worker thread, bounded by an absolute deadline and abortable.

    The waiting coroutine enforces the deadline and calls ``abort`` when it stops waiting, at the
    deadline or on cancellation; abort shuts the connection down, which ends a blocked read at once.
    The worker also bounds each socket operation by the time left and checks the deadline between
    reads of the body, so a body that keeps arriving slowly cannot extend it. A name lookup cannot be
    interrupted with the standard library: the worker then sends nothing after the deadline and ends
    when the lookup returns.
    """

    def __init__(self, request: urllib.request.Request, deadline: float):
        self._request = request
        self._deadline = deadline
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None
        self._abandoned = False

    def remaining(self) -> float:
        if self._abandoned:
            raise _Abandoned("The request was abandoned")
        left = self._deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("The Jev deadline passed")
        return left

    def attach(self, sock: socket.socket) -> None:
        with self._lock:
            self._sock = sock
            abandoned = self._abandoned
        if abandoned:
            _shutdown(sock)
            raise _Abandoned("The request was abandoned")

    def abort(self) -> None:
        with self._lock:
            self._abandoned = True
            sock = self._sock
        if sock is not None:
            _shutdown(sock)

    def run(self) -> tuple[int, bytes]:
        exchange = self

        class Connection(http.client.HTTPConnection):
            def connect(self) -> None:
                exchange.remaining()
                super().connect()
                exchange.attach(self.sock)

        class SecureConnection(http.client.HTTPSConnection):
            def connect(self) -> None:
                exchange.remaining()
                super().connect()
                exchange.attach(self.sock)

        class Handler(urllib.request.HTTPHandler):
            def http_open(self, req):
                return self.do_open(Connection, req)

        class SecureHandler(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return self.do_open(SecureConnection, req)

        # Connecting, sending and reading the headers are bounded by the socket timeout, which is
        # the time left when the request starts, and by abort.
        opener = urllib.request.build_opener(Handler(), SecureHandler())
        try:
            response = opener.open(self._request, timeout=self.remaining())
        except urllib.error.HTTPError as error:
            error.close()  # Only the status of a refusal is used; its body is never read.
            return error.code, b""
        with response:
            chunks = []
            # The response closes its connection itself once the whole body has arrived.
            while not response.isclosed():
                left = self.remaining()
                if self._sock is not None:
                    self._sock.settimeout(left)
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            return response.status, b"".join(chunks)


class JevJudge:
    """TypeSafe's Jev behind the ``Judge`` protocol: ``POST /v1/systemone`` with a bearer token.

    ``timeout_ms`` bounds one whole evaluation, including its single retry. Each request runs on its
    own daemon thread, which the evaluation stops when the deadline passes or it is cancelled.
    """

    def __init__(self, api_key: str, *, model: str = "jev-1.13.0", base_url: str = "https://api.typesafe.ai",
                 timeout_ms: int = 10_000):
        if not isinstance(api_key, str) or not api_key:
            raise TypeError("JevJudge requires an api_key")
        self._api_key = api_key
        self.model = model
        self.endpoint = base_url.rstrip("/") + "/v1/systemone"
        self.timeout_ms = timeout_ms

    async def _post(self, body: bytes, deadline: float) -> tuple[int, bytes]:
        request = urllib.request.Request(self.endpoint, data=body, method="POST", headers={
            "content-type": "application/json", "authorization": f"Bearer {self._api_key}"})
        exchange = _Exchange(request, deadline)
        loop = asyncio.get_running_loop()
        settled: asyncio.Future = loop.create_future()

        def work() -> None:
            value, error = None, None
            try:
                value = exchange.run()
            except Exception as failure:  # noqa: BLE001 - handed to the waiting coroutine
                error = failure
            try:
                loop.call_soon_threadsafe(_settle, settled, value, error)
            except RuntimeError:  # The event loop closed; nobody waits any more.
                pass

        threading.Thread(target=work, name="orchvia-jev", daemon=True).start()
        try:
            await asyncio.wait((settled,), timeout=max(0.0, deadline - time.monotonic()))
        finally:
            if not settled.done():
                # At the deadline or on cancellation: stop the worker instead of leaving it reading.
                settled.cancel()
                exchange.abort()
        if settled.cancelled():
            raise TimeoutError("The Jev deadline passed")
        return settled.result()

    async def evaluate(self, state: Any, questions: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        body = json.dumps({"state": state, "model": self.model,
                           "questions": {key: _jev_question(value) for key, value in questions.items()}}).encode()
        deadline = time.monotonic() + self.timeout_ms / 1000

        def timed_out() -> JudgeError:
            return JudgeError("JUDGE_TIMEOUT", f"Jev did not answer within {self.timeout_ms} ms")

        for attempt in (1, 2):
            if deadline - time.monotonic() <= 0:
                raise timed_out()
            try:
                status, payload = await self._post(body, deadline)
            except TimeoutError:
                raise timed_out() from None
            except urllib.error.URLError as error:
                if isinstance(error.reason, TimeoutError):
                    raise timed_out() from None
                if attempt == 1:
                    continue
                raise JudgeError("JUDGE_UNAVAILABLE", f"Jev request failed: {error.reason}") from None
            except (OSError, http.client.HTTPException) as error:
                if attempt == 1:
                    continue
                raise JudgeError("JUDGE_UNAVAILABLE", f"Jev request failed: {error}") from None
            if 200 <= status < 300:
                try:
                    parsed = json.loads(payload)
                except ValueError:
                    raise JudgeError("JUDGE_PROTOCOL", "Jev returned a body that is not JSON") from None
                if not isinstance(parsed, Mapping):
                    raise JudgeError("JUDGE_PROTOCOL", "Jev returned a body that is not an object")
                result: dict[str, Any] = {"answers": _checked_answers(questions, parsed.get("answers"), True)}
                if isinstance(parsed.get("model"), str):
                    result["model"] = parsed["model"]
                usage = parsed.get("usage")
                if isinstance(usage, Mapping) and isinstance(usage.get("input_tokens"), (int, float)):
                    result["usage"] = {"input_tokens": usage["input_tokens"],
                                       "output_tokens": usage.get("output_tokens", 0)}
                return result
            retryable = status in (429, 529) or status >= 500
            if retryable and attempt == 1:
                await asyncio.sleep(min(0.2, max(0.0, deadline - time.monotonic())))
                continue
            code = ("JUDGE_AUTH" if status in (401, 403) else "JUDGE_RATE_LIMITED" if status == 429
                    else "JUDGE_UNAVAILABLE" if retryable else "JUDGE_INVALID_REQUEST")
            raise JudgeError(code, f"Jev answered HTTP {status}", status)
        raise JudgeError("JUDGE_UNAVAILABLE", "Jev request failed")


_RULE_CONFIDENCE = 0.6
"""The highest confidence the rule judge claims, below every threshold of the default policy."""
_WRITE_VERBS = frozenset(
    "add bump change create delete edit fix implement migrate modify move patch refactor remove rename replace "
    "rewrite update upgrade write".split())
_COMMON_WORDS = frozenset(
    "about after all and any are can for from how into its not now our that the their them then this was what "
    "when where which with you your".split())


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", text.lower())


def _rule_words(text: str) -> set[str]:
    """The words of a text that can relate it to another: no verbs of change, no common words."""
    return {word for word in _tokens(text)
            if len(word) >= 3 and word not in _WRITE_VERBS and word not in _COMMON_WORDS}


def _by_count(count: int, length: int) -> int:
    """Level 0, the middle level or the last, for none, one, or two and more."""
    return 0 if count == 0 else (length - 1) // 2 if count == 1 else length - 1


def _score_answer(length: int, at: int, peak: float) -> dict[str, Any]:
    rest = (1 - peak) / (length - 1) if length > 1 else 0
    return {"type": "score", "probabilities": [peak if i == at else rest for i in range(length)],
            "confidence": min(peak, _RULE_CONFIDENCE)}


class RuleJudge:
    """A judge without a model (SPEC-0044 E04), mirroring ``createRuleJudge``.

    Relevance comes from the words a goal shares with an agent, ``writes`` from verbs of change, and
    ``size`` from the goal's length. It is a baseline for trying the routing layer, not a judge of
    quality: its confidence never exceeds 0.6, so the default policy asks for confirmation whenever
    there is an agent to choose. ``answer(id, question, state)`` may answer any question instead;
    ``None`` leaves it to the rules. Its answers are not capped.
    """

    model = "rules"

    def __init__(self, *, answer: Callable[[str, Mapping[str, Any], Any], Mapping[str, Any] | None] | None = None):
        self._answer = answer

    async def evaluate(self, state: Any, questions: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        state_map = state if isinstance(state, Mapping) else {}
        request = state_map.get("request") or {}
        finding = state_map.get("finding") or {}
        text = str(request.get("goal") if request.get("goal") is not None else finding.get("text") or "")
        words = _rule_words(text)
        agents = state_map.get("agents") or {}

        def shared(alias: str) -> int:
            agent = agents.get(alias)
            about = agent if isinstance(agent, str) else (agent or {}).get("description")
            return len(words & _rule_words(str(about or "")))

        answers: dict[str, Any] = {}
        for question_id, question in questions.items():
            custom = self._answer(question_id, question, state) if self._answer else None
            if custom is not None:
                answers[question_id] = custom
                continue
            alias = question_id.split(".", 1)[1] if "." in question_id else question_id
            if question["type"] == "choice":
                names = list(question["options"])
                counts = [0 if name == "fresh" else shared(name) for name in names]
                # Fresh wins when no agent shares a word, and otherwise counts as half a shared word.
                fresh = 1 if max([0, *counts]) == 0 else 0.5
                weights = [fresh if name == "fresh" else counts[i] for i, name in enumerate(names)]
                total = sum(weights) or 1
                probabilities = {name: weights[i] / total for i, name in enumerate(names)}
                choice = names[0]
                for name in names[1:]:
                    if probabilities[name] > probabilities[choice]:
                        choice = name
                answers[question_id] = {"type": "choice", "choice": choice, "probabilities": probabilities,
                                        "confidence": min(_RULE_CONFIDENCE, probabilities[choice])}
            elif question["type"] == "yesno":
                probability = 0.5
                if question_id == "writes":
                    probability = 0.8 if any(word in _WRITE_VERBS for word in _tokens(text)) else 0.2
                elif re.match(r"^(relevant|clash|affects)\.", question_id):
                    count = shared(alias)
                    probability = 0.2 if count == 0 else 0.55 if count == 1 else 0.8
                answers[question_id] = {"type": "yesno", "probability": probability}
            else:
                length = len(question["levels"])
                if question_id == "size":
                    count = len(text.split())
                    at = _by_count(0 if count <= 8 else 1 if count <= 30 else 2, length)
                    answers[question_id] = _score_answer(length, at, _RULE_CONFIDENCE)
                elif question_id.startswith("depends."):
                    answers[question_id] = _score_answer(length, _by_count(shared(alias), length), _RULE_CONFIDENCE)
                else:
                    # A question the rules do not know: every level equally likely.
                    answers[question_id] = _score_answer(length, 0, 1 / length)
        return {"answers": answers, "model": self.model}


@dataclass(frozen=True)
class RouteRuntime:
    """Provider and models for fresh work of one permission profile."""
    provider: str
    model: str
    small: str | None = None
    large: str | None = None


@dataclass(frozen=True)
class RoutingPolicy:
    max_candidates: int = 16
    max_context_refs: int = 20
    busy_wait_ms: int = 20 * 60_000
    confirm_below: float = 0.85
    min_margin: float = 0.2
    relevant_at: float = 0.5
    context_at: float = 0.7
    clash_at: float = 0.5
    essential_at: float = 0.5
    essential_no_fallback_at: float = 0.7
    small_at: float = 0.85
    large_at: float = 0.7
    writes_unsure: tuple[float, float] = (0.3, 0.7)
    notify_at: float = 0.7
    notify_confirm_at: float = 0.5
    on_judge_failure: Literal["confirm", "fresh"] = "confirm"
    description_chars: int = 600


@dataclass(frozen=True)
class Candidate:
    """One member agent as the router sees it; ``describe`` may turn it into the judge's text."""
    alias: str
    session: Snapshot
    task: Snapshot
    busy: bool


@dataclass(frozen=True)
class RouteProposal:
    """A proposed declaration. The host decides whether to submit it.

    ``confidence`` is the lower of ``judge_confidence`` and the judge's probability for the proposed
    option; for a fresh session because no agent is relevant, 1 minus the highest relevance instead
    of that probability. It is 1 without candidates and 0 when the judge was unavailable. Each of
    ``alternatives`` has ``probability``, its share among the options that can take the work, and
    ``judge_probability``, the probability the judge gave it.
    """
    spec: TaskSpec
    decision: dict[str, str]
    confidence: float
    needs_confirmation: bool
    alternatives: list[dict[str, Any]]
    reasons: list[dict[str, Any]]
    judge: dict[str, Any]
    judge_confidence: float | None = None


@dataclass(frozen=True)
class NotificationPlan:
    text: str
    notify: list[dict[str, Any]] = field(default_factory=list)
    confirm: list[dict[str, Any]] = field(default_factory=list)
    follow_up: list[dict[str, Any]] = field(default_factory=list)
    judge: dict[str, Any] = field(default_factory=dict)


_TERMINAL = {"completed", "failed", "cancelled"}
_UNAVAILABLE = {"closed", "paused", "pausing", "outcome_unknown"}
_SIZE_LEVELS = ["trivial: answered or done by looking at one place",
                "moderate: a focused change or investigation in a few files",
                "large: a multi-file design change or migration"]
_DEPENDENCE_LEVELS = ["none: another agent could do it just as well from scratch",
                      "helpful: the work this agent is doing now would save some investigation",
                      "essential: it must build directly on the changes this agent is making now"]
_CONFIRM = {"LOW_CONFIDENCE", "NARROW_MARGIN", "WRITES_UNCERTAIN", "RUNTIME_MISSING"}
MAX_CONTEXT_REF_BYTES = 32768
"""The engine's inline limit for one context reference, in UTF-8 bytes."""
_COMPLETE_RESULT_BYTES = 64 * 1024
"""The engine returns a task's complete result up to this size, and a marked preview beyond."""
_OMISSION = {"ARTIFACT_TOO_LARGE": "too_large", "ARTIFACT_HISTORY_EXPIRED": "expired",
             "ARTIFACT_CORRUPT": "corrupt", "NOT_FOUND": "missing"}
"""``CONTEXT_OMITTED`` reasons for the codes ``context.checkRefs`` reports (SPEC-0020)."""


def _code(error: BaseException) -> str:
    return error.code if isinstance(error, JudgeError) else "JUDGE_UNAVAILABLE"


class Router:
    """Proposes declarations for requests inside one group (SPEC-0018).

    ``scope="root"`` (default): a group is one root task. ``scope="engine"``: the host runs one group
    per engine and configured that engine with ``allowCrossRootReuse``.
    """

    def __init__(self, orchestrator: Any, judge: Judge, *, read_only: RouteRuntime | None = None,
                 writable: RouteRuntime | None = None, scope: Literal["root", "engine"] = "root",
                 describe: Callable[[Candidate], str | Awaitable[str]] | None = None,
                 policy: RoutingPolicy | None = None):
        if read_only is None and writable is None:
            raise TypeError("Router requires a read-only or writable runtime")
        self._orch = orchestrator
        self._judge = judge
        self._read_only = read_only
        self._writable = writable
        self._scope = scope
        self._describe = describe
        self.policy = policy or RoutingPolicy()
        if self.policy.max_context_refs > 20:
            raise TypeError("max_context_refs cannot exceed 20")

    async def _candidates(self, members: Sequence[str], root_task_id: str | None,
                          keep: Callable[[Snapshot, Snapshot], bool]) -> list[Candidate]:
        found: list[Candidate] = []
        for session_id in dict.fromkeys(members):
            if len(found) >= self.policy.max_candidates:
                break
            try:
                session = await self._orch.sessions.get(session_id)
            except OrchestrationError:
                continue
            if not session.get("task_id"):
                continue
            if self._scope == "root" and (not root_task_id or session.get("root_task_id") != root_task_id):
                continue
            task = await self._orch.tasks.get(session.task_id)
            if not keep(session, task):
                continue
            found.append(Candidate(f"A{len(found) + 1}", session, task,
                                   session.status != "idle" or task.status not in _TERMINAL))
        return found

    def _can_check(self) -> bool:
        """Whether the engine offers ``context.checkRefs`` (SPEC-0020)."""
        info = getattr(self._orch, "info", None)
        capabilities = info.get("capabilities") if isinstance(info, Mapping) else None
        workflow = capabilities.get("workflow") if isinstance(capabilities, Mapping) else None
        return isinstance(workflow, Mapping) and workflow.get("context_check") is True

    async def _description(self, candidate: Candidate) -> dict[str, Any]:
        if self._describe:
            text = self._describe(candidate)
            if asyncio.iscoroutine(text):
                text = await text
        else:
            result = candidate.task.get("result")
            goal = candidate.task.spec.goal
            text = f"{goal}\nResult: {result[:self.policy.description_chars]}" if result else goal
        return {"description": text, "status": "busy" if candidate.busy else "idle",
                "access": "writable" if candidate.session.get("permission_profile") == "workspace-write"
                else "read-only"}

    async def _ask(self, state: Any, questions: Mapping[str, Mapping[str, Any]]) -> tuple[dict, dict]:
        started = time.monotonic()
        result = await self._judge.evaluate(state, questions)
        answers = _checked_answers(questions, (result or {}).get("answers"), False)
        report: dict[str, Any] = {"latency_ms": round((time.monotonic() - started) * 1000)}
        if result.get("model"):
            report["model"] = result["model"]
        if result.get("usage"):
            report["usage"] = dict(result["usage"])
        return answers, report

    async def route(self, goal: str, acceptance: AcceptanceSpec | CheckAcceptanceSpec, members: Sequence[str], *,
                    root_task_id: str | None = None, needs_writes: bool | None = None,
                    write_scope: str | None = None, write_path: str | None = None,
                    budget: Mapping[str, Any] | None = None, parent_task_id: str | None = None) -> RouteProposal:
        if not isinstance(goal, str) or not goal.strip():
            raise TypeError("route requires a goal")
        policy = self.policy
        pool = await self._candidates(
            members, root_task_id,
            lambda session, task: session.status not in _UNAVAILABLE and (
                write_scope is None or (task.spec.get("write_scope") == write_scope
                                        and task.spec.get("write_path") == write_path)))
        reasons: list[dict[str, Any]] = []
        parent = root_task_id if self._scope == "root" else parent_task_id

        def base(writes: bool) -> RouteRuntime:
            wanted = self._writable if writes else self._read_only
            if wanted:
                return wanted
            reasons.append({"code": "RUNTIME_MISSING", "detail": {"needs_writes": writes}})
            return self._writable or self._read_only

        def spec(runtime: RuntimeSpec, plan: dict[str, Any], reuse: Candidate | None = None) -> TaskSpec:
            scope_name = reuse.task.spec.get("write_scope") if reuse else write_scope
            scope_path = reuse.task.spec.get("write_path") if reuse else write_path
            return TaskSpec(goal=goal, runtime=runtime, acceptance=acceptance, parent_task_id=parent,
                            write_scope=scope_name, write_path=scope_path, context_plan=plan,
                            budget=dict(budget) if budget else None)

        def refs(artifacts: list[str]) -> list[dict[str, Any]]:
            return [{"artifact_ref": artifact, "version": 1} for artifact in artifacts]

        def fresh_plan(artifacts: list[str]) -> dict[str, Any]:
            return {"requested_mode": "fresh", "independent": True, "dependency_task_ids": [],
                    "context_refs": refs(artifacts), "fallback_modes": []}

        agents = {candidate.alias: await self._description(candidate) for candidate in pool}
        state = {"request": {"goal": goal}, "agents": agents}
        questions: dict[str, dict[str, Any]] = {}
        if pool:
            questions["best"] = {
                "type": "choice",
                "instructions": "Which agent in `agents` should take `request.goal`? Pick the agent whose recent or "
                                "current work fits it best; pick fresh if none has context that helps.",
                "options": {**{candidate.alias: None for candidate in pool},
                            "fresh": "no existing agent has context that helps; start a new one"}}
            for candidate in pool:
                questions[f"relevant.{candidate.alias}"] = {
                    "type": "yesno",
                    "instructions": f"Would what agent `agents.{candidate.alias}` knows from its work help with "
                                    "`request.goal`?"}
            for candidate in pool:
                if candidate.busy:
                    questions[f"depends.{candidate.alias}"] = {
                        "type": "score",
                        "instructions": f"How much does `request.goal` depend on the work agent "
                                        f"`agents.{candidate.alias}` is doing now?",
                        "levels": _DEPENDENCE_LEVELS}
                    questions[f"clash.{candidate.alias}"] = {
                        "type": "yesno",
                        "instructions": f"If `request.goal` ran at the same time as the work of agent "
                                        f"`agents.{candidate.alias}`, would the two risk editing the same code?"}
        if needs_writes is None:
            questions["writes"] = {"type": "yesno",
                                   "instructions": "Does doing `request.goal` require modifying files?"}
        if any(ladder and (ladder.small or ladder.large) for ladder in (self._read_only, self._writable)):
            questions["size"] = {"type": "score", "instructions": "How much work is `request.goal` for a coding agent?",
                                 "levels": _SIZE_LEVELS}

        answers: dict[str, dict[str, Any]] = {}
        report: dict[str, Any] = {"latency_ms": 0}
        if questions:
            try:
                answers, report = await self._ask(state, questions)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - any judge failure falls back
                code = _code(error)
                runtime = base(needs_writes is not False)
                return RouteProposal(
                    spec=spec(RuntimeSpec(runtime.provider, runtime.model), fresh_plan([])),
                    decision={"mode": "fresh"}, confidence=0.0,
                    needs_confirmation=policy.on_judge_failure == "confirm", alternatives=[],
                    reasons=[*reasons, {"code": "JUDGE_UNAVAILABLE", "detail": {"error": code}}],
                    judge={"unavailable": code})

        def yes(question_id: str) -> float | None:
            answer = answers.get(question_id)
            return answer["probability"] if answer else None

        writes_probability = yes("writes")
        writes = needs_writes if needs_writes is not None else (writes_probability or 0) >= 0.5
        if (writes_probability is not None
                and policy.writes_unsure[0] <= writes_probability <= policy.writes_unsure[1]):
            reasons.append({"code": "WRITES_UNCERTAIN", "detail": {"probability": writes_probability}})
        eligible = [candidate for candidate in pool
                    if not writes or candidate.session.get("permission_profile") == "workspace-write"]

        def relevance(candidate: Candidate) -> float:
            return yes(f"relevant.{candidate.alias}") or 0.0

        best = answers.get("best")
        # Options keep the judge's own probabilities. Their share among the options left after the
        # write filter orders and reports them, but never raises the confidence that is checked.
        choices = [(option, (best or {}).get("probabilities", {}).get(option, 0.0))
                   for option in [*(candidate.alias for candidate in eligible), "fresh"]]
        total = sum(value for _, value in choices)
        ranked = [(option, value, value / total if total > 0 else 0.0) for option, value in choices]
        ranked.sort(key=lambda entry: entry[1], reverse=True)
        if total == 0:
            ranked.sort(key=lambda entry: entry[0] != "fresh")
        by_alias = {candidate.alias: candidate for candidate in pool}
        alternatives = [{"option": option if option == "fresh" else by_alias[option].session.id,
                         "probability": share, "judge_probability": value} for option, value, share in ranked]

        def result_of(candidate: Candidate) -> tuple[str, int] | None:
            """The latest result as a context reference, measured as the engine measures it.

            The snapshot holds the complete result up to 64 KiB (SPEC-0001) and a longer preview beyond.
            """
            artifacts = candidate.task.get("artifact_refs") or []
            text = candidate.task.get("result")
            if not artifacts or not isinstance(text, str):
                return None
            # surrogatepass counts a lone surrogate as three bytes, as the engine's replacement does.
            return artifacts[0], len(text.encode("utf-8", "surrogatepass"))

        def by_relevance(exclude: Candidate | None = None) -> list[Candidate]:
            sources = [candidate for candidate in pool
                       if candidate is not exclude and relevance(candidate) >= policy.context_at
                       and result_of(candidate)]
            sources.sort(key=relevance, reverse=True)
            return sources

        top = ranked[0] if ranked else None
        chosen = by_alias.get(top[0]) if top and top[0] != "fresh" else None
        # SPEC-0020: the engine checks every result that could be carried, at most 20 per call. An engine
        # without the check leaves them unchecked, and the proposal says so.
        checked = self._can_check()
        verdicts: dict[str, Mapping[str, Any]] = {}
        if checked:
            possible = [result_of(candidate) for candidate in [*by_relevance(), *([chosen] if chosen else [])]]
            candidate_refs = list(dict.fromkeys(result[0] for result in possible
                                                if result and result[1] <= MAX_CONTEXT_REF_BYTES))
            for start in range(0, len(candidate_refs), 20):
                answer = await self._orch.context.check_refs(
                    [{"artifact_ref": ref, "version": 1} for ref in candidate_refs[start:start + 20]])
                for entry in answer.context_refs:
                    verdicts[entry["artifactRef"]] = entry
        omitted: set[str] = set()

        def carry(sources: list[Candidate]) -> list[str]:
            """The results to carry, in order, at most ``max_context_refs``.

            The engine refuses a whole task when one reference exceeds its inline limit, so such a result
            is left out with a reason instead, and takes no place.
            """
            carried: list[str] = []
            for candidate in sources:
                if len(carried) >= policy.max_context_refs:
                    break
                result = result_of(candidate)
                if result is None or result[0] in carried:
                    continue
                artifact, size = result
                verdict = verdicts.get(artifact)
                if size <= MAX_CONTEXT_REF_BYTES and (verdict is None or verdict.get("admissible")):
                    carried.append(artifact)
                    continue
                if artifact in omitted:
                    continue
                omitted.add(artifact)
                if verdict is not None and size <= MAX_CONTEXT_REF_BYTES:
                    code = verdict.get("code")
                    refused: dict[str, Any] = {"session_id": candidate.session.id, "artifact_ref": artifact,
                                               "reason": _OMISSION.get(code, "unreadable")}
                    if code:
                        refused["code"] = code
                    if isinstance(verdict.get("bytes"), int):
                        refused["bytes"] = verdict["bytes"]
                    reasons.append({"code": "CONTEXT_OMITTED", "detail": refused})
                    continue
                detail: dict[str, Any] = {"session_id": candidate.session.id, "artifact_ref": artifact,
                                          "reason": "too_large"}
                if size <= _COMPLETE_RESULT_BYTES:  # Beyond the preview size it is only known to be larger.
                    detail["bytes"] = size
                detail["max_bytes"] = MAX_CONTEXT_REF_BYTES
                reasons.append({"code": "CONTEXT_OMITTED", "detail": detail})
            return carried

        def fresh_model(runtime: RouteRuntime) -> str:
            size = answers.get("size")
            if size and runtime.small and size["probabilities"][0] >= policy.small_at:
                reasons.append({"code": "MODEL_SMALL", "detail": {"probability": size["probabilities"][0]}})
                return runtime.small
            if size and runtime.large and size["probabilities"][2] >= policy.large_at:
                reasons.append({"code": "MODEL_LARGE", "detail": {"probability": size["probabilities"][2]}})
                return runtime.large
            return runtime.model

        any_relevant = any(relevance(candidate) >= policy.relevant_at for candidate in eligible)
        if not pool:
            reasons.append({"code": "NO_CANDIDATES"})
        # decision_confidence: how sure the decision itself is, before the judge's own confidence applies.
        if chosen and any_relevant and not chosen.busy:
            reasons.append({"code": "IDLE_REUSE", "detail": {"judge_probability": top[1]}})
            plan = {"requested_mode": "reuse", "independent": True, "dependency_task_ids": [],
                    "candidate_session_id": chosen.session.id, "context_refs": refs(carry(by_relevance(chosen))),
                    "fallback_modes": ["fresh"], "max_queue_wait_ms": policy.busy_wait_ms}
            proposal_spec = spec(RuntimeSpec(chosen.session.provider, chosen.session.model), plan, chosen)
            decision, decision_confidence = {"mode": "reuse", "session_id": chosen.session.id}, top[1]
        elif chosen and any_relevant:
            clash = yes(f"clash.{chosen.alias}") or 0.0
            dependence = answers.get(f"depends.{chosen.alias}")
            essential = dependence["probabilities"][2] if dependence else 0.0
            if clash >= policy.clash_at or essential >= policy.essential_at:
                fallback = essential < policy.essential_no_fallback_at
                reasons.append({"code": "BUSY_WAIT", "detail": {"clash": clash, "essential": essential}})
                own = [chosen] if fallback else []
                plan = {"requested_mode": "reuse", "independent": True, "dependency_task_ids": [],
                        "candidate_session_id": chosen.session.id,
                        "context_refs": refs(carry([*by_relevance(chosen), *own])),
                        "fallback_modes": ["fresh"] if fallback else [], "max_queue_wait_ms": policy.busy_wait_ms}
                proposal_spec = spec(RuntimeSpec(chosen.session.provider, chosen.session.model), plan, chosen)
                decision = {"mode": "reuse", "session_id": chosen.session.id}
            else:
                reasons.append({"code": "BUSY_PARALLEL", "detail": {"clash": clash, "essential": essential}})
                carried = carry([chosen, *by_relevance(chosen)])
                runtime = base(writes)
                proposal_spec = spec(RuntimeSpec(runtime.provider, fresh_model(runtime)), fresh_plan(carried))
                decision = {"mode": "fresh"}
            decision_confidence = top[1]
        else:
            if pool:
                reasons.append({"code": "FRESH_CHOSEN", "detail": {"judge_probability": top[1]}}
                               if top and top[0] == "fresh" else {"code": "NO_RELEVANT_AGENT"})
            runtime = base(writes)
            proposal_spec = spec(RuntimeSpec(runtime.provider, fresh_model(runtime)),
                                 fresh_plan(carry(by_relevance())))
            decision = {"mode": "fresh"}
            decision_confidence = (1.0 if not pool else top[1] if top and top[0] == "fresh"
                                   else 1 - max([0.0, *map(relevance, eligible)]))
        count = len(proposal_spec.context_plan["context_refs"])
        if count:
            reasons.append({"code": "CONTEXT_CARRIED", "detail": {"count": count}})
            if not checked:
                reasons.append({"code": "CONTEXT_UNCHECKED", "detail": {"count": count}})
        # A judge that reports low confidence in its own choice is unsure, however probable it made that
        # choice look.
        judge_confidence = best["confidence"] if best else None
        confidence = decision_confidence if judge_confidence is None else min(judge_confidence, decision_confidence)
        if pool and confidence < policy.confirm_below:
            detail = {"confidence": confidence}
            if judge_confidence is not None:
                detail["judge_confidence"] = judge_confidence
            reasons.append({"code": "LOW_CONFIDENCE", "detail": detail})
        # The tolerance keeps an exact threshold, such as 0.6 against 0.4, from reading as narrower.
        if len(ranked) > 1 and ranked[0][2] - ranked[1][2] < policy.min_margin - 1e-9:
            reasons.append({"code": "NARROW_MARGIN", "detail": {"margin": ranked[0][2] - ranked[1][2]}})
        return RouteProposal(spec=proposal_spec, decision=decision, confidence=confidence,
                             needs_confirmation=any(reason["code"] in _CONFIRM for reason in reasons),
                             alternatives=alternatives, reasons=reasons, judge=report,
                             judge_confidence=judge_confidence)

    async def submit(self, proposal: RouteProposal, *, idempotency_key: str | None = None):
        return await self._orch.tasks.create(proposal.spec, idempotency_key=idempotency_key)

    async def notifications(self, text: str, from_session_id: str, members: Sequence[str], *,
                            root_task_id: str | None = None) -> NotificationPlan:
        """The source must be one of ``members``.

        Under ``scope="root"`` the group is the source's root task, and a different ``root_task_id`` is
        refused; under ``scope="engine"`` it is ignored.
        """
        if not isinstance(text, str) or not text.strip():
            raise TypeError("notifications requires the finding text")
        if isinstance(members, str) or not isinstance(members, Sequence):
            raise TypeError("notifications requires members")
        # A finding belongs to the group of the member that made it; checked before any judge call.
        if from_session_id not in members:
            raise RoutingError("ROUTING_SOURCE_NOT_MEMBER",
                               "The source session of a finding must be one of the members")
        source = await self._orch.sessions.get(from_session_id)
        group_root = None
        if self._scope == "root":
            # The engine's own rule for a session's root, which it applies to every reuse.
            group_root = source.get("root_task_id")
            if not group_root and source.get("task_id"):
                task = await self._orch.tasks.get(source.task_id)
                group_root = task.get("root_task_id") or task.id
            if not group_root:
                raise RoutingError("ROUTING_ROOT_MISMATCH", "The source session has no root task")
            if root_task_id is not None and root_task_id != group_root:
                raise RoutingError("ROUTING_ROOT_MISMATCH", "root_task_id is not the root task of the source session")
        pool = await self._candidates(
            [member for member in members if member != source.id], group_root,
            lambda session, task: session.status not in ("closed", "outcome_unknown"))
        plan = NotificationPlan(text=text, judge={"latency_ms": 0})
        if not pool:
            return plan
        agents = {candidate.alias: await self._description(candidate) for candidate in pool}
        questions = {f"affects.{candidate.alias}": {
            "type": "yesno",
            "instructions": f"Could `finding.text` change what agent `agents.{candidate.alias}` should do or has "
                            "already done?"} for candidate in pool}
        try:
            answers, report = await self._ask({"finding": {"text": text}, "agents": agents}, questions)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - any judge failure notifies nobody
            return NotificationPlan(text=text, judge={"unavailable": _code(error)})
        plan = NotificationPlan(text=text, judge=report)
        for candidate in pool:
            probability = answers[f"affects.{candidate.alias}"]["probability"]
            target = {"session_id": candidate.session.id, "task_id": candidate.task.id, "probability": probability}
            ended = candidate.task.status in _TERMINAL
            if probability >= self.policy.notify_at:
                (plan.follow_up if ended else plan.notify).append(target)
            elif probability >= self.policy.notify_confirm_at:
                (plan.follow_up if ended else plan.confirm).append(target)
        for targets in (plan.notify, plan.confirm, plan.follow_up):
            targets.sort(key=lambda target: target["probability"], reverse=True)
        return plan

    async def notify(self, plan: NotificationPlan) -> list[Snapshot]:
        sent = []
        for target in plan.notify:
            session = await self._orch.sessions.get(target["session_id"])
            sent.append(await self._orch.messages.send({
                "task_id": target["task_id"], "to_session_id": target["session_id"],
                "expected_generation": session.generation, "kind": "finding", "summary": plan.text}))
        return sent
