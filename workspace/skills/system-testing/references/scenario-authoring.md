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

The runner gives validators a canonical, fully materialized evidence view:
content-addressed invocation requests/results are hydrated at validation time.
Validators therefore inspect the typed result directly and never branch on a
`vibestudio.blob-ref.v1` carrier. The durable run record remains bounded and
keeps those payloads by reference; missing referenced evidence is a harness
error, not a semantic validation failure.

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

## Exercise approvals without bypassing them

`TestCase.authorityPolicy` is a host-attested fixture for the ordinary
production authority path. List each gated/critical capability and each
userland subject the scenario expects. Capability names use an explicit
`{ kind: "exact", key }` scope by default. Use
`{ kind: "prefix", prefix }` only when the capability suffix itself is
production-authored at runtime; pair it with a resource scope that independently
confines the exact fixture source/class or other stable production boundary.
Resource and userland rules use `ResourceScope`:
prefer `{ kind: "exact", key }`; use `{ kind: "prefix", prefix }` only when the
production subject is intentionally dynamic, such as the digest-bearing
`user.exec.*` namespace or an agent-chosen Durable Object key beneath one exact
randomized fixture source and class. Keep the prefix at the narrowest stable
semantic boundary; dynamic identity below that boundary is production
behavior, not a reason to guess a preferred key in the prompt.

The receiver still constructs the real approval request and resolves it
through the normal approval service. The policy supplies the unattended user's
answer; it is not an alternate API or a blanket auto-approve switch. An
unmatched request must remain `EUNEXPECTEDTESTPROMPT`. Never compute a
test-only subject, patch the extension to skip approval, or weaken the
production gate for harness convenience.

The runner, not individual scenarios, owns the execution policy: the chosen
model, `approvalLevel: 2`, and disabled fallback are mandatory case facts.
They follow the host-attested context through trusted infrastructure and apply
to every downstream agent created there. `TestCase.authorityPolicy` only
describes expected capability/userland decisions and cannot override the
execution model.

The canonical workspace test runner uses the digest-bearing
`workspace-test:<digest>` subject. A scenario that intentionally runs focused
workspace verification must declare both the gated `user-approval.request`
authority capability and a `{ kind: "prefix", prefix: "workspace-test:" }`
userland rule. Do not broaden that rule to other workspace operations or
replace it with blanket auto-approval.

Validators for corrective workflows must fold the latest successful state by
stable identity. An earlier `needs-decision`, failed build report, or guarded
close remains useful trajectory evidence, but it must not override a later
resolved integration, passing verification, or successful close. Conversely,
do not accept “structured output” alone: inspect its semantic success fields
and the final causal effect. Do not require one ceremonial property name such
as `ok`: a focused verifier may return positive coverage counts together with
domain checks such as `allParsed: true`. Accept equivalent structured proof
only when it contains positive coverage and affirmative checks, and reject any
failed status, non-zero diagnostics, or false verification check. This keeps
validators semantic without teaching prompts a harness-specific response
shape.

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
