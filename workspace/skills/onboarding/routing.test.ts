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

  it("routes browser migration to its cohesive first-party workflow", () => {
    expect(
      resolveOnboardingSelection(
        onboardingInteraction("migration.browser-environment", "setup")
      )
    ).toEqual(
      expect.objectContaining({
        target: { via: "panel", path: "about/browser-import-inspector" },
      })
    );
  });

  it("routes model setup to the model-settings workflow instead of an agent questionnaire", () => {
    expect(
      resolveOnboardingSelection(onboardingInteraction("connection.ai-provider", "setup"))
    ).toEqual(
      expect.objectContaining({
        target: { via: "model-settings" },
      })
    );
  });
});
