import { describe, expect, it, vi } from "vitest";

import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { SHELL_SURFACE_KINDS } from "@vibestudio/shared/shellSurface";
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
    shellSurfaces: () => SHELL_SURFACE_KINDS,
    onOpenShellSurface,
  });
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return { service, dispatcher, viewManager, appOrchestrator, onOpenShellSurface };
}

function appCaller() {
  return createVerifiedCaller("@workspace-apps/shell", "app", {
    callerId: "@workspace-apps/shell",
    callerKind: "app",
    repoPath: "apps/shell",
    effectiveVersion: "ev-shell",
    executionDigest: "a".repeat(64),
    requested: ["external.open", "open-external", "panel-hosting"].map((capability) => ({
      capability,
      resource: { kind: "prefix" as const, prefix: "" },
    })),
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
    expect(onOpenShellSurface).toHaveBeenCalledWith({ kind: "connection-settings" });
    await expect(
      dispatcher.dispatch(codeCtx, "app", "openShellSurface", ["invented"])
    ).rejects.toThrow();
  });

  it("opens the command agent overlay about a panel with a pre-filled prompt", async () => {
    const { dispatcher, onOpenShellSurface } = makeService();
    const panelCtx = { caller: createVerifiedCaller("panel:nav-tour", "panel") };
    const target = {
      kind: "command-agent",
      panelId: "panel:tree/panels~tour/abc",
      mode: "quickfire",
      prompt: "Add a scene about builds.",
    };

    await expect(
      dispatcher.dispatch(panelCtx, "app", "openShellSurface", [target])
    ).resolves.toBeUndefined();
    expect(onOpenShellSurface).toHaveBeenCalledWith(target);
    await expect(
      dispatcher.dispatch(panelCtx, "app", "openShellSurface", [
        { kind: "command-agent", autoSend: true },
      ])
    ).rejects.toThrow();
  });

  it("opens About pages and panel commands, and describes what the host supports", async () => {
    const { dispatcher, onOpenShellSurface } = makeService();
    const codeCtx = { caller: createVerifiedCaller("do:onboarding", "do") };
    await dispatcher.dispatch(codeCtx, "app", "openShellSurface", [
      { kind: "about", page: "permissions" },
    ]);
    expect(onOpenShellSurface).toHaveBeenLastCalledWith({ kind: "about", page: "permissions" });
    await dispatcher.dispatch(codeCtx, "app", "openShellSurface", [
      { kind: "panel-command", panelId: "panel:tree/x", commandId: "tour-next" },
    ]);
    expect(onOpenShellSurface).toHaveBeenLastCalledWith({
      kind: "panel-command",
      panelId: "panel:tree/x",
      commandId: "tour-next",
    });
    await expect(
      dispatcher.dispatch(codeCtx, "app", "openShellSurface", [{ kind: "about", page: "../etc" }])
    ).rejects.toThrow(/About page/);
    await expect(dispatcher.dispatch(codeCtx, "app", "describeShellSurfaces", [])).resolves.toEqual(
      {
        surfaces: [...SHELL_SURFACE_KINDS],
      }
    );
  });

  it("rejects surfaces this host does not support and says which it does", async () => {
    const onOpenShellSurface = vi.fn();
    const service = createAppService({
      panelOrchestrator: {} as never,
      serverClient: null,
      getViewManager: () => ({}) as never,
      connectionMode: "local",
      shellSurfaces: () => ["about"],
      onOpenShellSurface,
    });
    const ctx = { caller: createVerifiedCaller("do:onboarding", "do") };
    await expect(
      service.handler(ctx, "openShellSurface", [{ kind: "command-agent", prompt: "x" }])
    ).rejects.toThrow(/cannot open the "command-agent" surface \(available: about\)/);
    await expect(service.handler(ctx, "describeShellSurfaces", [])).resolves.toEqual({
      surfaces: ["about"],
    });
    expect(onOpenShellSurface).not.toHaveBeenCalled();
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
    await expect(
      unavailable.handler(
        { caller: createVerifiedCaller("do:onboarding", "do") },
        "describeShellSurfaces",
        []
      )
    ).resolves.toEqual({ surfaces: [] });
  });
});
