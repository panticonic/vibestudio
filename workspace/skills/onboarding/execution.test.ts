import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  callMain: vi.fn(),
  openPanel: vi.fn(),
}));

import { executeOnboardingSelection } from "./execution";
import { onboardingInteraction } from "./routing";

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

    expect(deps.openShellSurface).toHaveBeenCalledWith("connection-settings");
    expect(deps.openWorkspacePanel).toHaveBeenCalledWith("about/credentials");
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
});
