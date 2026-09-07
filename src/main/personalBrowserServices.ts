import path from "node:path";
import { app, session } from "electron";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { WorkspaceSessionConnection } from "./serverSession.js";
import type { ApplicationWindowController } from "./applicationWindowController.js";
import type { BrowserPermissionController } from "./services/browserPermissionController.js";
import type { AdBlockManager } from "./adblock/adBlockManager.js";
import { createBrowserDataClient } from "@vibestudio/browser-data";
import { createBrowserVaultNativeClient } from "./services/browserVaultNativeClient.js";
import { createAutofillService } from "./services/autofillService.js";
import { WorkspaceNativeViews } from "./workspaceNativeViews.js";
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
  adBlockManager: AdBlockManager;
}) {
  const {
    connection: conn,
    container,
    eventService,
    window,
    browserPermissions,
    browserPartition,
    hostConnectionId,
    adBlockManager,
  } = deps;
  const sc = conn.serverClient;
  const getViewManager = () => {
    if (!window.viewManager) throw new Error("Desktop window is closed");
    return new WorkspaceNativeViews(conn.workspaceId, window.viewManager);
  };
  const browserDataClient = createBrowserDataClient({
    callService: (service, method, args) => sc.call(service, method, args),
  });
  const browserVault = createBrowserVaultNativeClient(sc);
  let formFillManager: FormFillManager | null = null;
  let browserCookieProjection:
    | import("./services/browserCookieProjection.js").BrowserCookieProjectionApi
    | null = null;
  let browserFaviconObserver:
    | import("./services/browserFaviconObserver.js").BrowserFaviconObserver
    | null = null;
  let releaseBrowserAdBlocking: (() => void) | null = null;
  let websiteNotificationBridge:
    | import("./services/websiteNotificationBridge.js").WebsiteNotificationBridge
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
        browserImportHostProvider?.stop();
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
    container.registerManaged(
      createBrowserCookieProjectionService({
        nativeStorageScope: conn.nativeStorageScope,
        browserDataClient,
        browserVault,
        serverClient: sc,
        hostId: `desktop:${conn.workspaceId}`,
        outboxRoot: app.getPath("userData"),
        async onReady(api) {
          if (api.partition !== browserPartition) {
            throw new Error("Browser cookie projection resolved a different environment");
          }
          browserCookieProjection = api;
          const browserSession = session.fromPartition(api.partition);
          releaseBrowserAdBlocking?.();
          releaseBrowserAdBlocking = adBlockManager.attachToSession(browserSession);

          // Browser views need the session partition and nothing else. The
          // subsystems below enrich the environment — site permissions, web
          // notifications, download tracking — and each can fail on its own
          // without making the browser unusable. Letting one rejection escape
          // marked the whole environment unavailable, which left every
          // browser panel with no view at all and an empty pane.
          const attach = async (label: string, start: () => Promise<void> | void) => {
            try {
              await start();
            } catch (error) {
              console.error(
                `Browser environment: ${label} unavailable; continuing without it: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          };

          await attach("download history", () => deps.downloads.attachHistory(browserDataClient));

          await attach("site permissions", async () => {
            // The notification bridge routes through permission decisions, so
            // it only exists when those are available.
            const { WebsiteNotificationBridge } =
              await import("./services/websiteNotificationBridge.js");
            websiteNotificationBridge = new WebsiteNotificationBridge({
              permissions: browserPermissions,
              eventService,
              getViewManager,
            });
            websiteNotificationBridge.start();
          });
        },
        async onStopped() {
          websiteNotificationBridge?.stop();
          websiteNotificationBridge = null;
          releaseBrowserAdBlocking?.();
          releaseBrowserAdBlocking = null;
          browserCookieProjection = null;
        },
      })
    );
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
    onNotificationAction(id: string, actionId: string) {
      websiteNotificationBridge?.handleAction(id, actionId);
    },
  };
}
export type PersonalBrowserServices = Awaited<ReturnType<typeof registerPersonalBrowserServices>>;
