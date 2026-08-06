import type { ServiceContext, ServiceHandler } from "@vibestudio/shared/serviceDispatcher";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelLayoutStoreApi } from "../panelLayoutStore.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import { sanitizeFilenamePart } from "../safeFilename.js";
import type { ServerClient } from "../serverClient.js";
import { panelMethods } from "@vibestudio/service-schemas/panel";
import { buildPanelChromeState, type PanelChromeState } from "@vibestudio/shared/panelChrome";
import { createBrowserDataClient } from "@vibestudio/browser-data";
import { callerHasPlatformCapability, requireAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { dialog } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

function requirePanelHostingAppCapability(
  ctx: ServiceContext,
  viewManager: ViewManager,
  method: string
): void {
  requireAppCapability(ctx, viewManager, "panel-hosting", `panel.${method}`);
}

function requirePanelHostingChrome(
  ctx: ServiceContext,
  viewManager: ViewManager,
  method: string
): void {
  if (
    callerHasPlatformCapability(ctx.caller.runtime.id, ctx.caller.runtime.kind, "panel-hosting")
  ) {
    return;
  }
  requirePanelHostingAppCapability(ctx, viewManager, method);
}

export interface PanelViewMethodDeps {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  panelView: PanelView;
  getViewManager: () => ViewManager;
  serverClient?: ServerClient | null;
  panelLayoutStore?: PanelLayoutStoreApi | null;
  getWorkspaceId?: () => string;
  getAccountUserId?: () => Promise<string>;
}

export function buildPanelViewHandler(deps: PanelViewMethodDeps): ServiceHandler {
  return defineServiceHandler("view", panelMethods, {
    createPanel: async (ctx, [parentId, source, options]) => {
      requirePanelHostingChrome(ctx, deps.getViewManager(), "createPanel");
      const { stateArgs, ...createOptions } = options ?? {};
      const caller =
        ctx.caller.runtime.kind === "app"
          ? { callerId: ctx.caller.runtime.id, callerKind: ctx.caller.runtime.kind }
          : undefined;
      return deps.panelOrchestrator.createPanel(
        parentId ?? ctx.caller.runtime.id,
        source,
        { ...createOptions, isRoot: parentId === null },
        stateArgs,
        caller
      );
    },
    focusPanel: (_ctx, [panelId, options]) =>
      deps.panelOrchestrator.focusPanel(panelId, {
        loadIfNeeded: true,
        ...options,
      }),
    ensurePanelLoaded: (ctx, [panelId]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "ensurePanelLoaded");
      return deps.panelOrchestrator.ensureLoaded(panelId);
    },
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
    getPresentation: async (ctx, [panelId]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getPresentation");
      const panel = await deps.panelOrchestrator.refreshPanelProjection(panelId);
      if (!panel) return null;
      const parentId = deps.panelRegistry.findParentId(panelId);
      const siblings = parentId
        ? (deps.panelRegistry.getPanel(parentId)?.children ?? [])
        : deps.panelRegistry.getRootPanels();
      return {
        ...panel,
        parentId,
        position: Math.max(
          0,
          siblings.findIndex((candidate) => candidate.id === panelId)
        ),
        hostViewRevision: deps.panelOrchestrator.getPanelViewRevision(),
      };
    },
    getChromeState: (ctx, [panelId]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getChromeState");
      const panel = deps.panelRegistry.getPanel(panelId);
      if (!panel) throw new Error(`Panel not found: ${panelId}`);
      return buildPanelChromeState({ panel }) satisfies PanelChromeState;
    },
    markBrowserNavigationIntent: (ctx, [panelId, intent]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "markBrowserNavigationIntent");
      deps.panelView.markBrowserNavigationIntent?.(panelId, intent);
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
    getFocusedPanelId: (ctx) => {
      requirePanelHostingChrome(ctx, deps.getViewManager(), "getFocusedPanelId");
      return deps.panelOrchestrator.getFocusedPanelId();
    },
    setFocusedPanelId: (ctx, [panelId]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "setFocusedPanelId");
      return deps.panelOrchestrator.setFocusedPanelId(panelId);
    },
    getCollapsedPanelIds: async (ctx) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "getCollapsedPanelIds");
      return deps.panelOrchestrator.getCollapsedIds();
    },
    setPanelCollapsed: async (ctx, [panelId, collapsed]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "setPanelCollapsed");
      await deps.panelOrchestrator.setCollapsed(panelId, collapsed);
    },
    expandPanelIds: async (ctx, [panelIds]) => {
      requirePanelHostingAppCapability(ctx, deps.getViewManager(), "expandPanelIds");
      await deps.panelOrchestrator.expandIds(panelIds);
    },
    openPanelDevTools: (ctx, [panelId, mode]) => {
      const viewManager = deps.getViewManager();
      requirePanelHostingAppCapability(ctx, viewManager, "openPanelDevTools");
      viewManager.openDevTools(panelId, mode);
    },
  });
}

function requireBrowserDataClient(serverClient?: ServerClient | null) {
  if (!serverClient) throw new Error("Browser environment is unavailable");
  return createBrowserDataClient({
    callService: (service, method, args) => serverClient.call(service, method, args),
    callTarget: (targetId, method, args) => serverClient.callTarget(targetId, method, args),
  });
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
