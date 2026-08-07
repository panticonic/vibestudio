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
   pnpm system-test --instance INSTANCE doctor --approve-startup \
     --model openai-codex:gpt-5.3-codex-spark
   ```

   This command is the provisioning boundary as well as the diagnostic one. If
   `INSTANCE` is absent, stale, unpaired, or has no server yet, the launcher
   creates a named ephemeral server from the current checkout, waits for its
   ready record, and pairs the instance-scoped CLI before running `doctor`.
   Agents should invoke it directly; “no server is running” is not a blocker and
   is not a reason to ask the user to start one. Use one stable unique instance
   name throughout parallel work. The launcher refuses to take ownership of an
   unrelated existing instance.

   Repair failed infrastructure checks before interpreting scenario behavior.
   On a fresh disposable instance, `--approve-startup` resolves only exact,
   version-bound startup install reviews and refuses if any unrelated consent is
   pending. It does not approve credentials, userland requests, publication,
   or standing grants. Test turns themselves use the runner's host-attested
   authority policy and `approvalLevel: 2`; this pair is the supported
   unattended auto-approve workflow. The policy is resident on the test
   context. Trusted panel and worker infrastructure preserves it, and every
   downstream agent is forced onto the same exact model with full-auto and no
   fallback; userland cannot inject or widen that policy.
   Model readiness is lifecycle-aware: an expired URL-bound credential counts
   as ready only when it has both durable refresh material and an exact refresh
   recipe. Reconnect a nonrenewable credential; do not retry around it or import
   credentials from another tool's private store. `doctor` proves catalog,
   required extension, and credential readiness; approved lazy extensions may
   remain `available` until first use, while a pending startup unit review fails
   before a scenario can strand itself inside an unavailable native extension.
   It does not spend a provider request, so provider quota is
   established only by the journaled model attempt in a run.

2. Discover the exact current test name:

   ```bash
   pnpm system-test --instance INSTANCE list --json
   ```

3. Run the smallest relevant exact test:

   ```bash
   pnpm system-test --instance INSTANCE run TEST_NAME \
     --model openai-codex:gpt-5.3-codex-spark
   ```

   Every case has a 10-minute deadline by default so one wedged turn cannot
   hold an unattended run forever. Use `--test-timeout-ms N` to override that
   case budget. Multi-phase orchestrations share one budget and every phase
   receives only the time remaining from the original deadline. A timeout is a
   terminal errored result to inspect, not a reason to add sleeps or retries.

   Cancellation is terminal only after the active test has followed its normal
   cleanup path: the agent turn is interrupted, the headless session/context is
   retired, and any exact repository fixture is cleaned. Inspect a cancelled
   record's cleanup failures just as you would an errored record; do not assume
   cancellation made partial work disappear.

   The intermediate durable status is `cancelling`. Treat it as live work:
   cleanup retains the orchestrator and descendant evaluated-execution
   admissions until teardown and terminal-record persistence have settled.

   For a long run, start with `--detach` and observe it with
   `system-test status RUN_ID --wait --json`. Each running case reports its
   current lifecycle `phase`, `phaseStartedAt`, `elapsedMs`, and
   `phaseElapsedMs`. `session-cleanup:*` means the user task has ended and the
   harness is waiting for an acknowledged unsubscribe, evidence capture,
   disconnect, or runtime-context retirement—not that the model is still
   working. `workspace-fixture-cleanup:*` names the exact semantic teardown
   boundary: task status/ancestry, publication intersection, cleanup-context
   creation, each revert/commit/push counteraction boundary, or context
   destruction. Use
   `inspect` while the run is live for the exact cleanup phase and transcript
   evidence.

   A suite never occupies one long-lived runner RPC. The sealed runner starts
   the durable eval and returns; the orchestrator uses short status, terminal
   result, result-release, and cancellation calls keyed by the run ID. A
   closed runner socket is therefore an infrastructure failure, not a reason
   to extend a request deadline. Inspect whether the inner eval is still
   progressing and recover its durable terminal record before rerunning.

   Repository cleanup does not bypass protected-main authority. The harness
   derives repository identities from the task line's semantic
   `repository-create` changes, creates a case-policy cleanup context with
   critical deletion authority for only those exact paths, and counteracts the
   exact authored changes. Any unrelated path or unrelated test policy fails
   closed.

4. On any non-zero exit, inspect the durable run packet immediately:

   ```bash
   pnpm system-test --instance INSTANCE inspect RUN_ID --json
   ```

   Completed runs are inspected from the terminal heartbeat packet first, so
   diagnostics do not queue behind a failed run's still-unwinding eval scope.
   The durable-record fallback is read-only and its reconstruction eval has a
   30-second execution deadline; a failed diagnostic returns an explicit error
   instead of waiting forever.

   If the bounded packet cannot explain the mismatch, inspect the full test
   trajectory:

   ```bash
   pnpm system-test --instance INSTANCE trajectory RUN_ID TEST_NAME --full --json
   ```

5. Classify the root cause as infrastructure, documentation, harness, or
   validator. Default to repairing infrastructure. Do not compensate for a
   platform or documentation defect by teaching the prompt the answer.

Use a stable named instance for destructive or publication-heavy system
testing. The first command provisions its ephemeral server automatically. Each
instance acquires its own workspace from the exact promoted base-template pin
and never publishes back to that upstream, so parallel hubs cannot seed one
another's next bootstrap:

```bash
pnpm system-test --instance system-tests-a doctor --approve-startup \
  --model openai-codex:gpt-5.3-codex-spark
```

6. Implement the root fix and run focused conventional tests/type checks.
   Restarting the current source server is sufficient for host-code-only
   changes. A named `--bootstrap-workspace` deliberately preserves its acquired
   semantic state and never reacquires the promoted base pin on restart. For a
   fresh checkout after workspace-source changes, run
   `pnpm system-test --instance INSTANCE stop`, then invoke `doctor` again; the
   launcher provisions a fresh checkout acquired from the exact promoted base
   template pin. The source-server supervisor isolates the
   hub lease, identity, databases, workspace, ports, ready file, CLI device, and
   CLI sessions while reusing profile-owned model configuration and encrypted
   provider credentials. Address that exact hub with
   `pnpm system-test --instance INSTANCE ...`; never terminate or retarget another
   developer's live instance.

7. After the exact test passes, run its category and then smoke coverage. Use
   the prior run to rerun every failure or unexpected tool failure:

   ```bash
   pnpm system-test --instance INSTANCE rerun RUN_ID
   ```

8. When verification is complete, stop exactly the managed instance:

   ```bash
   pnpm system-test --instance INSTANCE stop
   ```

   The launcher refuses to stop an instance it did not create.

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

The execution model is pinned to `openai-codex:gpt-5.3-codex-spark`. It has no
implicit usage-limit fallback: doctor and every spawned test agent name the
same single model, so a provider failure remains visible instead of silently
changing the experiment. Context-created auxiliary agents are covered too:
host mediation carries the resident case policy and runtime creation replaces
their requested model/approval/fallback fields with Spark, full-auto, and no
fallback. Keep that explicit `--model` value in automation; an override is
only for a deliberately model-specific diagnosis.

One named agent session owns one EvalDO notebook: its live heap is retained for
while its kernel activation remains resident and its exact durable scope is cold-recovered, so eval work is
intentionally FIFO. Concurrent CLI `inspect` and `trajectory` requests wait on
that same admission queue and inherit caller cancellation; they do not fail
merely because another read is active and they have no fixed wait deadline.
Use distinct named server instances for parallel workspace experiments and
distinct agent sessions when inspection itself must execute in parallel.

## Interactive staged runs

In an interactive workspace-agent session, derive stage choices from
`allTests()` and `testStages()`. Keep the full run state in `scope`, run one
category-sized stage per eval with bounded concurrency, and publish one stage
report card after every stage through `reportStage`.

The report card is a bounded presentation, not the diagnostic record. Full
messages and snapshots remain in `scope.results.results`. Mention recovered
tool failures even when the final task passed; they can reveal infrastructure
defects hidden by successful agent recovery.
Typed no-effect and guest-code failures remain visible in the diagnostic record,
but are diagnostic-only and do not count as unexpected tool failures. Only an
unclassified failure is an unexpected failure that belongs in rerun and failure
summaries.

Ordinary local agent tools have no implicit wall-clock deadline. They inherit
explicit cancellation from the owning turn; tools and deferred protocols may
own deadlines only where those deadlines are part of their semantics. Treat an
unexpected timeout terminal as infrastructure evidence and inspect the affected
invocation. Do not conceal it by increasing the system-test deadline or by
prompting the agent away from the broken capability.
Structured channel deliveries are independently bounded to 15 seconds per
attempt and durably retried. A channel alarm waiting longer than that is a
transport defect: inspect the channel delivery outbox and recipient lifecycle
rather than extending the test deadline.
Build publication has the same liveness separation: graph/effective-version
settlement is authoritative and finite, while changed-unit cache warming runs
downstream. If opening a newly published panel blocks all later VCS/filesystem
calls, treat that as build-settlement head-of-line blocking, not as an agent
prompt or validator problem.

Repository fixtures are also complete authority fixtures. The runner grants
gated `workspace-main-advance` to the immutable atomic
`workspace-source-change:publication:<id>` transaction. The fixture reconciler
then enforces the declared repository ownership and counteracts any unexpected
publication. Critical cleanup authority remains repository-qualified as
`workspace-repo-delete:<repoPath>`: exact for a seeded fixture and section-wide
for an as-yet-unnamed created/derived fixture. The cleanup context inherits the
same resident test policy, so teardown uses the ordinary protected VCS path
without an interactive card or a privileged cleanup API.

Repository fixtures automatically claim the suite scheduler resource
`vcs:protected-main`. Their task contexts and local working heads are isolated,
but successful publication and cleanup counteraction both advance the one
protected branch. The runner therefore serializes fixture cases without
requiring each test definition to remember this global constraint; unrelated
cases with disjoint resources still run concurrently.

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
- compare plus bounded coordinate merge pages, intent review, and explicit conflict resolutions;
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
