# Reference host

A host that embeds Orchvia must remember what it submitted, show the engine's events without counting any twice, and recover after a crash without creating, running or billing anything twice. This directory is one such host, in TypeScript and in Python, for one workflow ([SPEC-0050](../../docs/specs/0050-reference-host.md)):

1. **change**: a task changes the code; a registered test rule accepts it, with one repair.
2. **review**: a second task reviews the change, starts only after the change completed, receives its result, and waits for a person to approve, deny or revise.

Both hosts use the fake runtime, so no model is called. This README is the only source for running them and for their recovery steps.

| File          | Holds                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `journal.sql` | The journal's schema, loaded by both hosts: runs, steps, decisions, owner commands, the event checkpoint and the projection |
| `recipe.ts`   | The two requests, their idempotency keys, and the run states with the next step of each                                     |
| `journal.ts`  | The TypeScript journal                                                                                                      |
| `host.ts`     | The TypeScript host, with its engine embedded                                                                               |
| `host.py`     | The Python host, with its engine started through `orchvia host --stdio`                                                     |
| `inspect.ts`  | The read-only inspector for runs of either host                                                                             |

## Run it

About two minutes, offline, on a checkout with `npm ci --ignore-scripts` done. Nothing outside the directory you choose is written.

1. Make a directory for the run, with a workspace whose tests pass:

   ```sh
   export REFHOST="$(mktemp -d)" && mkdir "$REFHOST/workspace" && touch "$REFHOST/workspace/tests-pass"
   ```

   - Success: `ls "$REFHOST/workspace"` prints `tests-pass`.
   - The file stands for a passing test suite: without it the test rule fails.

2. Start a run with the TypeScript host:

   ```sh
   node examples/reference-host/host.ts start --root "$REFHOST" --run r1 --goal "Add restock()"
   ```

   - Success: the last line is JSON with `"state":"awaiting_review"`.
   - Failure: any other state; step 3 says why.

3. See why the run stopped and who acts next:

   ```sh
   node examples/reference-host/inspect.ts --root "$REFHOST"
   ```

   - Success: `state awaiting_review` and `next the reviewer: approve, deny or revise`.

4. Decide as the reviewer:

   ```sh
   node examples/reference-host/host.ts decide --root "$REFHOST" --run r1 --choice approve
   ```

   - Success: `"state":"done"`.
   - `--choice revise --comment "..."` sends the review back with the comment and ends in `awaiting_review` again; `--choice deny` ends in `rejected`.

The Python host takes the same commands and arguments, on its own directory (step 1 again):

```sh
PYTHONPATH=python/src python3 examples/reference-host/host.py start --root "$REFHOST" --run r1 --goal "Add restock()"
```

The inspector reads a directory written by either host.

## What each state asks for

| State             | Next step                                                                        |
| ----------------- | -------------------------------------------------------------------------------- |
| `awaiting_review` | The reviewer runs `decide` with `approve`, `deny` or `revise`.                   |
| `tests_failed`    | A person runs `abandon`, which cancels both tasks, or starts a new run.          |
| `needs_reconcile` | The owner checks what ran, then runs `reconcile` (below). Never resend the task. |
| `ended`           | The run ended without a result; start a new one.                                 |
| `attention`       | A person reads the attention reason the inspector shows, and acts on it.         |
| `running`         | Nothing: the engine is working. Run `advance` to continue after a stop.          |

`tests_failed` leaves the change blocked and the review waiting for it: the engine keeps a dependent task waiting until its dependency completes or ends, so the host must decide (SPEC-0015).

`needs_reconcile` follows a crash during a dispatch. The engine never replays a dispatch whose outcome is unknown; the owner states what happened:

```sh
node examples/reference-host/host.ts reconcile --root "$REFHOST" --run r1 --outcome interrupted --summary "The runtime process is gone; the workspace is unchanged"
```

- Success: `"state":"ended"`: the change failed as interrupted and the review is blocked by it. Start a new run for the same goal.

## How it recovers

- **Intent before send.** Each request is written to the journal, with its store and its key `refhost/<run>/<step>`, before it is sent. Every send of a step sends that same request under that key.
- **Recovery before new work.** On every start, a step with an intent and no receipt is looked up with `operations.lookup` in the store it was recorded in. Found: the receipt is recorded and nothing is sent. Not found: the create did not commit, so the same request goes again under the same key. `OPERATION_HISTORY_EXPIRED`, a changed store, an unknown operation or `IDEMPOTENCY_CONFLICT` put the step in `attention`, and it is never sent again.
- **Projection with its checkpoint.** Events and the checkpoint after them commit in one journal transaction, keyed by store and cursor, so a replay changes nothing. The TypeScript host commits a page of events at a time; the Python SDK reads events through an iterator, so the Python host commits one event at a time. `CURSOR_EXPIRED` puts the run in `attention`.
- **Unknown stays unknown.** A task whose dispatch outcome is unknown is never resent; only `reconcile` resolves it.
- **An embedded engine dies with its host.** A crash of the TypeScript host, or of the Python host's process group, during a dispatch leaves that dispatch unknown. The Python host also survives its engine child dying alone: it starts the engine again and recovers before going on.

`blockedBy` is computed only by a running engine. The host records it with the time it read it, and the inspector shows that reading, never a guess.

## The Python host and writable runtimes

The Python SDK starts its engine through the JSON CLI, which names its providers `fake`, `claude` and `codex` and allows `workspace-write` only for `fake`. So the Python host runs both steps on the one fake provider, while the TypeScript host runs the review on a second, read-only provider. A Python host cannot run the change step on a real model today; the [readiness ledger](../../docs/acceptance/readiness.md) records this.

## Tests

`tests/contract/reference-host-0050.test.ts` runs both hosts through the workflow and kills them at each point below with `--fault <point>`, then checks that each step has one task, no dispatch ran twice, each usage record is counted once, and unknown outcomes stay unknown. `python/tests/test_reference_host_0050.py` covers the Python host's recovery answers.

| Point                      | Where the host dies                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `after-intent`             | after the intent is on disk, before the create is sent                              |
| `after-send`               | after the engine created and started the change, before the receipt is on disk      |
| `before-projection-commit` | after reading the events that ask for the review's decision, before projecting them |
| `during-dispatch`          | while the change's dispatch runs                                                    |
| `after-decide-send`        | after the decision was sent, before its receipt is on disk                          |
| `engine-exit` (Python)     | the engine child dies during the change's dispatch; the host lives                  |
