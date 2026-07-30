import { describe, expect, it } from "vitest";
import {
  onboardingInteraction,
  resolveOnboardingSelection,
  resolveTemplateSelection,
  templateCatalogInteraction,
  templateUrlInteraction,
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

  it("routes mobile installation through the verified template catalog", () => {
    expect(
      resolveOnboardingSelection(onboardingInteraction("connection.device", "install"))
    ).toEqual(
      expect.objectContaining({
        action: "install",
        ownerSkillPath: "skills/phone-setup/SKILL.md",
        target: { via: "template-catalog", templateId: "mobile" },
      })
    );
  });

  it("routes catalog and pasted addresses by typed template interactions", () => {
    const catalog = templateCatalogInteraction(
      "news-agent-and-panel",
      "a".repeat(40),
      `v1-sha256:${"b".repeat(64)}`
    );
    expect(resolveTemplateSelection(catalog)).toEqual({
      target: { via: "template-composer" },
      interaction: catalog,
    });
    expect(resolveTemplateSelection(templateUrlInteraction("https://example.test/template.git"))).toEqual({
      target: { via: "template-composer" },
      interaction: templateUrlInteraction("https://example.test/template.git"),
    });
    expect(() =>
      resolveTemplateSelection({
        ...templateCatalogInteraction(
          "retired",
          "a".repeat(40),
          `v1-sha256:${"b".repeat(64)}`
        ),
        registryCommit: "",
      })
    ).toThrow("Template add selection is invalid");
  });
});
