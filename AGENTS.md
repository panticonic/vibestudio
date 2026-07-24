# Vibestudio repository agent guide

## General instructions

My requests are APPROXIMATE. I am not the one coding; you are. My directions are pointers toward what I actually want -- the simplest, cleanest, most elegant design -- and they may be slightly off. That goal ALWAYS outranks my literal words.

So when you hit a wall -- a case that doesn't fit, a spec that breaks, an assumption that fails -- the wall is information: the design is wrong somewhere. STOP. Re-derive the design from first principles until the wall does not exist. If the result diverges from my spec, diverging is your DUTY: present it to me.

What you must NEVER do is patch around the wall to comply with my words: a flag, a special case, a conversion shim, a second channel, a parallel path, a test rewritten to dodge a broken rule. The patch IS the failure. Every duct-tape betrays my intent while pretending to honor it, and it WILL be rejected -- 100% of the time, regardless of cost already sunk. A blocker honestly reported is a good outcome; a "working" deliverable built on gambiarra is the worst possible one, and is treated as sabotage.

## Headless system tests

When a task asks to verify, diagnose, or repair Vibestudio through the headless
agentic system tests, use the running server through the CLI:

1. Run `pnpm cli [--instance ID] system-test doctor` and fix failed
   infrastructure checks first. Use the instance id printed by the source
   server whenever multiple developer hubs are running.
2. Use `pnpm cli [--instance ID] system-test list --json` to discover exact test names.
3. Run the smallest relevant exact test with
   `pnpm cli [--instance ID] system-test run TEST_NAME`.
4. A non-zero test exit is an investigation trigger, not a reporting boundary.
   Immediately run `pnpm cli [--instance ID] system-test inspect RUN_ID --json`,
   then `pnpm cli [--instance ID] system-test trajectory RUN_ID TEST_NAME
   --full --json` when the bounded packet is insufficient.
5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Default to repairing infrastructure; do not route around platform
   bugs by over-specifying prompts.
6. Implement the fix and run focused conventional tests/type checks. Restarting
   the current source server is sufficient for host-code-only changes. Changes
   under `workspace/` are workspace source: a named `--bootstrap-workspace`
   preserves its semantic state across restarts and does not reread the checkout
   template. Stop that exact instance and start
   `pnpm server:live --ephemeral --instance ID` to test a fresh checkout copied
   from the current template, then address it with `pnpm cli --instance ID ...`.
   Never stop or reuse another live instance merely because it came from the
   same checkout.
7. After it passes, run its category and then smoke coverage. Use
   `pnpm cli [--instance ID] system-test rerun RUN_ID` to rerun every failure
   or unexpected tool failure from a prior run.

`pnpm dev` and `pnpm server:live` run under the same developer-instance
supervisor. Every instance has its own lease, identity, databases, workspace
state, ports, ready file, CLI credential, and CLI sessions. Provider/model
configuration and encrypted provider credentials remain profile-scoped and are
shared safely. `pnpm server:live` uses the persistent `source` instance;
`--instance NAME` selects another persistent instance; `--ephemeral` creates a
temporary instance (an explicit name makes parallel logs and CLI commands
stable). The supervisor prints the exact `pnpm cli --instance NAME` prefix.

Do not stop after merely listing artifact paths or restating validation errors.
Inspect the captured conversation, invocations, lifecycle/debug events, cleanup
errors, provenance, and runtime diagnostics and explain the concrete mismatch.
Stop only when repair requires missing credentials, new authority, unavailable
external infrastructure, or a server restart the user has not authorized.

System-test artifacts are stored with restrictive permissions under
`${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/` unless
`--out-dir` is supplied. Full trajectories may contain sensitive data; do not
publish them or weaken their file permissions.
