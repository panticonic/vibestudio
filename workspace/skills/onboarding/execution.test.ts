import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  callMain: vi.fn(),
  openPanel: vi.fn(),
}));

import { executeOnboardingSelection, executeTemplateSelection } from "./execution";
import { onboardingInteraction, templateCatalogInteraction } from "./routing";

function dependencies() {
  return {
    openWorkspacePanel: vi.fn(async () => undefined),
    openShellSurface: vi.fn(async () => undefined),
  };
}

describe("executeOnboardingSelection", () => {
  it("opens client-owned shell and About routes", async () => {
    const deps = dependencies();

    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.device", "setup"), deps)
    ).resolves.toEqual({
      handled: true,
      target: { via: "shell-navigation", target: "connection-settings" },
    });
    await executeOnboardingSelection(onboardingInteraction("connection.github", "inspect"), deps);
    await executeOnboardingSelection(
      onboardingInteraction("migration.browser-environment", "setup"),
      deps
    );

    expect(deps.openShellSurface).toHaveBeenCalledWith("connection-settings");
    expect(deps.openWorkspacePanel).toHaveBeenCalledWith("about/credentials");
    expect(deps.openWorkspacePanel).toHaveBeenCalledWith("about/browser-import-inspector");
  });

  it("returns existing owner workflows and rejects retired IDs", async () => {
    const deps = dependencies();

    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.github", "setup"), deps)
    ).resolves.toEqual({
      handled: false,
      target: { via: "owner-skill" },
      ownerSkillPath: "skills/github/SKILL.md",
    });
    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.retired", "setup"), deps)
    ).rejects.toThrow("Unknown or retired onboarding capability");
  });

  it("returns template selections to the userland composer workflow", () => {
    const interaction = templateCatalogInteraction(
      "base-dev-tools",
      "1".repeat(40),
      `v1-sha256:${"2".repeat(64)}`
    );
    expect(executeTemplateSelection(interaction)).toEqual({
      handled: false,
      target: { via: "template-composer" },
      interaction,
    });
  });
});
