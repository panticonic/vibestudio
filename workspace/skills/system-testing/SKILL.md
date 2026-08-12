---
name: system-testing
description: Run, author, diagnose, or repair Vibestudio headless agentic system tests and their deterministic validators, retained trajectories, runtime evidence, and managed test instances.
---

# Vibestudio system testing

System tests drive real headless agents and retain conversations, tool
invocations, runtime events, cleanup, provenance, and diagnostics. A failing
command starts an investigation; it is not the reporting boundary.

## Read by task

| Task | Reference |
| --- | --- |
| Diagnose a run or artifact | [diagnostics and artifacts](references/diagnostics-and-artifacts.md) |
| Author or revise a scenario | [scenario authoring](references/scenario-authoring.md) |
| Select coverage | [scenario catalog](references/scenario-catalog.md) |
| Repair a discovered defect | [self-improvement](SELF_IMPROVEMENT.md) |
| Exercise managed source | [Vibestudio VCS](../vibestudio-vcs/SKILL.md) |

Implementation entry points are `runner.ts`, `test-runner.ts`, `types.ts`,
`stages.ts`, `diagnostics.ts`, and `tests/`. Import suite collections from the
stages entry point, not individual test files.

## CLI repair loop

Use one stable, unique instance ID throughout an investigation.

1. Provision and check infrastructure:

   ```bash
   pnpm system-test --instance <id> doctor
   ```

   Doctor owns creation, readiness, and pairing of an isolated ephemeral
   instance. A missing or unpaired server is not a blocker. Inspect the printed
   supervisor log and repair failed infrastructure before interpreting scenario
   behavior. Never borrow or stop an unrelated instance.

2. List tests only when the exact name is unknown:

   ```bash
   pnpm system-test --instance <id> list --json
   ```

3. Run the smallest exact test:

   ```bash
   pnpm system-test --instance <id> run <test-name>
   ```

   Use `--detach` plus the documented status command for a long run. Treat
   cancellation and timeouts as terminal records whose cleanup evidence must be
   inspected; do not add sleeps or extend a deadline to conceal liveness bugs.
   Pass an explicit model only when the model itself is the experiment. The
   default route and quota fallback live in `config.ts`.

4. On any non-zero exit, inspect the retained run immediately:

   ```bash
   pnpm system-test --instance <id> inspect <run-id> --json
   ```

   If that bounded packet is insufficient:

   ```bash
   pnpm system-test --instance <id> trajectory <run-id> <test-name> --full --json
   ```

5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Repair the owning layer. Do not over-specify the test prompt to
   route around a platform or documentation defect.

6. Run focused conventional checks. Host-code-only changes can use the owned
   source server. Changes under `workspace/` require a freshly provisioned
   workspace copy: stop the managed instance, then rerun doctor.

7. Rerun only affected coverage. Use a prior run's rerun command when several
   failures remain relevant to the same fix. Expand to a category or smoke set
   only when the changed behavior or captured evidence justifies it.

8. Stop the exact managed instance:

   ```bash
   pnpm system-test --instance <id> stop
   ```

Do not report completion while an owned instance, panel, page, or inspector is
still live. Stop only for missing credentials, required new authority,
unavailable external infrastructure, or an unauthorized server restart—not at
an artifact path or validator message.

## Orchestrator and test subject

Use `HeadlessRunner` or `TestRunner` only to orchestrate tests. If the prompt
asks the current agent to exercise one capability and return evidence, it is the
test subject: use that capability's normal skill and API. Do not recursively
spawn a system-test agent.

Each ordinary test gets an isolated context. Multi-actor behavior belongs in a
declared orchestration with independent sessions. Source-changing cases must
declare the repository fixture type required by the scenario; fixture setup and
cleanup use public semantic VCS and remain outside the user-like prompt. Read
the authoring reference for exact fixture and authority contracts.

## Agentic and deterministic layers

System testing is the agentic layer: a model selects skills and tools and is
judged by semantic validators. `@workspace/testkit` is the deterministic layer
for exact assertions, panel automation, viewport checks, and runtime
supervision.

Use deterministic coverage directly when model judgment is unnecessary. Use
both layers when an agent must discover and perform a workflow whose effects
can be asserted exactly.

A completed turn is not a mechanical quality verdict. Inspect the trajectory
for confusion, unnecessary source search, repeated failures, and poor recovery
even when final validators pass. Preserve recovered tool failures as product or
documentation evidence.

Prompts describe realistic user goals and observable outcomes. They do not name
internal tools, API expressions, configuration objects, validator markers, or a
required call sequence. Put exact wire checks in deterministic probes.

## Programmatic orchestration

Use `HeadlessRunner` from `runner.ts`, `TestRunner` from `test-runner.ts`, and
suite exports from `stages.ts`. Keep full results in eval scope and return only
bounded summaries. Read those public types for callbacks, concurrency,
cancellation, and retained results instead of copying their API here.

Headless runs have no panel-only tools. Their identity, model route, approval
mode, fallback, and test authority come from the sealed runner policy; userland
subjects must not inject or widen it. Credential setup waits are infrastructure
failures in unattended tests and must be repaired through the canonical
connection flow.

Use separate instances for parallel workspace experiments and separate agent
sessions when eval work itself must proceed concurrently. Do not interpret a
closed orchestration socket, mailbox delay, or still-running eval as a slow
model without checking the retained lifecycle and transport evidence.

## Authoring and validation rules

- Follow typed lifecycle phases and structured errors; never parse explanatory
  prose for control flow.
- Keep primary operation failure separate from cleanup, rollback, and transport
  evidence.
- Test panel slot commitment separately from boot readiness and rendered
  correctness. Use exact lifecycle waits, not sleeps.
- Let repository fixtures claim their declared scheduler resources; do not add
  undeclared parallel publication against protected main.
- Preserve ordinary authority and cancellation through publication and cleanup.
  A test policy authorizes only its declared case resources.
- Keep fixture mechanics, cleanup coordinates, and validator knowledge out of
  the subject prompt.
- For semantic VCS cases, validate the public workflow and recorded identities,
  decisions, moves/copies, counteractions, provenance, and typed recovery—not an
  implementation-specific sequence.
- Workers and DOs normally follow the test context; panels need an explicit
  context ref when unpublished code is under test.

## Artifact security

Run artifacts default to the profile's `vibestudio/system-test-runs/<run-id>`
directory with restrictive permissions unless an output directory is supplied.
Full trajectories can contain sensitive data. Do not publish them, paste them
wholesale, or weaken permissions; extract only the bounded evidence needed to
explain the mismatch.

The orchestrator can run from eval, workers, Durable Objects, or panels. Use the
authorized runtime participant identity; never invent a synthetic participant.
For trusted app failures, read [app development](../appdev/SKILL.md). For host
source repair, use [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md).
