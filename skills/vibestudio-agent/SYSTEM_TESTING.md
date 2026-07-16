# Headless agentic system testing

The `system-test` command group runs the workspace's canonical
`@workspace-skills/system-testing` catalog through isolated headless agent
sessions. It is CLI-native: it does not require a chat panel, feedback form,
`chat` binding, or `agent.describe()` binding.

## Preflight and discovery

```bash
vibestudio system-test doctor
vibestudio system-test list
vibestudio system-test list --category smoke --json
```

`doctor` verifies that the test catalog builds, the agent worker is healthy,
and both models in the canonical test policy are usable. The server automatically keeps a
headless renderer available for panel/CDP work; an individual CDP test remains
the authoritative end-to-end check of that path.

## Running tests

Names are exact, not substring filters:

```bash
vibestudio system-test run eval-return-value
vibestudio system-test run eval-return-value fs-write-read
vibestudio system-test run --category smoke
vibestudio system-test run --all --concurrency 4
```

Useful flags:

- `--model REF` explicitly overrides the canonical policy for a model-specific
  investigation. Ordinarily, tests start on
  `openai-codex:gpt-5.3-codex-spark`; only a concrete terminal usage-limit
  result activates `openai-codex:gpt-5.6-luna` at minimal reasoning effort.
- If `doctor` reports that the selected `openai-codex` subscription credential
  is expired and cannot refresh, do not bypass the failure with a different
  prompt or hidden token. Ask the operator to run
  `vibestudio model connect openai-codex` from the paired CLI and finish the
  canonical browser sign-in. Then rerun `doctor`; the command replaces the
  credential through the ordinary credential coordinator and never prints
  OAuth URLs or token material.
- Each test has one five-minute agent-turn budget by default. Multi-phase tests
  share it rather than restarting the clock for each phase. `--test-timeout-ms N`
  replaces that budget for a deliberately longer or shorter investigation.
  It is not a liveness fix; inspect the terminal errored result and repair the
  underlying system whenever it fires.
- Cancellation becomes terminal only after the active test interrupts its agent
  turn, retires the headless session/context, and cleans any exact repository
  fixture. Inspect cleanup failures on cancelled records; partial work is never
  hidden by the cancellation status.
- `--detach` starts the durable EvalDO job and immediately returns its run ID.
- `--out-dir DIR` writes result artifacts below `DIR/<run-id>/`. The default is
  the CLI config root with mode `0600` files.

A completed command exits `1` when any validation failed, a session errored, or
an unexpected tool failure was observed. It still prints the run ID and saves
the summary.

## Durable runs and inspection

```bash
vibestudio system-test runs
vibestudio system-test status st_...
vibestudio system-test status st_... --wait
vibestudio system-test wait st_...
vibestudio system-test inspect st_...
vibestudio system-test inspect st_... --test eval-return-value
vibestudio system-test trajectory st_... eval-return-value
vibestudio system-test trajectory st_... eval-return-value --full
vibestudio system-test cancel st_...
```

`inspect` returns a bounded diagnostic packet: prompt, validation reason,
session error, final response, conversation tail, invocation statuses/errors,
debug events, cleanup errors, workspace repo fixture setup/teardown, participants,
provenance, and likely issue.
`trajectory --full` returns the full retained test entry and should be used only
when the bounded packet does not explain the mismatch.

Detached status includes durable queued/running/completed per-test progress.
`status --wait` keeps polling until the run is terminal; `system-test wait` is
its ergonomic alias. `--poll-ms` controls the interval for either spelling.

Each result records the channel ID, branch ID, agent entity/target, isolated
context ID, model selection, and system-testing build provenance. The CLI keeps
local routing metadata so status and inspection can address the same EvalDO
scope across separate invocations.

## Repair loop

On failure, do not stop at reporting it:

1. Inspect the bounded packet.
2. Inspect the full trajectory only if needed.
3. Fix infrastructure before docs; fix docs before weakening prompts or
   validators.
4. Run focused conventional tests and type checks.
5. Restart the server when host source changed.
6. Rerun failures:

```bash
vibestudio system-test rerun st_...
```

Rerun includes both failed tests and passing tests that encountered unexpected
tool failures. Once targeted reruns pass, run the affected category and smoke
suite to catch regressions.

Tests that create or publish workspace source declare a typed harness-owned
fixture. Setup imports one stable repository identity into a fresh task context
and does not publish it. Unpublished work disappears when that context is
destroyed. If task events reached main, cleanup intersects the task's exact
first-parent event line with paged current-main history, counteracts only that
published work in reverse causal order from a fresh main context, then commits
and pushes once. Any extra task-authored repository identity is removed by the
same causal walk and reported as a scope failure. Cleanup failures remain
visible in `inspect` diagnostics.
