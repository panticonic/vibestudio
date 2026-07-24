# Scenario authoring

## Test a user goal

Write prompts at the user's level: state the desired outcome, constraints that
would be known to the user, and concise final evidence fields. Do not prescribe
the exact method sequence, response schema, error branch, or workaround. The
agent must discover the relevant skill and demonstrate that the documented
system is usable.

Good prompts expose documentation and ergonomics defects. Answer-bearing
prompts hide them.

## Validate effects and trajectory

Use a final marker only as bounded reporting evidence. Pair it with semantic
validation of the durable effect and invocation trajectory whenever the
capability mutates state.

A strong validator checks:

- no invocation remains incomplete;
- required durable effects exist at the identity returned by the operation;
- expected negative operations failed with the correct typed discriminant;
- no legacy or out-of-scope mutation path was used;
- cleanup retired an unpublished task context or counteracted the task's exact
  published work without disturbing sibling work;
- final prose accurately reports the observed state.

Do not make validators lenient merely because an agent found a workaround. If
the workaround violates the intended abstraction, classify and repair the
platform or docs.

## Isolate tests

Ordinary tests use fresh headless contexts. Tests that create or publish
workspace source must select a typed repository fixture:

- `CONTENT_WORKSPACE_REPO_FIXTURE` owns an empty `projects/...` content repo.
- `BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE` owns a `packages/...` repo seeded
  with the canonical minimal manifest and source entry.

The harness imports that repository as one exact snapshot into a fresh task
context. Setup does not publish it. A fixture that never reached main disappears
with its context. If task events reached main, teardown finds the newest one by
intersecting the exact first-parent task line with paged current-main history.
It counteracts only that published work, newest first, in a fresh context, then
commits and pushes once. Extra task-authored repository identities are removed
by the same causal walk and reported as scope failures; newer unpublished work
is left to task-context destruction. Refer to the harness-provided fixture; do
not put cleanup commands, fixed shared names, or seed instructions in prompts.
The fixture also supplies both protected-effect rules: main publication and
repository deletion, exact for a seeded repo or section-prefixed for an owned
task-created/derived repo. Teardown must use those rules through ordinary VCS;
never add a cleanup-only transport or ignore an approval failure.

Multi-actor behavior belongs in `TestCase.orchestrate`. The first/base-author
role runs in the fixture task context and publishes the shared base through the
ordinary product workflow; later roles get independent contexts rooted at the
then-current main. Give each session a normal user goal. The orchestrator may
sequence phases, but agents must not spoof another context or write private
state directly.

## Semantic VCS scenarios

VCS scenarios are protocol tests, not API-recitation tests. Before authoring
them, read `../../vibestudio-vcs/SKILL.md` and the relevant references.

Cover these distinct invariants:

- every mutation names the exact observed working state;
- commit consumes the complete local application chain;
- incoming changes are incorporated through small local decisions until the
  source event is accounted for, then committed with that source parent;
- push publishes one exact clean event against one observed main event;
- move preserves file identity while copy mints identity and records ancestry;
- revert creates counteracting changes instead of erasing history;
- provenance walks directly among content, changes, work, commands, events,
  and the exact trajectory invocation that caused a command;
- blame follows immediate coordinate mappings rather than a flattened author
  field;
- `RevisionChanged` causes re-observation and a new command ID, while an
  uncertain identical request is retried with the same command ID.

Keep status, whole-chain commit, push, incremental integration, move/copy,
causality/blame, revert, freshness, and idempotency separately diagnosable.
Do not rebuild a parallel release-scenario registry beside the live `TestCase`
catalog.

## Expected failures

Negative tests should identify the expected typed refusal and verify that no
state changed. Mark deliberately induced failures as expected in diagnostics so
they remain evidence without becoming product-defect counts.

Never branch a validator on human-readable error prose when a discriminant or
terminal outcome exists.

New tool-failure scenarios must also verify the durable
`agent-tool-failure.v1` object on the terminal invocation: stable code/kind,
operation and stage, causal IDs when available, retry policy, and primary versus
cleanup ordering. When the scenario creates a scaffold or fork, require
`preflight.ok === true` before accepting publication evidence. A recovery
scenario must call `recoverProjectPublication` from the recorded failure and
prove no second repository edit or commit occurred.
