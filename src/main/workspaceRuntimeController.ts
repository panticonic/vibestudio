import { reportDraftContent } from "@vibestudio/service-schemas/problemReportBundle";
import {
  observeMainProcessErrors,
  readRetainedMainProcessErrors,
} from "./mainProcessErrorLedger.js";
import { collectedPacket } from "../server/problemReporting/collection.js";
import { createHash } from "node:crypto";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { ProblemReportingStore } from "../server/problemReporting/store.js";
import { ReportCapture } from "../server/problemReporting/capture.js";
import { UsageAnalytics } from "../server/problemReporting/usage.js";
import { ReportDelivery } from "../server/problemReporting/delivery.js";
import { createProblemReportsService } from "../server/services/problemReportsService.js";
import { problemReportsMethods } from "@vibestudio/service-schemas/problemReports";
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
import { createAppService } from "./services/appService.js";
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
import {
  RemoteCdpHostProviderSocket,
  whenServerChannelAvailable,
} from "./remoteCdpHostProviderSocket.js";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";
import { PanelPinStore } from "./panelPinStore.js";
import { PANEL_UI_MAX_LOADED_DESKTOP, PANEL_UI_IDLE_UNLOAD_MS } from "@vibestudio/shared/constants";
import { recoverRenderer } from "./rendererRecovery.js";
import { RpcBoundaryError } from "@vibestudio/rpc/errors";

type StartableDesktopWorkspaceRuntime = {
  start(): Promise<void>;
  close(): Promise<void>;
};

/** Owns publication and startup at the boundary where local services become ready. */
export function prepareDesktopWorkspaceRuntime<T extends StartableDesktopWorkspaceRuntime>(
  runtimes: Map<string, Promise<T>>,
  workspaceId: string,
  runtime: T
): { ready: Promise<T>; start(): Promise<T>; abort(error: unknown): Promise<void> } {
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: unknown) => void;
  let settled = false;
  let starting: Promise<T> | null = null;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const abort = async (error: unknown) => {
    if (settled) return;
    settled = true;
    if (runtimes.get(workspaceId) === ready) runtimes.delete(workspaceId);
    rejectReady(error);
    let failure = error;
    try {
      await runtime.close();
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        "Workspace runtime startup and cleanup failed"
      );
    }
    if (failure !== error) throw failure;
  };
  const start = () => {
    if (settled) return ready;
    return (starting ??= (async () => {
      try {
        await runtime.start();
        if (runtimes.get(workspaceId) !== ready) {
          throw new Error("Workspace access was removed during startup");
        }
        settled = true;
        resolveReady(runtime);
        return runtime;
      } catch (error) {
        await abort(error);
        throw error;
      }
    })());
  };
  runtimes.set(workspaceId, ready);
  void ready.catch(() => undefined);
  return { ready, start, abort };
}

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
  app?: Pick<
    Parameters<typeof createAppService>[0],
    "shellSurfaces" | "onOpenShellSurface" | "getAppOrchestrator" | "initialFocusedWorkspaceId"
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
  const reportingStore = new ProblemReportingStore(
    path.join(
      getCentralDataPath(),
      "problem-reporting",
      "clients",
      createHash("sha256").update(connection.nativeStorageScope).digest("hex")
    )
  );
  const reportingRemote = createTypedServiceClient(
    "problemReports",
    problemReportsMethods,
    (service, method, args) => connection.serverClient.call(service, method, args)
  );
  const reportingDelivery = new ReportDelivery(reportingStore, {
    forwardHostFetch: async (params) => {
      params.signal.throwIfAborted();
      const action =
        params.method === "POST" ? "upload" : params.method === "DELETE" ? "delete" : "status";
      const result = problemReportsMethods.transport.returns.parse(
        await connection.serverClient.call(
          "problemReports",
          "transport",
          [
            {
              action,
              submissionId: params.operation.resourceKey,
              digest: params.operation.preparedStateDigest,
              receiptSecret: params.headers!["x-report-receipt-secret"]!,
              publicKey: params.headers?.["x-report-public-key"],
              signature: params.headers?.["x-report-signature"],
              bytes: typeof params.body === "string" ? params.body : undefined,
            },
          ],
          { signal: params.signal }
        )
      );
      return {
        status: result.status,
        statusText: "",
        headerPairs: result.headerPairs,
        finalUrl: params.url,
        body: new TextEncoder().encode(result.body),
      };
    },
  });
  const reportingUsage = new UsageAnalytics(reportingStore, async (transmission, signal) => {
    signal.throwIfAborted();
    await connection.serverClient.call("problemReports", "usageTransport", [transmission], {
      signal,
    });
  });
  const reportingCapture = new ReportCapture(
    reportingStore,
    workspaceId,
    () => reportingDelivery.wake(),
    {
      runtime: "desktop",
      owner: () => reportingStore.localIdentity()?.userId ?? null,
      productVersion: app.getVersion(),
    }
  );
  dispatcher.setFailureObserver((failure) => reportingCapture.serviceFailure(failure));
  dispatcher.setSuccessObserver((outcome) => {
    if (outcome.service === "app" || outcome.service === "view")
      reportingUsage.serviceCompleted(
        outcome,
        () => reportingStore.localIdentity()?.userId ?? null
      );
  });
  const stopMainCapture = observeMainProcessErrors((record) => {
    const owner = reportingStore.localIdentity()?.userId;
    if (owner)
      reportingCapture.observe(
        owner,
        {
          category: "startup",
          component: "main",
          operation: record.kind,
          code: null,
          kind: "internal",
          frames: [],
          externalFramesOmitted: 0,
        },
        record.origin,
        new Date(record.timestamp).toISOString()
      );
  });
  let reportingSubject: Promise<{ userId: string; handle: string }> | null = null;
  const resolveReportingSubject = () =>
    (reportingSubject ??= (async () => {
      if (!connection.serverClient.isConnected()) {
        const persisted = reportingStore.localIdentity();
        if (!persisted) throw new Error("Local reporting identity is not available yet");
        return persisted;
      }
      const { accountProfileSchema } = await import("@vibestudio/service-schemas/account");
      const profile = accountProfileSchema.parse(
        await connection.serverClient.call("account", "getProfile", [])
      );
      if (profile.revoked) throw new Error("Account is revoked");
      const subject = { userId: profile.userId, handle: profile.handle };
      reportingStore.setLocalIdentity(subject);
      return subject;
    })()
      .then((subject) => {
        reportingUsage.startup(subject.userId);
        return subject;
      })
      .catch((error) => {
        reportingSubject = null;
        throw error;
      }));
  container.registerRpc(
    createProblemReportsService({
      store: reportingStore,
      forwardDraft: async (value) => {
        const draft = await reportingRemote.create(value.problem);
        const updated = await reportingRemote.update(
          draft.id,
          draft.revision,
          reportDraftContent(value)
        );
        return { reportId: draft.id, revision: updated.revision };
      },
      usage: reportingUsage,
      connectedServer: {
        consent: () => reportingRemote.consent(),
        decide: (revision, state) => reportingRemote.decide(revision, state),
      },
      workspaceId,
      redact: (text) => text,
      prepareRedactor: async () => {
        const { CredentialStore } = await import("@vibestudio/credential-client/store");
        const { registeredSecretRedactor } = await import("../server/problemReporting/sanitize.js");
        return registeredSecretRedactor(await new CredentialStore().list());
      },
      environment: {
        productVersion: app.getVersion(),
        buildVersion: null,
        templateVersion: null,
        platform: ["linux", "darwin", "win32"].includes(process.platform)
          ? (process.platform as "linux" | "darwin" | "win32")
          : "unknown",
        architecture: process.arch === "x64" || process.arch === "arm64" ? process.arch : "unknown",
        runtime: "desktop",
      },
      wake: () => reportingDelivery.wake(),
      abort: () => reportingDelivery.abortActive(),
      resolveSubject: resolveReportingSubject,
      transport: (_ctx, input) => reportingRemote.transport(input),
      collect: (_ctx, selection) => {
        if (selection.source === "startup") {
          const contents = window.viewManager?.getWebContents(_ctx.caller.runtime.id);
          const shell = window.viewManager?.getHostedShellWebContents();
          if (_ctx.caller.runtime.kind !== "shell" && (!contents || contents.id !== shell?.id))
            throw Object.assign(new Error("Select device diagnostics in trusted reporting UI"), {
              errorKind: "access",
            });
          return {
            source: "startup",
            coordinate: "main-diagnostics",
            collect: async () => {
              const all = readRetainedMainProcessErrors();
              const records = all.slice(-20);
              return {
                value: records,
                retained: records.length,
                omitted: Math.max(0, all.length - records.length),
                coordinate: JSON.stringify({ origins: records.map((record) => record.origin) }),
              };
            },
          };
        }
        return {
          source: selection.source,
          coordinate:
            selection.source === "runtime"
              ? JSON.stringify(selection.entity)
              : `server-log:${connection.workspaceId}`,
          collect: async (signal) => {
            const value = await connection.serverClient.call(
              selection.source === "runtime" ? "runtime" : "serverLog",
              selection.source === "runtime" ? "supervision.health" : "query",
              selection.source === "runtime"
                ? [selection.entity, { limit: 50, errorLimit: 50 }]
                : [{ limit: 100, tag: selection.tag, until: Date.now() }],
              { signal }
            );
            return collectedPacket(selection.source, value);
          },
        };
      },
      importPrepared: async (reference) => {
        const prepared = await reportingRemote.prepare(reference.reportId, reference.revision);
        if (prepared.digest !== reference.digest)
          throw new Error("Prepared report changed; review the current revision");
        const { decodeReport } = await import("@vibestudio/service-schemas/problemReportBundle");
        const bundle = await decodeReport(new TextEncoder().encode(prepared.bytes));
        if (bundle.intent !== "manual-problem")
          throw new Error("Only selected manual reports can be imported for review");
        return bundle;
      },
      isHuman: (ctx) =>
        ctx.caller.runtime.kind === "shell" ||
        (ctx.caller.runtime.kind === "app" &&
          window.viewManager?.getWebContents(ctx.caller.runtime.id)?.id ===
            window.viewManager?.getHostedShellWebContents()?.id),
    })
  );
  reportingDelivery.wake();
  let cdp: CdpHostProvider | null = null;
  let downloads: BrowserDownloadManager | null = null;
  const nativeViews = () => {
    if (!window.viewManager) throw new Error("Desktop window is closed");
    return new WorkspaceNativeViews(workspaceId, window.viewManager);
  };
  const cdpHost = {
    emitBrowserActivity: (panelId: string, activity: "popup" | "download", payload: unknown) =>
      cdp?.emitBrowserActivity(panelId, activity, payload),
    registerTarget: (id: string, contents: number) => cdp?.registerTarget(id, contents),
    unregisterTarget: (id: string, contentsId: number) => cdp?.unregisterTarget(id, contentsId),
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
    deps.window.handleWebsiteNotificationAction(connection.workspaceId, id, actionId);
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
  let rendererRecovery = new AbortController();
  let latestConnection = {
    status: connection.serverClient.getConnectionStatus(),
    isRemote: connection.connectionMode === "remote",
  };
  let recoveryPending = latestConnection.status !== "connected";
  const publishConnectionStatus = (status: import("./serverClient.js").ConnectionStatus) => {
    latestConnection = { ...latestConnection, status };
    eventService.emit("server-connection-changed", latestConnection);
  };
  const recover = async (kind: "resubscribe" | "cold-recover") => {
    if (closed) return;
    const epoch = ++semanticRecoveryEpoch;
    rendererRecovery.abort(new Error("Workspace recovery superseded"));
    rendererRecovery = new AbortController();
    const signal = rendererRecovery.signal;
    await watch.recover();
    if (closed || epoch !== semanticRecoveryEpoch) return;
    await controller.orchestrator.recoverShellSnapshot({ loadFocusedView: false });
    if (closed || epoch !== semanticRecoveryEpoch) return;
    const renderers = new Set<Electron.WebContents>();
    for (const { panelId } of controller.registry.listPanels()) {
      const panel = controller.registry.getPanel(panelId);
      if (!panel || getPanelSource(panel).startsWith("browser:")) continue;
      const contents = window.getWorkspacePanelView(workspaceId)?.getWebContents(panelId);
      if (contents && !contents.isDestroyed()) renderers.add(contents);
    }
    const chrome = window.viewManager?.getHostedShellWebContents();
    if (chrome && !chrome.isDestroyed()) renderers.add(chrome);
    const results = await Promise.allSettled(
      [...renderers].map((contents) => recoverRenderer(contents, kind, workspaceId, signal))
    );
    if (closed || epoch !== semanticRecoveryEpoch) return;
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    recoveryPending = false;
    publishConnectionStatus("connected");
    await deps.onRecovered?.(kind);
  };
  const stopRecovery = connection.serverClient.onRecovery(recover);
  const stopStatus = connection.serverClient.onConnectionStatusChange((status) => {
    if (closed) return;
    if (status === "connected") reportingDelivery.wake();
    if (status !== "connected") {
      rendererRecovery.abort(
        new RpcBoundaryError(
          "Workspace connection lost during recovery",
          "transport",
          "CONNECTION_LOST"
        )
      );
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
  let disposed = false;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Workspace runtime is closed");
  };
  type CleanupStep = { done: boolean; run: () => unknown };
  const producerCleanup: CleanupStep[] = [
    () => rendererRecovery.abort(new Error("Workspace runtime closed")),
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
  ].map((run) => ({ done: false, run }));
  const resourceCleanup: CleanupStep[] = [
    () => watch.close(),
    () => controller.orchestrator.unregisterRuntimeClient(),
    () => container.stopAll(),
    () => downloads?.stop(),
    () => flushPanelLog(),
  ].map((run) => ({ done: false, run }));
  const ownerCleanup: CleanupStep[] = [
    async () => {
      stopMainCapture();
      dispatcher.setFailureObserver(undefined);
      dispatcher.setSuccessObserver(undefined);
      reportingCapture.stop();
      await reportingUsage.stop();
      await reportingDelivery.stop();
      reportingStore.close();
    },
    () => controller.core.shutdown(),
    () => window.detachWorkspace(workspaceId),
  ].map((run) => ({ done: false, run }));
  const runCleanup = async (steps: CleanupStep[]): Promise<unknown[]> => {
    const results = await Promise.allSettled(
      steps
        .filter((step) => !step.done)
        .map(async (step) => {
          await step.run();
          step.done = true;
        })
    );
    return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  };
  const dispose = () => {
    if (disposed) return Promise.resolve();
    if (disposing) return disposing;
    const operation = (async () => {
      const errors: unknown[] = [];
      // Stop every producer even when one teardown fails, then drain work before
      // retiring the core and native owner. Connection lifetime is the caller's.
      errors.push(...(await runCleanup(producerCleanup)));
      errors.push(...(await runCleanup(resourceCleanup)));
      errors.push(...(await runCleanup(ownerCleanup)));
      if (errors.length) throw new AggregateError(errors, "Workspace runtime cleanup failed");
      disposed = true;
    })();
    disposing = operation;
    void operation.catch(() => {
      if (disposing === operation) disposing = null;
    });
    return operation;
  };
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
    if (entry.source === "lifecycle" && entry.level === "error") {
      const owner = reportingStore.localIdentity()?.userId;
      if (owner)
        reportingCapture.observe(
          owner,
          {
            category: "runtime",
            component: "renderer",
            operation: ["render-process-gone", "unresponsive", "did-fail-load"].includes(
              entry.message
            )
              ? entry.message
              : "panel.lifecycle",
            code: null,
            kind: entry.message === "render-process-gone" ? "internal" : "application",
            frames: [],
            externalFramesOmitted: 0,
          },
          undefined,
          new Date(entry.timestamp).toISOString()
        );
    }
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
  // These prerequisites own resources. Drain every sibling before startup
  // cleanup, including when one fails before another finishes acquiring one.
  const together = async <T extends readonly unknown[]>(tasks: {
    [K in keyof T]: Promise<T[K]>;
  }): Promise<T> => {
    try {
      return await Promise.all(tasks);
    } catch (error) {
      await Promise.allSettled(tasks);
      throw error;
    }
  };
  let starting: Promise<void> | null = null;
  const close = () => {
    closed = true;
    if (closing) return closing;
    const operation = (async () => {
      await starting?.catch(() => undefined);
      await dispose();
    })();
    closing = operation;
    void operation.catch(() => {
      if (closing === operation) closing = null;
    });
    return operation;
  };
  const start = () =>
    (starting ??= (async () => {
      try {
        assertOpen();
        const [partition] = await together([
          browserPartition,
          controller.orchestrator.registerRuntimeClient(),
        ] as const);
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
          createAppService({
            ...deps.app,
            panelOrchestrator: controller.orchestrator,
            serverClient: connection.serverClient,
            getViewManager,
            connectionMode: connection.connectionMode,
          })
        );
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
            snapshots: {
              "panel-tree-invalidated": () => latestTree,
              "server-connection-changed": () => latestConnection,
            },
            onWatchOpened: (events, context) => {
              const manager = window.viewManager;
              if (!manager) throw new Error("Desktop window is closed");
              requireAppCapability(context, manager, "panel-hosting", "Desktop server events");
              return watch.retainMany(events);
            },
          })
        );
        const hostConnectionId = controller.orchestrator.getRuntimeClientSessionId();
        const downloadManager = new BrowserDownloadManager({
          browserSession: session.fromPartition(partition),
          environmentKey: browserPermissions.getEnvironmentKey(),
          hostId: `desktop:${hostConnectionId}`,
          downloadsDirectory: app.getPath("downloads"),
          eventService,
          getViewManager: nativeViews,
          onActivity: (panelId, payload) => cdp?.emitBrowserActivity(panelId, "download", payload),
          requestSiteCapability: (contents, capability) =>
            browserPermissions.requestSiteCapability(contents, capability),
        });
        downloads = downloadManager;
        if (!deps.personal)
          container.registerRpc(
            createBrowserEnvironmentService({
              getDownloads: () => downloads,
              importRouter: localBrowserEnvironmentImportRouter(() => null),
              browserDataBrokerRepoPath: null,
            })
          );
        const personalServices = deps.personal
          ? import("./personalBrowserServices.js").then(({ registerPersonalBrowserServices }) =>
              registerPersonalBrowserServices({
                connection,
                container,
                eventService,
                window,
                browserPermissions,
                browserPartition: partition,
                downloads: downloadManager,
                hostConnectionId,
                adBlockManager: deps.adBlockManager,
              })
            )
          : Promise.resolve(null);
        [personalBrowser] = await together([personalServices, downloadManager.start()] as const);
        assertOpen();
        await container.startAll();
        assertOpen();
        window.attachWorkspaceServices({
          serverSession: connection,
          eventService,
          openShellSurface: deps.app?.onOpenShellSurface,
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
                  whenChannelAvailable: () => whenServerChannelAvailable(connection.serverClient),
                }
              : { kind: "authenticated-websocket", authToken: () => connection.getCdpAuthToken() },
          getViewManager: () => nativeViews(),
          diagnosticsStore: new RuntimeDiagnosticsStore({ statePath: connection.statePath }),
          forwardDiagnostic,
          onHostCommand: async (panelId, action, args, signal) => {
            if (action === "browserOperation") {
              const request =
                args[0] as import("@vibestudio/shared/panel/browserAutomation").BrowserAutomationRequest;
              if (!downloads) throw new Error("Download provider unavailable");
              return downloads.automation(panelId, request, signal);
            }
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
