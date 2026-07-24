import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";

import { docsProbeTests } from "./docs-probes.js";
import { projectLifecycleTests } from "./project-lifecycle.js";

function invocation(
  id: string,
  name: string,
  args: Record<string, unknown>,
  details: Record<string, unknown>
) {
  return {
    kind: "message" as const,
    senderId: "agent",
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id,
      name,
      arguments: args,
      execution: {
        status: "complete",
        isError: false,
        result: { protocolContent: [], details },
      },
    },
  };
}

function todoExecution(calls: ReturnType<typeof invocation>[]): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content:
          "I observed and repaired the compiler defect, then fixed the UX and verified add, complete, filter, and delete behavior.",
      },
    ],
  } as TestExecutionResult;
}

function mutation(applicationId: string) {
  return {
    storage: "vcs",
    vcsResult: {
      applicationId,
      workingHead: { kind: "application", applicationId },
    },
  };
}

describe("project lifecycle prompts", () => {
  it("keep panel lifecycle prompts goal-level", () => {
    const panelPrompts = projectLifecycleTests
      .filter((test) => test.name.startsWith("panel-"))
      .map((test) => test.prompt);

    expect(panelPrompts).toEqual([
      "Create a brand-new isolated panel project and open it for use.",
      "Fork the existing panel into a new isolated panel and open the result.",
      "Build a simple, polished To-Do list as a brand-new isolated panel. Begin with two small deliberate defects—one compiler error and one obvious usability problem—so the development loop has real failures to find. Observe the compiler defect through a structured compile or build check, then diagnose and repair only that failure while leaving the usability defect intact. Launch and inspect that compile-clean but visibly flawed panel, then repair the usability defect in a separate source edit. Refresh the same running panel with the repaired source, capture its appearance, exercise the add, complete, filter, and delete flows in the live UI, and publish the finished result. Make the final experience keyboard-friendly, responsive, visually polished, and free of runtime or console errors. Report the defects you observed and concrete final verification.",
    ]);

    for (const prompt of panelPrompts) {
      expect(prompt).not.toMatch(/finish with|respond with|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/iu);
      expect(prompt).not.toMatch(/createProject|forkProject|openPanel|dryRun/iu);
    }
  });

  it("declares repository creation scopes that match each lifecycle task", () => {
    const fixtureFor = (name: string) =>
      projectLifecycleTests.find((test) => test.name === name)?.workspaceRepoFixture;

    expect(fixtureFor("panel-create-commit-open")).toEqual({
      kind: "created-repository",
      section: "panels",
    });
    expect(fixtureFor("panel-fork-dry-run-and-commit")).toEqual({
      kind: "buildable-panel-with-derived",
      section: "panels",
    });
    expect(fixtureFor("commit-existing-project")).toEqual({
      kind: "created-repository",
      section: "packages",
    });
    expect(fixtureFor("panel-todo-debug-polish")).toEqual({
      kind: "created-repository",
      section: "panels",
    });
  });

  it("accepts canonical panel operations that combine build and browser evidence", () => {
    const test = projectLifecycleTests.find(({ name }) => name === "panel-todo-debug-polish")!;
    const source = "panels/todo";
    const uxApplicationId = "application:ux";
    const calls = [
      invocation(
        "create",
        "eval",
        { code: "createProject()" },
        {
          returnValue: {
            created: source,
            files: 2,
            preflight: { ok: true, projectType: "panel", checked: ["package.json"] },
            publication: {
              published: true,
              committedEventId: "event:create",
              publishedEventId: "event:create",
              mainEventId: "event:create",
              effectId: "effect:create",
            },
          },
        }
      ),
      invocation(
        "broken-edit",
        "write",
        { path: `${source}/src.tsx` },
        mutation("application:broken")
      ),
      invocation(
        "broken-build",
        "eval",
        { code: "getBuildReport()" },
        {
          returnValue: {
            repoPath: source,
            kind: "panel",
            status: "failed",
            diagnostics: [{ severity: "error", source: "tsc", message: "Expected token" }],
            builds: [],
          },
        }
      ),
      invocation(
        "compiler-repair",
        "write",
        { path: `${source}/src.tsx` },
        mutation("application:compiler")
      ),
      invocation(
        "clean-launch-and-inspect",
        "eval",
        { code: "openPanel(); handle.cdp.page(); handle.snapshot();" },
        {
          returnValue: [
            {
              source,
              phase: "ready",
              runtimeEntityId: "runtime:initial",
              buildKey: "build:initial",
            },
            {
              panelId: "panel:todo",
              runtimeEntityId: "runtime:initial",
              buildKey: "build:initial",
              capturedAt: 1,
              document: { kind: "synth", text: "Flawed todo" },
            },
          ],
        }
      ),
      invocation("ux-repair", "write", { path: `${source}/src.tsx` }, mutation(uxApplicationId)),
      invocation(
        "rebuild-and-verify",
        "eval",
        {
          code: "handle.rebuild(); handle.cdp.page(); screenshot(); field.fill('task'); button.click(); row.evaluate(() => true); filter.click(); active.click(); completed.click(); remove.click(); const consoleHistory = await handle.cdp.consoleHistory(); return { consoleErrors: consoleHistory.errors.length };",
        },
        {
          returnValue: [
            {
              source,
              phase: "ready",
              runtimeEntityId: "runtime:final",
              buildKey: "build:final",
            },
            { consoleErrors: 0 },
          ],
        }
      ),
      invocation(
        "commit",
        "commit",
        { message: "Polish To-Do UX" },
        {
          result: {
            committedApplicationIds: [uxApplicationId],
            event: { kind: "event", eventId: "event:ux" },
          },
        }
      ),
      invocation(
        "push",
        "push",
        {},
        {
          result: { eventId: "event:ux", mainEventId: "event:ux" },
        }
      ),
    ];

    expect(test.validate(todoExecution(calls))).toEqual({ passed: true, reason: undefined });

    const wrongBuildIdentity = calls.map((call) =>
      call.invocation.id === "broken-build"
        ? invocation("broken-build", "eval", call.invocation.arguments, {
            returnValue: {
              repoPath: "panels/unrelated",
              kind: "panel",
              status: "failed",
              diagnostics: [{ severity: "error", source: "tsc", message: "Expected token" }],
              builds: [],
            },
          })
        : call
    );
    expect(test.validate(todoExecution(wrongBuildIdentity)).passed).toBe(false);

    const pageAcquisitionWithoutInspection = calls.map((call) =>
      call.invocation.id === "clean-launch-and-inspect"
        ? invocation(
            "clean-launch-and-inspect",
            "eval",
            { code: "openPanel(); handle.cdp.page();" },
            call.invocation.execution.result.details
          )
        : call
    );
    expect(test.validate(todoExecution(pageAcquisitionWithoutInspection)).passed).toBe(false);

    const canonicalSnapshotEvidence = calls.map((call) =>
      call.invocation.id === "rebuild-and-verify"
        ? invocation(
            "rebuild-and-verify",
            "eval",
            {
              code: "handle.rebuild(); handle.cdp.page(); field.fill('task'); button.click(); row.evaluate(() => true); filter.click(); active.click(); completed.click(); remove.click(); const before = await handle.cdp.consoleHistory(); const snapshot = await handle.snapshot(); const after = await handle.cdp.consoleHistory(); return { beforeErrors: before.errors, afterErrors: after.errors, snapshot };",
            },
            {
              returnValue: [
                {
                  source,
                  phase: "ready",
                  runtimeEntityId: "runtime:final",
                  buildKey: "build:final",
                },
                {
                  beforeErrors: [],
                  afterErrors: [],
                  snapshot: {
                    panelId: "panel:todo",
                    runtimeEntityId: "runtime:final",
                    buildKey: "build:final",
                    capturedAt: 1,
                    document: { kind: "synth", text: "Todo" },
                  },
                },
              ],
            }
          )
        : call
    );
    expect(test.validate(todoExecution(canonicalSnapshotEvidence))).toEqual({
      passed: true,
      reason: undefined,
    });

    const dirtyPostInteractionConsole = canonicalSnapshotEvidence.map((call) =>
      call.invocation.id === "rebuild-and-verify"
        ? invocation("rebuild-and-verify", "eval", call.invocation.arguments, {
            returnValue: [
              {
                source,
                phase: "ready",
                runtimeEntityId: "runtime:final",
                buildKey: "build:final",
              },
              {
                beforeErrors: [],
                afterErrors: [{ level: "error", text: "interaction failed" }],
                snapshot: {
                  panelId: "panel:todo",
                  runtimeEntityId: "runtime:final",
                  buildKey: "build:final",
                  capturedAt: 1,
                  document: { kind: "synth", text: "Todo" },
                },
              },
            ],
          })
        : call
    );
    expect(test.validate(todoExecution(dirtyPostInteractionConsole)).passed).toBe(false);

    const fabricatedConsoleEvidence = calls.map((call) =>
      call.invocation.id === "rebuild-and-verify"
        ? invocation(
            "rebuild-and-verify",
            "eval",
            {
              code: "handle.rebuild(); handle.cdp.page(); screenshot(); field.fill('task'); button.click(); row.evaluate(() => true); filter.click(); active.click(); completed.click(); remove.click(); await handle.cdp.consoleHistory(); return { consoleErrors: 0 };",
            },
            call.invocation.execution.result.details
          )
        : call
    );
    expect(test.validate(todoExecution(fabricatedConsoleEvidence))).toEqual({
      passed: false,
      reason:
        "No final live-panel verification rebuilt the same panel, exercised add/complete/filter/delete behavior, captured the UI, and returned an empty console error list",
    });
  });

  it("asks the worker case to execute the dry run its validator observes", () => {
    const worker = projectLifecycleTests.find(
      (test) => test.name === "worker-fork-classmap-dry-run"
    );

    expect(worker?.prompt).toBe(
      "Perform and verify a safe isolated dry run of an existing worker fork."
    );
    expect(worker?.prompt).not.toMatch(/forkProject|dryRun\s*:/u);
  });

  it("keeps docs workspace-dev probe broad", () => {
    const probe = docsProbeTests.find((test) => test.name === "docs-workspace-dev-change-loop");

    expect(probe?.prompt).toContain("Create, publish, and inspect a tiny isolated panel project.");
    expect(probe?.prompt).not.toContain("Unknown build unit");
    expect(probe?.prompt).not.toContain("do not emit the success markers");
    expect(probe?.prompt).not.toContain("Close any temporary opened panel handle");
  });
});
