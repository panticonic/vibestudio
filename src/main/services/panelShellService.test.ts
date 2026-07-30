import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { buildPanelViewHandler } from "./panelShellService.js";
import { panelMethods } from "@vibestudio/service-schemas/panel";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";

const appCtx: ServiceContext = { caller: createVerifiedCaller("@workspace-apps/shell", "app") };
const panelCtx: ServiceContext = { caller: createVerifiedCaller("panel:chat", "panel") };

function createServiceHarness(appCapabilities: string[] = []) {
  const setCurrentTheme = vi.fn();
  const broadcastTheme = vi.fn();
  const setCurrentThemeConfig = vi.fn();
  const broadcastThemeConfig = vi.fn();
  const themeConfig = {
    accentColor: "violet",
    grayColor: "mauve",
    radius: "medium" as const,
    scaling: "100%" as const,
    panelBackground: "translucent" as const,
  };
  const getThemeConfig = vi.fn(() => themeConfig);
  const ensureLoaded = vi.fn(async () => ({
    panelId: "panel-1",
    status: "loaded",
    focused: false,
    loaded: true,
  }));
  const takeOverPanel = vi.fn(async () => ({
    panelId: "panel-1",
    status: "loaded",
    focused: true,
    loaded: true,
  }));
  const markBrowserNavigationIntent = vi.fn();
  const reload = vi.fn();
  const forceReload = vi.fn();
  const getFocusedPanelId = vi.fn(() => "panel-1");
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

  const handler = buildPanelViewHandler({
    panelOrchestrator: {
      setCurrentTheme,
      broadcastTheme,
      setCurrentThemeConfig,
      broadcastThemeConfig,
      getThemeConfig,
      ensureLoaded,
      takeOverPanel,
      getPanelViewRevision: vi.fn(() => 4),
      refreshPanelProjection: vi.fn(async () => ({
        id: "panel-1",
        title: "Panel 1",
        children: [],
        snapshot: { source: "about/new", contextId: "ctx-1", options: {} },
        artifacts: {},
      })),
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
      getFocusedPanelId,
      findParentId: vi.fn(() => null),
      getRootPanels: vi.fn(() => []),
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
    service: {
      name: "view",
      authority: { principals: ["user", "code"] },
      methods: panelMethods,
      handler,
    } satisfies ServiceDefinition,
    setCurrentTheme,
    broadcastTheme,
    setCurrentThemeConfig,
    broadcastThemeConfig,
    getThemeConfig,
    themeConfig,
    ensureLoaded,
    takeOverPanel,
    markBrowserNavigationIntent,
    reload,
    forceReload,
    getFocusedPanelId,
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

    expect(harness.setCurrentTheme).toHaveBeenCalledWith("dark");
    expect(harness.broadcastTheme).toHaveBeenCalledWith("dark");

    // Theme identity (accent/radius/…) sets + broadcasts live to panels.
    const config = { ...harness.themeConfig, accentColor: "blue" };
    await harness.service.handler(appCtx, "updateThemeConfig", [config]);
    expect(harness.setCurrentThemeConfig).toHaveBeenCalledWith(config);
    expect(harness.broadcastThemeConfig).toHaveBeenCalled();
    expect(await harness.service.handler(appCtx, "getThemeConfig", [])).toEqual(
      harness.themeConfig
    );
    expect(harness.markBrowserNavigationIntent).toHaveBeenCalledWith("panel-1", {
      transition: "reload",
    });
    expect(harness.serverClient.call).not.toHaveBeenCalled();
    expect(harness.serverClient.callAs).not.toHaveBeenCalled();
  });

  it("denies apps without panel-hosting capability", async () => {
    const harness = createServiceHarness();

    await expect(
      harness.service.handler(appCtx, "markBrowserNavigationIntent", [
        "panel-1",
        { transition: "reload" },
      ])
    ).rejects.toThrow(/panel-hosting/);
    expect(harness.markBrowserNavigationIntent).not.toHaveBeenCalled();
  });

  it("allows panel runtimes to read the live theme config", async () => {
    const harness = createServiceHarness();

    await expect(harness.service.handler(panelCtx, "getThemeConfig", [])).resolves.toEqual(
      harness.themeConfig
    );
  });

  it("exposes only the theme config getter to panel callers through dispatch policy", async () => {
    const harness = createServiceHarness();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(harness.service);
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(panelCtx, "view", "getThemeConfig", [])).resolves.toEqual(
      harness.themeConfig
    );

    await expect(
      dispatcher.dispatch(panelCtx, "view", "markBrowserNavigationIntent", [
        "panel-1",
        { transition: "reload" },
      ])
    ).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(harness.markBrowserNavigationIntent).not.toHaveBeenCalled();
  });

  it("denies bootstrap shell callers", async () => {
    const harness = createServiceHarness(["panel-hosting"]);

    await expect(
      harness.service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "markBrowserNavigationIntent",
        ["panel-1", { transition: "reload" }]
      )
    ).rejects.toThrow(/restricted to app callers/);
    expect(harness.markBrowserNavigationIntent).not.toHaveBeenCalled();
  });

  it("does not expose panel-tree mutation proxy methods", async () => {
    const harness = createServiceHarness(["panel-hosting"]);

    await expect(harness.service.handler(appCtx, "archive", ["panel-1"])).rejects.toThrow(
      /Unknown view method/
    );
    await expect(harness.service.handler(appCtx, "create", ["about/new"])).rejects.toThrow(
      /Unknown view method/
    );
    await expect(
      harness.service.handler(appCtx, "navigate", ["panel-1", "about/new"])
    ).rejects.toThrow(/Unknown view method/);
    expect(harness.serverClient.call).not.toHaveBeenCalled();
    expect(harness.serverClient.callAs).not.toHaveBeenCalled();
  });
});
