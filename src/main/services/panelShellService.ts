import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ThemeAppearance } from "@natstack/shared/types";
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
      const status = (await serverClient.call("vcs", "unitStatus", [unitPath])) as {
        unitPath: string;
        head: string;
        stateHash: string | null;
        dirty: boolean;
      };
      return {
        unitPath: status.unitPath,
        head: status.head,
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
      requireAppCapability(ctx, vm, "panel-hosting", `panel.${method}`);

      switch (method) {
        case "updateTheme": {
          const theme = args[0] as ThemeAppearance;
          lifecycle.setCurrentTheme(theme);
          lifecycle.broadcastTheme(theme);
          return;
        }

        case "getChromeState": {
          const panelId = args[0] as string;
          const panel = registry.getPanel(panelId);
          if (!panel) throw new Error(`Panel not found: ${panelId}`);
          const repo = await getRepoState(getPanelSource(panel), deps.serverClient);
          return buildPanelChromeState({ panel, repo }) satisfies PanelChromeState;
        }

        case "getAddressOptions": {
          const source = args[0] as string;
          const ref = args[1] as string | undefined;
          return getPanelAddressOptions(source, ref, deps.serverClient);
        }

        case "getBrowserAddressOptions": {
          return getBrowserAddressOptions(args[0] as string, registry, deps.serverClient);
        }

        case "markBrowserNavigationIntent": {
          const [panelId, intent] = args as [string, BrowserNavigationIntent];
          pv.markBrowserNavigationIntent?.(panelId, intent);
          return;
        }

        case "reloadView": {
          const panelId = args[0] as string;
          vm.reload(panelId);
          return;
        }

        case "forceReloadView": {
          const panelId = args[0] as string;
          vm.forceReload(panelId);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
