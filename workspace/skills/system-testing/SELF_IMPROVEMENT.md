# Self-Improvement Workflow

When system tests reveal bugs in Vibestudio, follow this workflow to fix them.

For unattended live runs, launch a disposable server with
`vibestudio remote serve --dev --auto-approve`. This reuses the host's existing
development approval-queue auto-approver, including credential and userland
requests that are separate from chat tool approval levels.

## Priority: Fix Infrastructure First

**Never work around broken infrastructure in skills or prompts.** If an RPC method returns unintuitive results, has a confusing signature, swallows errors, or doesn't exist when it should — fix the service, not the caller. The goal is a platform where agents can discover how to use APIs naturally from skill documentation, without needing implementation tricks.

Concretely:

- **RPC method doesn't work as expected** → fix the service in `src/server/services/`, not the eval code calling it
- **API requires unintuitive parameters** → fix the API signature, add sensible defaults, improve error messages
- **Error is swallowed or unclear** → surface it properly with a descriptive message
- **Capability missing** → add it to the service layer, don't hack a workaround in eval
- **Skill docs are misleading** → fix the docs AFTER fixing the underlying API

Only after the infrastructure is solid should you adjust skills or test prompts.
The test agent should be able to accomplish any task with minimal hints — if it
can't, the platform has a bug. Keep system-test prompts as vague as possible:
state the user-visible goal and final marker, not the API mechanics, object
shapes, or workaround steps the docs are supposed to teach.

## Phase 1: Run Tests

For an external CLI orchestrator, run the exact test or selected category with
`vibestudio system-test run`, then use `inspect`, `trajectory`, and `rerun` as
documented in `skills/vibestudio-agent/SYSTEM_TESTING.md`. The feedback UI and
stage cards below apply only to an interactive workspace chat agent that
actually advertises those UI tools.

Start by presenting the user with a feedback UI so they can choose which stages
to run. A stage is a category-sized group by default, so stages can contain more
than three tests. Keep one eval call per stage, run as much concurrency inside
that stage as is feasible, publish a concise user-visible report after each
stage, then continue to the next selected stage.

Store the full stage/run scaffold in `scope`; return only the compact control
data needed to render the feedback form. Do not return `scope.systemTestingRun`,
the full stage list, or test result arrays from eval calls.

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

Before running any tests, show a feedback form populated from the initialization
eval's `stageOptions` and `defaultStages`, then store the selected stage indexes
on `scope.systemTestingRun.selectedStageIndexes`. The selection eval should
return only a compact selection summary, such as selected stage count and
selected test count, while leaving the selected stage objects in `scope`. Do not
hard-code stage names or counts; they must come from the current system-testing
skill exports. If the user cancels, stop and report that no tests were run.

Then run the next selected stage with this eval. This eval must be invoked once
per stage and must not contain a `for`, `while`, or recursive loop over stages.
After it returns, publish/report the stage findings in the normal assistant
turn. If `remainingStages` is greater than `0`, continue by issuing this same
eval again as a new tool call.

Run the short stage-loop snippet directly in eval. File-loaded eval remains
preferred for substantive multi-line or multi-file code, but helper files should
not be used merely to wrap this stage loop. If eval cannot be called, report
the exact failed eval attempt and its exact error; helper-file edit/write/read
errors are separate setup failures.

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

    const runner = new HeadlessRunner(ctx.contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("  Running: " + t.name + "..."),
      onTestEnd: (t, r, ex) => console.log("  " + (r.passed ? "PASS" : "FAIL") + ": " + t.name + " (" + ex.duration + "ms)"),
      onTestResult: (_entry, aggregate) => {
        console.log("  Stage progress: " + stage.name + " " + aggregate.total + "/" + stage.tests.length);
      },
    });

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
    const toolFailureNames = partial.results
      .filter((entry) => (entry.execution.toolFailures?.length ?? 0) > 0)
      .map((entry) => {
        const tools = entry.execution.toolFailures.map((failure) => failure.name).join(", ");
        return entry.test.name + ": " + entry.execution.toolFailures.length + " tool failure(s): " + tools;
      });
    const remainingStages = selectedStages.filter((item) => !completed.has(item.index)).length;
    const stageSummary = {
      index: stage.index,
      name: stage.name,
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
    const reportLines = [
      "**System Test Stage " + stagePosition + "/" + selectedStages.length + ": " + stage.name + "**",
      "- Stage results: " + partial.passed + " passed, " + partial.failed + " failed, " + partial.errored + " errored",
      "- Concurrency: " + concurrency + " test agents",
      "- Cumulative results: " + aggregate.passed + " passed, " + aggregate.failed + " failed, " + aggregate.errored + " errored, " + aggregate.skipped + " not run/skipped",
      failedNames.length ? "- Findings: " + failedNames.join("; ") : "- Findings: no failures in this stage",
      "- Next: " + (remainingStages ? "continuing to the next selected stage" : "all selected stages complete"),
    ];
    await chat.publish("message", { content: reportLines.join("\\n") });

    return {
      runId: run.runId,
      stage: stage.name,
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

## Phase 2: Analyze Failures

Full test state lives in `scope.results.results`, with compact per-stage
summaries in `scope.systemTestingRun.stageSummaries`. Eval return values are
only progress/control packets; do not use them as the diagnostic record.

Tool failures are not automatically task failures. If a subagent hits a tool
error and then recovers enough to satisfy validation, keep the test as passed
but report the tool failure as an investigation item. Do not trim messages or
snapshots from passing results; the top-level agent needs the full raw evidence
to determine whether the issue is runtime, docs, harness, or expected recovery.
`summarizeFailures(scope.results)` includes both failed tests and passed tests
with tool failures, so use it as the bounded investigation packet before
drilling into the full raw session state.

For each failed test, inspect **everything** — the conversation, every tool call and its result, harness lifecycle, and participant state. Never hand off only filenames or artifact paths. A useful report must say what the test agent did, where it diverged from the expected marker/behavior, what tool calls completed or errored, and whether the failure looks like runtime, docs, harness, or test validation.

Start with the bounded summary helper:

```typescript
import { summarizeFailures } from "@workspace-skills/system-testing/diagnostics";
return summarizeFailures(scope.results);
```

Then drill into any failure whose summary does not explain the mismatch:

```typescript
for (const r of scope.results.results.filter((r) => !r.result.passed)) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`FAIL: ${r.test.name} (${r.test.category})`);
  console.log(`Prompt: ${r.test.prompt}`);
  console.log(`Validation: ${r.result.reason}`);
  console.log(`Duration: ${r.execution.duration}ms`);
  if (r.execution.error) console.log(`Session error: ${r.execution.error}`);

  // 1. Full conversation — every message exchanged
  console.log(`\n--- Conversation (${r.execution.messages.length} messages) ---`);
  const selfId = r.execution.messages[0]?.senderId;
  for (const m of r.execution.messages) {
    const who = m.senderId === selfId ? "USER" : "AGENT";
    const type = m.contentType ?? m.kind ?? "text";
    console.log(`  [${who}] (${type}) ${m.content?.slice(0, 500) ?? "(empty)"}`);
    if (m.error) console.log(`    ERROR: ${m.error}`);
  }

  // 2. Invocation cards — every tool call, args, return value, errors
  const snap = r.execution.snapshot;
  if (snap?.invocations.length) {
    console.log(`\n--- Invocations (${snap.invocations.length} calls) ---`);
    for (const inv of snap.invocations) {
      console.log(`  [${inv.status}] ${inv.name}`);
      if (inv.error) console.log(`    Error: ${inv.error}`);
    }
  }

  // 3. Debug events — harness lifecycle (spawn, start, stop, crash)
  if (snap?.debugEvents.length) {
    console.log(`\n--- Debug Events (${snap.debugEvents.length}) ---`);
    for (const ev of snap.debugEvents) {
      console.log(`  ${JSON.stringify(ev).slice(0, 300)}`);
    }
  }

  // 4. Participants — who joined, who disconnected
  if (snap?.participants) {
    console.log(`\n--- Participants ---`);
    for (const [id, p] of Object.entries(snap.participants)) {
      console.log(
        `  ${p.name} (${p.type}/${p.handle}): ${p.connected ? "connected" : "DISCONNECTED"}`
      );
    }
  }
}
```

If lifecycle events show `turn.opened` but no assistant message, tool call, or
`turn.closed`, compare durable GAD health with the activation-local agent view:

```typescript
const health = await gad.inspectAgentHealth({ channelId: chat.channelId });
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The local snapshot never hydrates its folded loop through GAD. Treat
`loaded: false` as an explicit activation-local absence and use `health` for
durable terminality and provenance. For an out-of-band or cross-channel probe,
use the channel DO's bounded `inspectAgent` path described in
`docs/agent-debug-port.md`.

VCS publication is semantic ancestry/integration validation, approval, and an
atomic protected-ref update; it does not run or certify a build. Invoke an
explicit build against the test context when build confidence is part of the
test. If a failure appears on the state-triggered post-publication build path,
inspect the build event buffer before repairing source:

```typescript
// Eval uses the same portable `rpc.call(target, method, args)` shape as panels/workers.
// Raw server services target "main".
return {
  recent: await rpc.call("main", "build.listRecentBuildEvents", []),
  forUnit: await rpc.call("main", "build.listRecentBuildEvents", ["panels/example"]),
  unit: await rpc.call("main", "build.inspectBuildProvenance", ["panels/example"]),
};
```

`build.listRecentBuildEvents` can be filtered with a unit name or
workspace-relative path. State-triggered events identify the exact build
revision and changed workspace view. Correlate the explicit check or derived
artifact with the semantic event and test trajectory; never treat the build as
publication authority. For activation failures, verify the new artifact was
rejected and the previous runnable artifact remained selected.

## Phase 3: Classify the Root Cause

For each failure, determine the root cause category and act accordingly:

### Infrastructure bugs (fix the platform)

- **RPC method returns wrong data** → fix the service handler
- **RPC method missing** → add it to the service definition
- **Error swallowed silently** → add proper error propagation
- **API signature unintuitive** → redesign the API, add defaults, improve types
- **Missing capability** → implement it in the service layer
- **Service not registered** → add it to the server or Electron ServiceContainer; only add true Electron-local services to `ELECTRON_LOCAL_SERVICE_NAMES`

### Documentation bugs (fix the docs)

- **Skill docs describe a different API** → update the skill docs to match reality
- **Skill docs missing a capability** → add documentation for the undocumented feature
- **System prompt misleads the agent** → fix the headless system prompt

### Test bugs (fix the test — last resort)

- **Validation too strict** → loosen the validator, but only after confirming the agent's response is correct
- **Prompt truly underspecified** → clarify only the user-visible goal or required output marker; never add implementation details that hide a docs or runtime bug
- **Long-running task** → inspect where progress stopped and fix the blocked operation
- **Published test work survives into a later run** → select
  `CONTENT_WORKSPACE_REPO_FIXTURE` on the mutating `TestCase`, or
  `BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE` when the behavior requires a real
  buildable package; do not add a fixed repository basename, seed recipe, or
  cleanup steps to the user prompt. The harness imports one exact
  `system-test-*` repository on a fresh task line without publishing it. If a
  task event reaches main, cleanup intersects that first-parent task line with
  current main history and counteracts only the published task work, newest
  first, before one commit and push. This also removes extra repository
  identities the task authored and reports them as a scope failure. Newer local
  work and a fixture that never reached main disappear with the task context.
  The harness never inventories or prefix-deletes ambient sibling work, invents
  a fixture-only deletion path, or serializes fixture tests behind a global
  lock.

**Default assumption: the infrastructure is wrong, not the test.** Only classify as a test bug after reading the service code and confirming the API works correctly.

## Phase 4: Identify Files to Change

| Symptom                       | Likely files                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fs operation failed           | `src/server/services/fsService.ts`, `workspace/packages/runtime/src/panel/fs.ts`                                                                                                               |
| DO storage operation failed   | `src/server/internalDOs/*`, `workspace/packages/runtime/src/worker/durable-base.ts`                                                                                                            |
| Semantic VCS operation failed | `packages/service-schemas/src/vcs.ts`, `src/server/services/vcsService.ts`, `workspace/packages/semantic-control-plane/src/semanticVcs*`, `workspace/packages/runtime/src/shared/vcsClient.ts` |
| external Git operation failed | `packages/git/src/client.ts`, `src/server/services/gitInteropService.ts`                                                                                                                       |
| Build failed                  | `src/server/buildV2/`, `build.mjs`                                                                                                                                                             |
| Worker/DO issue               | `src/server/services/workerService.ts`, `workspace/packages/runtime/src/worker/`                                                                                                               |
| Panel lifecycle               | `src/main/panelOrchestrator.ts`, `src/server/services/bridgeService.ts`                                                                                                                        |
| Credential/OAuth error        | `src/server/services/credentialService.ts`, `workspace/packages/runtime/src/shared/credentials.ts`                                                                                             |
| Harness crash                 | `workspace/packages/harness/src/entry.ts`, `src/server/harnessManager.ts`                                                                                                                      |
| PubSub issue                  | `workspace/packages/pubsub/src/`, `workspace/workers/pubsub-channel/`                                                                                                                          |
| Skill import                  | `src/server/buildV2/`, package.json exports                                                                                                                                                    |
| Agent behavior                | `workspace/workers/agent-worker/ai-chat-worker.ts`, harness config                                                                                                                             |
| RPC routing                   | `src/shared/serviceDispatcher.ts`, `packages/rpc/src/`                                                                                                                                         |
| Error swallowed               | Search for `.catch(` and empty catch blocks near the failure site                                                                                                                              |

## Phase 5: Prepare an Editable Checkout

Pick the checkout type based on what failed.

### Workspace Runtime Source

If the bug is in workspace-owned runtime source — from your file root that is
`apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, or `skills/` —
edit the files directly in your context with the `edit`/`write` tools. Then use
the canonical [Vibestudio VCS protocol](../vibestudio-vcs/SKILL.md): retain the
exact working state, integrate current main through local incremental decisions
when necessary, commit the complete local chain, and publish the exact committed
event. These trees are live build inputs.

For `apps/` bugs, read `skills/appdev/SKILL.md` before
editing. App fixes can require target-specific validation: Electron host chrome,
mobile native bootstrap and principal grants, or terminal process supervision.

### Vibestudio Application Source

If the bug is in the Vibestudio application itself, such as `src/server/`,
`src/main/`, or root `packages/*`, use a plain project checkout under
`projects/vibestudio`.

#### Dogfood Server Mode

When the operator launched Vibestudio with:

```bash
pnpm dev:self:server
```

the active workspace is a managed dogfood workspace. The launcher creates or
reuses `~/.config/vibestudio/workspaces/dogfood/source/projects/vibestudio` and
writes `meta/dogfood.json`.

In this mode, `projects/vibestudio` is still a plain project, not a Build V2
runtime unit, but it is a **self-edit target**:

- Host-checkout mirroring is an external effect of the semantic VCS; it is not
  a second authority available to the test subject.
- Changes in `projects/vibestudio` prepare an external Git branch or patch; they
  do not hot-patch the running Vibestudio server.
- Verification requires restarting Vibestudio from that checkout, applying the
  patch in the host checkout, or handing the branch to a developer.
- Restarting from a patched host checkout still does not import that checkout's
  `workspace/` subtree into an existing semantic workspace. Publish workspace
  runtime changes through semantic VCS, or use a freshly seeded pre-release
  workspace whose exact `systemEpoch` matches the host. Never clear only the
  build cache to force a mixed host/userland generation.

Userland code can detect this mode by reading `meta/dogfood.json`:

```typescript
// `fs` is injected in eval (context-scoped) — do not import it.
async function getDogfoodInfo() {
  try {
    return JSON.parse(await fs.readFile("meta/dogfood.json", "utf-8"));
  } catch {
    return null;
  }
}

const dogfood = await getDogfoodInfo();
if (dogfood?.schemaVersion === 1 && dogfood.project === "projects/vibestudio") {
  console.log("Dogfood server mode:", dogfood.sourceRoot);
}
```

Do not rely on `VIBESTUDIO_DOGFOOD` from userland. That environment variable is a
server launcher detail; `meta/dogfood.json` is the workspace-visible marker.

#### Normal Project Mode

When the server is not running in dogfood mode, plain projects are editable
repos, not runtime units. Changing `projects/vibestudio` prepares a branch/patch,
but it does not hot-patch the running Vibestudio server. Verification may require
restarting Vibestudio from that checkout or handing the branch to a developer.

Prefer an existing `projects/vibestudio` workspace repo when it exists. If it
does not exist yet and the workspace is not dogfood-managed, import it with
`git.importProject()`. That uses one workspace config approval showing the
destination path, remote URL, and branch; records the shared remote and matching
upstream with `autoPush: false` in `meta/vibestudio.yml`; and clones one exact
Git snapshot as a committed semantic candidate. It does not propagate that
candidate into protected `main`. Integrate and publish the candidate through the
ordinary VCS protocol before using it as shared source. The same API can import
panels, packages, skills, workers, templates, about pages, and plain projects by
choosing the destination path.

```
eval({
  code: `
    // In eval, fs is injected and the git client maps to the gitInterop service.
    const dir = "projects/vibestudio";
    try {
      await fs.stat(dir);
      console.log(dir + " already exists");
    } catch {
      const imported = await git.importProject({
        path: dir,
        remote: {
          name: "origin",
          url: "https://github.com/YOUR_ORG/vibestudio.git",
          branch: "main",
        },
      });
      console.log("Import candidate:", imported.candidate);
    }

    scope.checkoutDir = dir;
    return dir;
  `,
})
```

**Important:** Work on a branch before making changes.

```typescript
const branchName = `fix/system-test-${failedTestName}`;
import { GitClient } from "@vibestudio/git";
import { credentials, fs } from "@workspace/runtime";
const externalGit = new GitClient(fs, { http: credentials.gitHttp() });
await externalGit.createBranch({ dir: scope.checkoutDir, name: branchName });
await externalGit.checkout(scope.checkoutDir, branchName);
```

## Phase 6: Edit and Fix

Edit source files in the checkout using fs operations. For a Vibestudio
application checkout, paths are relative to `projects/vibestudio/`:

```typescript
const content = await fs.readFile("projects/vibestudio/src/server/services/fsService.ts", "utf-8");
// ... modify content ...
await fs.writeFile("projects/vibestudio/src/server/services/fsService.ts", fixedContent);
```

**Fix checklist:**

- [ ] Service method has clear parameter types and returns useful data
- [ ] Errors are propagated with descriptive messages (no empty catch blocks)
- [ ] The fix is in the service/infrastructure layer, not a workaround in caller code
- [ ] Skill documentation matches the actual API after the fix

## Phase 7: Publish, then Verify

For workspace-owned source, publication is a semantic protocol:

1. Observe the context's exact working state, committed event, and current main.
2. Confirm the repair is represented by coherent work units and changes, not
   only by projected bytes.
3. If main moved, compare its exact event and incorporate incoming changes
   through truthful local adopt/reconcile/decline decisions.
4. Commit the complete local application chain, adding the integrated source
   event as a parent when applicable.
5. Run explicit checks against the context when the repair needs build or type
   confidence; their diagnostics are advisory and move no ref.
6. Push the exact clean committed event against the main event you observed.
7. Treat ancestry, integration, authorization, approval, or atomic-ref failure
   as a typed no-write result. Repair the cause and continue from newly observed
   state.
8. Inspect post-publication build and activation projections separately. A
   failed activation must retain the previous runnable artifact while the
   published source remains on `main`.

Every semantic mutation has a stable `commandId`. Retry the same ID only for an
identical request whose response may have been lost. After a freshness failure
or any request change, re-observe the basis and use a new ID. See
[typed recovery](../vibestudio-vcs/references/typed-recovery.md).

For plain external project repositories, continue to use `@vibestudio/git`
with `credentials.gitHttp()`. External Git commits and pushes do not hot-patch
the running server; restart from that checkout or hand off the branch/patch
before retesting server changes.

Choose the restart boundary that owns the changed code:

- For host-only changes, restart the current source server. Host modules load
  from the checkout on each process start.
- For changes under `workspace/` (including this skill, agents, workers, and
  userland packages), stop the current server and start
  `pnpm server:live --ephemeral`. The ephemeral workspace is copied fresh from
  the checkout template. A named `--bootstrap-workspace` is durable product
  state: restarting it correctly preserves its semantic source and build
  projections, so it must never be treated as a checkout-sync mechanism.

Before assuming a repair failed, verify:

- the test's context and active build ref correspond to the returned event;
- the intended work unit, changes, and application are present;
- the publication receipt points at the committed event, while any build
  artifact separately names that exact semantic state;
- a moved file retained its `fileId`, or a copied file has the expected new ID
  plus its exact `authored-copy-source` relation and `copies-content` mappings;
- the source server was restarted when host code changed, and workspace-source
  changes were exercised through a fresh ephemeral checkout;
- external project changes were actually applied to the server under test.
- every worker/DO runtime image selects the intended context/main state and
  its build metadata derives from that exact semantic state;
- the manifest's `systemEpoch` matches the host before any runtime starts.

Then rerun the exact failed test through the CLI, followed by its category and
smoke coverage. Inspect any new failure trajectory rather than adding prompt
instructions or timing delays.

## Phase 8: Iterate or Finalize

```typescript
if (retest.result.passed) {
  console.log(`Fix verified on branch: ${branchName}`);
} else {
  console.log("Fix didn't work. Iterating...");
  // Go back to Phase 6 — edit, publish, rebuild, re-test
}
```

## Tips

- **Start with the smallest relevant exact test.** Run `doctor` and discover its
  current name first; run the affected category and smoke only after the exact
  test passes.
- **Keep each repair semantically coherent.** Don't bundle unrelated fixes.
- **Use the isolated semantic task context for workspace-owned source.** Create
  a Git branch only when editing a plain external project repository.
- **Check type errors before committing.** Use the `@workspace-extensions/typecheck-service` extension.
- **Re-run the full smoke suite after fixing.** Your fix might break something else.
- **Declare typed repository fixtures.** Any agentic case that may create or
  fork workspace source must select the `projects/...` content fixture or the
  seeded `packages/...` buildable-package fixture. The baseline is local; normal
  `vcs.push` is what makes it shared. Cleanup derives the newest published task
  event from exact event ancestry and counteracts that task's published semantic
  work in reverse causal order; it does not infer ownership from paths or a
  workspace inventory.
- **Use `projects/` for plain external repos.** They are editable and can have
  shared remotes, but they are not live runtime units.
- **Shared remotes are transport declarations.** `git.setSharedRemote()` records
  and propagates remotes for a workspace repo that exists or will exist later;
  startup completion asks the provider's `upstreamStatus` and imports only
  `not-materialized` checkouts.
- **Use `git.importProject()` to create a workspace repo from a remote.** It
  clones into operational server state under `state/git-checkouts/`, records the
  shared remote and matching upstream with auto-push off, and returns a
  committed candidate context and event. Compare and integrate that candidate
  incrementally, check it, commit the complete chain, and explicitly publish it
  before treating the repo as available to other contexts. Build V2 reads exact
  semantic/CAS state, never this checkout. Use the destination path to choose
  the category, such as `panels/name`, `skills/name`, `workers/name`, or
  `projects/name`.
- **Use `git.completeWorkspaceDependencies()` as a retry/backfill.** It imports
  each configured upstream whose provider status is `not-materialized` and
  reports imported, skipped, and failed paths, including candidate coordinates
  for each successful import. Other provider-reported states are skipped as
  `already-materialized`, including `integration-required`. Pass
  `{ credentialId }` for private repo retries; startup auto-import has no
  interactive credential argument.
- **If an API is confusing, fix the API.** Don't add comments explaining the confusion.
- **If an error message is unhelpful, fix the error message.** Don't add try/catch wrappers that translate it.
- **If a service is missing a method, add the method.** Don't chain multiple calls to work around it.
