import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ServerClient } from "../serverClient.js";
import { panelMethods } from "@vibestudio/service-schemas/panel";
import {
  buildPanelChromeState,
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type AddressProviderBrowserDataAdapter,
  type PanelAddressOptions,
  type BrowserAddressOptions,
  type PanelChromeState,
} from "@vibestudio/shared/panelChrome";
import { createBrowserDataClient } from "@vibestudio/browser-data";
import { requireAppCapability, requireChromeCaller } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

async function getPanelAddressOptions(
  source: string,
  serverClient?: ServerClient | null
): Promise<PanelAddressOptions> {
  return getSharedPanelAddressOptions({
    source,
    repoProvider: serverClient ? createRepoAdapter(serverClient) : null,
  });
}

async function getBrowserAddressOptions(
  query: string,
  registry: PanelRegistry,
  serverClient?: ServerClient | null
): Promise<BrowserAddressOptions> {
  return getSharedBrowserAddressOptions({
    query,
    panels: registry.getSerializablePanelTree(),
    browserData: serverClient ? createBrowserDataAdapter(serverClient) : null,
  });
}

function createRepoAdapter(serverClient: ServerClient) {
  return {
    // The workspace.sourceTree RPC is untyped here; loosened to fit AddressProviderRepoAdapter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceTree: () => serverClient.call("workspace", "sourceTree", []) as Promise<any>,
  };
}

function createBrowserDataAdapter(serverClient: ServerClient): AddressProviderBrowserDataAdapter {
  const client = createBrowserDataClient(serverClient);
  return {
    searchHistoryForAutocomplete: (query, limit) =>
      client.searchHistoryForAutocomplete(query, limit),
    getHistory: (query) => client.getHistory(query),
    searchBookmarks: (query) => client.searchBookmarks(query),
    getSearchEngines: () => client.getSearchEngines(),
  };
}

function requirePanelHostingAppCapability(
  ctx: ServiceContext,
  viewManager: ViewManager,
  method: string
): void {
  requireAppCapability(ctx, viewManager, "panel-hosting", `panel.${method}`);
}

export function createPanelShellService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  panelView: PanelView;
  getViewManager: () => ViewManager;
  serverClient?: ServerClient | null;
}): ServiceDefinition {
  return {
    name: "panel",
    description: "Electron-local panel view helpers",
    policy: { allowed: ["shell", "app"] },
    methods: panelMethods,
    handler: defineServiceHandler("panel", panelMethods, {
      updateTheme: (ctx, [theme]) => {
        const lifecycle = deps.panelOrchestrator;
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "updateTheme");
        lifecycle.setCurrentTheme(theme);
        lifecycle.broadcastTheme(theme);
        return;
      },
      updateThemeConfig: (ctx, [config]) => {
        const lifecycle = deps.panelOrchestrator;
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "updateThemeConfig");
        lifecycle.setCurrentThemeConfig(config);
        lifecycle.broadcastThemeConfig();
        return;
      },
      getThemeConfig: () => deps.panelOrchestrator.getThemeConfig(),
      getTreeSnapshot: (ctx) => {
        requireChromeCaller(ctx, deps.getViewManager(), "panel.getTreeSnapshot");
        return deps.panelRegistry.getPanelTreeSnapshot();
      },
      getFocusedPanelId: (ctx) => {
        requireChromeCaller(ctx, deps.getViewManager(), "panel.getFocusedPanelId");
        return deps.panelRegistry.getFocusedPanelId();
      },
      getChromeState: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getChromeState");
        const panel = deps.panelRegistry.getPanel(panelId);
        if (!panel) throw new Error(`Panel not found: ${panelId}`);
        return buildPanelChromeState({ panel }) satisfies PanelChromeState;
      },
      getAddressOptions: (ctx, [source]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getAddressOptions");
        return getPanelAddressOptions(source, deps.serverClient);
      },
      getBrowserAddressOptions: (ctx, [query]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getBrowserAddressOptions");
        return getBrowserAddressOptions(query, deps.panelRegistry, deps.serverClient);
      },
      ensureLoaded: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "ensureLoaded");
        return deps.panelOrchestrator.ensureLoaded(panelId);
      },
      takeOver: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "takeOver");
        return deps.panelOrchestrator.takeOverPanel(panelId);
      },
      markBrowserNavigationIntent: (ctx, [panelId, intent]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "markBrowserNavigationIntent");
        deps.panelView.markBrowserNavigationIntent?.(panelId, intent);
        return;
      },
      reloadView: (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "reloadView");
        vm.reload(panelId);
        return;
      },
      forceReloadView: (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "forceReloadView");
        vm.forceReload(panelId);
        return;
      },
      togglePin: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "togglePin");
        return deps.panelOrchestrator.togglePanelPin(panelId);
      },
      listPinnedPanelIds: (ctx) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "listPinnedPanelIds");
        return deps.panelOrchestrator.listPinnedPanelIds();
      },
    }),
  };
}
