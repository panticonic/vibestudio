import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialsMock = vi.hoisted(() => ({
  getClientConfigStatus: vi.fn(),
  listStoredCredentials: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  browserData: {},
  callMain: vi.fn(),
  createDurableObjectServiceClient: vi.fn(() => ({ call: vi.fn() })),
  credentials: credentialsMock,
  extensions: {},
  git: {},
  openExternal: vi.fn(),
  openPanel: vi.fn(),
}));

import {
  createCredentialConnectionStatusAdapter,
  createStatusAdapters,
  type OnboardingStatusDependencies,
} from "./status.js";

function dependencies(
  overrides: Partial<OnboardingStatusDependencies> = {}
): OnboardingStatusDependencies {
  return {
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
  beforeEach(() => {
    vi.clearAllMocks();
    credentialsMock.getClientConfigStatus.mockResolvedValue({ configured: true });
    credentialsMock.listStoredCredentials.mockResolvedValue([]);
  });

  it("keeps declared credential presence distinct from live verification", async () => {
    credentialsMock.listStoredCredentials.mockResolvedValue([
      {
        id: "google-credential",
        metadata: { providerId: "google-workspace" },
        accountIdentity: { email: "person@example.test" },
      },
    ]);
    credentialsMock.fetch.mockResolvedValue(
      new Response(JSON.stringify({ email: "verified@example.test" }))
    );
    const adapter = createCredentialConnectionStatusAdapter(
      {
        kind: "credential-connection",
        providerId: "google-workspace",
        clientConfigId: "google-workspace",
        verifyUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        identityField: "email",
      },
      "Google Workspace"
    );

    await expect(adapter()).resolves.toEqual(
      expect.objectContaining({
        state: "connected-unverified",
        verification: "unverified",
      })
    );
    await expect(adapter({ verify: true })).resolves.toEqual(
      expect.objectContaining({
        state: "connected",
        verification: "verified",
        summary: "Verified as verified@example.test.",
      })
    );
  });

  it("reports an unconfigured declared credential connection without provider literals", async () => {
    credentialsMock.getClientConfigStatus.mockResolvedValue({ configured: false });
    const adapter = createCredentialConnectionStatusAdapter(
      {
        kind: "credential-connection",
        providerId: "example-provider",
        clientConfigId: "example-provider",
      },
      "Example Provider"
    );

    await expect(adapter()).resolves.toEqual({
      state: "not-configured",
      summary: "Example Provider needs provider setup before an account can connect.",
      attention: "optional",
      rawStage: "needs-setup",
    });
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
