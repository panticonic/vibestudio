---
name: system-testing
description: Orchestrate automated Vibestudio test suites via headless agentic sessions, validate results, and run the self-improvement workflow. Use when asked to run, author, stage, analyze, or repair a system-test suite. Do not use it recursively as a spawned test subject that was asked to exercise one capability; use that capability's own skill/API directly.
---

# System Testing Skill

Spin up headless agentic sessions to systematically test every Vibestudio capability — filesystem, database, GAD workspace VCS, external Git interop, workers, panels, browser panels, build system, OAuth, skills, and more. Collect structured pass/fail results with full diagnostic data for every turn.

## Files

| Document                                   | Content                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| runner.ts                                  | `HeadlessRunner` — spawn headless sessions from eval with one line |
| test-runner.ts                             | `TestRunner` — orchestrate test suites, collect full diagnostics   |
| types.ts                                   | `TestCase`, `TestResult`, `TestSuiteResult`, `TestExecutionResult` |
| tests/                                     | 148 pre-built test cases across 32 categories                      |
| deterministic.ts                           | Bridge to `@workspace/testkit` deterministic suites (see below)    |
| [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) | Workflow for analyzing failures and committing fixes               |

## Orchestrator vs. Test Subject

Use `HeadlessRunner`/`TestRunner` only when orchestrating a suite or stage. If
the current request is one capability exercise with a result marker (for
example, `WORKER_DESTROY_OK`), you are the spawned test subject: exercise the
documented capability directly and report its evidence. Do not spawn another
system-test agent or import/re-run the canonical test that prompted you.

Suite orchestrators should import suite collections from the public
`@workspace-skills/system-testing/stages` entry point (for example,
`workerTests`). Do not infer an internal source-file subpath from the Files
table.

## Deterministic tests (testkit)

The `deterministic` stage wraps the exact-assertion suites from
`@workspace/testkit` (see the **testkit** skill — panel lifecycle, viewport
fits, chat transcript, spectrolite, terminal). They run via
`deterministicTestCases()` inside the normal staged agentic workflow, or
directly without an agent session:

```
import { runDeterministic } from "@workspace-skills/system-testing/deterministic";
const { suiteResult } = await runDeterministic();
```

Layering: testkit = deterministic layer (exact assertions, CDP automation,
profiling); system-testing = agentic layer (LLM-driven sessions judged by
validators). Prefer testkit when expected behavior is exactly specifiable.

## Full Remote/Mobile Smoke

Use this when the question is "does remote access and mobile pairing work with
the real clients?"

```bash
pnpm smoke:full
```

The harness writes forensics under `test-results/full-system-smoke/` and runs:

- `pnpm build`
- `scripts/desktop-pairing-smoke.mjs` with the branded Electron binary and
  WebRTC pairing through the deployed signaling service
- `pnpm test:e2e` for desktop Playwright coverage
- `scripts/cli/mobile-smoke.mjs --platform android` against adb/emulator,
  asserting the mobile `smokePhase` ladder through pairing, OTA activation, and
  panel WebView load

Both pairing phases launch the normal `remote serve` hub without a signaling
override and consume the fresh hub's root-device invite. Android
attempts normal host/STUN/TURN ICE by default; use `--require-turn` to enforce
relay readiness. Pass `--local-signaling` only for the offline Miniflare/coturn
variant.

If a phase fails, read that phase's log first, then the Electron/mobile logs
collected by the underlying smoke. Missing adb/emulator, X11/Wayland display, or
node-datachannel are environment failures; do not report the product as verified
until the full harness has actually run green.

## Quick Start

`HeadlessRunner.spawn()` creates an isolated agent context by default. This keeps
tests from sharing working VCS state with the orchestrating panel or with each
other. If a scenario genuinely needs multiple actors, make it a harness-level
`TestCase.orchestrate(...)` flow and spawn multiple headless sessions; do not
prompt one agent to write a foreign `ctx:*` head. Use `runner.spawn({ context:
"parent" })` only for tests that intentionally exercise the orchestrator's
current context.

Context isolation does not roll back a `vcs.push`, because publication advances
workspace `main`. A test that may create or fork a published repo must set
`workspaceRepoFixture: true` on its `TestCase`. The runner then injects a unique
`system-test-*` repository basename as harness metadata, removes stale repos in that
reserved namespace before the test, and removes the test's published repos
afterward. Cleanup errors and repos created outside the namespace fail the run
with diagnostics. Keep those fixture mechanics out of the user-like `prompt`.

```
eval({
  code: `
    import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
    import { TestRunner } from "@workspace-skills/system-testing/test-runner";
    import { smokeTests } from "@workspace-skills/system-testing/stages";

    // Uses the pinned Spark-first, usage-limit-only Luna fallback policy.
    const runner = new HeadlessRunner(ctx.contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("Running: " + t.name + "..."),
      onTestEnd: (t, r) => console.log((r.passed ? "PASS" : "FAIL") + ": " + t.name),
    });
    const results = await tester.runSuite(smokeTests);
    scope.results = results;
    return {
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      errored: results.errored,
      skipped: results.skipped,
    };
  `,
})
```

Workspace packages like `@workspace-skills/system-testing/stages` are auto-resolved - the build system builds them on first import. No `imports` parameter needed.

## CLI/headless orchestrator mode

When the orchestrator is an external CLI agent rather than a workspace chat
agent, use the first-class CLI commands instead of the feedback-form and stage
report-card flow below:

```bash
vibestudio system-test doctor
vibestudio system-test list --json
vibestudio system-test run eval-return-value
vibestudio system-test inspect <run-id> --json
vibestudio system-test trajectory <run-id> eval-return-value --full --json
vibestudio system-test rerun <run-id>
```

For a disposable unattended server, enable the host's existing development
auto-approver when starting it:

```bash
vibestudio remote serve --dev --auto-approve
```

`--auto-approve` is intentionally accepted only with `--dev`. It covers host
credential, userland, startup-unit, and capability approvals, which are a
separate layer from the spawned chat agent's approval level. The headless
runner also fixes every spawned agent at approval level 2.

CLI eval intentionally has no `agent` or `chat` binding, so it cannot call
`agent.describe()`, publish report cards, or show feedback forms. The CLI-neutral
`@workspace-skills/system-testing/cli` persists full results under a durable run
ID and returns machine-readable summaries. By default every test starts with
`openai-codex:gpt-5.3-codex-spark`; a journaled terminal usage-limit result is
the only condition that activates `openai-codex:gpt-5.6-luna` at minimal
reasoning effort for the current and later tests. An explicit model override is
for model-specific investigations and disables that canonical fallback policy.
Exact test names, categories, and the complete catalog are supported.

There is no default per-test harness deadline. An explicit deadline is only an
operator cancellation boundary and must never be used to mask an effect,
transport, or Durable Object liveness bug.

In CLI mode, a failed command is the start of the repair loop. Inspect the
bounded packet, inspect the full trajectory if necessary, fix the root cause,
rerun the exact test, then its category and smoke coverage. Do not stop after
only reporting a failure unless repair is blocked by missing credentials,
authority, external infrastructure, or a required server restart.

When a test requires workspace development or panel API docs, read the
canonical skill path from the workspace root, for example
`skills/workspace-dev/PANEL_API.md`. Do not use bare root paths like
`workspace-dev/PANEL_API.md`. The Files table above is relative to this skill
directory; when using read/grep tools, use workspace-root paths such as
`skills/system-testing/tests/oauth.ts`, not `system-testing/tests/oauth.ts`.

## Interactive workspace-agent full suite

Start by presenting the user with a feedback UI so they can choose which stages
to run. A stage is a category-sized group by default, so stages can contain more
than three tests. Keep one eval call per stage, run as much concurrency inside
that stage as is feasible, publish a concise user-visible report after each
stage, then continue to the next selected stage.

First initialize stage progress. Store the full stage/run scaffold in `scope`;
return only the compact control data needed to render the feedback form. Do not
return `scope.systemTestingRun`, the full stage list, or test result arrays from
eval calls.

> `rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`, `db`, `help`, and (in agent
> eval) `chat` are **pre-injected ambient globals** in eval — use them directly.
> Do **not** `import` any of them from `@workspace/runtime`. The context id is
> `ctx.contextId`; reach raw service catalog methods through
> `rpc.call("<svc>.<method>", [...])`. `services.<svc>` is convenience sugar and
> may be an ergonomic runtime client when the service name collides with a
> runtime binding. Run the block below as written.

```
eval({
  code: `
    import { allTests, testStageChoices, testStages } from "@workspace-skills/system-testing/stages";
    const tests = allTests();
    const stages = testStages(tests);
    const stageOptions = testStageChoices(stages);
    const runId = crypto.randomUUID();
    await scopes.push();
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: tests.length,
      duration: 0,
      results: [],
    };
    scope.systemTestingRun = {
      runId,
      stages: stages.map((stage) => ({
        index: stage.index,
        name: stage.name,
        category: stage.category,
        tests: stage.tests.map((test) => test.name),
      })),
      completedStages: [],
      results,
    };
    scope.results = results;
    return {
      runId,
      stageOptions,
      defaultStages: stageOptions.map((option) => option.value),
      stageCount: stages.length,
      testCount: tests.length,
    };
  `,
})
```

Then show a feedback form before running any tests. Populate `options` from the
`stageOptions` returned by the initialization eval and `default` from
`defaultStages`. Do not hard-code stage names or counts; they must come from the
current system-testing skill exports. Default to all stages if the user does not
narrow the selection. In the example below, substitute
`stageOptionsFromInitialization` and `defaultStagesFromInitialization` with the
actual arrays returned by the initialization eval.

```
feedback_form({
  title: "Choose System Test Stages",
  fields: [
    {
      key: "stages",
      label: "Stages to run",
      type: "multiSelect",
      options: stageOptionsFromInitialization,
      default: defaultStagesFromInitialization,
      allowFreeText: false,
      required: true,
      description: "The agent will run only the selected stages, reporting after each stage.",
    },
  ],
  submitLabel: "Run selected stages",
  cancelLabel: "Cancel",
})
```

If the user cancels, stop and report that no tests were run. If they submit,
store the selected stage indexes in `scope` and return only a compact selection
summary:

```
eval({
  code: `
    const selected = [
      // Fill from feedback result value.stages, e.g. "0", "3", "7".
    ];
    const run = scope.systemTestingRun;
    if (!run || typeof run !== "object") {
      throw new Error("No active systemTestingRun. Run the initialization eval first.");
    }
    const allIndexes = Array.isArray(run.stages) ? run.stages.map((stage) => stage.index) : [];
    const selectedIndexes = selected
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && allIndexes.includes(value));
    run.selectedStageIndexes = selectedIndexes.length ? selectedIndexes : allIndexes;
    scope.systemTestingRun = run;
    const selectedStages = run.stages.filter((stage) => run.selectedStageIndexes.includes(stage.index));
    return {
      runId: run.runId,
      selectedStageCount: selectedStages.length,
      selectedTestCount: selectedStages.reduce((total, stage) => total + stage.tests.length, 0),
    };
  `,
})
```

Then run the next selected stage with this eval. This eval must be invoked once
per stage and must not contain a `for`, `while`, or recursive loop over stages.
After it returns, publish/report the stage findings in the normal assistant
turn. If `remainingStages` is greater than `0`, continue by issuing this same
eval again as a new tool call.

Run this short orchestration snippet directly in eval. File-loaded eval remains
preferred for substantive multi-line or multi-file code, but helper files should
not be used merely to wrap this stage loop. If an operation fails, report the
error you actually observed, verbatim, with the operation that produced it.

```
eval({
  code: `
    import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
    import { TestRunner } from "@workspace-skills/system-testing/test-runner";
    import { allTests, nextSelectedStage } from "@workspace-skills/system-testing/stages";
    const tests = allTests();
    const run = scope.systemTestingRun;
    if (!run || typeof run !== "object") {
      throw new Error("No active systemTestingRun. Run the initialization eval first.");
    }
    const next = nextSelectedStage(tests, run);
    if (!next) {
      const aggregate = run.results ?? scope.results;
      return {
        done: true,
        runId: run.runId,
        total: aggregate?.total ?? 0,
        passed: aggregate?.passed ?? 0,
        failed: aggregate?.failed ?? 0,
        errored: aggregate?.errored ?? 0,
        toolFailureCount: aggregate?.toolFailureCount ?? 0,
        testsWithToolFailures: aggregate?.testsWithToolFailures ?? 0,
        skipped: aggregate?.skipped ?? 0,
      };
    }
    const { stage, stagePosition, selectedStages } = next;
    const completed = new Set(Array.isArray(run.completedStages) ? run.completedStages : []);

    // Uses the pinned Spark-first, usage-limit-only Luna fallback policy.
    const runner = new HeadlessRunner(ctx.contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("Running: " + t.name + "..."),
      onTestEnd: (t, r) => console.log((r.passed ? "PASS" : "FAIL") + ": " + t.name),
      onTestResult: (_entry, aggregate) => {
        console.log("Stage progress: " + stage.name + " " + aggregate.total + "/" + stage.tests.length);
      },
    });

    // Cap concurrency: each test is a full headless agent + channel, and the
    // workers stage adds workerd/DO lifecycle pressure inside each test.
    const concurrency = stage.category === "workers"
      ? 1
      : Math.min(2, Math.max(1, stage.tests.length));
    const partial = await tester.runSuite(stage.tests, { concurrency });
    const aggregate = run.results ?? scope.results ?? {
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
      skipped: tests.length,
      duration: 0,
      results: [],
    };
    aggregate.total += partial.total;
    aggregate.passed += partial.passed;
    aggregate.failed += partial.failed;
    aggregate.errored += partial.errored;
    aggregate.toolFailureCount = (aggregate.toolFailureCount ?? 0) + (partial.toolFailureCount ?? 0);
    aggregate.testsWithToolFailures = (aggregate.testsWithToolFailures ?? 0) + (partial.testsWithToolFailures ?? 0);
    aggregate.duration += partial.duration;
    aggregate.results.push(...partial.results);
    aggregate.skipped = tests.length - aggregate.total;
    completed.add(stage.index);
    run.completedStages = [...completed];
    run.results = aggregate;
    run.stageSummaries = Array.isArray(run.stageSummaries) ? run.stageSummaries : [];
    scope.systemTestingRun = run;
    scope.results = aggregate;

    const failedNames = partial.results
      .filter((entry) => !entry.result.passed || entry.execution.error)
      .map((entry) => {
        const reason = entry.execution.error || entry.result.reason || "No reason captured";
        return entry.test.name + ": " + reason.slice(0, 240);
      });
    const toolFailureNames = partial.results.flatMap((entry) => {
      const failures = (entry.execution.toolFailures ?? []).filter((failure) => failure.expected !== true);
      if (failures.length === 0) return [];
      const tools = failures.map((failure) => failure.name).join(", ");
      return [entry.test.name + ": " + failures.length + " unexpected tool failure(s): " + tools];
    });
    const remainingStages = selectedStages.filter((item) => !completed.has(item.index)).length;
    const stageSummary = {
      index: stage.index,
      name: stage.name,
      category: stage.category,
      position: stagePosition,
      selectedStageCount: selectedStages.length,
      total: partial.total,
      passed: partial.passed,
      failed: partial.failed,
      errored: partial.errored,
      toolFailureCount: partial.toolFailureCount ?? 0,
      testsWithToolFailures: partial.testsWithToolFailures ?? 0,
      durationMs: partial.duration,
      concurrency,
      failedTests: failedNames,
      toolFailures: toolFailureNames,
    };
    run.stageSummaries.push(stageSummary);
    run.lastStageSummary = stageSummary;
    scope.systemTestingRun = run;

    return {
      runId: run.runId,
      stage: stage.name,
      stagePosition,
      remainingStages,
      total: aggregate.total,
      passed: aggregate.passed,
      failed: aggregate.failed,
      errored: aggregate.errored,
      toolFailureCount: aggregate.toolFailureCount ?? 0,
      testsWithToolFailures: aggregate.testsWithToolFailures ?? 0,
      skipped: aggregate.skipped,
      failedTestCount: failedNames.length,
      toolFailureTestCount: toolFailureNames.length,
    };
  `,
})
```

## Stage report cards (post one after every stage)

The stage eval no longer posts a prose message. Instead, after each stage eval
returns, post a **stage report card** — a custom message that renders this
stage's full per-test table and per-failure diagnostics, with your prose summary
on top. Run this as a separate eval (the prose must be written by you, not the
deterministic stage eval):

```
eval({
  code: `
    import { reportStage } from "@workspace-skills/system-testing/report";
    await reportStage(chat, scope, {
      prose: "<2-4 sentences: what passed, what failed, any non-fatal tool failures observed, and the most likely cause or investigation needed>",
    });
    return { reported: scope.systemTestingRun.lastStageSummary.name };
  `,
})
```

`reportStage` defaults to the most-recently completed stage
(`scope.systemTestingRun.lastStageSummary`) and bounds the card to that stage's
own tests (so a category split across stages still yields one card per stage).
Pass `{ stageIndex }` to report a specific earlier stage. The card embeds bounded
diagnostics from `summarizeFailures`, so it persists across reload/replay without
depending on live `scope`. Do not skip a stage's card; the cards are the primary
per-stage deliverable.

Tool failures are not the same as task failures. A test can pass after a
subagent hits a tool error and recovers, but the stage report must still mention
the affected test and tool so the top-level agent can investigate and surface
the issue. Full raw messages and snapshots remain in `scope.results.results`;
the report card is only a bounded presentation layer and is not the complete
diagnostic record.

## Inspecting Results

Full test state lives in `scope.results.results`, with compact per-stage
summaries in `scope.systemTestingRun.stageSummaries`. Eval return values are
only progress/control packets; do not use them as the diagnostic record.

Every test result includes full diagnostics. **After running a suite, always
inspect failures in detail from `scope.results.results` and include the evidence
in your answer. Never report only filenames, artifact names, or "files to
inspect"; those are pointers, not diagnosis.**

`execution.provenance` records `channelId`, `branchId`, `agentEntityId`,
`agentTargetId`, and the isolated agent `contextId`, so external inspectors do
not need to infer trajectory identity from the participant roster.

For a bounded structured packet that is safe to paste into a handoff report:

```typescript
import { summarizeFailures } from "@workspace-skills/system-testing/diagnostics";

return summarizeFailures(scope.results, {
  failures: 12,
  messages: 12,
  invocations: 20,
  debugEvents: 20,
  text: 900,
});
```

Each summary includes the prompt, validation reason, session error, final agent
message, bounded conversation transcript, invocation statuses and errors, debug
events, cleanup errors, participant state, non-fatal tool failures, and a coarse
likely issue. Deliberately induced failures are retained with `expected: true`
as resilience evidence but are not counted as defects. `summarizeFailures()`
includes failed tests and passed tests with unexpected tool failures. Use that
packet to explain the mismatch or recovered tool error.
If the packet is insufficient, query the specific session further; do not
substitute a list of files.

### Summary

```typescript
for (const r of scope.results.results) {
  const icon = r.result.passed ? "PASS" : "FAIL";
  console.log(`${icon}: ${r.test.name} (${r.execution.duration}ms)`);
  if (!r.result.passed) console.log(`  Reason: ${r.result.reason}`);
}
```

### Full conversation log

Every turn the test agent took is captured — messages, tool calls, thinking, errors:

```typescript
const fail = scope.results.results.find((r) => !r.result.passed);
for (const m of fail.execution.messages) {
  const who = m.senderId === fail.execution.messages[0]?.senderId ? "USER" : "AGENT";
  const type = m.contentType ?? m.kind ?? "text";
  console.log(`[${who}] (${type}) ${m.content?.slice(0, 500)}`);
  if (m.error) console.log(`  ERROR: ${m.error}`);
}
```

### Invocation cards (every tool call + result)

See exactly what the test agent tried — eval calls, their code, return values, errors, timing:

```typescript
if (fail.execution.snapshot) {
  for (const inv of fail.execution.snapshot.invocations) {
    console.log(`  [${inv.status}] ${inv.name}`);
    if (inv.error) console.log(`    Error: ${inv.error}`);
  }
}
```

### Debug events (harness lifecycle)

See if the agent's harness spawned, crashed, stalled, or had warnings:

```typescript
if (fail.execution.snapshot) {
  for (const ev of fail.execution.snapshot.debugEvents) {
    console.log(`  [debug] ${JSON.stringify(ev).slice(0, 200)}`);
  }
}
```

### Cleanup diagnostics

Each headless test closes its session after capturing messages. Cleanup
failures are surfaced instead of swallowed:

```typescript
if (fail.execution.cleanupErrors?.length) {
  console.log("Cleanup errors:");
  for (const err of fail.execution.cleanupErrors) console.log(`  ${err}`);
}
if (fail.execution.snapshot?.cleanupErrors.length) {
  console.log(JSON.stringify(fail.execution.snapshot.cleanupErrors, null, 2));
}
```

Treat cleanup errors as infrastructure failures. They can indicate that the
headless agent was not unsubscribed/retired cleanly, which may otherwise show
up later as recovery or stale-turn artifacts.

### Automatic runtime diagnostics

When a test errors, `execution.diagnostics` is attached automatically. It
contains build provenance for `@workspace-skills/system-testing` and, when a
headless channel was created, a bounded `gad.inspectAgentHealth(...)` report.

```typescript
if (fail.execution.diagnostics) {
  console.log(JSON.stringify(fail.execution.diagnostics, null, 2).slice(0, 4000));
}
```

### Orchestrator failures before tests start

If `tester.runSuite(...)` throws before `scope.results` is set, capture bounded
runtime diagnostics from the orchestrating channel instead of retrying blindly:

```typescript
// In eval, `rpc` is injected (do not import it). Raw service catalog calls use
// rpc.call("<svc>.<method>", [args]); services.<svc> is convenience sugar for
// non-colliding names.
const channelId = "chat-...";
const branchId = `branch:channel:${channelId}`;

return {
  health: await rpc.call("main", "gad.inspectAgentHealth", [{ channelId, branchId }]),
  build: await rpc.call("main", "build.inspectBuildProvenance", [
    "@workspace-skills/system-testing",
  ]),
  serverLogs: await rpc.call("main", "serverLog.query", [{ level: "warn", limit: 100 }]),
};
```

You can also call `await runner.collectDiagnostics({ channelId, error })` to
produce the same bounded packet explicitly.

System-testing commonly runs from server-side eval. For eval, worker, and
Durable Object orchestrators, `HeadlessRunner` uses the caller's authorized
runtime identity (`rpc.selfId`) as its PubSub participant id. Do not invent
synthetic client ids such as `headless-*`; PubSub rejects connectionless callers
that subscribe as a different participant. Panel-only orchestrators with a
stable panel slot may use that slot id.

### Background build failures

A `vcs.push` is itself the build gate: a `build-failed` push advances no head and
returns structured `file:line:col` diagnostics directly. Some other build
failures still happen on the server's state-triggered background build path,
separate from a push. To inspect those, query the build service before retrying
or guessing:

```typescript
// Eval uses the same portable `rpc.call(target, method, args)` shape as panels/workers.
// Raw server services target "main".
return {
  recent: await rpc.call("main", "build.listRecentBuildEvents", []),
  forUnit: await rpc.call("main", "build.listRecentBuildEvents", ["panels/example"]),
  panel: await rpc.call("main", "build.inspectBuildProvenance", ["panels/example"]),
};
```

`build.listRecentBuildEvents` accepts an optional unit name or workspace path,
for example `["panels/example"]`. Events include `build-error` messages and, for
state-triggered builds, a `trigger` with head, state hash, changed paths, and the
verified caller that caused the edit when the server can attribute it. Authoritative
builds run at the push gate. A `vcs.commit(...)` returns a repo-rooted
`stateHash` and `changedPaths`; push/build events expose the workspace-rooted
trigger state used by the build. Pass the unit path here for matching
build-event lookup.
A `vcs.edit(...)` (uncommitted working change) does not build — use
`vcs.previewBuild({ repoPaths })` for an on-demand build of working content.

### Agent debug port

If a test shows an open turn but no assistant message, tool call, or
`turn.closed` event, inspect the agent debug port before changing prompts or
adding waits:

```typescript
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The default AI agent exposes `getDebugState` as a read-only participant method.
It reports dispatcher state, runner phase, persisted pending work, channel
checkpoints, and recent lifecycle events. See
`docs/agent-debug-port.md` for the full response shape and interpretation
guide.

`chat.callMethod` only reaches participants in the current test channel. When a
failure points at a parent/sibling/other panel's channel, resolve that target
channel first and call the channel DO's read-only inspection path:

```typescript
const channel = await workers.resolveService("vibestudio.channel.v1", targetChannelId);
const debug = await rpc.call(channel.targetId, "inspectAgent", [
  agentParticipantId,
  "getDebugState",
]);
```

For eval/tool projection mismatches, call the joined suspension diagnostic:

```typescript
const suspensions = await chat.callMethod(agentParticipantId, "inspectMethodSuspensions", {});
console.log(JSON.stringify(suspensions, null, 2).slice(0, 4000));
```

For a non-current target channel, use the same channel DO route with
`"inspectMethodSuspensions"`.

### Participants (who was in the channel)

Check if the agent actually joined, and whether it disconnected:

```typescript
if (fail.execution.snapshot) {
  for (const [id, p] of Object.entries(fail.execution.snapshot.participants)) {
    console.log(`  ${p.name} (${p.type}): ${p.connected ? "connected" : "DISCONNECTED"}`);
  }
}
```

## Available Test Suites

| Suite                     | Tests | What it covers                                                                                                                         |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `smokeTests`              | 4     | Basic sanity: eval, fs, package import, file tools                                                                                     |
| `filesystemTests`         | 9     | All fs operations: read/write, dirs, stats, symlinks, handles                                                                          |
| `vcsTests`                | 9     | edit (uncommitted working ops) → commit → ff-only push, plus log, state diff, discardEdits, push status, divergence → merge → push     |
| `vcsAdvancedTests`        | 8     | revert, previewBuild of working content, readFile/listFiles at head, fileHistory, pendingMerge, rebaseContext, edit provenance, recall |
| `gitInteropTests`         | 4     | External Git bridge: upstream status, publish/push to a disposable remote, importProject, commit mapping                               |
| `panelTests`              | 4     | Open, browser panel create+navigate, screenshot, evaluate, panel-tree walk/navigate/close, list sources                                |
| `workerTests`             | 7     | Create, list, unified RPC DO calls, destroy, env bindings, DO SQLite persistence across calls, list sources                            |
| `buildTests`              | 4     | Workspace + npm builds, build at GAD state ref, eval imports                                                                           |
| `oauthTests`              | 3     | List providers/connections, error on missing connection                                                                                |
| `credentialTests`         | 2     | Store/inspect/revoke a dummy URL-bound credential without secret leaks, client config status                                           |
| `workspaceTests`          | 3     | List, active, config                                                                                                                   |
| `unitDiagnosticsTests`    | 4     | units list/inspector, persisted unit logs + error buffer, unit versions, recurring jobs + heartbeats read-only                         |
| `multiUserTests`          | 5     | Account whoami, workspace members, live presence, channel roster human/agent identity, hub workspace listing                           |
| `approvalPermissionTests` | 3     | Permissions list, approval queue inspection, harmless approval request + withdraw round trip                                           |
| `notificationTests`       | 2     | Show + dismiss                                                                                                                         |
| `skillTests`              | 4     | Load sandbox, workspace-dev, api-integrations, headless-sessions                                                                       |
| `agentCapabilityTests`    | 6     | Multi-turn, error recovery, large output, dynamic import                                                                               |
| `rpcTests`                | 2     | Cross-service calls                                                                                                                    |
| `edgeCaseTests`           | 3     | Invalid eval args, invalid imports, missing files                                                                                      |
| `agenticRuntimeTests`     | 8     | State args, runtime VCS client, GAD conventions, bounded inspection, test-runner extension, no-stall tool turns                        |
| `evalLifecycleTests`      | 3     | Eval-local db persistence across calls, scope reset produces a fresh sandbox, cancel of a long-running run                             |
| `blobstoreTests`          | 3     | Text/range/grep round-trips, binary round-trip, immutable file trees (put/list/diff/materialize)                                       |
| `serverLogTests`          | 2     | Bounded serverLog query + stats, bounded tail of newest entries                                                                        |
| `webhookTests`            | 2     | Subscription create/list/rotate/revoke lifecycle, bounded listing                                                                      |
| `extensionSurfaceTests`   | 3     | List extensions, typecheck a unit via the typecheck surface, invoke a harmless extension method                                        |
| `harnessToolTests`        | 3     | Provenance orientation, knowledge-claim record/revise/retract lifecycle, workspace memory search                                       |
| `docsDiscoveryTests`      | 3     | Live docs surface: capability search, service description with methods, bounded service listing                                        |
| `interactionSurfaceTests` | 6     | MDX ActionButton, inline UI, action bar, set_title, custom messages incl. in-place update + clear                                      |
| `projectLifecycleTests`   | 4     | Create, fork, commit, open, and inspect real workspace units                                                                           |
| `cdpGadDiagnosticTests`   | 5     | CDP UI mutation, lightweight console/DOM inspection, historical console diagnostics, panel state args, GAD integrity/state diagnostics |
| `harnessResilienceTests`  | 5     | Eval errors, huge returns, visible timeouts, invalid args, post-tool follow-ups                                                        |
| `docsProbeTests`          | 10    | Scenario probes that require agents to apply relevant skills, not summarize docs                                                       |

Use `allTests()` to get all 148 tests combined. For full-suite execution, prefer
the staged-progress pattern above: initialize `testStages(allTests())`, build
feedback choices with `testStageChoices(stages)`, run one selected stage per
eval with a bounded concurrency cap (`1` for `workers`, at most `2` elsewhere),
publish the stage report, then continue until `remainingStages` is `0`. Because
the choices come from `allTests()` and `testStages()`, the feedback form follows
the current test skill exports automatically.

## Expanded Regression Coverage

The suite intentionally includes tests for failure modes that are easy to miss
with ordinary smoke testing:

- state args must update the caller panel immediately from the returned host
  snapshot, while host-published events still update non-callers
- browser-panel workspace edits go through `edit`/`write`/`vcs.edit` as
  UNCOMMITTED working changes (projected to disk, not yet a commit); a deliberate
  `vcs.commit(message)` then seals them, and `vcs.push` fast-forwards them into
  `main`; external Git remotes use `@vibestudio/git` with `credentials.gitHttp()`
- GAD raw SQL uses positional `(sql, bindings)` calls
- channel/history inspection must stay bounded enough for agent context
- large eval/tool results must complete visibly without pending invocation
  spinners or silent turns
- the standard agent participant debug method should be discoverable
- rich interaction surfaces must exercise MDX, `inline_ui`,
  `load_action_bar`, and custom messages without hand-writing raw channel rows.
  Because normal headless sessions do not have browser-panel UI tools, the
  `inline_ui` and `load_action_bar` tests opt into the runner's synthetic panel
  UI methods; those methods advertise the panel tools and publish the same typed
  UI events, but they do not verify browser mounting or pixels.
- project lifecycle flows must create real projects (scaffolding records files
  as working edits via `vcs.edit`, then seals them with `vcs.commit`), fork
  panel and worker sources, open the result, and inspect snapshots/state
- CDP/Playwright automation must be able to mutate browser UI, type/click,
  evaluate DOM state, and take screenshots through runtime panel handles
- panel tests require explicit final fields such as `handle=<panel-id>`,
  `url=<current-url>`, and `bytes=<byte-count>`; do not rely on prose that only
  mentions a panel ID, URL, or byte count indirectly
- historical console diagnostics must expose host-captured general logs and a
  separate error buffer through `handle.cdp.consoleHistory()`
- unit diagnostics must expose persisted worker/DO/extension logs and separate
  error buffers through `workspace.units.diagnostics(name)`
- server host logs must be accessible through `serverLog.query/tail/stats`, and
  live following must use `server-log:append` or the `about/server-logs` viewer
- GAD diagnostic APIs must provide bounded summaries for storage,
  publication, turn, invocation, hash, branch, and file/state probes
- harness failures must surface visibly for thrown evals, huge eval returns,
  timeout-style errors, invalid tool arguments, and post-tool follow-up turns
- external Git interop must go through the documented gitInterop surface with
  disposable local remotes when real provider credentials are absent; tests
  accept explicit `*_UNAVAILABLE` markers only with a concrete blocking reason
- advanced VCS paths (revert, previewBuild of working content, fileHistory,
  pendingMerge inspection, rebaseContext, edit provenance, recall) are exercised
  separately from the core edit → commit → push loop
- identity-aware surfaces must work from a normal agent context: account
  profile, workspace members, live presence, and channel rosters that
  distinguish human from agent participants
- operational read-only surfaces (serverLog, unit diagnostics/versions,
  recurring jobs, heartbeats, permissions, approval queue) must be inspectable
  with bounded output and without mutating scheduler or approval state
- credential and webhook lifecycles are tested with obviously fake artifacts
  that are revoked at the end and must never surface secret values in
  transcripts
- eval sandbox lifecycle (persistent `db` across calls, scope reset freshness,
  cancellation of long runs) is covered beyond single-shot eval execution

The `docsProbeTests` suite uses realistic user goals and asks agents to choose
the relevant skills themselves. These tests avoid doc recitation and instead
check concrete decisions, bounded evidence, and clear reports when documented
paths do not work.

For SQLite-backed userland storage, the canonical pattern is `this.sql` inside
a Durable Object service, not eval `db`. Tests for app databases should cover
the DO methods directly with `createTestDO(...)` and, when testing panels/apps,
also verify `workers.resolveService(protocol, objectKey?)` plus
`rpc.call(targetId, method, args)` from the actual caller kind. Keep the fast
`createTestDO(...)` test co-located with its real worker, and use a disposable
worker owned by the system-test fixture for the workerd integration path.

## Filtering

```typescript
await tester.runSuite(allTests(), { category: "filesystem" });
await tester.runSuite(allTests(), { name: "fs-write-read" });
```

## How It Works

Each test case:

1. Prepares any declared workspace repo fixture and clears stale namespaced artifacts
2. Spawns a fresh headless session (new channel + new AiChatWorker DO)
3. Appends the shared system-test agent prompt from `runner.ts`
4. Sends a short natural-language prompt telling the test agent what goal to accomplish
5. Waits for the agent to become idle (debounce-based turn completion)
6. Captures a full snapshot: messages, invocation diagnostics, debug events, cleanup diagnostics, participants
7. Validates programmatically and returns structured results
8. Closes the session and tears down the declared fixture, surfacing cleanup failures

The test agent is a standard AiChatWorker with full eval + set_title tools and
full-auto approval. The shared system-test prompt tells it that it is testing
the harness, should choose relevant skills itself, should report setup/tool/API
mismatches clearly, should not hunt for unrelated workarounds, and should keep
evidence bounded. Individual test prompts should stay as vague as possible:
state the user-visible goal and required final marker, not the API mechanics,
object shapes, edge cases, or workaround steps the skill docs are supposed to
teach. If an agent fails because docs are missing or misleading, fix the docs or
runtime; do not narrow the test prompt to route around the failure.

For a test that creates or forks a workspace repo, declare
`workspaceRepoFixture: true` instead of putting a fixed test name or cleanup
instructions in its prompt. The harness serializes such cases, supplies the
reserved repository basename through the system-test environment, cleans only that
namespace, and records fixture setup/teardown in `execution.diagnostics`.

## Auto-Start as Initial Panel

See `meta/vibestudio.yml` for the current testing agent configuration.

## Build Model

**The model is edit → commit → push, a three-layer pipeline.** `vcs.edit` records
UNCOMMITTED working changes on your context head — tracked durably with provenance
and projected to disk, but NOT a commit: no head advance, no vcs.log entry, no
build. `vcs.commit(message)` folds your uncommitted edits into a deliberate
snapshot per repo, advancing the context head. `vcs.push` is fast-forward-only: it
ships committed changes into the repo's `main` and is the authoritative build gate.
When fixing bugs in workspace source files (`apps/`, `extensions/`, `packages/`,
`panels/`, `workers/`, `skills/`), edit with the `edit`/`write` tools or `vcs.edit`
(the working content projects to disk so a `vcs.previewBuild` sees it), then
`vcs.commit` to seal the change and `vcs.push` to build + ship it. Do not edit via
`fs.writeFile` and expect it to be tracked: the worktree is a disposable projection
and the VCS reads GAD state, so the edit must land on the head via the edit tools.

When a loose system test asks for VCS status, logs, or diffs, use the documented
runtime API shape rather than guessing from filesystem terms:

- `vcs.status(repoPath, head?)` reports a repo head's unpushed changes vs the repo's own `main` (a GAD state-diff, not filesystem dirtiness) plus an `uncommitted` count of working edits; `repoPath` is a positional repo path (e.g. `panels/chat`) and the optional second arg is a materialized head such as `main` or `ctx:...`.
- `vcs.edit({ edits })` records UNCOMMITTED working edits on your per-repo context head (routing each edit to its owning repo by path) and returns `stateHash`, `editSeq`, and `changedPaths` with `committed: false`. It does NOT commit, advance the head, or build.
- `vcs.commit({ message })` folds your uncommitted edits into a snapshot per repo (`message` mandatory), advancing each context head; returns per-repo results with `stateHash` and `editCount`. `exclude` leaves listed paths uncommitted.
- `vcs.discardEdits(repoPath)` drops a repo's uncommitted working edits (and any pending merge), restoring the committed head on disk.
- `vcs.diff(leftStateHash, rightStateHash)` compares repo-rooted committed state hashes. To build at one of those states, first call `vcs.workspaceViewWithRepoAt(repoPath, repoStateHash)` and pass the returned workspace-rooted `stateHash` to `build.getBuild`.
- `vcs.readFile({ path: "path", repoPath })` reads from a repo's current head (working content included).
- `vcs.pushStatus(["panels/chat"])` reports how far each repo is ahead of its `main` (pre-push), its `uncommitted` count, and whether it has `diverged`, without moving anything.
- `vcs.push({ repoPaths: ["panels/chat"] })` fast-forwards committed changes into each repo's `main`, build-gated. It REJECTS while edits are uncommitted (commit first) and, on divergence (main moved past your base), returns a structured `{ status: "diverged", divergences }` instead of pushing. Reconcile with `vcs.merge(repoPath)`, `vcs.commit(message)`, then re-push so it fast-forwards. Multiple repoPaths push as one atomic group.

Pass a positional repo path to `vcs.status`; do not pass workspace roots, cwd
values, or filesystem paths to `vcs.status` or `vcs.diff`.

GAD VCS implementation files live under `src/server/services/vcsService.ts`,
`src/server/gadVcs/`, and the runtime client
`workspace/packages/runtime/src/shared/vcsClient.ts`. Do not look for
`packages/runtime/src/server/vcs/vcs.ts`; that path is not part of this
workspace layout.

For trusted app failures under `apps/`, read `skills/appdev/SKILL.md` before
changing shell, mobile, or terminal app source. App bugs often involve approval
identity, capabilities, native bootstrap, or target-specific build artifacts.

For Vibestudio application source (`src/server/`, `src/main/`, root
`packages/*`), use a plain checkout under `projects/vibestudio`. In normal mode
that prepares a branch/patch but does not hot-patch the running server. In
dogfood server mode (`pnpm dev:self:server`), the workspace contains
`meta/dogfood.json`, but host-checkout mirroring is unavailable under GAD VCS.
Treat `projects/vibestudio` as an external Git project used to
prepare a branch or patch; it does not hot-patch the running server. See
[SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) for the full workflow and the
userland detection snippet.

## Environment Compatibility

This skill can run from server-side eval, workers, Durable Objects, or panels.
In eval/worker/DO contexts the orchestrator must use its own `rpc.selfId` as the
PubSub participant id. It then spawns separate headless test sessions for the
individual test agents.
