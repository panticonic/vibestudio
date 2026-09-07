import { app, session } from "electron";
import { BrowserDownloadManager } from "./services/browserDownloadManager.js";
import {
  createBrowserEnvironmentService,
  localBrowserEnvironmentImportRouter,
} from "./services/browserEnvironmentService.js";
import path from "node:path";
import { EventService } from "@vibestudio/shared/eventsService";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { PanelTreeInvalidation } from "@vibestudio/shared/panel/treeIndex";
import type { WorkspaceSessionConnection } from "./serverSession.js";
import { createDesktopWorkspaceController } from "./desktopWorkspaceController.js";
import type { ApplicationWindowController } from "./applicationWindowController.js";
import { WorkspaceNativeViews } from "./workspaceNativeViews.js";
import { createViewService } from "./services/viewService.js";
import { createMenuService } from "./services/menuService.js";
import { createDesktopEventsService } from "./services/desktopEventsService.js";
import { createBrowserVaultNativeClient } from "./services/browserVaultNativeClient.js";
import { BrowserPermissionController } from "./services/browserPermissionController.js";
import { createServerEventBridge, bindHostDirectServerEvents } from "./serverEventBridge.js";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";
import { CdpHostProvider } from "./cdpHostProvider.js";
import { RemoteCdpHostProviderSocket } from "./remoteCdpHostProviderSocket.js";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";
import { PanelPinStore } from "./panelPinStore.js";
import { PANEL_UI_MAX_LOADED_DESKTOP, PANEL_UI_IDLE_UNLOAD_MS } from "@vibestudio/shared/constants";

/** A complete workspace runtime beneath the window's single System app. */
export async function openDesktopWorkspaceRuntime(deps: {
  connection: WorkspaceSessionConnection;
  personal: boolean;
  adBlockManager: import("./adblock/adBlockManager.js").AdBlockManager;
  window: ApplicationWindowController;
  authorize: Parameters<ServiceDispatcher["setAuthorityResolver"]>[0];
  openExternal(url: string): Promise<void>;
  onCredentialCaptureRequest?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  const { connection, window } = deps;
  const workspaceId = connection.workspaceId;
  const eventService = new EventService();
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(deps.authorize);
  const container = new ServiceContainer(dispatcher);
  let cdp: CdpHostProvider | null = null;
  let downloads: BrowserDownloadManager | null = null;
  const nativeViews = () => {
    if (!window.viewManager) throw new Error("Desktop window is closed");
    return new WorkspaceNativeViews(workspaceId, window.viewManager);
  };
  const cdpHost = {
    registerTarget: (id: string, contents: number) => cdp?.registerTarget(id, contents),
    unregisterTarget: (id: string) => cdp?.unregisterTarget(id),
    cleanupPanelAccess: (id: string) => cdp?.cleanupPanelAccess(id),
    isTargetUnderAutomation: (id: string) => cdp?.isTargetUnderAutomation(id) ?? false,
  };
  const browserPermissions = new BrowserPermissionController({
    nativeStorageScope: connection.nativeStorageScope,
    serverClient: connection.serverClient,
    eventService,
    getViewManager: () =>
      window.viewManager ? new WorkspaceNativeViews(workspaceId, window.viewManager) : null,
    isTargetUnderAutomation: (runtimeId) => cdpHost.isTargetUnderAutomation(runtimeId),
  });
  const browserPartition = browserPermissions.attachBrowserEnvironment();
  const controller = createDesktopWorkspaceController({
    connection,
    eventService,
    onPresentationUpdated: (payload) => eventService.emit("panel-presentation-changed", payload),
    presentation: {
      cdpHost,
      getPanelView: () => window.getWorkspacePanelView(workspaceId),
      waitForBrowserSessionPartition: () => browserPartition,
      sendPanelEvent: (id, event, payload) => {
        const contents = nativeViews().getWebContents(id);
        if (contents && !contents.isDestroyed()) contents.send("vibestudio:event", event, payload);
      },
      pinStore: new PanelPinStore(path.join(connection.statePath, "panel-pins.json")),
      getResidentPanelIds: () => nativeViews().getDeclaredPanelSlotIds(),
      getNativeBinding: (id) => nativeViews().getNativePanelSlotBinding(id),
      attachNativeBinding: (id) => nativeViews().attachDeclaredPanelSlot(id),
      publishPresentation: (snapshot) =>
        eventService.emit("panel-local-presentation-changed", snapshot),
      runtimeClient: {
        label: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        maxAssignedPanelViews: PANEL_UI_MAX_LOADED_DESKTOP,
        uiIdleUnloadMs: PANEL_UI_IDLE_UNLOAD_MS,
      },
    },
  });
  let latestTree: PanelTreeInvalidation | undefined;
  const onServerEvent = createServerEventBridge({
    eventService,
    getPanelOrchestrator: () => controller.orchestrator,
    getServerClient: () => connection.serverClient,
    openExternal: deps.openExternal,
    warn: console.warn,
    onCredentialCaptureRequest: deps.onCredentialCaptureRequest,
    onPanelTreeInvalidated: (payload) => {
      latestTree = payload;
    },
  });
  const watch = createServerEventSubscriptionBridge({
    getServerClient: () => connection.serverClient,
    onEvent: onServerEvent,
  });
  const stopDirectEvents = bindHostDirectServerEvents(connection.serverClient, onServerEvent);
  const stopCapture = deps.personal
    ? connection.serverClient.onDirectEvent("credential:capture-request", (payload) =>
        onServerEvent("credential:capture-request", payload)
      )
    : () => {};
  const stopRecovery = connection.serverClient.onRecovery(async () => {
    await watch.recover();
    await controller.orchestrator.recoverShellSnapshot({ loadFocusedView: false });
  });
  const stopStatus = connection.serverClient.onConnectionStatusChange((status) => {
    eventService.emit("server-connection-changed", {
      status,
      isRemote: connection.connectionMode === "remote",
    });
  });
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      stopDirectEvents();
      stopCapture();
      stopRecovery();
      stopStatus();
      browserPermissions.stop();
      cdp?.stop();
      const results = await Promise.allSettled([
        watch.close(),
        controller.orchestrator.unregisterRuntimeClient(),
        container.stopAll(),
        downloads?.stop(),
      ]);
      controller.core.shutdown();
      window.detachWorkspace(workspaceId);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, "Workspace runtime cleanup failed");
    })());
  try {
    const partition = await browserPartition;
    const panelView = () => {
      const value = window.getWorkspacePanelView(workspaceId);
      if (!value) throw new Error("Workspace native views are unavailable");
      return value;
    };
    const getViewManager = () => {
      if (!window.viewManager) throw new Error("Desktop window is closed");
      return window.viewManager;
    };
    container.registerRpc(
      createViewService({
        workspaceId,
        panelOrchestrator: controller.orchestrator,
        panelRegistry: controller.registry,
        get panelView() {
          return panelView();
        },
        browserVault: createBrowserVaultNativeClient(connection.serverClient),
        getViewManager,
      })
    );
    container.registerRpc(
      createMenuService({
        panelOrchestrator: controller.orchestrator,
        panelRegistry: controller.registry,
        serverClient: connection.serverClient,
        getViewManager,
        getPanelWebContents: (id) => nativeViews().getWebContents(id),
      })
    );
    container.registerRpc(
      createDesktopEventsService({
        eventService,
        snapshots: { "panel-tree-invalidated": () => latestTree },
        onWatchOpened: (events) => watch.retainMany(events),
      })
    );
    await controller.orchestrator.registerRuntimeClient();
    const hostConnectionId = controller.orchestrator.getRuntimeClientSessionId();
    downloads = new BrowserDownloadManager({
      browserSession: session.fromPartition(partition),
      environmentKey: browserPermissions.getEnvironmentKey(),
      hostId: `desktop:${hostConnectionId}`,
      downloadsDirectory: app.getPath("downloads"),
      eventService,
      getViewManager: nativeViews,
      requestSiteCapability: (contents, capability) =>
        browserPermissions.requestSiteCapability(contents, capability),
    });
    await downloads.start();
    if (!deps.personal)
      container.registerRpc(
        createBrowserEnvironmentService({
          getDownloads: () => downloads,
          importRouter: localBrowserEnvironmentImportRouter(() => null),
          browserDataBrokerRepoPath: null,
        })
      );
    const personalBrowser = deps.personal
      ? await (
          await import("./personalBrowserServices.js")
        ).registerPersonalBrowserServices({
          connection,
          container,
          eventService,
          window,
          browserPermissions,
          browserPartition: partition,
          downloads,
          hostConnectionId,
          adBlockManager: deps.adBlockManager,
        })
      : null;
    await container.startAll();
    window.attachWorkspaceServices({
      serverSession: connection,
      eventService,
      panelRegistry: controller.registry,
      panelOrchestrator: controller.orchestrator,
      cdpHost,
      formFillManager: personalBrowser?.formFillManager ?? null,
      browserFaviconObserver: personalBrowser?.browserFaviconObserver ?? null,
      recordBrowserHistory: deps.personal,
      getBrowserPermissionController: () => browserPermissions,
    });
    dispatcher.markInitialized();
    if (personalBrowser) {
      const { publishHostService } = await import("./hostServicePublisher.js");
      for (const service of personalBrowser.publishedServices)
        publishHostService(connection.serverClient, dispatcher, service);
    }
    cdp = new CdpHostProvider({
      serverUrl: connection.gatewayConfig.serverUrl,
      hostConnectionId,
      transport:
        connection.connectionMode === "remote"
          ? {
              kind: "preauthenticated",
              createSocket: () =>
                new RemoteCdpHostProviderSocket({
                  serverClient: connection.serverClient,
                  hostConnectionId,
                }),
            }
          : { kind: "authenticated-websocket", authToken: () => connection.getCdpAuthToken() },
      getViewManager: () => nativeViews(),
      diagnosticsStore: new RuntimeDiagnosticsStore({ statePath: connection.statePath }),
      onHostCommand: async (panelId, action) => {
        if (action === "rebuildPanel") return controller.orchestrator.rebuildPanel(panelId);
        if (action === "reloadPanel") return controller.orchestrator.reloadPanel(panelId);
        if (action === "panelObservation") {
          return controller.orchestrator.getPanelHostObservation(
            panelId,
            await cdp!.getBootObservation(panelId)
          );
        }
        throw new Error(`Unknown host command: ${action}`);
      },
    });
    cdp.start();
    await watch.retainAll([
      "build:complete",
      "panel-tree-invalidated",
      "panel-presentation-changed",
      "panel:runtimeLeaseChanged",
      "shell-approval:pending-changed",
    ]);
    await controller.orchestrator.initializePanelTree();
    return {
      ...controller,
      eventService,
      personalBrowser,
      serverClient: connection.serverClient,
      dispatcher,
      close,
      browserPermissions,
      watch,
    };
  } catch (error) {
    await close().catch((cleanupError) => console.error("Workspace cleanup failed", cleanupError));
    throw error;
  }
}

export type DesktopWorkspaceRuntime = Awaited<ReturnType<typeof openDesktopWorkspaceRuntime>>;
