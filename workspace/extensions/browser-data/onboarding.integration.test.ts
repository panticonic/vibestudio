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

import { createBrowserDataClient, type ImportJobSnapshot } from "@vibestudio/browser-data";
import { activate } from "./index.js";
import { composeOnboardingSnapshot } from "../../skills/onboarding/snapshot.js";
import {
  createStatusAdapters,
  type CapabilityOnboardingStatusAdapter,
  type OnboardingStatusDependencies,
} from "../../skills/onboarding/status.js";

const completedImport: ImportJobSnapshot = {
  jobId: "import-1",
  hostId: "host-1",
  sourceId: "source-1",
  phase: "complete",
  requestedDataTypes: ["bookmarks"],
  progress: [],
  warnings: [],
  resumable: false,
  startedAt: 1,
  updatedAt: 2,
  finishedAt: 2,
};

describe("onboarding browser-data component chain", () => {
  it("composes browser status through main and the activated provider with a stub store", async () => {
    const storeCall = vi.fn(async (_target: string, method: string) =>
      method === "listImportJobs" ? [completedImport] : []
    );
    const extension = await activate({
      rpc: {
        call: storeCall as unknown as <T>(
          targetId: string,
          method: string,
          ...args: unknown[]
        ) => Promise<T>,
        stream: vi.fn(async () => new Response()),
      },
      workers: {
        resolveService: vi.fn(async () => ({
          kind: "durable-object" as const,
          targetId: "do:vibestudio/internal:BrowserDataDO:environment-key",
          objectKey: "environment-key",
        })),
      },
      invocation: {
        current: () => ({
          caller: {
            callerId: "panel:onboarding",
            callerKind: "shell",
            userId: "user-1",
            workspaceId: "workspace-1",
          },
        }),
        signal: () => null,
      },
      log: { info: vi.fn() },
      health: { healthy: vi.fn(), degraded: vi.fn(), unhealthy: vi.fn() },
      emit: vi.fn(),
    });
    const provider = extension.providerContracts.browserData as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const routeCall = vi.fn(
      async (target: string, method: string, args: unknown[]): Promise<unknown> => {
        expect(target).toBe("main");
        expect(method).toBe("extensions.invokeProvider");
        const [namespace, providerMethod, providerArgs] = args as [string, string, unknown[]];
        expect(namespace).toBe("browserData");
        return provider[providerMethod]!(...providerArgs);
      }
    );
    const browserData = createBrowserDataClient({
      callService: (service, method, args) => routeCall("main", `${service}.${method}`, args),
    });
    const statusDeps = {
      google: vi.fn(),
      github: vi.fn(),
      modelSettings: vi.fn(),
      localModelsStatus: vi.fn(),
      localModelsList: vi.fn(),
      browserImportJobs: () => browserData.listImportJobs(),
      activeSearchProvider: vi.fn(),
    } as unknown as OnboardingStatusDependencies;
    const browserAdapter = createStatusAdapters(statusDeps)["browser-environment"]!;
    const ready: CapabilityOnboardingStatusAdapter = async () => ({
      state: "configured",
      summary: "Ready.",
      attention: "none",
    });
    const adapters = {
      "ai-provider": ready,
      "google-workspace": ready,
      github: ready,
      "browser-environment": browserAdapter,
      "local-models": ready,
      "agent-defaults": ready,
      "web-search": ready,
    };

    const snapshot = await composeOnboardingSnapshot(
      {},
      {
        adapters,
        readHostTopology: async () => ({
          devices: {
            availability: "available",
            pairedDeviceCount: 1,
            thisDevicePaired: true,
          },
          remote: {
            availability: "available",
            route: "local",
            workspaceCount: 1,
          },
        }),
        now: () => new Date("2026-07-25T12:00:00.000Z"),
      }
    );

    expect(snapshot.find((entry) => entry.id === "migration.browser-environment")).toEqual(
      expect.objectContaining({
        state: "configured",
        summary: "1 browser import completed.",
        rawStage: "complete",
      })
    );
    expect(routeCall).toHaveBeenCalledWith("main", "extensions.invokeProvider", [
      "browserData",
      "listImportJobs",
      [],
    ]);
    expect(storeCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:BrowserDataDO:environment-key",
      "listImportJobs"
    );
  });
});
