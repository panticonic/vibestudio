import { describe, expect, it } from "vitest";
import {
  onboardingInteraction,
  onboardingTemplateInteraction,
  resolveOnboardingSelection,
  resolveOnboardingTemplateSelection,
} from "./routing.js";

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
      resolveOnboardingSelection(onboardingInteraction("migration.browser-environment", "setup"))
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

  it("does not invent a template route for a base capability", () => {
    expect(() =>
      resolveOnboardingSelection({
        ...onboardingInteraction("connection.device", "setup"),
        action: "install" as never,
      })
    ).toThrow("connection.device does not offer the install action");
  });

  it("resolves optional template choices to the canonical Templates owner and URL", () => {
    expect(
      resolveOnboardingTemplateSelection(onboardingTemplateInteraction("template.news"))
    ).toEqual(
      expect.objectContaining({
        ownerSkillPath: "skills/templates/SKILL.md",
        url: "git+https://github.com/panticonic/vibestudio-template-news.git",
      })
    );
    expect(() =>
      resolveOnboardingTemplateSelection(onboardingTemplateInteraction("template.retired"))
    ).toThrow("Unknown or retired onboarding template");
  });
});
