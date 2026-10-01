# Pre-registration of the first paid run

Written on 2026-10-01, before any paid run, and approved by the owner (D-bench-2 option 1). It fixes what the run asks, how it is measured and what counts as an answer, so that the result cannot choose its own reading. A change to this file after the first paid request is a new pre-registration, dated, and the earlier text stays in the history.

## Question

For the same four requests on the same small project, what does running them through Orchvia cost, in tokens, money and time, compared with running them directly on the Claude Agent SDK, and does the work pass the same checks?

This run uses the fixture of [`bench/`](README.md): a small JavaScript project, four requests in two independent tracks. It says nothing about large repositories or long tasks; a run on a real repository needs its own tasks, checks and pre-registration.

## Arms

The four arms of [`run.mjs`](run.mjs), unchanged: `single` (one session, in order), `fresh` (a new session for each request, in order), `parallel` (both tracks at once on the SDK, each track resuming its session, without the engine) and `orchvia` (both tracks at once through the engine). Same model, same Claude Code build, same tools, no user or project settings, same sandbox.

## Measures

For each arm and repetition, from the report: input, output, cache-read and cache-write tokens, split into the main loop and outside it; the estimated cost at the list prices recorded in the report; wall time; and the number of requests that pass both their hidden check and their own tests. A request whose cost is unknown has a cost of null and counts in no total as 0.

## Hypotheses and thresholds

Each compares medians over the repetitions of the full run. Each is decided as written, and a hypothesis that fails is reported as failed.

| # | Hypothesis | Holds when |
| --- | --- | --- |
| H1 | The engine adds little to what the same parallel work costs | `orchvia` total tokens are within 10% of `parallel` total tokens |
| H2 | Two independent tracks finish sooner through the engine than in one session | `orchvia` wall time is at most 75% of `single` wall time |
| H3 | The engine does not lose work | `orchvia` passes at most one request fewer than the best direct arm |
| H4 | The engine does not make a passed request much dearer | `orchvia` cost per passed request is at most 115% of `single` cost per passed request |

A total with an unknown part cannot decide H1 or H4; the report then says "undecided", with the unknown parts named.

## Runs and limits

- Model: `claude-sonnet-5`, at the list prices in [`meter.mjs`](meter.mjs).
- Pilot: one repetition per arm, `--budget-usd 10 --reserve-usd 1`. It measures what a repetition costs and decides nothing.
- Full run: three repetitions per arm, `--budget-usd 30 --reserve-usd 1`. Only the full run decides the hypotheses.
- The harness starts no request that would pass the budget; it does not cap the provider's bill, and a subscription plan is not billed per token, so the estimate measures usage.
- A run that stops at its budget is reported as stopped, with what ran; its hypotheses are undecided unless every arm finished every repetition.
- Each paid run starts only on the owner's word, on the owner's own Claude Code sign-in.

## Publication

The report and its `rows.jsonl` are committed under [`results/`](results/) with the exact command, whether or not they favor Orchvia. The README's claims about speed and cost link to them, and say nothing the report does not show.
