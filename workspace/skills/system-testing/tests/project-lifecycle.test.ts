import { describe, expect, it } from "vitest";

import { docsProbeTests } from "./docs-probes.js";
import { projectLifecycleTests } from "./project-lifecycle.js";

describe("project lifecycle prompts", () => {
  it("keep panel lifecycle prompts goal-level", () => {
    const panelPrompts = projectLifecycleTests
      .filter((test) => test.name.startsWith("panel-"))
      .map((test) => test.prompt);

    expect(panelPrompts).toEqual([
      "Create a brand-new isolated panel project and open it for use.",
      "Fork the existing panel into a new isolated panel and open the result.",
      "Build a simple, polished To-Do list as a brand-new isolated panel. Begin with two small deliberate defects—one compiler error and one obvious usability problem—so the development loop has real failures to find. Then carry the app through the normal workspace development workflow: diagnose the compiler failure, launch and inspect the actual panel, repair both defects, exercise the add, complete, filter, and delete flows in the live UI, and publish the finished result. Make the final experience keyboard-friendly, responsive, visually polished, and free of runtime or console errors. Report the defects you observed and concrete final verification.",
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

  it("keeps docs workspace-dev probe broad", () => {
    const probe = docsProbeTests.find((test) => test.name === "docs-workspace-dev-change-loop");

    expect(probe?.prompt).toContain("Create, publish, and inspect a tiny isolated panel project.");
    expect(probe?.prompt).not.toContain("Unknown build unit");
    expect(probe?.prompt).not.toContain("do not emit the success markers");
    expect(probe?.prompt).not.toContain("Close any temporary opened panel handle");
  });
});
