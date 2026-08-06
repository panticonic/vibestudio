import { describe, expect, it } from "vitest";
import {
  onboardingCatalog,
  validateOnboardingCatalog,
  type OnboardingCapabilityDefinition,
} from "./catalog.js";

describe("onboarding catalog", () => {
  it("has unique stable ids and satisfies setup/action ownership invariants", () => {
    expect(validateOnboardingCatalog()).toEqual([]);
    expect(new Set(onboardingCatalog.map((entry) => entry.id)).size).toBe(onboardingCatalog.length);
  });

  it("keeps ready capabilities out of setup state", () => {
    const invalid: OnboardingCapabilityDefinition[] = [
      {
        id: "capability.invalid",
        title: "Invalid",
        summary: "Invalid",
        category: "ready-now",
        role: "ready-capability",
        scope: "workspace",
        tier: "direct",
        visibility: "primary",
        setup: {
          statusAdapter: "invented",
          successDescription: "Should not exist",
        },
      },
    ];
    expect(validateOnboardingCatalog(invalid)).toContain(
      "capability.invalid cannot declare setup status"
    );
  });

  it("routes credential and grant management to their real owners", () => {
    for (const entry of onboardingCatalog.filter((item) => item.role === "connection")) {
      if (entry.actions && "inspect" in entry.actions) {
        expect(entry.actions.inspect).toEqual({ via: "about-page", page: "credentials" });
        expect(entry.actions.revoke).toEqual({ via: "about-page", page: "credentials" });
        expect(entry.actions.grants).toEqual({ via: "about-page", page: "permissions" });
      }
    }
  });

  it("describes only capabilities shipped in the base workspace", () => {
    expect(JSON.stringify(onboardingCatalog)).not.toContain('"via":"template"');
    expect(JSON.stringify(onboardingCatalog)).not.toContain('"install"');
  });

  it("uses the concise browser import label", () => {
    expect(
      onboardingCatalog.find((entry) => entry.id === "migration.browser-environment")?.title
    ).toBe("Browser import");
  });

  it("routes Local Models through its shipped panel instead of a nonexistent skill", () => {
    const localModels = onboardingCatalog.find(
      (entry) => entry.id === "configuration.local-models"
    );
    expect(localModels?.ownerSkillPath).toBeUndefined();
    expect(localModels?.actions?.setup).toEqual({ via: "panel", path: "panels/local-models" });
  });
});
