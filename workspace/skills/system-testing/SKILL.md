---
name: system-testing
description: Orchestrate Vibestudio headless agentic system tests, inspect complete trajectories and runtime evidence, classify root causes, repair the platform or docs, and verify focused, category, and smoke coverage. Use when asked to run, author, diagnose, or repair system tests. Do not recursively invoke it from a spawned test subject that was asked to exercise one capability.
---

# Vibestudio system testing

System tests exercise Vibestudio through real headless agent sessions and retain
their conversations, tool invocations, lifecycle events, cleanup evidence,
provenance, and runtime diagnostics. A failing command starts an investigation;
it is not the reporting boundary.

## Read by task

| Task                            | Reference                                                            |
| ------------------------------- | -------------------------------------------------------------------- |
| Diagnose a run or artifact      | [diagnostics and artifacts](references/diagnostics-and-artifacts.md) |
| Author or revise scenarios      | [scenario authoring](references/scenario-authoring.md)               |
| Choose suites and coverage      | [scenario catalog](references/scenario-catalog.md)                   |
| Repair a discovered defect      | [self-improvement workflow](SELF_IMPROVEMENT.md)                     |
| Exercise semantic workspace VCS | [Vibestudio VCS protocol](../vibestudio-vcs/SKILL.md)                |

Implementation entry points are `runner.ts` (`HeadlessRunner`),
`test-runner.ts` (`TestRunner`), `types.ts`, `stages.ts`, `diagnostics.ts`, and
`tests/`. Import suite collections through
`@workspace-skills/system-testing/stages`, not internal test-file paths.

## Required headless repair loop

For CLI-driven verification, diagnosis, or repair, follow this order:

1. Check infrastructure first:

   ```bash
   pnpm cli --instance INSTANCE system-test doctor
   ```

   Repair failed infrastructure checks before interpreting scenario behavior.
   Model readiness is lifecycle-aware: an expired URL-bound credential counts
   as ready only when it has both durable refresh material and an exact refresh
   recipe. Reconnect a nonrenewable credential; do not retry around it or import
   credentials from another tool's private store. `doctor` proves catalog and
   credential readiness; it does not spend a provider request, so provider
   quota is established only by the journaled model attempt in a run.

2. Discover the exact current test name:

   ```bash
   pnpm cli --instance INSTANCE system-test list --json
   ```

3. Run the smallest relevant exact test:

   ```bash
   pnpm cli --instance INSTANCE system-test run TEST_NAME
   ```

   CLI runs have no per-test deadline by default. Use `--test-timeout-ms N`
   only when an investigation needs an explicit finite budget. When supplied,
   multi-phase orchestrations share that budget and every phase receives only
   the time remaining from the original deadline. A timeout is a terminal
   errored result to inspect, not a reason to add sleeps or retries.

   Cancellation is terminal only after the active test has followed its normal
   cleanup path: the agent turn is interrupted, the headless session/context is
   retired, and any exact repository fixture is cleaned. Inspect a cancelled
   record's cleanup failures just as you would an errored record; do not assume
   cancellation made partial work disappear.

   For a long run, start with `--detach` and observe it with
   `system-test status RUN_ID --wait --json`. Each running case reports its
   current lifecycle `phase`, `phaseStartedAt`, `elapsedMs`, and
   `phaseElapsedMs`. `session-cleanup:*` means the user task has ended and the
   harness is waiting for an acknowledged unsubscribe, evidence capture,
   disconnect, or runtime-context retirement—not that the model is still
   working. Use `inspect` while the run is live for the session's exact cleanup
   phase and transcript evidence.

4. On any non-zero exit, inspect the durable run packet immediately:

   ```bash
   pnpm cli --instance INSTANCE system-test inspect RUN_ID --json
   ```

   If the bounded packet cannot explain the mismatch, inspect the full test
   trajectory:

   ```bash
   pnpm cli --instance INSTANCE system-test trajectory RUN_ID TEST_NAME --full --json
   ```

5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Default to repairing infrastructure. Do not compensate for a
   platform or documentation defect by teaching the prompt the answer.

Use a named ephemeral developer instance for destructive or publication-heavy
system testing. Non-`source` instances own a copied workspace and never mirror
protected publications into the checkout template, so parallel hubs cannot
seed one another's next bootstrap:

```bash
pnpm server:live --ephemeral --instance system-tests-a
pnpm cli --instance system-tests-a system-test doctor
```

6. Implement the root fix and run focused conventional tests/type checks.
   Restarting the current source server is sufficient for host-code-only
   changes. Changes under `workspace/` are workspace source: a named
   `--bootstrap-workspace` deliberately preserves its semantic state and never
   rereads the checkout template on restart. Stop it and start
   `pnpm server:live --ephemeral --instance INSTANCE` to test a fresh checkout
   copied from the current template. The source-server supervisor isolates the
   hub lease, identity, databases, workspace, ports, ready file, CLI device, and
   CLI sessions while reusing profile-owned model configuration and encrypted
   provider credentials. Address that exact hub with
   `pnpm cli --instance INSTANCE ...`; never terminate or retarget another
   developer's live instance.

7. After the exact test passes, run its category and then smoke coverage. Use
   the prior run to rerun every failure or unexpected tool failure:

   ```bash
   pnpm cli --instance INSTANCE system-test rerun RUN_ID
   ```

Stop only when repair requires missing credentials, new authority, unavailable
external infrastructure, or a server restart that has not been authorized.
Do not stop at an artifact path or restated validator error: explain the
concrete mismatch in the captured behavior.

Headless tests are non-interactive. Their turn observer treats credential setup
and reconnect waits as terminal infrastructure failures, while ordinary
interactive sessions remain resumable. If one appears in a run packet, repair
readiness or complete the canonical connection flow instead of extending the
test timeout. Stored-credential use approval is a separate security decision:
the unattended agent-worker version must already have a normal version grant
from the workspace approval UI. Never auto-grant it in the harness. A run with
zero model evidence and a pending credential approval is waiting for that
decision, not suffering a model, WebRTC, or VCS failure.

## Orchestrator versus test subject

Use `HeadlessRunner` or `TestRunner` only when orchestrating a suite. If the
current prompt asks for one capability exercise and a marker, you are the test
subject: use that capability's canonical skill/API directly and return evidence.
Do not spawn another system-test agent.

Every ordinary test gets an isolated agent context. This prevents working VCS
state from leaking between tests. A genuine multi-actor scenario belongs in
`TestCase.orchestrate`: the harness spawns independent sessions and coordinates
their user-visible goals. Never prompt one agent to write another context's
state or invent a foreign context reference.

A test that creates or publishes workspace source must declare a typed fixture.
Use `CONTENT_WORKSPACE_REPO_FIXTURE` for an empty `projects/...` repository and
`BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE` only when a minimal `packages/...`
unit is necessary. Setup imports one exact generated snapshot into a fresh task
context through the public semantic VCS; it never publishes scaffolding.
Ordinary agents and the first role in a multi-actor scenario use that local
baseline. Teardown destroys the task context directly when no task event reached
main. Otherwise it opens a fresh context at current main. It never inventories
the ambient workspace: it derives any other repository identities from the task
context's exact first-parent work and point-inspects only those identities on
main. It finds the newest task event actually reachable from current main
through paged event history, counteracts published task work in reverse causal
order, then commits once and pushes once. Newer unpublished work disappears
with the task context. There is no fixture-only repository API or cleanup merge
protocol. Keep all fixture mechanics out of user-like prompts.

## Agentic and deterministic layers

System-testing is the agentic layer: a model selects skills and tools, acts in a
real session, and is judged by semantic validators. `@workspace/testkit` is the
deterministic layer for exact assertions, CDP automation, viewport checks,
transcript behavior, and similar precisely specifiable properties.

Run deterministic coverage directly when no agent judgment is under test:

```ts
import { runDeterministic } from "@workspace-skills/system-testing/deterministic";

const { suiteResult } = await runDeterministic();
```

Use both layers when an agent must discover and perform a workflow whose final
effects can also be asserted exactly.

## Programmatic orchestration

```ts
import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
import { TestRunner } from "@workspace-skills/system-testing/test-runner";
import { smokeTests } from "@workspace-skills/system-testing/stages";

const runner = new HeadlessRunner(ctx.contextId);
const tester = new TestRunner(runner, {
  onTestStart: (test) => console.log(`Running ${test.name}`),
  onTestEnd: (test, result) => console.log(`${result.passed ? "PASS" : "FAIL"}: ${test.name}`),
});

scope.results = await tester.runSuite(smokeTests);
return {
  total: scope.results.total,
  passed: scope.results.passed,
  failed: scope.results.failed,
  errored: scope.results.errored,
  skipped: scope.results.skipped,
};
```

There is no default per-test harness deadline. An explicit deadline is an
operator cancellation boundary, never a workaround for effect, transport, or
Durable Object liveness bugs.

The default model is pinned to `openai-codex:gpt-5.4-mini`. It has no implicit
usage-limit fallback: doctor and every spawned test agent name the same single
model, so a provider failure remains visible instead of silently changing the
experiment. An explicit model override is only for model-specific diagnosis.

## Interactive staged runs

In an interactive workspace-agent session, derive stage choices from
`allTests()` and `testStages()`. Keep the full run state in `scope`, run one
category-sized stage per eval with bounded concurrency, and publish one stage
report card after every stage through `reportStage`.

The report card is a bounded presentation, not the diagnostic record. Full
messages and snapshots remain in `scope.results.results`. Mention recovered
tool failures even when the final task passed; they can reveal infrastructure
defects hidden by successful agent recovery.

Ordinary local agent tools cannot hold a turn open forever: the runtime owns a
30-second default invocation deadline and records a structured
`tool_execution_timeout` terminal naming the tool and elapsed/deadline values.
Tools may declare another finite boundary; deliberately long work must use a
deferred protocol. Treat this terminal as infrastructure evidence and inspect
the affected invocation. Do not conceal it by increasing the system-test
deadline or by prompting the agent away from the broken capability.
Structured channel deliveries are independently bounded to 15 seconds per
attempt and durably retried. A channel alarm waiting longer than that is a
transport defect: inspect the channel delivery outbox and recipient lifecycle
rather than extending the test deadline.
Build publication has the same liveness separation: graph/effective-version
settlement is authoritative and finite, while changed-unit cache warming runs
downstream. If opening a newly published panel blocks all later VCS/filesystem
calls, treat that as build-settlement head-of-line blocking, not as an agent
prompt or validator problem.

Repository fixtures are also complete authority fixtures. The runner derives
two repository-qualified rules from the same declared ownership: gated
`workspace-main-advance` for
`workspace-source-change:<repoPath>:main`, and critical
`workspace-repo-delete` for `workspace-repo-delete:<repoPath>`. A seeded
fixture receives exact rules; a task-created/derived fixture receives section
prefixes because its owned basename is intentionally chosen during the task.
The cleanup context inherits the same resident test policy, so teardown uses
the ordinary protected VCS path without an interactive card or a privileged
cleanup API. Any prompt outside that scope is an immediate
`EUNEXPECTEDTESTPROMPT` harness failure; an unattended test must never leave a
real approval card waiting.

The protected-publication wait remains part of the originating VCS request:
its abort signal must reach the authority acquisition. An eval deadline or run
cancellation therefore closes any pending acquisition and unwinds the held
EvalDO execution. A timed-out tool whose underlying eval remains `running`, or
a `system-test cancel` command that waits on that eval, is cancellation
propagation breakage—not an ordinary test timeout.

Rich unit/config review is presentation carried by that same acquisition.
Panel, app, extension, worker, and meta changes must not call a legacy approval
queue directly. If a fixture-authorized panel publish produces an interactive
unit card, the canonical authority path was bypassed; repair the host gate
instead of adding a unit-card-specific test exception.

## Semantic VCS scenarios

VCS tests validate one semantic agentic system, not a sequence of old file/VCS
commands. The test subject must read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) and demonstrate:

- exact committed-event and local-application identities;
- complete-chain commit with no staging or selective remainder protocol;
- compare plus small local adopt/reconcile/decline integration steps;
- exact-event publication to protected main;
- explicit move/copy operations with stable move identity and copy ancestry;
- counteraction-based revert without erased history;
- walkable content, command, and trajectory-invocation causality plus blame;
- one bounded `gad.diagnoseInvocation` join whose terminal failure preserves
  primary and cleanup causes and reports any truncation;
- mixed native-edit/import-boundary blame that keeps exact new intent separate
  from honestly unknown pre-import authorship;
- typed stale-basis recovery and identical-request command idempotency.

Workers and Durable Objects created for a test follow the test context's working
state by default. Use `ref: "main"` only when the test explicitly needs
protected-main code. A panel still needs an explicit context build ref when its
unpublished code is under test.

If host and userland behavior disagree, inspect runtime-image `stateHash`,
`scopeRef`, `buildKey`, and effective version before blaming WebRTC or adding a
retry. A persistent workspace runs semantic state, not unimported files from the
host checkout. The workspace `systemEpoch` must exactly match the host; an
epoch mismatch is a fail-readiness condition, never a compatibility case.

Prompts state realistic user goals and final evidence fields. They do not name
the exact call sequence, object shape, or recovery branch. Validators inspect
the resulting effects and complete trajectory; a final prose marker alone is
not sufficient evidence of protocol correctness.

## Full remote/mobile smoke

For real desktop remote access and mobile pairing, run:

```bash
pnpm smoke:full
```

Forensics are written under `test-results/full-system-smoke/`. The harness
builds the product, exercises Electron pairing through the deployed signaling
service, runs desktop Playwright coverage, and verifies the Android pairing/OTA
activation/panel-load ladder. Missing adb/emulator, display, or
node-datachannel is an environment failure; do not claim product verification
until the full harness runs green.

## Artifact security

CLI artifacts are stored with restrictive permissions under
`${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/` unless an
output directory is supplied. Full trajectories can contain sensitive data.
Do not publish them, paste them wholesale, or weaken their permissions; extract
only the bounded evidence needed to explain the mismatch.

## Environment compatibility

The orchestrator can run from server-side eval, workers, Durable Objects, or
panels. In eval/worker/DO contexts it uses its authorized runtime identity as
the PubSub participant ID. Do not invent synthetic participant IDs. Panel-only
orchestrators with a stable panel slot may use that slot.

For trusted app failures under `apps/`, read `skills/appdev/SKILL.md`. For host
source under `src/` or root `packages/`, use the checkout/repair procedure in
[SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md); workspace source repair uses the
semantic VCS protocol linked above.
