# Benchmark: the same work, four ways

This benchmark measures what running agents through Orchvia costs and saves, compared with running Claude directly ([SPEC-0021](../docs/specs/0021-open-source-readiness.md) E03 to E06). Results are published whether or not they favor Orchvia.

## The work

A small JavaScript project ([fixture](fixture/)) gets four requests ([requests.json](requests.json)) on two independent tracks:

| Request | Track   | Asks for                                                     |
| ------- | ------- | ------------------------------------------------------------ |
| X1      | restock | `restock(inventory, name, quantity)` with tests              |
| Y1      | report  | `lowStock(inventory, threshold)`, sorted by name, with tests |
| X2      | restock | a `RangeError` for quantities that are not positive integers |
| Y2      | report  | sorting by stock, then by name                               |

Each request passes when its hidden check ([checks](checks/)) and the track's own tests pass. The checks never live inside the agent's workspace.

## The four arms

All arms use the same model (Claude Sonnet 5 by default), the same Claude Code build (the one bundled with `@anthropic-ai/claude-agent-sdk`), the same tools (Read, Glob, Grep, Edit, Write, Bash), no user or project settings, and the same operating-system sandbox as Orchvia's writable Claude profile.

- **single:** one Claude session does all four requests in order, resuming its history each time.
- **fresh:** each request starts a new Claude session, in order.
- **parallel:** the two tracks run at the same time directly on the Agent SDK, each follow-up resuming its track's session: the orchvia arm without the engine, so that a difference between the two is the engine's, not parallelism's or reuse's ([SPEC-0050](../docs/specs/0050-reference-host.md) B04).
- **orchvia:** the two tracks run at the same time, each on its own session; each follow-up reuses its track's warm session. The harness acts as the reviewer: it runs the checks and accepts the result.

## Running it

This section is the only source for running the benchmark. A real run calls a model and spends money on the Claude Code account signed in on the machine. Before each request starts, the harness reserves `--reserve-usd`, the most one request may cost, and starts it only while the estimate spent, the running requests' reservations and its own stay within `--budget-usd`; a paid run refuses to start without `--reserve-usd`. This limits what the harness starts, not the provider's bill: a request that costs more than its reservation still overruns.

1. Sign in to Claude Code on the machine (the account owner, about 2 minutes, needs the internet):

   ```sh
   claude auth login
   ```

   - Success: `claude auth status` prints `"loggedIn": true`.
   - Failure: a real run that stops with "OAuth session expired" means the sign-in is missing or expired; sign in again.

2. Check the harness with the real Claude Code binary and no model (about a minute, offline):

   ```sh
   node bench/run.mjs --gateway --out /tmp/orchvia-bench-gateway.json
   ```

   - Success: every arm prints `4/4 passed`.
   - Failure: do not start a paid run; the report's rows show which request failed and why.

3. Run the pilot, one repetition per arm, within $10:

   ```sh
   node bench/run.mjs --reps 1 --budget-usd 10 --reserve-usd 1 --out bench/results/$(date +%F)-pilot.json
   ```

   - Success: the last line prints `"stopped":false` and the spent estimate.
   - Failure: `"stopped":true` means the budget refused a request; its row says `not_run` with `reason: "budget"`, and the report keeps what ran.
   - Every finished request is also in `bench/results/<name>-pilot.json.rows.jsonl` the moment it finishes, so a run that stops half-way keeps its rows. A request that failed is a row with `status: "error"` and its message, and an unknown cost is `null`, never 0.

4. The full run repeats step 3 with `--reps 3`, a budget the owner sets from the pilot's cost, and a `-full.json` name. [PREREGISTRATION.md](PREREGISTRATION.md) fixes the first paid run's hypotheses, thresholds and limits; read it before either run.

`--fake` runs every arm offline with the reference solutions ([solutions](solutions/)) in place of the agent's edits, and `--fake-skip X2` leaves one request's solution out, which its checks must then fail. `npm test` runs both (`tests/contract/bench.test.ts`). `--gateway` answers every model request from a loopback gateway ([gateway.mjs](gateway.mjs)) that reads and writes the reference solutions through Claude Code's own tools; CI runs it on Linux and macOS with `--require-pass`, which exits with 1 unless every arm passes every request.

In the orchvia arm, the engine releases a writable dispatch only after the host proves that its execution stopped. Both tracks share the workspace, so the harness's proof ([stop.mjs](stop.mjs)) waits for the dispatch's own Claude process to exit and then requires every process still using the workspace to descend from the harness; a process that outlived its parent fails the proof.

## What is measured

For every request: wall time, and input, cache-read, cache-write and output tokens, in two parts that every arm counts the same way ([meter.mjs](meter.mjs), [SPEC-0047](../docs/specs/0047-bench-metering.md)):

- **main:** the request's main loop. The direct arms take it from the result's `usage`; the orchvia arm from the engine's main record of the task.
- **outside:** the calls Claude Code made outside the main loop, such as subagents and compactions, per model. The direct arms take them from the result's `modelUsage` minus the main loop; the orchvia arm from the engine's records of those calls. Claude Code 2.1.277 and later continue a resumed session's totals, so the single arm then subtracts its totals after the previous request, as the Claude adapter does.

Each part is priced at its model's [list price](https://platform.claude.com/docs/en/about-claude/pricing) (the table is in [meter.mjs](meter.mjs) and in every report), with cache writes at the 5-minute or the 1-hour rate where the counts separate them; a cache write that is not separated, as outside the main loop, takes the 5-minute rate, and the request is marked `cacheWriteAt5mRate`. A count that is unknown stays unknown: the request's `costUsd` is then null, `unpricedParts` counts the parts without a cost, and `knownCostUsd` holds the rest, which the budget counts. The two direct arms also record Claude Code's own cost figure, so a difference shows. A subscription plan is not billed per token; the estimate then measures usage, not a bill. Each report records the model, prices, machine and every request.

## Results

See [results](results/).
