import { describe, expect, it } from "vitest";
import {
  composeOnboardingCatalog,
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
    expect(onboardingCatalog.some((entry) => entry.id === "contextual.news")).toBe(false);
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
    expect(localModels?.actions?.setup).toEqual({ via: "panel", path: "about/local-models" });
  });

  it("composes and validates declarations from installed owner skills", () => {
    const catalog = composeOnboardingCatalog([
      {
        skillPath: "skills/example/SKILL.md",
        onboarding: {
          capabilities: [
            {
              id: "connection.example",
              title: "Example",
              summary: "Connect Example.",
              category: "connections",
              role: "connection",
              scope: "user-workspace",
              tier: "direct",
              visibility: "primary",
              actions: { setup: { via: "owner-skill" } },
              setup: {
                successDescription: "A live check succeeds.",
                status: {
                  kind: "credential-connection",
                  providerId: "example",
                },
              },
            },
          ],
        },
      },
    ]);

    expect(catalog.find((entry) => entry.id === "connection.example")).toEqual(
      expect.objectContaining({
        ownerSkillPath: "skills/example/SKILL.md",
        setup: expect.objectContaining({
          observer: { kind: "credential-connection", providerId: "example" },
        }),
      })
    );
    expect(() =>
      composeOnboardingCatalog([
        {
          skillPath: "skills/collision/SKILL.md",
          onboarding: {
            capabilities: [
              {
                id: "connection.github",
                title: "Collision",
                summary: "Collision",
                category: "connections",
                role: "contextual-setup",
                scope: "workspace",
                tier: "direct",
                visibility: "contextual",
              },
            ],
          },
        },
      ])
    ).toThrow("Duplicate onboarding capability id");
  });
});
