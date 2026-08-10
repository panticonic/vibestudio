# Vibestudio repository agent guide

## General instructions

My requests are APPROXIMATE. I am not the one coding; you are. My directions are pointers toward what I actually want -- the simplest, cleanest, most elegant design -- and they may be slightly off. That goal ALWAYS outranks my literal words.

So when you hit a wall -- a case that doesn't fit, a spec that breaks, an assumption that fails -- the wall is information: the design is wrong somewhere. STOP. Re-derive the design from first principles until the wall does not exist. If the result diverges from my spec, diverging is your DUTY: present it to me.

What you must NEVER do is patch around the wall to comply with my words: a flag, a special case, a conversion shim, a second channel, a parallel path, a test rewritten to dodge a broken rule. The patch IS the failure. Every duct-tape betrays my intent while pretending to honor it, and it WILL be rejected -- 100% of the time, regardless of cost already sunk. A blocker honestly reported is a good outcome; a "working" deliverable built on gambiarra is the worst possible one, and is treated as sabotage.

## Performance investigations

For Vibestudio panel, app, worker, build, startup, and agent-workflow performance,
use the repository's native profiling system documented in
`workspace/skills/performance/SKILL.md`. It measures the real panel lifecycle,
runtime builds, Electron/CDP pages, services, and managed system-test instances.
Do not use the generic `web-perf` skill for these tasks: its conventional website
and Chrome DevTools MCP workflow does not model Vibestudio's materialization and
hosting pipeline.

The absence of a running or paired developer instance is never a performance
investigation blocker. Provision one isolated, uniquely named instance from the
current checkout. Prefer `pnpm system-test --instance ID doctor` when an
unattended paired instance is useful; it owns, provisions, waits for, and pairs
that instance. For a direct server session, run
`pnpm server:live --instance ID --ephemeral` as an owned long-running process,
wait for its ready record, and address it only through
`pnpm cli --instance ID ...`. Never reuse, restart, or stop somebody else's
instance merely because it is available.

Instance cleanup is part of the profiling operation, not optional housekeeping.
Use a `finally`-equivalent cleanup path: stop a managed instance with
`pnpm system-test --instance ID stop`; terminate and await an owned ephemeral
server process so its supervisor unregisters the instance and removes its
temporary state. Do not report profiling complete while an owned instance or
inspector/page connection remains live. Instance startup is a blocker only when
isolated bootstrap itself fails after its supervisor log has been inspected and
the infrastructure defect cannot be repaired within the task.

## Headless system tests

When a task asks to verify, diagnose, or repair Vibestudio through the headless
agentic system tests, use the self-provisioning system-test entry point. An
unavailable, stale, or unpaired developer instance is not a blocker: the
command creates a separate named ephemeral instance from the current checkout,
waits for readiness, pairs its instance-scoped CLI, and then runs the requested
operation. In parallel work, pass one stable unique `--instance ID` on every
command.

1. Run `pnpm system-test [--instance ID] doctor` before the first test on a
   managed instance, or when infrastructure may have changed, and fix failed
   infrastructure checks first. Reuse a recent successful doctor result for an
   unchanged instance. Do not run doctor against an unrelated existing source
   server merely because it is already live.
2. Use `pnpm system-test [--instance ID] list --json` only when the exact test
   name is not already known.
3. Run the smallest relevant exact test with
   `pnpm system-test [--instance ID] run TEST_NAME`.
4. A non-zero test exit is an investigation trigger, not a reporting boundary.
   Immediately run `pnpm system-test [--instance ID] inspect RUN_ID --json`,
   then `pnpm system-test [--instance ID] trajectory RUN_ID TEST_NAME
--full --json` when the bounded packet is insufficient.
5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Default to repairing infrastructure; do not route around platform
   bugs by over-specifying prompts.
6. Implement the fix and run focused conventional tests/type checks. Restarting
   the current source server is sufficient for host-code-only changes. Changes
   under `workspace/` are workspace source: a named `--bootstrap-workspace`
   preserves its semantic state across restarts and does not reread the checkout
   template. Stop the managed test instance with
   `pnpm system-test [--instance ID] stop`, then rerun doctor to provision a
   fresh checkout copied from the current template. Never stop or reuse another
   live instance merely because it came from the same checkout.
7. Verification is evidence-directed. Do not automatically run category or
   smoke coverage after an exact test passes, and do not rerun tests that
   already passed unless the subsequent change could affect them or there is
   concrete evidence of nondeterminism. Expand to the smallest relevant set
   justified by the changed behavior and its plausible blast radius. Use
   `pnpm system-test [--instance ID] rerun RUN_ID` only when multiple failures
   from that run remain relevant to the same fix.
8. When verification is complete, stop the exact managed instance with
   `pnpm system-test [--instance ID] stop`.

The default agentic test route starts with
`openai-codex:gpt-5.3-codex-spark` and automatically falls back to
`openai-codex:gpt-5.6-luna` at low thinking effort only when Spark reports
`usage_limit_terminal`. Do not stop or manually rerun solely because Spark's
quota is exhausted; inspect the completed run to confirm whether the configured
fallback also failed. Passing `--model` intentionally disables this fallback
for a single-model diagnostic run.

Incorrect: stop after doctor says “not paired.” Correct: invoke
`pnpm system-test [--instance ID] doctor`; it provisions and pairs an isolated
ephemeral instance automatically. Report a setup blocker only when that
automatic bootstrap itself fails and its printed supervisor log has been
inspected.

`pnpm dev` and `pnpm server:live` run under the same developer-instance
supervisor. Every instance has its own lease, identity, databases, workspace
state, ports, ready file, CLI credential, and CLI sessions. Provider/model
configuration and encrypted provider credentials remain profile-scoped and are
shared safely. `pnpm server:live` uses the persistent `source` instance;
`--instance NAME` selects another persistent instance; `--ephemeral` creates a
temporary instance (an explicit name makes parallel logs and CLI commands
stable). `pnpm system-test` owns only instances it created and refuses to stop
an unrelated instance.

Do not stop after merely listing artifact paths or restating validation errors.
Inspect the smallest set of captured evidence needed to explain the concrete
mismatch; use deeper trajectories and additional diagnostics only when the
bounded failure packet is insufficient. Stop only when repair requires missing
credentials, new authority, unavailable external infrastructure, or a server
restart the user has not authorized.

System-test artifacts are stored with restrictive permissions under
`${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/` unless
`--out-dir` is supplied. Full trajectories may contain sensitive data; do not
publish them or weaken their file permissions.
