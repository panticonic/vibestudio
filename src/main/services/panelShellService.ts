import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ThemeAppearance, ThemeConfig } from "@natstack/shared/types";
import type { ServerClient } from "../serverClient.js";
import { panelMethods } from "@natstack/shared/serviceSchemas/panel";
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
} from "@natstack/shared/panelChrome";
import { createBrowserDataRpcClient } from "@natstack/browser-data";
import { getPanelSource } from "@natstack/shared/panel/accessors";
import type { BrowserNavigationIntent } from "@natstack/shared/panelCommands";
import { requireAppCapability } from "./appCapabilities.js";

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
  const client = createBrowserDataRpcClient(serverClient);
  return {
    searchHistoryForAutocomplete: (query, limit) =>
      client.history.searchForAutocomplete(query, limit),
    getHistory: (query) => client.history.get(query),
    searchBookmarks: (query) => client.bookmarks.search(query),
    getSearchEngines: () => client.searchEngines.getAll(),
  };
}

async function getRepoState(
  source: string,
  serverClient?: ServerClient | null
): Promise<PanelRepoState | undefined> {
  if (!serverClient || isBrowserPanelSource(source) || source.startsWith("about/")) {
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
    handler: async (ctx, method, args) => {
      const lifecycle = deps.panelOrchestrator;
      const registry = deps.panelRegistry;
      const pv = deps.panelView;
      const vm = deps.getViewManager();

      switch (method) {
        case "updateTheme": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const theme = args[0] as ThemeAppearance;
          lifecycle.setCurrentTheme(theme);
          lifecycle.broadcastTheme(theme);
          return;
        }

        case "updateThemeConfig": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const config = args[0] as ThemeConfig;
          lifecycle.setCurrentThemeConfig(config);
          lifecycle.broadcastThemeConfig();
          return;
        }

        case "getThemeConfig": {
          return lifecycle.getThemeConfig();
        }

        case "getChromeState": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          const panel = registry.getPanel(panelId);
          if (!panel) throw new Error(`Panel not found: ${panelId}`);
          const repo = await getRepoState(getPanelSource(panel), deps.serverClient);
          return buildPanelChromeState({ panel, repo }) satisfies PanelChromeState;
        }

        case "getAddressOptions": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const source = args[0] as string;
          const ref = args[1] as string | undefined;
          return getPanelAddressOptions(source, ref, deps.serverClient);
        }

        case "getBrowserAddressOptions": {
          requirePanelHostingAppCapability(ctx, vm, method);
          return getBrowserAddressOptions(args[0] as string, registry, deps.serverClient);
        }

        case "ensureLoaded": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          return lifecycle.ensureLoaded(panelId);
        }

        case "takeOver": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          return lifecycle.takeOverPanel(panelId);
        }

        case "markBrowserNavigationIntent": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const [panelId, intent] = args as [string, BrowserNavigationIntent];
          pv.markBrowserNavigationIntent?.(panelId, intent);
          return;
        }

        case "reloadView": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          vm.reload(panelId);
          return;
        }

        case "forceReloadView": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          vm.forceReload(panelId);
          return;
        }

        case "togglePin": {
          requirePanelHostingAppCapability(ctx, vm, method);
          const panelId = args[0] as string;
          return lifecycle.togglePanelPin(panelId);
        }

        case "listPinnedPanelIds": {
          requirePanelHostingAppCapability(ctx, vm, method);
          return lifecycle.listPinnedPanelIds();
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
