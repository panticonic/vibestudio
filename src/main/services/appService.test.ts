import { describe, expect, it, vi } from "vitest";

import {
  createHostCaller,
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { createAppService } from "./appService.js";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  nativeTheme: {
    shouldUseDarkColors: false,
    themeSource: "system",
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
  },
}));

function makeService() {
  const appOrchestrator = {
    applyPendingAppUpdate: vi.fn(async () => true),
    listPendingAppUpdates: vi.fn(() => [{ appId: "@workspace-apps/shell" }]),
  };
  const viewManager = {
    getViewInfo: vi.fn((id: string) =>
      id === "@workspace-apps/shell"
        ? { type: "app", capabilities: ["open-external", "panel-hosting", "window-management"] }
        : null
    ),
    openDevTools: vi.fn(),
  };
  const service = createAppService({
    panelOrchestrator: { invalidateReadyPanels: vi.fn() } as never,
    serverClient: {
      call: vi.fn(async (serviceName: string, method: string) => {
        if (serviceName === "workspace" && method === "getInfo") return { path: "/workspace" };
        if (serviceName === "build" && method === "getAboutPages") return [];
        return null;
      }),
      getConnectionStatus: vi.fn(() => "connected"),
    } as never,
    getViewManager: () => viewManager as never,
    getAppOrchestrator: () => appOrchestrator as never,
    connectionMode: "local",
  });
  return { service, viewManager, appOrchestrator };
}

function authorityCtx(caller: VerifiedCaller, capabilities: readonly string[]): ServiceContext {
  return {
    caller,
    authority: {
      allows: vi.fn(async ({ capability }) => capabilities.includes(capability)),
      assert: vi.fn(async () => undefined),
    },
  };
}

describe("createAppService", () => {
  it("does not grant app-host capabilities to the bootstrap shell caller", async () => {
    const { service } = makeService();
    const shellCtx = authorityCtx(createVerifiedCaller("shell", "shell"), []);

    await expect(
      service.handler(shellCtx, "openExternal", ["https://example.com"])
    ).rejects.toThrow(/requires 'open-external' authority/);
    await expect(service.handler(shellCtx, "clearBuildCache", [])).rejects.toThrow(/panel-hosting/);
  });

  it("allows app callers with declared capabilities to use app-host surfaces", async () => {
    const { service } = makeService();
    const appCtx = authorityCtx(
      createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        executionDigest: "ev-shell",
        delegations: [],
        requested: [{ capability: "open-external", resource: { kind: "prefix", prefix: "" } }],
      }),
      ["open-external"]
    );

    await expect(
      service.handler(appCtx, "openExternal", ["https://example.com"])
    ).resolves.toBeUndefined();
  });

  it("lets shell and panel-hosting apps apply queued app updates", async () => {
    const { service, appOrchestrator } = makeService();
    const shellCtx = authorityCtx(createHostCaller("shell", "shell"), ["panel-hosting"]);
    const appCtx = authorityCtx(
      createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        executionDigest: "ev-shell",
        delegations: [],
        requested: [{ capability: "panel-hosting", resource: { kind: "prefix", prefix: "" } }],
      }),
      ["panel-hosting"]
    );

    await expect(
      service.handler(shellCtx, "applyUpdate", ["@workspace-apps/shell"])
    ).resolves.toEqual({ applied: true });
    await expect(service.handler(appCtx, "listPendingUpdates", [])).resolves.toEqual([
      { appId: "@workspace-apps/shell" },
    ]);
    expect(appOrchestrator.applyPendingAppUpdate).toHaveBeenCalledWith("@workspace-apps/shell");
  });
});
