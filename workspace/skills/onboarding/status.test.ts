import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  browserData: {},
  callMain: vi.fn(),
  createDurableObjectServiceClient: vi.fn(() => ({ call: vi.fn() })),
  credentials: {},
  extensions: {},
  git: {},
  openExternal: vi.fn(),
  openPanel: vi.fn(),
}));

import { createStatusAdapters, type OnboardingStatusDependencies } from "./status.js";

function dependencies(
  overrides: Partial<OnboardingStatusDependencies> = {}
): OnboardingStatusDependencies {
  return {
    google: vi.fn(async () => ({
      stage: "connected" as const,
      configured: true,
      readyToConnect: false,
      connected: true,
      credentials: [],
      nextActions: [],
      warnings: [],
    })),
    github: vi.fn(async () => ({
      stage: "needs-token" as const,
      connected: false,
      verified: false,
      credentials: [],
      nextActions: [],
      warnings: [],
    })),
    modelSettings: vi.fn(
      async () =>
        ({
          catalog: {
            providers: [],
            models: [
              {
                ref: "provider:model",
                name: "Model",
                availability: { state: "ready" },
              },
            ],
          },
          defaultModel: "provider:model",
          defaultModelSource: "workspace",
          defaultAgentConfig: { model: "provider:model" },
        }) as never
    ),
    localModelsStatus: vi.fn(
      async () =>
        ({
          fallback: { ready: false, warm: false },
          downloads: [],
        }) as never
    ),
    localModelsList: vi.fn(async () => []),
    browserImportJobs: vi.fn(async () => []),
    activeSearchProvider: vi.fn(async () => "duckduckgo" as const),
    hasSkill: vi.fn(async () => true),
    ...overrides,
  };
}

describe("onboarding status adapters", () => {
  it("keeps credential presence distinct from live verification", async () => {
    const deps = dependencies({
      google: vi
        .fn()
        .mockResolvedValueOnce({
          stage: "connected",
          connected: true,
          email: "person@example.test",
        })
        .mockResolvedValueOnce({
          stage: "verified",
          connected: true,
          email: "person@example.test",
          verification: { valid: true },
        }),
    });
    const adapters = createStatusAdapters(deps);

    await expect(adapters["google-workspace"]!()).resolves.toEqual(
      expect.objectContaining({
        state: "connected-unverified",
        verification: "unverified",
      })
    );
    await expect(adapters["google-workspace"]!({ verify: true })).resolves.toEqual(
      expect.objectContaining({
        state: "connected",
        verification: "verified",
      })
    );
  });

  it("treats the built-in search provider as a healthy default", async () => {
    await expect(createStatusAdapters(dependencies())["web-search"]!()).resolves.toEqual({
      state: "using-defaults",
      summary: "Built-in DuckDuckGo search is active.",
      attention: "none",
      rawStage: "duckduckgo",
    });
  });

  it("reports an explicitly failed connection check as attention", async () => {
    const adapters = createStatusAdapters(
      dependencies({
        github: vi.fn(
          async () =>
            ({
              stage: "connected",
              connected: true,
              verified: false,
              verification: { valid: false, error: "unauthorized" },
            }) as never
        ),
      })
    );
    await expect(adapters["github"]!({ verify: true })).resolves.toEqual(
      expect.objectContaining({
        state: "needs-attention",
        verification: "failed",
        attention: "blocking",
      })
    );
  });

  it("reports a missing shipped owner as unavailable before calling its status code", async () => {
    const google = vi.fn();
    const deps = dependencies({
      google,
      hasSkill: vi.fn(async (path) => path !== "skills/google-workspace/SKILL.md"),
    });
    await expect(createStatusAdapters(deps)["google-workspace"]!()).resolves.toEqual({
      state: "unavailable",
      summary:
        "Google Workspace is unavailable because its base capability owner could not be loaded.",
      attention: "blocking",
      rawStage: "owner-unavailable",
    });
    expect(google).not.toHaveBeenCalled();
  });

  it("queries the Local Models extension without inventing a skill owner", async () => {
    const hasSkill = vi.fn(async () => false);
    const defaults = dependencies({ hasSkill });
    const localModelsStatus = vi.fn(defaults.localModelsStatus);
    const localModelsList = vi.fn(defaults.localModelsList);
    const adapter = createStatusAdapters(
      dependencies({ localModelsStatus, localModelsList, hasSkill })
    )["local-models"]!;

    await expect(adapter()).resolves.toEqual({
      state: "using-defaults",
      summary: "Cloud models remain available; no local model is installed.",
      attention: "none",
      rawStage: "not-installed",
    });
    expect(localModelsStatus).toHaveBeenCalledOnce();
    expect(localModelsList).toHaveBeenCalledOnce();
    expect(hasSkill).not.toHaveBeenCalled();
  });
});
