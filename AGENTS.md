# Vibestudio repository agent guide

## General instructions

My requests are APPROXIMATE. I am not the one coding; you are. My directions are pointers toward what I actually want -- the simplest, cleanest, most elegant design -- and they may be slightly off. That goal ALWAYS outranks my literal words.

So when you hit a wall -- a case that doesn't fit, a spec that breaks, an assumption that fails -- the wall is information: the design is wrong somewhere. STOP. Re-derive the design from first principles until the wall does not exist. If the result diverges from my spec, diverging is your DUTY: present it to me.

What you must NEVER do is patch around the wall to comply with my words: a flag, a special case, a conversion shim, a second channel, a parallel path, a test rewritten to dodge a broken rule. The patch IS the failure. Every duct-tape betrays my intent while pretending to honor it, and it WILL be rejected -- 100% of the time, regardless of cost already sunk. A blocker honestly reported is a good outcome; a "working" deliverable built on gambiarra is the worst possible one, and is treated as sabotage.

## Headless system tests

When a task asks to verify, diagnose, or repair Vibestudio through the headless
agentic system tests, use the running server through the CLI:

1. Run `pnpm cli system-test doctor` and fix failed infrastructure checks first.
2. Use `pnpm cli system-test list --json` to discover exact test names.
3. Run the smallest relevant exact test with `pnpm cli system-test run TEST_NAME`.
4. A non-zero test exit is an investigation trigger, not a reporting boundary.
   Immediately run `pnpm cli system-test inspect RUN_ID --json`, then
   `pnpm cli system-test trajectory RUN_ID TEST_NAME --full --json` when the
   bounded packet is insufficient.
5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Default to repairing infrastructure; do not route around platform
   bugs by over-specifying prompts.
6. Implement the fix and run focused conventional tests/type checks. Restarting
   the current source server is sufficient for host-code-only changes. Changes
   under `workspace/` are workspace source: a named `--bootstrap-workspace`
   preserves its semantic state across restarts and does not reread the checkout
   template. Stop it and start `pnpm server:live --ephemeral` to test a fresh
   checkout copied from the current template, then rerun the exact agentic test.
7. After it passes, run its category and then smoke coverage. Use
   `pnpm cli system-test rerun RUN_ID` to rerun every failure or unexpected tool
   failure from a prior run.

Do not stop after merely listing artifact paths or restating validation errors.
Inspect the captured conversation, invocations, lifecycle/debug events, cleanup
errors, provenance, and runtime diagnostics and explain the concrete mismatch.
Stop only when repair requires missing credentials, new authority, unavailable
external infrastructure, or a server restart the user has not authorized.

System-test artifacts are stored with restrictive permissions under
`${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/` unless
`--out-dir` is supplied. Full trajectories may contain sensitive data; do not
publish them or weaken their file permissions.
