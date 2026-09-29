/**
 * Optional routing layer (SPEC-0018). A pluggable judge answers typed questions about a request
 * and the agents of one group; deterministic policy turns the answers into an ordinary declaration
 * that the engine validates and executes as before. Nothing here changes the engine or the wire.
 */
import type {
  ContextPlan,
  Json,
  MessageSnapshot,
  RuntimeSpec,
  SessionSnapshot,
  TaskSnapshot,
  TaskSpec,
} from '../../engine/src/types.ts';
import type { MutationOptions, Orchestrator, TaskHandle } from './index.ts';

export type Rubric = Json;
export type JudgeQuestion =
  | { type: 'choice'; instructions: string; options: Record<string, Rubric | null> }
  | { type: 'yesno'; instructions: string; yes?: Rubric; no?: Rubric }
  | { type: 'score'; instructions: string; levels: Rubric[] };
export type JudgeAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'yesno'; probability: number }
  | { type: 'score'; probabilities: number[]; confidence: number };
export interface JudgeRequest {
  state: Json;
  questions: Record<string, JudgeQuestion>;
  signal?: AbortSignal;
}
export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface JudgeResult {
  answers: Record<string, JudgeAnswer>;
  model?: string;
  usage?: JudgeUsage;
}
/** Any model or rule set that answers typed questions with probabilities. */
export interface Judge {
  evaluate(request: JudgeRequest): Promise<JudgeResult>;
}
export type JudgeErrorCode =
  | 'JUDGE_AUTH'
  | 'JUDGE_INVALID_REQUEST'
  | 'JUDGE_RATE_LIMITED'
  | 'JUDGE_UNAVAILABLE'
  | 'JUDGE_TIMEOUT'
  | 'JUDGE_PROTOCOL';
export class JudgeError extends Error {
  readonly code: JudgeErrorCode;
  readonly status?: number;
  constructor(code: JudgeErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface JevJudgeOptions {
  apiKey: string;
  /** Pinned by default; the router's thresholds were calibrated against this version. */
  model?: string;
  baseUrl?: string;
  /** Deadline for one evaluation, covering the single retry. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function jevQuestion(question: JudgeQuestion): Json {
  if (question.type === 'choice')
    return { type: 'choice', instructions: question.instructions, criteria: question.options };
  if (question.type === 'score')
    return { type: 'score', instructions: question.instructions, criteria: question.levels };
  return {
    type: 'noul',
    instructions: question.instructions,
    ...(question.yes !== undefined || question.no !== undefined
      ? {
          criteria: {
            ...(question.yes !== undefined ? { true: question.yes } : {}),
            ...(question.no !== undefined ? { false: question.no } : {}),
          },
        }
      : {}),
  };
}
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** Waits `ms`, or less when `signal` aborts first. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });

/** Checks that every question came back answered with its own kind, and returns the answers. */
function checkedAnswers(
  questions: Record<string, JudgeQuestion>,
  raw: unknown,
  mapJev: boolean,
): Record<string, JudgeAnswer> {
  const protocol = (message: string): never => {
    throw new JudgeError('JUDGE_PROTOCOL', message);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    protocol('The judge returned no answers object');
  const answers = raw as Record<string, Record<string, unknown> | undefined>;
  const result: Record<string, JudgeAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || typeof answer !== 'object') protocol(`The judge did not answer ${id}`);
    if (question.type === 'choice') {
      const probabilities = answer!.probabilities as Record<string, unknown> | undefined;
      if (
        answer!.type !== 'choice' ||
        typeof answer!.choice !== 'string' ||
        !Object.hasOwn(question.options, answer!.choice) ||
        !probabilities ||
        Object.entries(probabilities).some(
          ([option, value]) => !Object.hasOwn(question.options, option) || !probability(value),
        ) ||
        !probability(answer!.confidence)
      )
        protocol(`Answer ${id} is not a valid choice`);
      result[id] = {
        type: 'choice',
        choice: answer!.choice as string,
        probabilities: probabilities as Record<string, number>,
        confidence: answer!.confidence as number,
      };
    } else if (question.type === 'yesno') {
      const value = mapJev ? answer!.noul : answer!.probability;
      if (answer!.type !== (mapJev ? 'noul' : 'yesno') || !probability(value))
        protocol(`Answer ${id} is not a valid yes/no probability`);
      result[id] = { type: 'yesno', probability: value as number };
    } else {
      const levels = question.levels.length;
      let values: unknown[];
      if (mapJev) {
        const byLevel = answer!.probabilities as Record<string, unknown> | undefined;
        if (byLevel && typeof byLevel === 'object')
          values = Array.from({ length: levels }, (_, level) => byLevel[String(level)] ?? 0);
        else if (typeof answer!.score === 'number' && Number.isFinite(answer!.score)) {
          const level = Math.min(levels - 1, Math.max(0, Math.round(answer!.score)));
          values = Array.from({ length: levels }, (_, index) => (index === level ? 1 : 0));
        } else values = [];
      } else values = Array.isArray(answer!.probabilities) ? answer!.probabilities : [];
      if (
        answer!.type !== 'score' ||
        values.length !== levels ||
        !values.every(probability) ||
        !probability(answer!.confidence)
      )
        protocol(`Answer ${id} is not a valid score`);
      result[id] = {
        type: 'score',
        probabilities: values as number[],
        confidence: answer!.confidence as number,
      };
    }
  }
  return result;
}

/** TypeSafe's Jev behind the `Judge` interface: `POST /v1/systemone` with a bearer token. */
export function createJevJudge(options: JevJudgeOptions): Judge {
  if (typeof options.apiKey !== 'string' || !options.apiKey)
    throw new TypeError('createJevJudge requires an apiKey');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${(options.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '')}/v1/systemone`;
  const model = options.model ?? 'jev-1.13.0';
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async evaluate(request) {
      const questions = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [id, jevQuestion(question)]),
      );
      const body = JSON.stringify({ state: request.state, model, questions });
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, deadline.signal])
        : deadline.signal;
      const timedOut = () =>
        new JudgeError('JUDGE_TIMEOUT', `Jev did not answer within ${timeoutMs} ms`);
      try {
        for (let attempt = 1; ; attempt++) {
          let response: Response;
          try {
            response = await fetchImpl(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${options.apiKey}`,
              },
              body,
              signal,
            });
          } catch (error) {
            if (deadline.signal.aborted) throw timedOut();
            if (request.signal?.aborted) throw error;
            if (attempt === 1) continue;
            throw new JudgeError('JUDGE_UNAVAILABLE', `Jev request failed: ${String(error)}`);
          }
          if (response.ok) {
            let parsed: { model?: unknown; answers?: unknown; usage?: Record<string, unknown> };
            try {
              parsed = (await response.json()) as typeof parsed;
            } catch (error) {
              if (deadline.signal.aborted) throw timedOut();
              // The caller's abort also ends the body read; that is not a malformed answer.
              if (request.signal?.aborted) throw error;
              throw new JudgeError('JUDGE_PROTOCOL', 'Jev returned a body that is not JSON');
            }
            const usage = parsed.usage;
            return {
              answers: checkedAnswers(request.questions, parsed.answers, true),
              ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
              ...(usage && typeof usage.input_tokens === 'number'
                ? {
                    usage: {
                      inputTokens: usage.input_tokens,
                      outputTokens:
                        typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
                    },
                  }
                : {}),
            };
          }
          await response.body?.cancel().catch(() => {});
          const status = response.status;
          const retryable = status === 429 || status === 529 || status >= 500;
          if (retryable && attempt === 1) {
            // The pause counts against the same deadline and ends early with it or the caller.
            await pause(200, signal);
            if (deadline.signal.aborted) throw timedOut();
            if (request.signal?.aborted) throw request.signal.reason;
            continue;
          }
          throw new JudgeError(
            status === 401 || status === 403
              ? 'JUDGE_AUTH'
              : status === 429
                ? 'JUDGE_RATE_LIMITED'
                : retryable
                  ? 'JUDGE_UNAVAILABLE'
                  : 'JUDGE_INVALID_REQUEST',
            `Jev answered HTTP ${status}`,
            status,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface RuleJudgeOptions {
  /** Answers a question instead of the rules; `undefined` leaves it to them. Not capped. */
  answer?: (id: string, question: JudgeQuestion, state: Json) => JudgeAnswer | undefined;
}
/** The highest confidence the rule judge claims, below every threshold of the default policy. */
const RULE_CONFIDENCE = 0.6;
const WRITE_VERBS = new Set(
  'add bump change create delete edit fix implement migrate modify move patch refactor remove rename replace rewrite update upgrade write'.split(
    ' ',
  ),
);
const COMMON_WORDS = new Set(
  'about after all and any are can for from how into its not now our that the their them then this was what when where which with you your'.split(
    ' ',
  ),
);
const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** The words of a text that can relate it to another: no verbs of change, no common words. */
const ruleWords = (text: string) =>
  new Set(
    tokens(text).filter(
      (word) => word.length >= 3 && !WRITE_VERBS.has(word) && !COMMON_WORDS.has(word),
    ),
  );
const sharedWords = (a: Set<string>, b: Set<string>) => [...a].filter((word) => b.has(word)).length;
/** Level 0, the middle level or the last, for none, one, or two and more. */
const byCount = (count: number, length: number) =>
  count === 0 ? 0 : count === 1 ? Math.floor((length - 1) / 2) : length - 1;
/** `peak` on level `at` and the rest spread evenly; the confidence is the peak. */
function scoreAnswer(length: number, at: number, peak: number): JudgeAnswer {
  const rest = length > 1 ? (1 - peak) / (length - 1) : 0;
  return {
    type: 'score',
    probabilities: Array.from({ length }, (_, i) => (i === at ? peak : rest)),
    confidence: Math.min(peak, RULE_CONFIDENCE),
  };
}

/**
 * A judge without a model (SPEC-0044 E04): relevance from the words a goal shares with an agent,
 * `writes` from verbs of change, and `size` from the goal's length. It is a baseline for trying
 * the routing layer, not a judge of quality: its confidence never exceeds 0.6, so the default
 * policy asks for confirmation whenever there is an agent to choose.
 */
export function createRuleJudge(options: RuleJudgeOptions = {}): Judge {
  return {
    async evaluate(request) {
      if (request.signal?.aborted) throw request.signal.reason;
      const state = request.state as {
        request?: { goal?: unknown };
        finding?: { text?: unknown };
        agents?: Record<string, { description?: unknown } | string>;
      } | null;
      const text = String(state?.request?.goal ?? state?.finding?.text ?? '');
      const words = ruleWords(text);
      const shared = (alias: string) => {
        const agent = state?.agents?.[alias];
        const about = typeof agent === 'string' ? agent : agent?.description;
        return sharedWords(words, ruleWords(String(about ?? '')));
      };
      const answers: Record<string, JudgeAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const custom = options.answer?.(id, question, request.state);
        if (custom !== undefined) {
          answers[id] = custom;
          continue;
        }
        const alias = id.slice(id.indexOf('.') + 1);
        if (question.type === 'choice') {
          const names = Object.keys(question.options);
          const counts = names.map((name) => (name === 'fresh' ? 0 : shared(name)));
          // Fresh wins when no agent shares a word, and otherwise counts as half a shared word.
          const fresh = Math.max(0, ...counts) === 0 ? 1 : 0.5;
          const weights = names.map((name, i) => (name === 'fresh' ? fresh : counts[i]!));
          const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
          const probabilities = Object.fromEntries(
            names.map((name, i) => [name, weights[i]! / total]),
          );
          const choice = names.reduce((a, b) => (probabilities[b]! > probabilities[a]! ? b : a));
          answers[id] = {
            type: 'choice',
            choice,
            probabilities,
            confidence: Math.min(RULE_CONFIDENCE, probabilities[choice]!),
          };
        } else if (question.type === 'yesno') {
          let probability = 0.5;
          if (id === 'writes')
            probability = tokens(text).some((word) => WRITE_VERBS.has(word)) ? 0.8 : 0.2;
          else if (/^(relevant|clash|affects)\./.test(id)) {
            const count = shared(alias);
            probability = count === 0 ? 0.2 : count === 1 ? 0.55 : 0.8;
          }
          answers[id] = { type: 'yesno', probability };
        } else {
          const length = question.levels.length;
          if (id === 'size') {
            const count = text.split(/\s+/).filter(Boolean).length;
            answers[id] = scoreAnswer(
              length,
              byCount(count <= 8 ? 0 : count <= 30 ? 1 : 2, length),
              RULE_CONFIDENCE,
            );
          } else if (id.startsWith('depends.'))
            answers[id] = scoreAnswer(length, byCount(shared(alias), length), RULE_CONFIDENCE);
          // A question the rules do not know: every level equally likely.
          else answers[id] = scoreAnswer(length, 0, 1 / length);
        }
      }
      return { answers, model: 'rules' };
    },
  };
}

/** Provider and models for fresh work of one permission profile. */
export interface RouteRuntime {
  provider: string;
  model: string;
  small?: string;
  large?: string;
}
export interface RoutingPolicy {
  maxCandidates: number;
  maxContextRefs: number;
  busyWaitMs: number;
  confirmBelow: number;
  minMargin: number;
  relevantAt: number;
  contextAt: number;
  clashAt: number;
  essentialAt: number;
  essentialNoFallbackAt: number;
  smallAt: number;
  largeAt: number;
  writesUnsure: [number, number];
  notifyAt: number;
  notifyConfirmAt: number;
  onJudgeFailure: 'confirm' | 'fresh';
  descriptionChars: number;
}
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  maxCandidates: 16,
  maxContextRefs: 20,
  busyWaitMs: 20 * 60_000,
  confirmBelow: 0.85,
  minMargin: 0.2,
  relevantAt: 0.5,
  contextAt: 0.7,
  clashAt: 0.5,
  essentialAt: 0.5,
  essentialNoFallbackAt: 0.7,
  smallAt: 0.85,
  largeAt: 0.7,
  writesUnsure: [0.3, 0.7],
  notifyAt: 0.7,
  notifyConfirmAt: 0.5,
  onJudgeFailure: 'confirm',
  descriptionChars: 600,
};
/** One member agent as the router sees it; `describe` may turn it into the text the judge reads. */
export interface CandidateView {
  alias: string;
  session: SessionSnapshot;
  task: TaskSnapshot;
  busy: boolean;
}
export interface RouterOptions {
  orchestrator: Orchestrator;
  judge: Judge;
  runtimes: { readOnly?: RouteRuntime; writable?: RouteRuntime };
  /**
   * `root` (default): a group is one root task. `engine`: the host runs one group per engine and
   * configured that engine with `allowCrossRootReuse`.
   */
  scope?: 'root' | 'engine';
  describe?: (candidate: CandidateView) => string | Promise<string>;
  policy?: Partial<RoutingPolicy>;
}
export interface RouteRequest {
  goal: string;
  acceptance: TaskSpec['acceptance'];
  /** Session ids of the group's agents. Nothing else is read. */
  members: string[];
  /** The group's root task under `scope: 'root'`; the proposed task becomes its child. */
  rootTaskId?: string;
  /** Skips the judge's writes question when the host already knows. */
  needsWrites?: boolean;
  /** Other task fields to keep, such as `budget`, `writeScope` or `writePath`. */
  spec?: Partial<Omit<TaskSpec, 'goal' | 'acceptance' | 'runtime' | 'contextPlan'>>;
  signal?: AbortSignal;
}
export type RoutedContextPlan = Omit<ContextPlan, 'maxQueueWaitMs'> & { maxQueueWaitMs?: number };
/** A task spec whose fresh plans leave the queue wait to the host default. */
export type RoutedTaskSpec = Omit<TaskSpec, 'contextPlan'> & { contextPlan: RoutedContextPlan };
export type RouteReasonCode =
  | 'IDLE_REUSE'
  | 'BUSY_WAIT'
  | 'BUSY_PARALLEL'
  | 'FRESH_CHOSEN'
  | 'NO_RELEVANT_AGENT'
  | 'NO_CANDIDATES'
  | 'CONTEXT_CARRIED'
  | 'CONTEXT_OMITTED'
  | 'CONTEXT_UNCHECKED'
  | 'MODEL_SMALL'
  | 'MODEL_LARGE'
  | 'RUNTIME_MISSING'
  | 'LOW_CONFIDENCE'
  | 'NARROW_MARGIN'
  | 'WRITES_UNCERTAIN'
  | 'JUDGE_UNAVAILABLE';
export interface RouteReason {
  code: RouteReasonCode;
  detail?: Record<string, Json>;
}
export type JudgeReport =
  | { model?: string; latencyMs: number; usage?: JudgeUsage }
  | { unavailable: JudgeErrorCode };
export interface RouteAlternative {
  /** A session id or `fresh`. */
  option: string;
  /** Share among the options that can take the work, after read-only agents are dropped. */
  probability: number;
  /** The probability the judge gave this option. */
  judgeProbability: number;
}
export interface RouteProposal {
  spec: RoutedTaskSpec;
  decision: { mode: 'reuse'; sessionId: string } | { mode: 'fresh' };
  /**
   * The lower of `judgeConfidence` and the judge's probability for the proposed option; for a
   * fresh session because no agent is relevant, 1 minus the highest relevance instead of that
   * probability. 1 without candidates, 0 when the judge was unavailable.
   */
  confidence: number;
  /** The judge's own confidence in its `best` answer; null when it was not asked or failed. */
  judgeConfidence: number | null;
  needsConfirmation: boolean;
  /** Most probable first. */
  alternatives: RouteAlternative[];
  reasons: RouteReason[];
  judge: JudgeReport;
}
/** The engine's inline limit for one context reference, in UTF-8 bytes. */
export const MAX_CONTEXT_REF_BYTES = 32768;
/** The engine returns a task's complete result up to this size, and a marked preview beyond. */
const COMPLETE_RESULT_BYTES = 64 * 1024;
/** `CONTEXT_OMITTED` reasons for the codes `context.checkRefs` reports (SPEC-0020). */
const OMISSION: Record<string, string> = {
  ARTIFACT_TOO_LARGE: 'too_large',
  ARTIFACT_HISTORY_EXPIRED: 'expired',
  ARTIFACT_CORRUPT: 'corrupt',
  NOT_FOUND: 'missing',
};
const encoder = new TextEncoder();
export type RoutingErrorCode = 'ROUTING_ROOT_MISMATCH' | 'ROUTING_SOURCE_NOT_MEMBER';
/** A request that would leave the router's group. It is refused before the judge is asked. */
export class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  constructor(code: RoutingErrorCode, message: string) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}
export interface NotificationTarget {
  sessionId: string;
  taskId: string;
  probability: number;
}
export interface NotificationPlan {
  text: string;
  /** Agents whose current task a finding may change; `notify` sends to these. */
  notify: NotificationTarget[];
  /** Less certain; the host decides. */
  confirm: NotificationTarget[];
  /** Affected agents whose task ended; they cannot receive messages, so start a follow-up. */
  followUp: NotificationTarget[];
  judge: JudgeReport;
}
export interface Router {
  route(request: RouteRequest): Promise<RouteProposal>;
  submit(proposal: RouteProposal, options?: MutationOptions): Promise<TaskHandle>;
  /**
   * The source must be one of `members`. Under `scope: 'root'` the group is the source's root
   * task, and a different `rootTaskId` is refused; under `scope: 'engine'` it is ignored.
   */
  notifications(finding: {
    text: string;
    fromSessionId: string;
    members: string[];
    rootTaskId?: string;
    signal?: AbortSignal;
  }): Promise<NotificationPlan>;
  notify(plan: NotificationPlan, options?: MutationOptions): Promise<MessageSnapshot[]>;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const UNAVAILABLE = new Set(['closed', 'paused', 'pausing', 'outcome_unknown']);
const SIZE_LEVELS = [
  'trivial: answered or done by looking at one place',
  'moderate: a focused change or investigation in a few files',
  'large: a multi-file design change or migration',
];
const DEPENDENCE_LEVELS = [
  'none: another agent could do it just as well from scratch',
  'helpful: the work this agent is doing now would save some investigation',
  'essential: it must build directly on the changes this agent is making now',
];
const judgeCode = (error: unknown): JudgeErrorCode =>
  error instanceof JudgeError ? error.code : 'JUDGE_UNAVAILABLE';

/** Creates a router that proposes declarations for requests inside one group (SPEC-0018). */
export function createRouter(options: RouterOptions): Router {
  const { orchestrator: orch, judge } = options;
  const scope = options.scope ?? 'root';
  const policy: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY, ...options.policy };
  if (!options.runtimes.readOnly && !options.runtimes.writable)
    throw new TypeError('createRouter requires a read-only or writable runtime');
  if (policy.maxContextRefs > 20) throw new TypeError('maxContextRefs cannot exceed 20');

  /** The members that can take work in this group, under neutral aliases. */
  async function candidates(
    members: string[],
    rootTaskId: string | undefined,
    keep: (session: SessionSnapshot, task: TaskSnapshot) => boolean,
  ): Promise<CandidateView[]> {
    const found: CandidateView[] = [];
    for (const id of [...new Set(members)]) {
      if (found.length >= policy.maxCandidates) break;
      let session: SessionSnapshot;
      try {
        session = await orch.sessions.get(id);
      } catch {
        continue;
      }
      if (!session.taskId) continue;
      if (scope === 'root' && (!rootTaskId || session.rootTaskId !== rootTaskId)) continue;
      const task = await orch.tasks.get(session.taskId);
      if (!keep(session, task)) continue;
      found.push({
        alias: `A${found.length + 1}`,
        session,
        task,
        busy: session.status !== 'idle' || !TERMINAL.has(task.status),
      });
    }
    return found;
  }
  async function describe(candidate: CandidateView): Promise<Json> {
    const text = options.describe
      ? await options.describe(candidate)
      : candidate.task.result
        ? `${candidate.task.spec.goal}\nResult: ${candidate.task.result.slice(0, policy.descriptionChars)}`
        : candidate.task.spec.goal;
    return {
      description: text,
      status: candidate.busy ? 'busy' : 'idle',
      access: candidate.session.permissionProfile === 'workspace-write' ? 'writable' : 'read-only',
    };
  }
  async function ask(
    state: Json,
    questions: Record<string, JudgeQuestion>,
    signal: AbortSignal | undefined,
  ): Promise<{ answers: Record<string, JudgeAnswer>; report: JudgeReport }> {
    const started = Date.now();
    const result = await judge.evaluate({ state, questions, ...(signal ? { signal } : {}) });
    const answers = checkedAnswers(questions, result.answers, false);
    return {
      answers,
      report: {
        ...(result.model ? { model: result.model } : {}),
        latencyMs: Date.now() - started,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }
  /**
   * A candidate's latest result as a context reference, measured as the engine measures it. The
   * snapshot holds the complete result up to 64 KiB (SPEC-0001) and a longer preview beyond.
   */
  const resultOf = (candidate: CandidateView) => {
    const artifactRef = candidate.task.artifactRefs[0];
    const text = candidate.task.result;
    return artifactRef && typeof text === 'string'
      ? { artifactRef, bytes: encoder.encode(text).byteLength }
      : undefined;
  };

  return {
    async route(request) {
      if (typeof request.goal !== 'string' || !request.goal.trim())
        throw new TypeError('route requires a goal');
      if (!Array.isArray(request.members)) throw new TypeError('route requires members');
      const extra = request.spec ?? {};
      const pool = await candidates(
        request.members,
        request.rootTaskId,
        (session, task) =>
          !UNAVAILABLE.has(session.status) &&
          (extra.writeScope === undefined ||
            (task.spec.writeScope === extra.writeScope && task.spec.writePath === extra.writePath)),
      );
      const reasons: RouteReason[] = [];
      const parentTaskId =
        scope === 'root' ? request.rootTaskId : (extra.parentTaskId ?? undefined);
      const base = (writes: boolean) => {
        const wanted = writes ? options.runtimes.writable : options.runtimes.readOnly;
        if (wanted) return wanted;
        reasons.push({ code: 'RUNTIME_MISSING', detail: { needsWrites: writes } });
        return (options.runtimes.writable ?? options.runtimes.readOnly)!;
      };
      const plan = (
        runtime: RuntimeSpec,
        contextPlan: RoutedContextPlan,
        reuse?: CandidateView,
      ): RoutedTaskSpec => ({
        ...extra,
        // A reused session keeps its write scope, so the engine's compatibility check holds.
        ...(reuse?.task.spec.writeScope !== undefined
          ? { writeScope: reuse.task.spec.writeScope }
          : {}),
        ...(reuse?.task.spec.writePath !== undefined
          ? { writePath: reuse.task.spec.writePath }
          : {}),
        goal: request.goal,
        runtime,
        acceptance: request.acceptance,
        ...(parentTaskId ? { parentTaskId } : {}),
        contextPlan,
      });
      const freshPlan = (contextRefs: string[]): RoutedContextPlan => ({
        requestedMode: 'fresh',
        independent: true,
        dependencyTaskIds: [],
        contextRefs: contextRefs.map((artifactRef) => ({ artifactRef, version: 1 as const })),
        fallbackModes: [],
      });

      const agents: Record<string, Json> = {};
      for (const candidate of pool) agents[candidate.alias] = await describe(candidate);
      const state: Json = { request: { goal: request.goal }, agents };
      const questions: Record<string, JudgeQuestion> = {};
      if (pool.length) {
        questions.best = {
          type: 'choice',
          instructions:
            'Which agent in `agents` should take `request.goal`? Pick the agent whose recent or current work fits it best; pick fresh if none has context that helps.',
          options: {
            ...Object.fromEntries(pool.map((candidate) => [candidate.alias, null])),
            fresh: 'no existing agent has context that helps; start a new one',
          },
        };
        for (const { alias } of pool)
          questions[`relevant.${alias}`] = {
            type: 'yesno',
            instructions: `Would what agent \`agents.${alias}\` knows from its work help with \`request.goal\`?`,
          };
        for (const { alias, busy } of pool)
          if (busy) {
            questions[`depends.${alias}`] = {
              type: 'score',
              instructions: `How much does \`request.goal\` depend on the work agent \`agents.${alias}\` is doing now?`,
              levels: DEPENDENCE_LEVELS,
            };
            questions[`clash.${alias}`] = {
              type: 'yesno',
              instructions: `If \`request.goal\` ran at the same time as the work of agent \`agents.${alias}\`, would the two risk editing the same code?`,
            };
          }
      }
      if (request.needsWrites === undefined)
        questions.writes = {
          type: 'yesno',
          instructions: 'Does doing `request.goal` require modifying files?',
        };
      const ladders = [options.runtimes.readOnly, options.runtimes.writable];
      if (ladders.some((ladder) => ladder?.small || ladder?.large))
        questions.size = {
          type: 'score',
          instructions: 'How much work is `request.goal` for a coding agent?',
          levels: SIZE_LEVELS,
        };

      let answers: Record<string, JudgeAnswer> = {};
      let report: JudgeReport = { latencyMs: 0 };
      if (Object.keys(questions).length) {
        try {
          ({ answers, report } = await ask(state, questions, request.signal));
        } catch (error) {
          if (request.signal?.aborted) throw error;
          const code = judgeCode(error);
          const runtime = base(request.needsWrites !== false);
          return {
            spec: plan({ provider: runtime.provider, model: runtime.model }, freshPlan([])),
            decision: { mode: 'fresh' },
            confidence: 0,
            judgeConfidence: null,
            needsConfirmation: policy.onJudgeFailure === 'confirm',
            alternatives: [],
            reasons: [...reasons, { code: 'JUDGE_UNAVAILABLE', detail: { error: code } }],
            judge: { unavailable: code },
          };
        }
      }
      const yes = (id: string) => (answers[id] as { probability: number } | undefined)?.probability;
      const writesProbability = yes('writes');
      const writes = request.needsWrites ?? (writesProbability ?? 0) >= 0.5;
      if (
        writesProbability !== undefined &&
        writesProbability >= policy.writesUnsure[0] &&
        writesProbability <= policy.writesUnsure[1]
      )
        reasons.push({ code: 'WRITES_UNCERTAIN', detail: { probability: writesProbability } });

      const eligible = pool.filter(
        (candidate) => !writes || candidate.session.permissionProfile === 'workspace-write',
      );
      const relevance = (candidate: CandidateView) => yes(`relevant.${candidate.alias}`) ?? 0;
      const best = answers.best as Extract<JudgeAnswer, { type: 'choice' }> | undefined;
      // Options keep the judge's own probabilities. Their share among the options left after the
      // write filter orders and reports them, but never raises the confidence that is checked.
      const choices = [...eligible.map((candidate) => candidate.alias), 'fresh'].map((option) => ({
        option,
        judgeProbability: best?.probabilities[option] ?? 0,
      }));
      const total = choices.reduce((sum, entry) => sum + entry.judgeProbability, 0);
      const ranked = choices
        .map((entry) => ({ ...entry, share: total > 0 ? entry.judgeProbability / total : 0 }))
        .sort((a, b) => b.judgeProbability - a.judgeProbability);
      // Without any probability mass, fresh leads: nothing argued for an existing agent.
      if (total === 0)
        ranked.unshift(
          ...ranked.splice(
            ranked.findIndex((entry) => entry.option === 'fresh'),
            1,
          ),
        );
      const byAlias = new Map(pool.map((candidate) => [candidate.alias, candidate]));
      const alternatives = ranked.map((entry) => ({
        option: entry.option === 'fresh' ? 'fresh' : byAlias.get(entry.option)!.session.id,
        probability: entry.share,
        judgeProbability: entry.judgeProbability,
      }));

      const byRelevance = (exclude?: CandidateView) =>
        pool
          .filter(
            (candidate) =>
              candidate !== exclude &&
              relevance(candidate) >= policy.contextAt &&
              resultOf(candidate),
          )
          .sort((a, b) => relevance(b) - relevance(a));
      const top = ranked[0];
      const chosen = top && top.option !== 'fresh' ? byAlias.get(top.option) : undefined;
      // SPEC-0020: the engine checks every result that could be carried, at most 20 per call. An
      // engine without the check leaves them unchecked, and the proposal says so.
      const checked =
        (orch.info?.capabilities?.workflow as { contextCheck?: unknown } | undefined)
          ?.contextCheck === true;
      const verdicts = new Map<string, { admissible: boolean; code?: string; bytes?: number }>();
      if (checked) {
        const candidateRefs = [
          ...new Set(
            [...byRelevance(), ...(chosen ? [chosen] : [])]
              .map(resultOf)
              .filter((result) => result && result.bytes <= MAX_CONTEXT_REF_BYTES)
              .map((result) => result!.artifactRef),
          ),
        ];
        for (let start = 0; start < candidateRefs.length; start += 20) {
          const { contextRefs } = await orch.context.checkRefs(
            candidateRefs
              .slice(start, start + 20)
              .map((artifactRef) => ({ artifactRef, version: 1 as const })),
            request.signal ? { signal: request.signal } : undefined,
          );
          for (const entry of contextRefs) verdicts.set(entry.artifactRef, entry);
        }
      }
      const omitted = new Set<string>();
      /**
       * The results of `sources` to carry, in order, at most `maxContextRefs`. The engine refuses a
       * whole task when one reference exceeds its inline limit, so such a result is left out with a
       * reason instead, and takes no place.
       */
      const carry = (sources: CandidateView[]): string[] => {
        const carried: string[] = [];
        for (const candidate of sources) {
          if (carried.length >= policy.maxContextRefs) break;
          const result = resultOf(candidate);
          if (!result || carried.includes(result.artifactRef)) continue;
          const verdict = verdicts.get(result.artifactRef);
          if (result.bytes <= MAX_CONTEXT_REF_BYTES && (!verdict || verdict.admissible)) {
            carried.push(result.artifactRef);
            continue;
          }
          if (omitted.has(result.artifactRef)) continue;
          omitted.add(result.artifactRef);
          if (verdict && result.bytes <= MAX_CONTEXT_REF_BYTES) {
            reasons.push({
              code: 'CONTEXT_OMITTED',
              detail: {
                sessionId: candidate.session.id,
                artifactRef: result.artifactRef,
                reason: OMISSION[verdict.code ?? ''] ?? 'unreadable',
                ...(verdict.code ? { code: verdict.code } : {}),
                ...(verdict.bytes !== undefined ? { bytes: verdict.bytes } : {}),
              },
            });
            continue;
          }
          reasons.push({
            code: 'CONTEXT_OMITTED',
            detail: {
              sessionId: candidate.session.id,
              artifactRef: result.artifactRef,
              reason: 'too_large',
              // Beyond the preview size the result is only known to be larger.
              ...(result.bytes <= COMPLETE_RESULT_BYTES ? { bytes: result.bytes } : {}),
              maxBytes: MAX_CONTEXT_REF_BYTES,
            },
          });
        }
        return carried;
      };
      const references = (refs: string[]) =>
        refs.map((artifactRef) => ({ artifactRef, version: 1 as const }));

      const anyRelevant = eligible.some((candidate) => relevance(candidate) >= policy.relevantAt);
      let proposal: Pick<RouteProposal, 'spec' | 'decision'>;
      /** How sure the decision itself is, before the judge's own confidence applies. */
      let decisionConfidence: number;
      if (!pool.length) {
        reasons.push({ code: 'NO_CANDIDATES' });
      }
      if (chosen && anyRelevant && !chosen.busy) {
        reasons.push({ code: 'IDLE_REUSE', detail: { judgeProbability: top.judgeProbability } });
        proposal = {
          spec: plan(
            { provider: chosen.session.provider, model: chosen.session.model },
            {
              requestedMode: 'reuse',
              independent: true,
              dependencyTaskIds: [],
              candidateSessionId: chosen.session.id,
              contextRefs: references(carry(byRelevance(chosen))),
              fallbackModes: ['fresh'],
              maxQueueWaitMs: policy.busyWaitMs,
            },
            chosen,
          ),
          decision: { mode: 'reuse', sessionId: chosen.session.id },
        };
        decisionConfidence = top.judgeProbability;
      } else if (chosen && anyRelevant) {
        const clash = yes(`clash.${chosen.alias}`) ?? 0;
        const dependence = answers[`depends.${chosen.alias}`] as
          | Extract<JudgeAnswer, { type: 'score' }>
          | undefined;
        const essential = dependence?.probabilities[2] ?? 0;
        if (clash >= policy.clashAt || essential >= policy.essentialAt) {
          const fallback = essential < policy.essentialNoFallbackAt;
          reasons.push({ code: 'BUSY_WAIT', detail: { clash, essential } });
          proposal = {
            spec: plan(
              { provider: chosen.session.provider, model: chosen.session.model },
              {
                requestedMode: 'reuse',
                independent: true,
                dependencyTaskIds: [],
                candidateSessionId: chosen.session.id,
                contextRefs: references(
                  carry([...byRelevance(chosen), ...(fallback ? [chosen] : [])]),
                ),
                fallbackModes: fallback ? ['fresh'] : [],
                maxQueueWaitMs: policy.busyWaitMs,
              },
              chosen,
            ),
            decision: { mode: 'reuse', sessionId: chosen.session.id },
          };
        } else {
          reasons.push({ code: 'BUSY_PARALLEL', detail: { clash, essential } });
          const refs = carry([chosen, ...byRelevance(chosen)]);
          const runtime = base(writes);
          proposal = {
            spec: plan({ provider: runtime.provider, model: freshModel(runtime) }, freshPlan(refs)),
            decision: { mode: 'fresh' },
          };
        }
        decisionConfidence = top.judgeProbability;
      } else {
        if (pool.length)
          reasons.push(
            top?.option === 'fresh'
              ? { code: 'FRESH_CHOSEN', detail: { judgeProbability: top.judgeProbability } }
              : { code: 'NO_RELEVANT_AGENT' },
          );
        const runtime = base(writes);
        const refs = carry(byRelevance());
        proposal = {
          spec: plan({ provider: runtime.provider, model: freshModel(runtime) }, freshPlan(refs)),
          decision: { mode: 'fresh' },
        };
        decisionConfidence = !pool.length
          ? 1
          : top?.option === 'fresh'
            ? top.judgeProbability
            : 1 - Math.max(0, ...eligible.map(relevance));
      }
      function freshModel(runtime: RouteRuntime): string {
        const size = answers.size as Extract<JudgeAnswer, { type: 'score' }> | undefined;
        if (size && runtime.small && size.probabilities[0] >= policy.smallAt) {
          reasons.push({ code: 'MODEL_SMALL', detail: { probability: size.probabilities[0] } });
          return runtime.small;
        }
        if (size && runtime.large && size.probabilities[2] >= policy.largeAt) {
          reasons.push({ code: 'MODEL_LARGE', detail: { probability: size.probabilities[2] } });
          return runtime.large;
        }
        return runtime.model;
      }
      if (proposal.spec.contextPlan.contextRefs.length) {
        reasons.push({
          code: 'CONTEXT_CARRIED',
          detail: { count: proposal.spec.contextPlan.contextRefs.length },
        });
        if (!checked)
          reasons.push({
            code: 'CONTEXT_UNCHECKED',
            detail: { count: proposal.spec.contextPlan.contextRefs.length },
          });
      }
      // A judge that reports low confidence in its own choice is unsure, however probable it made
      // that choice look.
      const judgeConfidence = best ? best.confidence : null;
      const confidence =
        judgeConfidence === null
          ? decisionConfidence
          : Math.min(judgeConfidence, decisionConfidence);
      if (pool.length && confidence < policy.confirmBelow)
        reasons.push({
          code: 'LOW_CONFIDENCE',
          detail: { confidence, ...(judgeConfidence === null ? {} : { judgeConfidence }) },
        });
      // The tolerance keeps an exact threshold, such as 0.6 against 0.4, from reading as narrower.
      if (ranked.length > 1 && ranked[0].share - ranked[1].share < policy.minMargin - 1e-9)
        reasons.push({
          code: 'NARROW_MARGIN',
          detail: { margin: ranked[0].share - ranked[1].share },
        });
      const confirm = new Set<RouteReasonCode>([
        'LOW_CONFIDENCE',
        'NARROW_MARGIN',
        'WRITES_UNCERTAIN',
        'RUNTIME_MISSING',
      ]);
      return {
        ...proposal,
        confidence,
        judgeConfidence,
        needsConfirmation: reasons.some((reason) => confirm.has(reason.code)),
        alternatives,
        reasons,
        judge: report,
      };
    },

    submit(proposal, submitOptions) {
      return orch.tasks.create(proposal.spec as TaskSpec, submitOptions);
    },

    async notifications(finding) {
      if (typeof finding.text !== 'string' || !finding.text.trim())
        throw new TypeError('notifications requires the finding text');
      if (!Array.isArray(finding.members)) throw new TypeError('notifications requires members');
      // A finding belongs to the group of the member that made it; checked before any judge call.
      if (!finding.members.includes(finding.fromSessionId))
        throw new RoutingError(
          'ROUTING_SOURCE_NOT_MEMBER',
          'The source session of a finding must be one of the members',
        );
      const source = await orch.sessions.get(finding.fromSessionId);
      let groupRoot: string | undefined;
      if (scope === 'root') {
        // The engine's own rule for a session's root, which it applies to every reuse.
        groupRoot =
          source.rootTaskId ??
          (source.taskId
            ? ((await orch.tasks.get(source.taskId)).rootTaskId ?? source.taskId)
            : undefined);
        if (!groupRoot)
          throw new RoutingError('ROUTING_ROOT_MISMATCH', 'The source session has no root task');
        if (finding.rootTaskId !== undefined && finding.rootTaskId !== groupRoot)
          throw new RoutingError(
            'ROUTING_ROOT_MISMATCH',
            'rootTaskId is not the root task of the source session',
          );
      }
      const pool = await candidates(
        finding.members.filter((id) => id !== source.id),
        groupRoot,
        (session) => session.status !== 'closed' && session.status !== 'outcome_unknown',
      );
      const plan: NotificationPlan = {
        text: finding.text,
        notify: [],
        confirm: [],
        followUp: [],
        judge: { latencyMs: 0 },
      };
      if (!pool.length) return plan;
      const agents: Record<string, Json> = {};
      for (const candidate of pool) agents[candidate.alias] = await describe(candidate);
      const questions: Record<string, JudgeQuestion> = Object.fromEntries(
        pool.map(({ alias }) => [
          `affects.${alias}`,
          {
            type: 'yesno',
            instructions: `Could \`finding.text\` change what agent \`agents.${alias}\` should do or has already done?`,
          },
        ]),
      );
      let answers: Record<string, JudgeAnswer>;
      try {
        ({ answers, report: plan.judge } = await ask(
          { finding: { text: finding.text }, agents },
          questions,
          finding.signal,
        ));
      } catch (error) {
        if (finding.signal?.aborted) throw error;
        return { ...plan, judge: { unavailable: judgeCode(error) } };
      }
      for (const candidate of pool) {
        const p = (answers[`affects.${candidate.alias}`] as { probability: number }).probability;
        const target = {
          sessionId: candidate.session.id,
          taskId: candidate.task.id,
          probability: p,
        };
        const ended = TERMINAL.has(candidate.task.status);
        if (p >= policy.notifyAt) (ended ? plan.followUp : plan.notify).push(target);
        else if (p >= policy.notifyConfirmAt) (ended ? plan.followUp : plan.confirm).push(target);
      }
      for (const list of [plan.notify, plan.confirm, plan.followUp])
        list.sort((a, b) => b.probability - a.probability);
      return plan;
    },

    async notify(plan, notifyOptions) {
      const sent: MessageSnapshot[] = [];
      for (const target of plan.notify) {
        const session = await orch.sessions.get(target.sessionId);
        sent.push(
          await orch.messages.send(
            {
              taskId: target.taskId,
              toSessionId: target.sessionId,
              expectedGeneration: session.generation,
              kind: 'finding',
              summary: plan.text,
            },
            notifyOptions,
          ),
        );
      }
      return sent;
    },
  };
}
