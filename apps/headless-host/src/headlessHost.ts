import { HeadlessBrowserDownloads } from "./browserDownloads.js";
import type { BrowserAutomationRequest } from "@vibestudio/shared/panel/browserAutomation";
/**
 * HeadlessHost — orchestrator. Startup order matters:
 *   rpc connect → panelRuntime.registerClient → event watch →
 *   browser launch → cdp-host bridge connect → snapshot reconcile.
 * (The bridge upgrade is rejected until registerClient exists server-side.)
 */
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { randomUUID } from "crypto";
import { createDevLogger } from "@vibestudio/dev-log";
import type {
  PanelHost,
  PanelHostRegistration,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@vibestudio/shared/panel/panelLease";
import { createPanelHostRegistration } from "@vibestudio/shared/panel/panelLease";
import type { PanelHostObservation } from "@vibestudio/shared/panel/observation";
import { LeaseTracker, type LeaseIntent } from "@vibestudio/shared/panel/leaseTracker";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import {
  selectCapEvictionVictims,
  selectIdlePanelVictims,
  type LoadedPanelSnapshot,
} from "@vibestudio/shared/panel/panelGc";
import type { HeadlessHostConfig, HeadlessHostServerConnection } from "./config.js";
import { connectToServer } from "./serverConnection.js";
import { PanelInitClient } from "./panelInitClient.js";
import { resolveChromium } from "./browser/acquire.js";
import { launchChromium, type LaunchedChromium } from "./browser/launch.js";
import { CdpConnection } from "./browser/cdpConnection.js";
import { PageHost } from "./pageHost.js";
import { ConsoleHistoryStore } from "./consoleHistory.js";
import { CdpHostBridgeClient } from "./hostBridge.js";
import { BrowserCookieProjector } from "./browserCookieProjector.js";
import { ChromiumFetchHost } from "./chromiumFetchHost.js";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";

const log = createDevLogger("HeadlessHost");

const IDLE_CHECK_INTERVAL_MS = 30_000;

export class HeadlessHost implements PanelHost {
  private connection: HeadlessHostServerConnection | null = null;
  private events: EventsClient | null = null;
  private stopLeaseEvents: (() => void) | null = null;
  private stopContextEvents: (() => void) | null = null;
  private panelInit: PanelInitClient | null = null;
  private tracker: LeaseTracker;
  private browser: LaunchedChromium | null = null;
  private cdp: CdpConnection | null = null;
  private pages: PageHost | null = null;
  private downloads: HeadlessBrowserDownloads | null = null;
  private bridge: CdpHostBridgeClient | null = null;
  private fetchHost: ChromiumFetchHost | null = null;
  private readonly consoleHistory = new ConsoleHistoryStore();
  private tabCounter = 0;
  private readonly tabIds = new Map<string, number>();
  private intentQueue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleExitSince: number | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private browserRelaunches = 0;
  private browserGeneration = 0;
  private browserRecovery: Promise<void> | null = null;
  private browserStart: Promise<void> | null = null;
  readonly registration: PanelHostRegistration;
  private readonly bootstrapRegistration: PanelHostRegistration;
  /** Resolves when stop() completes; main.ts awaits this. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly config: HeadlessHostConfig) {
    this.registration = createPanelHostRegistration({
      clientSessionId: config.clientSessionId,
      label: config.label,
      platform: "headless",
      supportsCdp: true,
      loadOnLeaseAssignment: true,
    });
    this.bootstrapRegistration = {
      ...this.registration,
      loadOnLeaseAssignment: false,
    };
    this.tracker = new LeaseTracker(config.clientSessionId);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  async start(): Promise<void> {
    const connection = await (this.config.connectionFactory?.() ?? connectToServer(this.config));
    this.connection = connection;
    const workspace = createTypedServiceClient(
      "workspace",
      workspaceMethods,
      (service, method, args) => connection.rpc.call("main", `${service}.${method}`, args)
    );
    const workspaceInfo = await workspace.getInfo();
    this.panelInit = new PanelInitClient(
      connection.rpc,
      this.config.serverUrl,
      this.config.label,
      this.config.clientSessionId,
      workspaceInfo.config.id
    );

    await this.registerClient(this.bootstrapRegistration);
    this.config.lifecycle?.onRegistered?.();
    this.events = new EventsClient(connection.rpc);
    this.stopLeaseEvents = this.events.on("panel:runtimeLeaseChanged", (payload) => {
      this.handleRuntimeLeaseChanged(payload as PanelRuntimeLeaseChangedEvent);
    });
    this.stopContextEvents = this.events.on("runtime:contextRemoved", ({ contextId }) => {
      this.intentQueue = this.intentQueue
        .then(() => this.pages?.retireContext(contextId))
        .catch((error) => log.warn(`context ${contextId} retirement failed: ${String(error)}`));
    });
    await this.events.subscribeAll(["panel:runtimeLeaseChanged", "runtime:contextRemoved"]);
    connection.onResubscribe(async () => {
      try {
        await this.registerClient(
          this.bridge?.isConnected() ? this.registration : this.bootstrapRegistration
        );
        await this.events?.recover();
        await this.reconcile();
      } catch (error) {
        log.warn(`resubscribe recovery failed: ${String(error)}`);
      }
    });

    await this.startBrowser();
    if (this.stopped) return;
    await this.startBridge();
    await this.registerClient(this.registration);
    await this.reconcile();

    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref?.();
    log.info(
      `headless host ready (session ${this.config.clientSessionId}, max ${this.config.maxPanels} panels)`
    );
    this.config.lifecycle?.onReady?.();
  }

  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.resolve().then(() => this.releaseResources(reason));
    return this.stopping;
  }

  private async releaseResources(reason: string): Promise<void> {
    log.info(`stopping: ${reason}`);
    const failures: unknown[] = [];
    const release = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (this.idleTimer) clearInterval(this.idleTimer);
    try {
      await this.connection?.rpc.call("main", "panelRuntime.unregisterClient", [
        this.config.clientSessionId,
      ]);
    } catch {
      // Server may be gone — leases expire via the reconnect grace anyway.
    }
    await release(() => this.bridge?.stop());
    await this.browserStart?.catch(() => {});
    try {
      await this.cdp?.send("Browser.close");
    } catch {
      // Fall through to confirmed process retirement.
    }
    await release(() => this.retireBrowser());
    await release(() => this.stopLeaseEvents?.());
    this.stopLeaseEvents = null;
    await release(() => this.stopContextEvents?.());
    this.stopContextEvents = null;
    // Remote subscriptions can disappear with the server; closing the native
    // connection below remains mandatory even when unsubscribe fails.
    await this.events?.unsubscribeAll().catch(() => {});
    this.events = null;
    await release(() => this.connection?.close());
    this.resolveDone();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Headless host resource retirement failed");
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async registerClient(registration: PanelHostRegistration): Promise<void> {
    await this.connection!.rpc.call("main", "panelRuntime.registerClient", [registration]);
  }

  handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): void {
    // Advance ownership at event receipt, not when the serialized side-effect
    // queue eventually reaches this event. In-flight loads consult the tracker
    // after each await, so this is the cancellation signal for an immutable
    // runtime that has already been replaced.
    this.enqueueIntents(this.tracker.apply(event));
  }

  async syncRuntimeLeases(): Promise<void> {
    await this.reconcile();
  }

  private startBrowser(): Promise<void> {
    if (this.browserStart) return this.browserStart;
    const starting = this.replaceBrowser().finally(() => {
      if (this.browserStart === starting) this.browserStart = null;
    });
    this.browserStart = starting;
    return starting;
  }

  private async replaceBrowser(): Promise<void> {
    await this.retireBrowser();
    if (this.stopped) return;
    const generation = ++this.browserGeneration;
    const resolved = await resolveChromium({
      chromiumPath: this.config.chromiumPath,
      cacheDir: this.config.cacheDir,
      leanBrowser: this.config.leanBrowser,
    });
    log.info(`using chromium (${resolved.source}): ${resolved.executablePath}`);
    this.browser = await launchChromium({
      executablePath: resolved.executablePath,
      profileRoot: this.config.profileRoot,
    });
    if (this.stopped) {
      await this.retireBrowser();
      return;
    }
    this.cdp = await CdpConnection.connect(this.browser.wsEndpoint);
    const cookieProjector = new BrowserCookieProjector(this.cdp, this.connection!.rpc);
    this.fetchHost = new ChromiumFetchHost(this.cdp, cookieProjector);
    this.downloads = new HeadlessBrowserDownloads(this.cdp, {
      ownerForFrame: (frameId) => this.pages?.ownerForFrame(frameId),
      approve: (panelId, url, signal) =>
        this.approveBrowserCapability(panelId, url, "downloads", signal),
      activity: (panelId, payload) =>
        this.bridge?.sendEvent(panelId, "Vibestudio.download", payload),
    });
    await this.downloads.start(this.browser.profileDir);
    this.pages = new PageHost(
      this.cdp,
      this.consoleHistory,
      (browserContextId, url) =>
        cookieProjector.prepare(browserContextId, url).catch((error) => {
          log.warn(`browser cookies were unavailable for a headless panel: ${String(error)}`);
        }),
      {
        configureContext: (id) => this.downloads!.configureContext(id),
        popup: async (panelId, url) => {
          const owner = this.pages!.ownerForPanel(panelId);
          if (!(await this.approveBrowserCapability(panelId, owner.url, "popups", owner.signal)))
            throw new Error("Popup permission denied");
          const popup = await this.connection!.rpc.call<{ id: string }>(
            "main",
            "panel.createPanel",
            [panelId, `browser:${url}`, { focus: false, placement: "child" }],
            { signal: owner.signal }
          );
          this.bridge?.sendEvent(panelId, "Vibestudio.popup", {
            popup: { panelId: popup.id, url },
          });
        },
        popupFailed: (panelId, error) =>
          this.bridge?.sendEvent(panelId, "Vibestudio.popup", { error: error.message }),
      }
    );
    await this.pages.initializeBrowserActivities();
    this.pages.onViewChanged((slotId) => {
      void this.reportPageObservation(slotId);
    });
    this.pages.onRelayEvent((slotId, method, params, sessionId) => {
      this.bridge?.sendEvent(slotId, method, params, sessionId);
    });
    this.cdp.onClose(() => void this.handleBrowserGone(generation));
    this.browser.process.once("exit", () => void this.handleBrowserGone(generation));
  }

  /**
   * Publish a native page transition through the same durable coordinator used
   * by desktop hosts. The renderer also reports bootstrap transitions itself;
   * this host-owned edge covers initial/late connection and failed renderer
   * bootstrap without reintroducing an observation poller.
   */
  private async reportPageObservation(slotId: string): Promise<void> {
    const panelSlotId = asPanelSlotId(slotId);
    const lease = this.tracker.heldLease(panelSlotId);
    if (!lease || !this.pages || !this.connection) return;
    try {
      const observation = await this.pages.panelPageObservation(slotId);
      const current = this.tracker.heldLease(panelSlotId);
      if (
        current?.runtimeEntityId !== lease.runtimeEntityId ||
        current.connectionId !== lease.connectionId
      ) {
        return;
      }
      await this.connection.rpc.call("main", "panelRuntime.reportView", [
        lease.runtimeEntityId,
        lease.connectionId,
        {
          url: observation.view.url,
          loading: observation.view.loading,
          boot: observation.boot,
        },
      ]);
    } catch (error) {
      // Navigation replaces the execution context and lease churn replaces the
      // runtime identity. A later native/renderer transition publishes the
      // winning incarnation; failures remain available through host probing.
      log.verbose(`view transition for ${slotId} was superseded: ${String(error)}`);
    }
  }

  private async handleBrowserGone(generation: number): Promise<void> {
    if (this.stopped) return;
    if (generation !== this.browserGeneration) return;
    if (this.browserRecovery) return this.browserRecovery;
    const recovery = this.recoverBrowser(generation).finally(() => {
      if (this.browserRecovery === recovery) this.browserRecovery = null;
    });
    this.browserRecovery = recovery;
    return recovery;
  }

  private async retireBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (this.downloads) await this.downloads.stop();
    this.downloads = null;
    this.cdp?.close();
    this.cdp = null;
    this.pages = null;
    this.fetchHost = null;
    await browser?.stop();
  }

  private async recoverBrowser(generation: number): Promise<void> {
    if (this.stopped || generation !== this.browserGeneration) return;
    this.browserRelaunches += 1;
    if (this.browserRelaunches > 1) {
      log.warn("chromium died twice — giving up");
      await this.stop("chromium crash loop");
      process.exitCode = 1;
      return;
    }
    log.warn("chromium died — relaunching");
    for (const slotId of this.tabIds.keys()) this.bridge?.unregisterTarget(slotId);
    this.tabIds.clear();
    try {
      await this.startBrowser();
      // Reset relaunch counter after 60s of stability.
      setTimeout(() => {
        this.browserRelaunches = 0;
      }, 60_000).unref?.();
      await this.reconcile({ forceReload: true });
    } catch (error) {
      log.warn(`chromium relaunch failed: ${String(error)}`);
      await this.stop("chromium relaunch failed");
      process.exitCode = 1;
    }
  }

  private startBridge(): Promise<void> {
    let resolveFirstAuthenticated!: () => void;
    const firstAuthenticated = new Promise<void>((resolve) => {
      resolveFirstAuthenticated = resolve;
    });
    let authenticatedOnce = false;
    this.bridge = new CdpHostBridgeClient({
      serverUrl: this.config.serverUrl,
      hostConnectionId: this.config.clientSessionId,
      getToken: () => this.connection!.getToken(),
      ...(this.config.bridgeSocketFactory
        ? { socketFactory: this.config.bridgeSocketFactory }
        : {}),
      handlers: {
        cdpCommand: (targetId, method, params, sessionId) =>
          this.pages!.relaySend(targetId, method, params, sessionId),
        navCommand: (targetId, action, url) =>
          this.pages!.navigate(
            targetId,
            action as "navigate" | "reload" | "goBack" | "goForward" | "stop",
            url
          ),
        hostCommand: (targetId, action, args, signal) =>
          this.handleHostCommand(targetId, action, args, signal),
        hostOperation: (action, args) => this.handleHostOperation(action, args),
        detach: (targetId) => this.pages!.detachRelay(targetId),
        registerRejected: (targetId, reason) => {
          void this.releaseAndUnload(targetId, `register rejected: ${reason}`);
          log.warn(`dropped panel ${targetId} after register rejection (${reason})`);
        },
      },
      onAuthenticated: () => {
        if (!authenticatedOnce) {
          authenticatedOnce = true;
          resolveFirstAuthenticated();
          return;
        }
        void this.registerClient(this.registration).catch((error) => {
          log.warn(`failed to refresh ready registration after bridge auth: ${String(error)}`);
        });
      },
      onDiagnostic: (diagnostic) => {
        this.config.lifecycle?.onBridgeDiagnostic?.(diagnostic);
      },
    });
    this.bridge.start();
    return firstAuthenticated;
  }

  private async approveBrowserCapability(
    panelId: string,
    url: string,
    capability: "downloads" | "popups",
    signal?: AbortSignal
  ): Promise<boolean> {
    const origin = new URL(url).origin;
    const result = await this.connection!.rpc.call<{ granted: boolean }>(
      "main",
      "browserPermissions.request",
      [
        {
          panelId,
          sessionEpoch: this.config.clientSessionId,
          origin,
          topLevelUrl: url,
          capabilities: [capability],
          deviceLabel: this.config.label,
        },
      ],
      { signal }
    );
    return result.granted;
  }

  private async handleHostCommand(
    slotId: string,
    action: string,
    args: unknown[],
    signal: AbortSignal
  ): Promise<unknown> {
    switch (action) {
      case "browserOperation":
        if (!this.downloads) throw new Error("Download provider unavailable");
        return this.downloads.operation(slotId, args[0] as BrowserAutomationRequest, signal);
      case "panelObservation": {
        const panelSlotId = asPanelSlotId(slotId);
        if (!this.tracker.heldLease(panelSlotId)) {
          throw new Error(`no lease held for panel ${slotId}`);
        }
        const observation = await this.pages!.panelPageObservation(slotId);
        return {
          holderLabel: this.registration.label,
          platform: this.registration.platform,
          supportsInspection: this.registration.supportsCdp,
          view: {
            exists: true,
            ...observation.view,
          },
          boot: observation.boot,
        } satisfies PanelHostObservation;
      }
      case "accessibilityTree":
        return this.pages!.accessibilityTree(slotId);
      case "domSnapshot":
        return this.pages!.domSnapshot(slotId);
      case "consoleHistory":
        return this.consoleHistory.query(
          slotId,
          (args[0] ?? {}) as Parameters<ConsoleHistoryStore["query"]>[1]
        );
      case "captureScreenshot":
        return this.pages!.captureScreenshot(
          slotId,
          (args[0] ?? {}) as Parameters<PageHost["captureScreenshot"]>[1]
        );
      case "evaluate":
        return this.pages!.evaluate(
          slotId,
          String(args[0] ?? ""),
          (args[1] ?? {}) as Parameters<PageHost["evaluate"]>[2]
        );
      case "rebuildPanel": {
        const panelSlotId = asPanelSlotId(slotId);
        const lease = this.tracker.heldLease(panelSlotId);
        if (!lease) throw new Error(`no lease held for panel ${slotId}`);
        const info = await this.panelInit!.getPanelLoadInfo(
          panelSlotId,
          lease.runtimeEntityId,
          lease.connectionId
        );
        await this.pages!.reloadPanel(panelSlotId, info.panelUrl, info.panelInit);
        return { action, status: "reloaded" };
      }
      case "reloadPanel": {
        const panelSlotId = asPanelSlotId(slotId);
        const lease = this.tracker.heldLease(panelSlotId);
        if (!lease) throw new Error(`no lease held for panel ${slotId}`);
        const info = await this.panelInit!.getPanelLoadInfo(
          panelSlotId,
          lease.runtimeEntityId,
          lease.connectionId
        );
        await this.pages!.reloadPanel(panelSlotId, info.panelUrl, info.panelInit);
        return {
          panelId: slotId,
          operation: "reload",
          status: "reloaded",
          loaded: true,
          rebuilt: false,
          reloaded: true,
        };
      }
      case "navigatePanel": {
        const panelSlotId = asPanelSlotId(slotId);
        if (!this.tracker.heldLease(panelSlotId)) {
          throw new Error(`no lease held for panel ${slotId}`);
        }
        const source = typeof args[0] === "string" ? args[0] : "";
        if (!source) throw new Error("navigatePanel requires a source");
        const options =
          args[1] && typeof args[1] === "object"
            ? (args[1] as {
                ref?: string;
                contextId?: string;
                env?: Record<string, string>;
                stateArgs?: Record<string, unknown>;
              })
            : undefined;
        const connectionId = `navigate-${slotId}-${randomUUID()}`;
        const result = await this.panelInit!.navigatePanel(
          panelSlotId,
          source,
          options,
          connectionId
        );
        await this.reconcile();
        return { id: result.panelId, title: result.title };
      }
      case "navigatePanelHistory": {
        const panelSlotId = asPanelSlotId(slotId);
        if (!this.tracker.heldLease(panelSlotId)) {
          throw new Error(`no lease held for panel ${slotId}`);
        }
        const delta = args[0] === -1 || args[0] === 1 ? args[0] : 0;
        if (!delta) throw new Error("navigatePanelHistory requires delta -1 or 1");
        const connectionId = `history-${slotId}-${randomUUID()}`;
        const result = await this.panelInit!.navigatePanelHistory(panelSlotId, delta, connectionId);
        await this.reconcile();
        return result;
      }
      case "openDevTools":
        throw new Error("openDevTools is not supported on a headless host");
      default:
        throw new Error(`Unknown host command: ${action}`);
    }
  }

  private async handleHostOperation(action: string, args: unknown[]): Promise<unknown> {
    switch (action) {
      case "chromiumFetch.open": {
        const input = (args[0] ?? {}) as { url?: unknown; session?: unknown };
        if (typeof input.url !== "string") throw new Error("chromiumFetch.open requires a URL");
        const session = input.session === "browser" ? "browser" : "public";
        return this.fetchHost!.open(input.url, session);
      }
      case "chromiumFetch.read": {
        const input = (args[0] ?? {}) as {
          responseId?: unknown;
          offset?: unknown;
          limit?: unknown;
        };
        if (typeof input.responseId !== "string") {
          throw new Error("chromiumFetch.read requires a response id");
        }
        return this.fetchHost!.read(
          input.responseId,
          typeof input.offset === "number" ? input.offset : 0,
          typeof input.limit === "number" ? input.limit : 256 * 1024
        );
      }
      case "chromiumFetch.close": {
        const input = (args[0] ?? {}) as { responseId?: unknown };
        if (typeof input.responseId === "string") this.fetchHost!.close(input.responseId);
        return undefined;
      }
      default:
        throw new Error(`Unknown host operation: ${action}`);
    }
  }

  private async reconcile(opts?: { forceReload?: boolean }): Promise<void> {
    const observedContexts = this.pages?.contextIds() ?? [];
    const snapshot = await this.connection!.rpc.call<RuntimeLeaseSnapshot>(
      "main",
      "panelRuntime.getSnapshot",
      []
    );
    const intents = this.tracker.reconcile(snapshot);
    const owners = await this.connection!.rpc.call<{ contexts: string[] }>(
      "main",
      "runtime.listContexts",
      []
    );
    if (opts?.forceReload) {
      // After a browser relaunch every held lease needs a fresh page even
      // though the tracker considers it converged.
      const held = new Set(intents.filter((i) => i.kind === "load").map((i) => i.slotId));
      for (const slotId of this.tracker.heldSlots()) {
        if (held.has(slotId)) continue;
        const lease = this.tracker.heldLease(slotId)!;
        intents.push({
          kind: "load",
          slotId,
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
      }
    }
    this.enqueueIntents(intents);
    this.intentQueue = this.intentQueue.then(() =>
      this.pages?.reconcileContextOwners(owners.contexts, observedContexts)
    );
    await this.intentQueue;
  }

  /** Serialize host side effects; lease ownership itself advances immediately. */
  private enqueueIntents(intents: LeaseIntent[]): void {
    this.intentQueue = this.intentQueue.then(async () => {
      for (const intent of intents) {
        try {
          await this.processIntent(intent);
        } catch (error) {
          if (intent.kind === "load" && !this.isCurrentLoadIntent(intent)) continue;
          log.warn(`intent ${intent.kind} for ${intent.slotId} failed: ${String(error)}`);
          if (intent.kind === "load") {
            await this.releaseAndUnload(intent.slotId, "load failed");
          }
        }
      }
    });
  }

  private isCurrentLoadIntent(intent: Extract<LeaseIntent, { kind: "load" }>): boolean {
    const current = this.tracker.heldLease(intent.slotId);
    return (
      current?.connectionId === intent.connectionId &&
      current.runtimeEntityId === intent.runtimeEntityId
    );
  }

  private async processIntent(intent: LeaseIntent): Promise<void> {
    if (this.stopped || !this.pages) return;
    if (intent.kind === "unload") {
      this.bridge?.unregisterTarget(intent.slotId);
      this.tabIds.delete(intent.slotId);
      await this.pages.unloadPanel(intent.slotId);
      return;
    }

    // Intent processing is serialized, but lease events keep updating the
    // tracker while an earlier page load is in flight. A queued load can
    // therefore be obsolete by the time it reaches this boundary. Re-check
    // ownership before asking the server for a single-use load token; otherwise
    // a normal close/navigate race becomes a noisy "Panel not found" failure.
    if (!this.isCurrentLoadIntent(intent)) return;

    await this.enforcePanelCap();
    if (!this.isCurrentLoadIntent(intent)) return;
    // Fetch init fresh each load — the embedded gateway token is single-use.
    let info;
    try {
      info = await this.panelInit!.getPanelLoadInfo(
        intent.slotId,
        intent.runtimeEntityId,
        intent.connectionId
      );
    } catch (error) {
      if (!this.isCurrentLoadIntent(intent)) return;
      throw error;
    }
    if (!this.isCurrentLoadIntent(intent)) return;
    const tabId = ++this.tabCounter;
    await this.pages.loadPanel({
      slotId: intent.slotId,
      contextId: info.contextId,
      panelUrl: info.panelUrl,
      panelInit: info.panelInit,
      tabId,
    });
    if (!this.isCurrentLoadIntent(intent)) {
      await this.pages.unloadPanel(intent.slotId);
      return;
    }
    this.tabIds.set(intent.slotId, tabId);
    this.bridge?.registerTarget(intent.slotId, tabId, {
      kind: info.source.startsWith("browser:") ? "browser" : "workspace",
      source: info.source,
    });
  }

  /**
   * Snapshot of currently loaded slots for the shared GC selectors. Headless
   * has no product retention intent; `keepLoaded` (active CDP/automation) is
   * the only protection beyond the cap/idle policy.
   */
  private loadedSlotSnapshots(now: number): LoadedPanelSnapshot[] {
    return this.pages!.slots().map((slotId) => ({
      panelId: slotId,
      lastActive: this.pages!.lastUsedAt(slotId) ?? now,
    }));
  }

  private readonly gcIsKeepLoaded = (slotId: string): boolean =>
    !!this.tracker.heldLease(asPanelSlotId(slotId))?.keepLoaded;

  private async enforcePanelCap(): Promise<void> {
    if (!this.pages) return;
    // Evict down to maxPanels-1 to leave room for the incoming panel, via the
    // same selector desktop/mobile use (unretained-oldest-first; keepLoaded-safe).
    const victims = selectCapEvictionVictims(this.loadedSlotSnapshots(Date.now()), {
      cap: Math.max(0, this.config.maxPanels - 1),
      protectedIds: [],
      hasRetentionIntent: () => false,
      isKeepLoaded: this.gcIsKeepLoaded,
    });
    for (const slotId of victims) await this.releaseAndUnload(slotId, "panel cap");
  }

  private async releaseAndUnload(slotId: string, why: string): Promise<void> {
    log.info(`releasing panel ${slotId} (${why})`);
    const panelSlotId = asPanelSlotId(slotId);
    const lease = this.tracker.heldLease(panelSlotId);
    this.tracker.drop(panelSlotId);
    this.bridge?.unregisterTarget(slotId);
    this.tabIds.delete(slotId);
    await this.pages?.unloadPanel(slotId);
    if (lease) {
      await this.connection?.rpc
        .call("main", "panelRuntime.release", [lease.runtimeEntityId, lease.connectionId])
        .catch(() => undefined);
    }
  }

  private checkIdle(): void {
    if (this.stopped || !this.pages) return;
    const now = Date.now();
    const victims = selectIdlePanelVictims(this.loadedSlotSnapshots(now), {
      now,
      idleMs: this.config.idleUnloadMs,
      protectedIds: [],
      hasRetentionIntent: () => false,
      isKeepLoaded: this.gcIsKeepLoaded,
    });
    for (const slotId of victims) void this.releaseAndUnload(slotId, "idle");

    if (this.config.idleExitMs && this.config.idleExitMs > 0) {
      if (this.tracker.heldSlots().length === 0) {
        this.idleExitSince ??= now;
        if (now - this.idleExitSince > this.config.idleExitMs) {
          void this.stop("idle exit");
        }
      } else {
        this.idleExitSince = null;
      }
    }
  }
}
