import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelLayoutStoreApi } from "../panelLayoutStore.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import { sanitizeFilenamePart } from "../safeFilename.js";
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
import { dialog } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  /** Client-local per-device layout store; absent on headless hosts. */
  panelLayoutStore?: PanelLayoutStoreApi | null;
  /** Active workspace id, resolved main-side — the shell never passes identity. */
  getWorkspaceId?: () => string;
  /** Signed-in account user id, resolved main-side (cached after first lookup). */
  getAccountUserId?: () => Promise<string>;
}): ServiceDefinition {
  return {
    name: "panel",
    description: "Electron-local panel view helpers",
    authority: { principals: ["user", "code"] },
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
      findInPage: async (ctx, [panelId, text, options]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "findInPage");
        const contents = vm.getWebContents(panelId);
        if (!contents || contents.isDestroyed() || !text) {
          return { activeMatchOrdinal: 0, matches: 0 };
        }
        return new Promise<{ activeMatchOrdinal: number; matches: number }>((resolve) => {
          const timeout = setTimeout(() => {
            contents.off("found-in-page", onResult);
            resolve({ activeMatchOrdinal: 0, matches: 0 });
          }, 2_000);
          const onResult = (_event: Electron.Event, result: Electron.FoundInPageResult) => {
            if (!result.finalUpdate) return;
            clearTimeout(timeout);
            contents.off("found-in-page", onResult);
            resolve({
              activeMatchOrdinal: result.activeMatchOrdinal,
              matches: result.matches,
            });
          };
          contents.on("found-in-page", onResult);
          contents.findInPage(text, options);
        });
      },
      stopFindInPage: (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "stopFindInPage");
        const contents = vm.getWebContents(panelId);
        if (contents && !contents.isDestroyed()) contents.stopFindInPage("clearSelection");
        return;
      },
      getBrowserSiteState: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "getBrowserSiteState");
        const page = currentBrowserPage(panelId, deps.panelRegistry, vm);
        const client = requireBrowserDataClient(deps.serverClient);
        const [preferences, bookmarks, siteData] = await Promise.all([
          client.getSitePreferences(page.origin),
          client.searchBookmarks(page.url),
          client.getCookieSiteSummary(page.origin),
        ]);
        vm.getWebContents(panelId)?.setZoomFactor(preferences.zoomFactor);
        const bookmark = bookmarks.find((item) => item.url === page.url);
        return {
          ...page,
          zoomFactor: preferences.zoomFactor,
          bookmarkId: bookmark?.id ?? null,
          cookieCount: siteData.cookieCount,
        };
      },
      toggleBrowserBookmark: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "toggleBrowserBookmark");
        const page = currentBrowserPage(panelId, deps.panelRegistry, vm);
        const client = requireBrowserDataClient(deps.serverClient);
        const bookmark = (await client.searchBookmarks(page.url)).find(
          (item) => item.url === page.url
        );
        if (bookmark) {
          await client.deleteBookmark(bookmark.id);
          return { bookmarked: false, bookmarkId: null };
        }
        const contents = vm.getWebContents(panelId);
        const bookmarkId = await client.addBookmark({
          title: contents?.getTitle().trim() || new URL(page.url).hostname,
          url: page.url,
          folderPath: "/",
        });
        return { bookmarked: true, bookmarkId };
      },
      setBrowserZoom: async (ctx, [panelId, zoomFactor]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "setBrowserZoom");
        const page = currentBrowserPage(panelId, deps.panelRegistry, vm);
        const client = requireBrowserDataClient(deps.serverClient);
        const rounded = Math.round(Math.min(5, Math.max(0.25, zoomFactor)) * 20) / 20;
        await client.setSiteZoom(page.origin, rounded);
        vm.getWebContents(panelId)?.setZoomFactor(rounded);
        return rounded;
      },
      clearBrowserSiteData: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "clearBrowserSiteData");
        const page = currentBrowserPage(panelId, deps.panelRegistry, vm);
        const client = requireBrowserDataClient(deps.serverClient);
        const removed = await client.clearCookiesForOrigin(page.origin);
        const contents = vm.getWebContents(panelId);
        if (!contents || contents.isDestroyed()) throw new Error("Browser page is not loaded");
        await contents.session.clearData({
          origins: [page.origin],
          dataTypes: ["cookies", "cache", "localStorage", "indexedDB", "serviceWorkers"],
        });
        await client.flushCookieProjection([page.origin]);
        return removed;
      },
      printBrowserPage: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "printBrowserPage");
        currentBrowserPage(panelId, deps.panelRegistry, vm);
        const contents = vm.getWebContents(panelId);
        if (!contents) throw new Error("Browser page is not loaded");
        await new Promise<void>((resolve, reject) => {
          contents.print({}, (success, failureReason) => {
            if (success) resolve();
            else reject(new Error(failureReason || "Printing failed"));
          });
        });
      },
      saveBrowserPagePdf: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "saveBrowserPagePdf");
        currentBrowserPage(panelId, deps.panelRegistry, vm);
        const contents = vm.getWebContents(panelId);
        if (!contents) throw new Error("Browser page is not loaded");
        const filename = safePdfName(contents.getTitle());
        const selected = await dialog.showSaveDialog({
          title: "Save page as PDF",
          defaultPath: filename,
          filters: [{ name: "PDF document", extensions: ["pdf"] }],
        });
        if (selected.canceled || !selected.filePath) return null;
        await fs.writeFile(selected.filePath, await contents.printToPDF({ printBackground: true }));
        return path.resolve(selected.filePath);
      },
      stopBrowserMedia: async (ctx, [panelId]) => {
        const vm = deps.getViewManager();
        requirePanelHostingAppCapability(ctx, vm, "stopBrowserMedia");
        currentBrowserPage(panelId, deps.panelRegistry, vm);
        const contents = vm.getWebContents(panelId);
        if (!contents) return;
        await contents.executeJavaScript(
          `for (const element of document.querySelectorAll("audio,video")) element.pause()`
        );
      },
      togglePin: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "togglePin");
        return deps.panelOrchestrator.togglePanelPin(panelId);
      },
      listPinnedPanelIds: (ctx) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "listPinnedPanelIds");
        return deps.panelOrchestrator.listPinnedPanelIds();
      },
      getPanelLayout: async (ctx) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getPanelLayout");
        const store = deps.panelLayoutStore;
        if (!store || !deps.getWorkspaceId || !deps.getAccountUserId) return null;
        return store.get(deps.getWorkspaceId(), await deps.getAccountUserId());
      },
      savePanelLayout: async (ctx, [layout]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "savePanelLayout");
        const store = deps.panelLayoutStore;
        if (!store || !deps.getWorkspaceId || !deps.getAccountUserId) return;
        store.set(deps.getWorkspaceId(), await deps.getAccountUserId(), layout);
      },
      setFocusedPanelId: (ctx, [panelId]) => {
        requirePanelHostingAppCapability(ctx, deps.getViewManager(), "setFocusedPanelId");
        deps.panelOrchestrator.setFocusedPanelId(panelId);
        return;
      },
    }),
  };
}

function requireBrowserDataClient(serverClient?: ServerClient | null) {
  if (!serverClient) throw new Error("Browser environment is unavailable");
  return createBrowserDataClient(serverClient);
}

function currentBrowserPage(
  panelId: string,
  registry: PanelRegistry,
  viewManager: ViewManager
): { origin: string; url: string; secure: boolean } {
  const panel = registry.getPanel(panelId);
  const contents = viewManager.getWebContents(panelId);
  if (!panel || !contents || contents.isDestroyed()) {
    throw new Error("Browser page is not loaded");
  }
  const state = buildPanelChromeState({ panel });
  if (state.kind !== "browser") throw new Error("This action requires a browser panel");
  const url = new URL(contents.getURL());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("This browser page has no website origin");
  }
  return { origin: url.origin, url: url.toString(), secure: url.protocol === "https:" };
}

function safePdfName(title: string): string {
  const stem =
    sanitizeFilenamePart(title.trim(), "-")
      .replace(/[.\s]+$/g, "")
      .slice(0, 120) || "page";
  return `${stem}.pdf`;
}
