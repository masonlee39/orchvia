# SPEC-0031: Usage outside the main loop

Date: 2026-09-27. Status: approved by the owner on 2026-09-27, who chose option 1 of the decision that the downstream host's report on 0.1.7 raised and approved this design, with the host's three refinements: the main model's record keeps the dispatch's model, a compaction in the middle of a dispatch is an acceptance path, and the timing invariants say what the subtraction compares. Release: 0.1.8. Evidence: [TDD-0031](../tdd/0031-usage-outside-the-main-loop.md).

## Why

The desktop host that [SPEC-0030](./0030-cache-write-durations-and-commit-time.md) served reported that the Claude adapter records only the main loop of a dispatch. The adapter took the result's `usage`, which the Claude Agent SDK documents as the main agent loop only. The result's `modelUsage` holds every model call of the query, per model: the main loop, Task subagents, sidechains and internal calls such as compaction; the SDK calls it the field for token and cost accounting.

An offline run of the real Claude Code binary against a scripted gateway showed what the engine missed:

- A dispatch that Claude Code compacted in the middle was recorded with 760,000 input and 80 output tokens, while `modelUsage` held 781,000 input, 2,180 output and 900 cache-write tokens.
- A `sessions.compact` dispatch was recorded with four zeros, while its compaction call used 7,000 input, 700 output and 300 cache-write tokens.

The host's totals and the engine's own cost ledger were low by those calls.

## Acceptance criteria

### A: The Claude adapter

- **A01** The observation of the main loop is unchanged: its ID, its counts, its split of cache writes (SPEC-0030 A01) and its raw.
- **A02** When the result holds `modelUsage`, the adapter also reports the calls outside the main loop, one observation per model:
  - for the main model, its counts minus the main loop's;
  - for any other model, its counts.

  `inputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` and `outputTokens` become `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens` and `outputTokens`. A model whose remainder is four zeros has no observation. An observation has no split of its cache writes, its raw is the SDK's entry for the model, and its ID is `<dispatch>:outside:<key>`, or a digest of the key when the key is long.
- **A03** The main model is the key that equals the dispatch's model, else the only key whose `canonicalModel` equals it, else the only key. Its observation names no model, so its record has the dispatch's model, as the main loop's record has. The observation of another model names that model's `canonicalModel`, or its key when it has none.
- **A04** When no key is the main model, the adapter reports one observation with four null counts, whose raw is the whole `modelUsage`. When a model's entry lacks a count, or a count of the main loop exceeds the main model's, that model's observation has four null counts.
- **A05** A result without `modelUsage` has only the main loop's observation, as before.

### B: The engine

- **B01** A usage observation may name its `model`, a string of 1 to 256 characters. The record holds it instead of the session's model. Any other value fails with `INVALID_RUNTIME_CONTRACT`, and nothing is stored.
- **B02** A repeated observation resolves its model as B01 does, the one it names or else the session's, and fails with `IDEMPOTENCY_CONFLICT` when that differs from its record's model. The engine keeps no mark of whether the first observation named its model, so naming the session's model is the same as naming none.
- **B03** The cost ledger prices a record whose model differs from its dispatch's with the registered pricing of its provider and model, when the dispatch was priced and that pricing has the dispatch's currency. Otherwise the record's cost is unknown, with the reason `pricing_not_registered`, and the dispatch's reservation stays held. A record of the dispatch's model is priced as before.
- **B04** `usage.recorded` carries each record's own model, and `usage.byTask` and `usage.summary` group each record under it.

### C: The real Claude Code binary

- **C01** With the real Claude Code binary and a scripted offline gateway, the records of a `sessions.compact` dispatch hold the compaction's call as a record outside the main loop, with the session's model.
- **C02** A dispatch that Claude Code compacts in the middle has, under the same task and with the dispatch's model, the record of its main loop and a record of the compaction's calls.

## Timing invariants

- **A02** (Superseded in part by [SPEC-0032](./0032-claude-session-totals.md): from Claude Code 2.1.277 on, a resumed or forked session's `modelUsage` continues from its earlier dispatches, and the adapter first subtracts the totals of the dispatch before.) The adapter subtracts the `usage` of a result from the `modelUsage` of the same result. A dispatch runs one `query()` with one user message, and the SDK starts `modelUsage` at zero for a resumed session, so both cover the calls of this dispatch and no other. `usage` counts one turn and `modelUsage` accumulates across turns, but a dispatch has one turn. The adapter reads the first result that matches the dispatch's session, as it already does for `usage`, and ignores later ones.
- **A02** The adapter reports every observation of a dispatch, through `reportUsage` and as events, before it yields the dispatch's terminal. The engine settles the dispatch's reservation again at the terminal, so that settlement sees them all.

## Tests

- Claude adapter, with scripted results:
  - one model equal to the main loop (A01, A05);
  - the main model with more calls (A02);
  - a second model, with and without `canonicalModel` (A03);
  - a main model found by `canonicalModel`, or as the only key (A03);
  - no main model, a missing count and a negative remainder (A04);
  - a long key (A02).
- Engine:
  - observations with and without a model, and invalid models (B01);
  - a repeated observation (B02);
  - pricing of the dispatch's model, of another registered model, of an unregistered one, and in another currency (B03);
  - the event and both totals (B04).
- `scripts/native-usage-smoke.mjs` runs the real Claude Code binary against a scripted gateway, locally and in the pinned native protocol CI job (C01, C02).

## Not in this increment

- A Task subagent through the real binary: the adapter's default tools do not include Task, so A03 uses a scripted result with two models.
- A split by duration of the cache writes outside the main loop: `modelUsage` has none.
- The Codex adapter.
