import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
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
  const onOpenShellSurface = vi.fn();
  const appOrchestrator = {
    applyPendingAppUpdate: vi.fn(async () => true),
    listPendingAppUpdates: vi.fn(() => [
      { appId: "@workspace-apps/shell", url: "https://updates.example/app" },
    ]),
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
        if (serviceName === "build" && method === "recompute") {
          return { changed: [], added: [], removed: [] };
        }
        return null;
      }),
      getConnectionStatus: vi.fn(() => "connected"),
    } as never,
    getViewManager: () => viewManager as never,
    getAppOrchestrator: () => appOrchestrator as never,
    connectionMode: "local",
    onOpenShellSurface,
  });
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return { service, dispatcher, viewManager, appOrchestrator, onOpenShellSurface };
}

function appCaller() {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../workspace/apps/shell/package.json", import.meta.url), "utf8")
  ) as {
    vibestudio: {
      authority: {
        requests: Array<{
          capability: string;
          resource: { kind: "exact"; key: string } | { kind: "prefix"; prefix: string };
        }>;
      };
    };
  };
  return createVerifiedCaller("@workspace-apps/shell", "app", {
    callerId: "@workspace-apps/shell",
    callerKind: "app",
    repoPath: "apps/shell",
    effectiveVersion: "ev-shell",
    executionDigest: "a".repeat(64),
    requested: manifest.vibestudio.authority.requests,
  });
}

describe("createAppService", () => {
  it("allows a live user-origin shell to exercise app host capabilities", async () => {
    const { dispatcher } = makeService();
    const shellCtx = { caller: createVerifiedCaller("shell", "shell") };

    await expect(
      dispatcher.dispatch(shellCtx, "app", "openExternal", ["https://example.com"])
    ).resolves.toBeUndefined();
    await expect(
      dispatcher.dispatch(shellCtx, "app", "clearBuildCache", [])
    ).resolves.toBeUndefined();
  });

  it("allows app callers with declared capabilities to use app-host surfaces", async () => {
    const { dispatcher } = makeService();
    const appCtx = { caller: appCaller() };

    await expect(
      dispatcher.dispatch(appCtx, "app", "openExternal", ["https://example.com"])
    ).resolves.toBeUndefined();
  });

  it("lets shell and panel-hosting apps apply queued app updates", async () => {
    const { dispatcher, appOrchestrator } = makeService();
    const shellCtx = { caller: createHostCaller("shell", "shell") };
    const appCtx = {
      caller: appCaller(),
    };

    await expect(
      dispatcher.dispatch(shellCtx, "app", "applyUpdate", ["@workspace-apps/shell"])
    ).resolves.toEqual({ applied: true });
    await expect(dispatcher.dispatch(appCtx, "app", "listPendingUpdates", [])).resolves.toEqual([
      { appId: "@workspace-apps/shell", url: "https://updates.example/app" },
    ]);
    expect(appOrchestrator.applyPendingAppUpdate).toHaveBeenCalledWith("@workspace-apps/shell");
  });

  it("opens only typed shell-owned management surfaces for code callers", async () => {
    const { dispatcher, onOpenShellSurface } = makeService();
    const codeCtx = { caller: createVerifiedCaller("do:onboarding", "do") };

    await expect(
      dispatcher.dispatch(codeCtx, "app", "openShellSurface", ["connection-settings"])
    ).resolves.toBeUndefined();
    expect(onOpenShellSurface).toHaveBeenCalledWith("connection-settings");
    await expect(
      dispatcher.dispatch(codeCtx, "app", "openShellSurface", ["invented"])
    ).rejects.toThrow();
  });

  it("does not claim shell navigation succeeded when the host has no navigation owner", async () => {
    const unavailable = createAppService({
      panelOrchestrator: {} as never,
      serverClient: null,
      getViewManager: () => ({}) as never,
      connectionMode: "local",
    });

    await expect(
      unavailable.handler(
        { caller: createVerifiedCaller("do:onboarding", "do") },
        "openShellSurface",
        ["connection-settings"]
      )
    ).rejects.toThrow("navigation is unavailable");
  });
});
