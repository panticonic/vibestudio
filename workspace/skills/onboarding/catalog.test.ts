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
});
