import { describe, expect, it } from "vitest";

import { docsProbeTests } from "./docs-probes.js";
import { projectLifecycleTests } from "./project-lifecycle.js";

describe("project lifecycle prompts", () => {
  it("keep panel lifecycle prompts goal-level", () => {
    const panelPrompts = projectLifecycleTests
      .filter((test) => test.name.startsWith("panel-"))
      .map((test) => test.prompt);

    expect(panelPrompts).toEqual([
      "Create and open a brand-new isolated panel project. Finish with PROJECT_PANEL_OK.",
      "Fork an existing panel into a new isolated panel and open the result. Finish with PROJECT_FORK_OK.",
    ]);

    for (const prompt of panelPrompts) {
      expect(prompt).not.toContain("publish/build");
      expect(prompt).not.toContain("Unknown build unit");
      expect(prompt).not.toContain("do not emit the success marker");
      expect(prompt).not.toContain("Close any temporary opened panel handle");
    }
  });

  it("keeps docs workspace-dev probe broad", () => {
    const probe = docsProbeTests.find((test) => test.name === "docs-workspace-dev-change-loop");

    expect(probe?.prompt).toContain("Create, publish, and inspect a tiny isolated panel project.");
    expect(probe?.prompt).not.toContain("Unknown build unit");
    expect(probe?.prompt).not.toContain("do not emit the success markers");
    expect(probe?.prompt).not.toContain("Close any temporary opened panel handle");
  });
});
