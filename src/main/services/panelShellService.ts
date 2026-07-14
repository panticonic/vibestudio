import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ServerClient } from "../serverClient.js";
import { panelMethods } from "@vibestudio/service-schemas/panel";
import {
  buildPanelChromeState,
  isBrowserPanelSource,
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type AddressProviderBrowserDataAdapter,
  type PanelAddressOptions,
  type BrowserAddressOptions,
  type PanelChromeState,
  type PanelRepoState,
} from "@vibestudio/shared/panelChrome";
import { createBrowserDataClient } from "@vibestudio/browser-data";
import { getPanelSource } from "@vibestudio/shared/panel/accessors";
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { requirePanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";

async function getPanelAddressOptions(
  source: string,
  ref?: string,
  serverClient?: ServerClient | null
): Promise<PanelAddressOptions> {
  return getSharedPanelAddressOptions({
    source,
    ref,
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
    findUnitForPath: (source: string) =>
      serverClient.call("workspace", "findUnitForPath", [source]) as Promise<{
        unitPath: string;
        relativePath: string;
      } | null>,
    unitStatus: async (unitPath: string) => {
      // Per-repo VCS: `unitStatus` is gone — the unit path IS the repo path, so
      // use repo-native `status(repoPath)` (returns {stateHash, dirty}, no head).
      const status = (await serverClient.call("vcs", "status", [unitPath])) as {
        stateHash: string | null;
        dirty: boolean;
      };
      return {
        unitPath,
        head: null as string | null,
        stateHash: status.stateHash,
        dirty: status.dirty,
      };
    },
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

async function getRepoState(
  source: string,
  serverClient?: ServerClient | null
): Promise<PanelRepoState | undefined> {
  if (!serverClient || isBrowserPanelSource(source) || isAboutSource(source)) {
    return undefined;
  }

  try {
    const repo = createRepoAdapter(serverClient);
    const unit = await repo.findUnitForPath(source);
    const unitPath = unit?.unitPath ?? source;
    const status = await repo.unitStatus(unitPath);
    return {
      unitPath: status.unitPath,
      head: status.head,
      stateHash: status.stateHash,
      dirty: status.dirty,
    };
  } catch {
    return {
      unitPath: source,
    };
  }
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
    authority: { principals: ["user", "code"] },
    methods: panelMethods,
    handler: defineServiceHandler("panel", panelMethods, {
      updateTheme: async (ctx, [theme]) => {
        const lifecycle = deps.panelOrchestrator;
        await requirePanelHostingAuthority(ctx, "panel.updateTheme");
        lifecycle.setCurrentTheme(theme);
        lifecycle.broadcastTheme(theme);
        return;
      },
      updateThemeConfig: async (ctx, [config]) => {
        const lifecycle = deps.panelOrchestrator;
        await requirePanelHostingAuthority(ctx, "panel.updateThemeConfig");
        lifecycle.setCurrentThemeConfig(config);
        lifecycle.broadcastThemeConfig();
        return;
      },
      getThemeConfig: () => deps.panelOrchestrator.getThemeConfig(),
      getTreeSnapshot: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "panel.getTreeSnapshot");
        return deps.panelRegistry.getPanelTreeSnapshot();
      },
      getFocusedPanelId: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "panel.getFocusedPanelId");
        return deps.panelRegistry.getFocusedPanelId();
      },
      getChromeState: async (ctx, [panelId]) => {
        await requirePanelHostingAuthority(ctx, "panel.getChromeState");
        const panel = deps.panelRegistry.getPanel(panelId);
        if (!panel) throw new Error(`Panel not found: ${panelId}`);
        const repo = await getRepoState(getPanelSource(panel), deps.serverClient);
        return buildPanelChromeState({ panel, repo }) satisfies PanelChromeState;
      },
      getAddressOptions: async (ctx, [source, ref]) => {
        await requirePanelHostingAuthority(ctx, "panel.getAddressOptions");
        return getPanelAddressOptions(source, ref, deps.serverClient);
      },
      getBrowserAddressOptions: async (ctx, [query]) => {
        await requirePanelHostingAuthority(ctx, "panel.getBrowserAddressOptions");
        return getBrowserAddressOptions(query, deps.panelRegistry, deps.serverClient);
      },
      ensureLoaded: async (ctx, [panelId]) => {
        await requirePanelHostingAuthority(ctx, "panel.ensureLoaded");
        return deps.panelOrchestrator.ensureLoaded(panelId);
      },
      takeOver: async (ctx, [panelId]) => {
        await requirePanelHostingAuthority(ctx, "panel.takeOver");
        return deps.panelOrchestrator.takeOverPanel(panelId);
      },
      markBrowserNavigationIntent: async (ctx, [panelId, intent]) => {
        await requirePanelHostingAuthority(ctx, "panel.markBrowserNavigationIntent");
        deps.panelView.markBrowserNavigationIntent?.(panelId, intent);
        return;
      },
      reloadView: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        await requirePanelHostingAuthority(ctx, "panel.reloadView");
        vm.reload(panelId);
        return;
      },
      forceReloadView: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        await requirePanelHostingAuthority(ctx, "panel.forceReloadView");
        vm.forceReload(panelId);
        return;
      },
      togglePin: async (ctx, [panelId]) => {
        await requirePanelHostingAuthority(ctx, "panel.togglePin");
        return deps.panelOrchestrator.togglePanelPin(panelId);
      },
      listPinnedPanelIds: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "panel.listPinnedPanelIds");
        return deps.panelOrchestrator.listPinnedPanelIds();
      },
    }),
  };
}
