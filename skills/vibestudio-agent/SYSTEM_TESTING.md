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
vibestudio system-test run --all --concurrency 2
```

Useful flags:

- `--model REF` explicitly overrides the canonical policy for a model-specific
  investigation. Ordinarily, tests start on
  `openai-codex:gpt-5.3-codex-spark`; only a concrete terminal usage-limit
  result activates `openai-codex:gpt-5.6-luna` at minimal reasoning effort.
- Tests have no harness deadline by default. `--test-timeout-ms N` is an
  operator-requested cancellation boundary, not a liveness fix; inspect the
  trajectory and repair the underlying system whenever it fires.
- `--approval-policy fail-fast|reachable|wait` controls only how this headless
  harness reacts after the agent reports that it is waiting for approval.
  `fail-fast` is the unattended default. `reachable` waits only while at least
  one approval-capable client is live. `wait` always leaves the suspended call
  to the host approval queue. The queue—not this harness—owns the bounded
  decision deadline (30 minutes by default).
- `--detach` starts the durable EvalDO job and immediately returns its run ID.
- `--out-dir DIR` writes result artifacts below `DIR/<run-id>/`. The default is
  the CLI config root with mode `0600` files.

A completed command exits `1` when any validation failed, a session errored, or
an unexpected tool failure was observed. It still prints the run ID and saves
the summary.

## CLI approval side-channel

Use a second terminal when a detached test or eval needs a human decision:

```bash
vibestudio approval list --json
vibestudio approval watch
vibestudio approval resolve <approval-id> session
```

`approval list` reports exact requester identity, operation, resource, allowed
decisions, and `decisionDeadlineAt`. `approval watch` continuously heartbeats a
live approval-capable CLI surface and prints queue changes; resolve or submit a
decision from another terminal. Structured setup/secret prompts use
`vibestudio approval submit <approval-id> '{"field":"value"}'`.

Ordinary prompt-enabled evals wait for the queue's bounded decision. Unattended
system tests default to `fail-fast`, producing the concrete approval ID and the
commands above instead of looking like a stalled model call. Select `wait` or
`reachable` explicitly when the side-channel is part of the test.

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

Tests that create or fork published workspace repos declare a harness-owned
fixture. The harness gives the agent a unique `system-test-*` project name
without narrowing the user-like test prompt, removes stale repos in that
namespace before execution, and removes created repos afterward. A cleanup
failure or a repo escaping the reserved namespace makes the run non-clean and
is included in `inspect` diagnostics.
