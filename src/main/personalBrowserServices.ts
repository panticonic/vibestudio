import { isReviewPending } from "@vibestudio/shared/authority/reviewPending";
import path from "node:path";
import { app } from "electron";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { WorkspaceSessionConnection } from "./serverSession.js";
import type { ApplicationWindowController } from "./applicationWindowController.js";
import type { BrowserPermissionController } from "./services/browserPermissionController.js";
import { createBrowserDataClient } from "@vibestudio/browser-data";
import { createBrowserVaultNativeClient } from "./services/browserVaultNativeClient.js";
import { createAutofillService } from "./services/autofillService.js";
import { WorkspaceNativeViews } from "./workspaceNativeViews.js";
import { workspaceProviderExtensionPackageName } from "@vibestudio/workspace/configParser";
import { FormFillManager } from "./autofill/formFillManager.js";

/** Personal owns imported data, cookie projection, history and autofill. */
export async function registerPersonalBrowserServices(deps: {
  connection: WorkspaceSessionConnection;
  container: ServiceContainer;
  eventService: EventService;
  window: ApplicationWindowController;
  browserPermissions: BrowserPermissionController;
  browserPartition: string;
  downloads: import("./services/browserDownloadManager.js").BrowserDownloadManager;
  hostConnectionId: string;
}) {
  const {
    connection: conn,
    container,
    eventService,
    window,
    browserPermissions,
    browserPartition,
    hostConnectionId,
  } = deps;
  const sc = conn.serverClient;
  const getViewManager = () => {
    if (!window.viewManager) throw new Error("Desktop window is closed");
    return new WorkspaceNativeViews(conn.workspaceId, window.viewManager);
  };
  const browserDataClient = createBrowserDataClient({
    callService: (service, method, args, options) => sc.call(service, method, args, options),
  });
  const browserVault = createBrowserVaultNativeClient(sc);
  let projectionService: import("./services/browserCookieProjection.js").BrowserCookieProjectionService;
  const projectionNoticeId = `browser-cookie-projection:${conn.workspaceId}`;
  const browserDataBroker = workspaceProviderExtensionPackageName(
    conn.workspaceConfig,
    "browserData"
  );
  const projectionActions = browserDataBroker
    ? [
        {
          id: `${projectionNoticeId}:privacy`,
          label: "Open Browser Privacy",
          invoke: {
            kind: "extension" as const,
            extension: browserDataBroker,
            method: "openBrowserPrivacyManager",
            args: ["debug"],
          },
        },
      ]
    : [];

  let formFillManager: FormFillManager | null = null;
  let browserCookieProjection:
    | import("./services/browserCookieProjection.js").BrowserCookieProjectionApi
    | null = null;
  let browserFaviconObserver:
    | import("./services/browserFaviconObserver.js").BrowserFaviconObserver
    | null = null;
  let browserImportHostProvider:
    | import("./services/browserImportHostProvider.js").BrowserImportHostProvider
    | null = null;
  let browserPrivacyManager:
    | import("./services/browserPrivacyManager.js").BrowserPrivacyManager
    | null = null;

  // Browser-data persistence lives on the server; Electron keeps only the
  // host-bound autofill adapter.
  {
    container.registerManaged({
      name: "browser-data-host",
      async start() {
        const { BrowserImportHostProvider } =
          await import("./services/browserImportHostProvider.js");
        const { SensitiveBrowserImportLedger } =
          await import("./services/sensitiveBrowserImportLedger.js");
        const { BrowserPrivacyManager } = await import("./services/browserPrivacyManager.js");
        browserPrivacyManager = new BrowserPrivacyManager({
          vault: browserVault,
          getProjection: () => browserCookieProjection,
          applyCookies: (signal) => projectionService.applyCookies(signal),
          preloadPath: path.join(__dirname, "browserPrivacyPreload.cjs"),
          htmlPath: path.join(__dirname, "browserPrivacy.html"),
        });
        browserImportHostProvider = new BrowserImportHostProvider(
          {
            hostId: `desktop:${hostConnectionId}`,
            displayName: "This device",
          },
          {
            browserVault,
            applyCookies: (signal) => projectionService.applyCookies(signal),
            sensitiveImportLedger: new SensitiveBrowserImportLedger(
              path.join(
                app.getPath("userData"),
                "browser-import",
                "sensitive-operation-ledger.json"
              )
            ),
          }
        );
        formFillManager = new FormFillManager({
          formFillStore: browserVault,
          eventService,
          getViewManager,
          autofillOverlayPreloadPath: path.join(__dirname, "autofillOverlayPreload.cjs"),
          requestSiteCapability: (contents, capability) =>
            browserPermissions?.requestSiteCapability(contents, capability) ??
            Promise.resolve(false),
        });
        const { CanonicalBrowserFaviconObserver } =
          await import("./services/browserFaviconObserver.js");
        browserFaviconObserver = new CanonicalBrowserFaviconObserver(browserDataClient);
        return browserDataClient;
      },
      async stop() {
        eventService.emit("notification:dismiss", { id: projectionNoticeId });
        await browserImportHostProvider?.stop();
        browserImportHostProvider = null;
        browserPrivacyManager?.destroy();
        browserPrivacyManager = null;
        if (formFillManager) {
          formFillManager.destroy();
          formFillManager = null;
        }
        browserFaviconObserver = null;
      },
    });
    const { createBrowserCookieProjectionService } =
      await import("./services/browserCookieProjection.js");
    projectionService = createBrowserCookieProjectionService({
      nativeStorageScope: conn.nativeStorageScope,
      browserDataClient,
      browserVault,
      serverClient: sc,
      hostId: `desktop:${conn.workspaceId}`,
      outboxRoot: app.getPath("userData"),
      brokerPackageName: browserDataBroker,
      onDiagnostics(diagnostics) {
        if (diagnostics.converged)
          eventService.emit("notification:dismiss", { id: projectionNoticeId });
        else
          eventService.emit("notification:show", {
            id: projectionNoticeId,
            type: "error",
            ttl: 0,
            actions: projectionActions,
            title: "Saved cookies could not be fully applied",
            message:
              "Your cookies are saved. Open Browser Privacy and choose Apply saved cookies to retry. Already-open pages may need a reload after application.",
          });
      },
      onUnavailable(error) {
        eventService.emit("notification:show", {
          id: projectionNoticeId,
          type: "error",
          ttl: 0,
          actions: isReviewPending(error) ? [] : projectionActions,
          title: isReviewPending(error)
            ? "Browser sessions need approval"
            : "Saved browser sessions are unavailable",
          message: isReviewPending(error)
            ? "Complete the pending workspace review to apply your saved cookies. Your saved data has been kept."
            : "Your saved cookies have been kept. Open Browser Privacy and choose Apply saved cookies to retry; you do not need to import again.",
        });
      },
      async onReady(api) {
        if (api.partition !== browserPartition) {
          throw new Error("Browser cookie projection resolved a different environment");
        }
        browserCookieProjection = api;
        browserImportHostProvider?.resumeSensitiveImports();
        // The download manager owns and cancels its history reads. Loading
        // supplementary history must not delay applying browser sessions.
        void deps.downloads.attachHistory(browserDataClient).catch((error) => {
          console.error("Browser download history unavailable", error);
        });
      },
      async onStopped() {
        browserCookieProjection = null;
      },
    });
    container.registerManaged(projectionService);
  }

  // Register autofill service (uses lazy resolution since formFillManager is created in browser-data start)
  container.registerRpc(
    createAutofillService({
      invoke: (ctx, method, args) => {
        if (!formFillManager) throw new Error("Autofill not initialized");
        return formFillManager.getServiceDefinition().handler(ctx, method, args);
      },
    })
  );
  const { createBrowserEnvironmentService, localBrowserEnvironmentImportRouter } =
    await import("./services/browserEnvironmentService.js");
  const { workspaceProviderExtensionRepoPath } = await import("@vibestudio/workspace/configParser");
  const desktopBrowserEnvironment = createBrowserEnvironmentService({
    getDownloads: () => deps.downloads,
    applyCookies: (signal) => projectionService.applyCookies(signal),
    importRouter: localBrowserEnvironmentImportRouter(() => browserImportHostProvider),
    browserDataBrokerRepoPath: workspaceProviderExtensionRepoPath(
      conn.workspaceConfig,
      "browserData"
    ),
  });
  container.registerRpc(desktopBrowserEnvironment);
  const { createDesktopBrowserPrivacyPresentation } =
    await import("./services/desktopBrowserPrivacyPresentation.js");
  const desktopBrowserPrivacyPresentation = createDesktopBrowserPrivacyPresentation({
    getPrivacyManager: () => browserPrivacyManager,
  });
  container.registerRpc(desktopBrowserPrivacyPresentation);
  return {
    publishedServices: [desktopBrowserPrivacyPresentation, desktopBrowserEnvironment],
    browserVault,
    get formFillManager() {
      return formFillManager;
    },
    get browserFaviconObserver() {
      return browserFaviconObserver;
    },
    get cookieProjection() {
      return browserCookieProjection;
    },
  };
}
export type PersonalBrowserServices = Awaited<ReturnType<typeof registerPersonalBrowserServices>>;
