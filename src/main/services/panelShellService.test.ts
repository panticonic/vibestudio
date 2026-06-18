import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createPanelShellService } from "./panelShellService.js";

const appCtx: ServiceContext = { caller: createVerifiedCaller("@workspace-apps/shell", "app") };

function createServiceHarness(appCapabilities: string[] = []) {
  const setCurrentTheme = vi.fn();
  const broadcastTheme = vi.fn();
  const markBrowserNavigationIntent = vi.fn();
  const reload = vi.fn();
  const forceReload = vi.fn();
  const getViewInfo = vi.fn(() => ({
    type: "app",
    visible: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    capabilities: appCapabilities,
  }));
  const serverClient = {
    call: vi.fn(),
    callAs: vi.fn(),
  };

  const service = createPanelShellService({
    panelOrchestrator: {
      setCurrentTheme,
      broadcastTheme,
    } as never,
    panelRegistry: {
      getPanel: vi.fn(() => ({
        id: "panel-1",
        title: "Panel 1",
        children: [],
        snapshots: [{ source: "about/new", contextId: "ctx-1", options: {} }],
        currentIndex: 0,
        artifacts: {},
      })),
      getSerializablePanelTree: vi.fn(() => []),
    } as never,
    panelView: {
      markBrowserNavigationIntent,
    } as never,
    getViewManager: () =>
      ({
        getViewInfo,
        reload,
        forceReload,
      }) as never,
    serverClient: serverClient as never,
  });

  return {
    service,
    setCurrentTheme,
    broadcastTheme,
    markBrowserNavigationIntent,
    reload,
    forceReload,
    serverClient,
  };
}

describe("PanelShellService", () => {
  it("allows Electron-local host helpers for panel-hosting apps", async () => {
    const harness = createServiceHarness(["panel-hosting"]);

    await harness.service.handler(appCtx, "updateTheme", ["dark"]);
    await harness.service.handler(appCtx, "markBrowserNavigationIntent", [
      "panel-1",
      { transition: "reload" },
    ]);
    await harness.service.handler(appCtx, "reloadView", ["panel-1"]);
    await harness.service.handler(appCtx, "forceReloadView", ["panel-1"]);

    expect(harness.setCurrentTheme).toHaveBeenCalledWith("dark");
    expect(harness.broadcastTheme).toHaveBeenCalledWith("dark");
    expect(harness.markBrowserNavigationIntent).toHaveBeenCalledWith("panel-1", {
      transition: "reload",
    });
    expect(harness.reload).toHaveBeenCalledWith("panel-1");
    expect(harness.forceReload).toHaveBeenCalledWith("panel-1");
    expect(harness.serverClient.call).not.toHaveBeenCalled();
    expect(harness.serverClient.callAs).not.toHaveBeenCalled();
  });

  it("denies apps without panel-hosting capability", async () => {
    const harness = createServiceHarness();

    await expect(harness.service.handler(appCtx, "reloadView", ["panel-1"])).rejects.toThrow(
      /panel-hosting/
    );
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("denies bootstrap shell callers", async () => {
    const harness = createServiceHarness(["panel-hosting"]);

    await expect(
      harness.service.handler({ caller: createVerifiedCaller("shell", "shell") }, "reloadView", [
        "panel-1",
      ])
    ).rejects.toThrow(/restricted to app callers/);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("does not expose panel-tree mutation proxy methods", async () => {
    const harness = createServiceHarness(["panel-hosting"]);

    await expect(harness.service.handler(appCtx, "archive", ["panel-1"])).rejects.toThrow(
      /Unknown panel method/
    );
    await expect(harness.service.handler(appCtx, "create", ["about/new"])).rejects.toThrow(
      /Unknown panel method/
    );
    await expect(
      harness.service.handler(appCtx, "navigate", ["panel-1", "about/new"])
    ).rejects.toThrow(/Unknown panel method/);
    expect(harness.serverClient.call).not.toHaveBeenCalled();
    expect(harness.serverClient.callAs).not.toHaveBeenCalled();
  });
});
