import { describe, expect, it } from "vitest";
import { onboardingInteraction, resolveOnboardingSelection } from "./routing.js";

describe("onboarding selection routing", () => {
  it("resolves a stable capability id to its owner workflow", () => {
    const resolved = resolveOnboardingSelection(
      onboardingInteraction("connection.github", "setup")
    );
    expect(resolved).toEqual(
      expect.objectContaining({
        action: "setup",
        ownerSkillPath: "skills/github/SKILL.md",
        target: { via: "owner-skill" },
      })
    );
  });

  it("fails visibly for unknown ids and unsupported actions", () => {
    expect(() =>
      resolveOnboardingSelection(onboardingInteraction("connection.retired", "setup"))
    ).toThrow("Unknown or retired onboarding capability");
    expect(() =>
      resolveOnboardingSelection(onboardingInteraction("connection.github", "change"))
    ).toThrow("does not offer the change action");
  });
});
