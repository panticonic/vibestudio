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
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { panelLogMethods, type PanelLogRecord } from "@vibestudio/service-schemas/panelLog";
import { getPanelSource } from "@vibestudio/shared/panel/accessors";
import type { ServerEventBridgeDeps } from "./serverEventBridge.js";
import type { PanelTreeInvalidation } from "@vibestudio/shared/panel/treeIndex";
import type { WorkspaceSessionConnection } from "./serverSession.js";
import { createDesktopWorkspaceController } from "./desktopWorkspaceController.js";
import type { ApplicationWindowController } from "./applicationWindowController.js";
import { WorkspaceNativeViews } from "./workspaceNativeViews.js";
import { createViewService } from "./services/viewService.js";
import { createMenuService } from "./services/menuService.js";
import { requireAppCapability } from "./services/appCapabilities.js";
import { createDesktopEventsService } from "./services/desktopEventsService.js";
import { createBrowserVaultNativeClient } from "./services/browserVaultNativeClient.js";
import { BrowserPermissionController } from "./services/browserPermissionController.js";
import {
  createServerEventBridge,
  bindHostDirectServerEvents,
  notificationAttention,
} from "./serverEventBridge.js";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";
import { CdpHostProvider } from "./cdpHostProvider.js";
import { RemoteCdpHostProviderSocket } from "./remoteCdpHostProviderSocket.js";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";
import { PanelPinStore } from "./panelPinStore.js";
import { PANEL_UI_MAX_LOADED_DESKTOP, PANEL_UI_IDLE_UNLOAD_MS } from "@vibestudio/shared/constants";

/** A complete workspace runtime beneath the window's single System app. */
export function createDesktopWorkspaceRuntime(deps: {
  connection: WorkspaceSessionConnection;
  personal: boolean;
  headless?: boolean;
  eventService?: EventService;
  dispatcher?: ServiceDispatcher;
  events?: Pick<
    ServerEventBridgeDeps,
    | "applyAppAvailable"
    | "onAppHostTargetChanged"
    | "resolveAppAvailableEvent"
    | "onApprovalPendingChanged"
    | "onAttentionRequired"
    | "onNotificationAction"
  >;
  view?: Pick<
    Parameters<typeof createViewService>[0],
    "authorizeWorkspaceMaterialization" | "onNativeSlotChanged"
  >;
  onRecovered?(kind: "resubscribe" | "cold-recover"): Promise<void> | void;
  adBlockManager: import("./adblock/adBlockManager.js").AdBlockManager;
  window: ApplicationWindowController;
  authorize: Parameters<ServiceDispatcher["setAuthorityResolver"]>[0];
  openExternal(url: string): Promise<void>;
  onCredentialCaptureRequest?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}) {
  const { connection, window } = deps;
  const workspaceId = connection.workspaceId;
  const eventService = deps.eventService ?? new EventService();
  const dispatcher = deps.dispatcher ?? new ServiceDispatcher();
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
    presentation: {
      cdpHost,
      getPanelView: () => window.getWorkspacePanelView(workspaceId),
      waitForBrowserSessionPartition: () => browserPartition,
      sendPanelEvent: (id, event, payload) => {
        const contents = nativeViews().getWebContents(id);
        if (contents && !contents.isDestroyed()) contents.send("vibestudio:event", event, payload);
      },
      pinStore: deps.headless
        ? undefined
        : new PanelPinStore(path.join(connection.statePath, "panel-pins.json")),
      getResidentPanelIds: () => nativeViews().getDeclaredPanelSlotIds(),
      getNativeBinding: (id) => nativeViews().getNativePanelSlotBinding(id),
      attachNativeBinding: (id) => nativeViews().attachDeclaredPanelSlot(id),
      publishPresentation: (snapshot) =>
        eventService.emit("panel-local-presentation-changed", snapshot),
      runtimeClient: deps.headless
        ? {
            label: "Headless",
            platform: "headless",
            supportsCdp: true,
            loadOnLeaseAssignment: true,
            restorePolicy: "none",
          }
        : {
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
  let personalBrowser: Awaited<
    ReturnType<typeof import("./personalBrowserServices.js").registerPersonalBrowserServices>
  > | null = null;
  const handleNotificationAction = async (id: string, actionId: string) => {
    personalBrowser?.onNotificationAction(id, actionId);
    if (actionId.startsWith("oauth-cancel:")) {
      await connection.serverClient.call("credentials", "cancelOAuth", [
        { transactionId: actionId.slice("oauth-cancel:".length) },
      ]);
    } else await deps.events?.onNotificationAction?.(id, actionId);
  };
  const onServerEvent = createServerEventBridge({
    ...deps.events,
    eventService,
    getPanelOrchestrator: () => controller.orchestrator,
    getServerClient: () => connection.serverClient,
    openExternal: deps.openExternal,
    warn: console.warn,
    notifyError: (title, message) =>
      eventService.emit("notification:show", {
        id: `workspace-error:${crypto.randomUUID()}`,
        type: "error",
        title,
        message,
        ttl: 0,
      }),
    onNotificationAction: handleNotificationAction,
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
  const stopNotificationAction = connection.serverClient.onDirectEvent(
    "notification:action",
    (payload) => {
      const action = payload as { id?: unknown; actionId?: unknown };
      if (typeof action.id !== "string" || typeof action.actionId !== "string") return;
      void handleNotificationAction(action.id, action.actionId).catch((error) =>
        console.warn("Desktop notification action failed", error)
      );
    }
  );
  const stopAttention = connection.serverClient.onDirectEvent("notification:show", (payload) => {
    const attention = notificationAttention("notification:show", payload);
    if (attention) deps.events?.onAttentionRequired?.(attention.title, attention.message);
  });
  let semanticRecoveryEpoch = 0;
  let recoveryPending = false;
  const publishConnectionStatus = (status: import("./serverClient.js").ConnectionStatus) => {
    eventService.emit("server-connection-changed", {
      status,
      isRemote: connection.connectionMode === "remote",
    });
  };
  const recover = async (kind: "resubscribe" | "cold-recover") => {
    if (closed) return;
    const epoch = ++semanticRecoveryEpoch;
    for (const { panelId } of controller.registry.listPanels()) {
      const contents = window.getWorkspacePanelView(workspaceId)?.getWebContents(panelId);
      if (contents && !contents.isDestroyed()) contents.send("vibestudio:rpc:recovery", kind);
    }
    await watch.recover();
    if (closed || epoch !== semanticRecoveryEpoch) return;
    await controller.orchestrator.recoverShellSnapshot({ loadFocusedView: false });
    if (closed || epoch !== semanticRecoveryEpoch) return;
    recoveryPending = false;
    publishConnectionStatus("connected");
    await deps.onRecovered?.(kind);
  };
  const stopRecovery = connection.serverClient.onRecovery(recover);
  const stopStatus = connection.serverClient.onConnectionStatusChange((status) => {
    if (closed) return;
    if (status !== "connected") {
      semanticRecoveryEpoch += 1;
      recoveryPending = true;
    }
    // The physical link can return before logical subscriptions and the native
    // snapshot. Every workspace publishes readiness at that same semantic boundary.
    if (status === "connected" && recoveryPending) return;
    publishConnectionStatus(status);
  });
  let closing: Promise<void> | null = null;
  let disposing: Promise<void> | null = null;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Workspace runtime is closed");
  };
  const dispose = () =>
    (disposing ??= (async () => {
      const errors: unknown[] = [];
      // Stop every producer even when one teardown fails, then drain work before
      // retiring the core and native owner. Connection lifetime is the caller's.
      for (const stop of [
        stopDirectEvents,
        stopAttention,
        stopNotificationAction,
        stopCapture,
        stopRecovery,
        stopStatus,
        () => browserPermissions.stop(),
        () => cdp?.stop(),
        () => {
          if (panelLogFlushTimer) clearTimeout(panelLogFlushTimer);
        },
      ]) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      const results = await Promise.allSettled(
        [
          () => watch.close(),
          () => controller.orchestrator.unregisterRuntimeClient(),
          () => container.stopAll(),
          () => downloads?.stop(),
          () => flushPanelLog(),
        ].map((stop) => Promise.resolve().then(stop))
      );
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      for (const stop of [
        () => controller.core.shutdown(),
        () => window.detachWorkspace(workspaceId),
      ]) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Workspace runtime cleanup failed");
    })());
  const panelLogClient = createTypedServiceClient(
    "panelLog",
    panelLogMethods,
    (service, method, args) => connection.serverClient.call(service, method, args)
  );
  const panelLogQueue: PanelLogRecord[] = [];
  let panelLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingPanelLogWrites = new Set<Promise<unknown>>();
  const flushPanelLog = async () => {
    panelLogFlushTimer = null;
    const batch = panelLogQueue.splice(0);
    if (batch.length) {
      const writing = panelLogClient.append(batch);
      pendingPanelLogWrites.add(writing);
      void writing.then(
        () => pendingPanelLogWrites.delete(writing),
        () => pendingPanelLogWrites.delete(writing)
      );
    }
    await Promise.all([...pendingPanelLogWrites]);
  };
  const forwardDiagnostic = (
    panelId: string,
    entry: import("./cdpHostProvider.js").PanelConsoleHistoryEntry
  ) => {
    const panel = controller.registry.getPanel(panelId);
    if (!panel) return;
    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) return;
    const unitSource = source.split(/[?#]/)[0];
    if (!unitSource) return;
    panelLogQueue.push({
      unitSource,
      panelId,
      timestamp: entry.timestamp,
      level: entry.level === "warning" ? "warn" : entry.level === "unknown" ? "info" : entry.level,
      message: entry.message,
      source: entry.source === "lifecycle" ? "lifecycle" : "console",
      fields: entry.fields,
      url: entry.url || undefined,
      line: entry.line || undefined,
    });
    const flush = () =>
      void flushPanelLog().catch((error) =>
        console.warn("Failed to persist panel diagnostics", error)
      );
    if (panelLogQueue.length >= 50) {
      if (panelLogFlushTimer) clearTimeout(panelLogFlushTimer);
      flush();
    } else if (!panelLogFlushTimer) panelLogFlushTimer = setTimeout(flush, 500);
  };
  let initializingPanels: Promise<void> | null = null;
  const initializePanelTree = () => {
    assertOpen();
    return (initializingPanels ??= controller.orchestrator.initializePanelTree().catch((error) => {
      initializingPanels = null;
      throw error;
    }));
  };
  let starting: Promise<void> | null = null;
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      await starting?.catch(() => undefined);
      await dispose();
    })());
  };
  const start = () =>
    (starting ??= (async () => {
      try {
        assertOpen();
        const partition = await browserPartition;
        assertOpen();
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
            ...deps.view,
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
            onWatchOpened: (events, context) => {
              const manager = window.viewManager;
              if (!manager) throw new Error("Desktop window is closed");
              requireAppCapability(context, manager, "panel-hosting", "Desktop server events");
              return watch.retainMany(events);
            },
          })
        );
        await controller.orchestrator.registerRuntimeClient();
        assertOpen();
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
        assertOpen();
        if (!deps.personal)
          container.registerRpc(
            createBrowserEnvironmentService({
              getDownloads: () => downloads,
              importRouter: localBrowserEnvironmentImportRouter(() => null),
              browserDataBrokerRepoPath: null,
            })
          );
        personalBrowser = deps.personal
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
        assertOpen();
        await container.startAll();
        assertOpen();
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
          forwardDiagnostic,
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
          "external-open:open",
          "browser-panel:open",
          ...(deps.events?.applyAppAvailable
            ? (["apps:available", "apps:status", "extensions:status"] as const)
            : []),
        ]);
        assertOpen();
        await initializePanelTree();
        assertOpen();
      } catch (error) {
        closed = true;
        await dispose().catch((cleanupError) =>
          console.error("Workspace cleanup failed", cleanupError)
        );
        throw error;
      }
    })());
  return {
    ...controller,
    eventService,
    serverClient: connection.serverClient,
    dispatcher,
    container,
    get personalBrowser() {
      return personalBrowser;
    },
    get cdpHostProvider() {
      return cdp;
    },
    cdpHost,
    close,
    start,
    initializePanelTree,
    recover,
    browserPermissions,
    watch,
  };
}

export type DesktopWorkspaceRuntime = ReturnType<typeof createDesktopWorkspaceRuntime>;
