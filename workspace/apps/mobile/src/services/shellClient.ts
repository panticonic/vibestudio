import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { Panel, PanelTreeSnapshot, ThemeAppearance } from "@vibestudio/shared/types";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { Appearance, Platform } from "react-native";
import { WorkspaceClient } from "@vibestudio/service-schemas/clients/shellWorkspaceClient";
import { SettingsClient } from "@vibestudio/service-schemas/clients/settingsClient";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type { RecoveryCoordinator, RecoveryKind } from "@vibestudio/shell-core/recoveryCoordinator";
import type { PanelManager } from "@vibestudio/shell-core/panelManager";
import type {
  PanelHost,
  PanelHostRegistration,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@vibestudio/shared/panel/panelLease";
import {
  createPanelHostRegistration,
  createPanelRuntimeLeaseRequest,
} from "@vibestudio/shared/panel/panelLease";
import { asPanelSlotId, asPanelEntityId, type PanelEntityId } from "@vibestudio/shared/panel/ids";
import {
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type BrowserAddressOptions,
  type PanelAddressOptions,
} from "@vibestudio/shared/panelChrome";
import {
  createBrowserDataClient,
  type BrowserDataClient,
  type RecordHistoryVisitRequest,
  type UpdateHistoryTitleRequest,
} from "@vibestudio/browser-data/client";
import { createBridgeAdapter } from "./bridgeAdapter";
import { MobileRpcClient, type ConnectionStatus } from "./mobileTransport";
import { createMobileShellCore } from "../shellCore/createMobileShellCore";
import { startPanelAssetFacade, type PanelAssetFacade } from "./panelAssetFacade";
import { drainWorkspaceMutationQueue } from "./backgroundActionQueue";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { pushMethods } from "@vibestudio/service-schemas/push";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import {
  systemAgentMethods,
  type SystemAgentConversation,
} from "@vibestudio/service-schemas/systemAgent";
import {
  createDurableObjectServiceClient,
  createGadServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
import {
  type UserNotification,
  type UserNotificationAcknowledgementResult,
  type UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import {
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
  isLaunchSessionEventFor,
} from "@vibestudio/shared/hostTargetLaunchGate";
import type { HostTargetLaunchSessionSnapshot } from "@vibestudio/shared/hostTargets";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import {
  mobilePanelRoots,
  orderMobilePanelForest,
  preferredMobileRoot,
} from "../shellCore/panelForest";
import {
  MobileAccountProfileClient,
  type MobileAccountProfile,
  type MobileAccountProfileUpdate,
} from "./accountProfileClient";

export type { MobileAccountProfile, MobileAccountProfileUpdate } from "./accountProfileClient";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[VibestudioMobileSmoke] phase=${phase}${suffix}`);
}

export interface ShellClientConfig {
  credentials: Credentials;
  onTreeUpdated?: (snapshot: PanelTreeSnapshot) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface Credentials {
  deviceId: string;
}
function createShellApprovalClient(transport: MobileRpcClient) {
  return createTypedServiceClient("shellApproval", shellApprovalMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createPanelRuntimeClient(transport: MobileRpcClient) {
  return createTypedServiceClient("panelRuntime", panelRuntimeMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createCredentialsClient(transport: MobileRpcClient) {
  return createTypedServiceClient("credentials", credentialsMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, rewriteCredentialArgsForPlatform(method, args))
  );
}

function rewriteCredentialArgsForPlatform(method: string, args: unknown[]): unknown[] {
  if (method !== "connect" || Platform.OS !== "ios") return args;
  const [request, ...rest] = args as [unknown, ...unknown[]];
  if (!request || typeof request !== "object" || Array.isArray(request)) return args;
  const redirect = (request as { redirect?: unknown }).redirect;
  if (!redirect || typeof redirect !== "object" || Array.isArray(redirect)) return args;
  if ((redirect as { type?: unknown }).type !== "client-loopback") return args;
  const callbackUri = (redirect as { callbackUri?: unknown }).callbackUri;
  return [
    {
      ...(request as Record<string, unknown>),
      redirect: {
        ...(redirect as Record<string, unknown>),
        type: "app-scheme",
        ...(typeof callbackUri === "string" ? { callbackUri } : {}),
      },
      browser: "external",
    },
    ...rest,
  ];
}

function createPushClient(transport: MobileRpcClient) {
  return createTypedServiceClient("push", pushMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createWorkspaceRpcClient(transport: MobileRpcClient) {
  return createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createHubControlClient(transport: MobileRpcClient) {
  return createTypedServiceClient("hubControl", hubControlMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

type ShellApprovalClient = ReturnType<typeof createShellApprovalClient>;
type PanelRuntimeClient = ReturnType<typeof createPanelRuntimeClient>;
type CredentialsClient = ReturnType<typeof createCredentialsClient>;
type PushClient = ReturnType<typeof createPushClient>;
type WorkspaceRpcClient = ReturnType<typeof createWorkspaceRpcClient>;
type WorkspaceInfo = Awaited<ReturnType<WorkspaceClient["getInfo"]>>;

export class MobileHostTargetApprovalRequiredError extends Error {
  readonly approvals: PendingUnitBatchApproval[];
  readonly launchSession: HostTargetLaunchSessionSnapshot;

  constructor(launchSession: HostTargetLaunchSessionSnapshot) {
    super(launchSession.message || "Approve the workspace mobile app before opening panels.");
    this.name = "MobileHostTargetApprovalRequiredError";
    this.approvals = launchSession.approvals;
    this.launchSession = launchSession;
  }
}

function formatHostTargetLaunchSession(session: HostTargetLaunchSessionSnapshot): string {
  return [session.message, session.detail].filter(Boolean).join(" ");
}

class MobilePanels implements PanelHost {
  private panelManager: PanelManager | null = null;
  private registryInstance: PanelRegistry | null = null;
  private bridgeAdapterInstance: ReturnType<typeof createBridgeAdapter> | null = null;
  // Set by the UI (MainScreen) so the panel-RPC relay can push server replies +
  // events into the right panel's webview. A mutable field (not a constructor
  // dep) because the webview refs live in the UI, which mounts after init().
  private deliverToPanelFn: ((panelId: string, envelope: unknown) => void) | null = null;
  // Host→panel envelopes that arrived before the UI registered its delivery sink
  // (init() completes before MainScreen mounts). Bounded per panel; flushed in
  // order by setDeliverToPanel so relay replies/events never silently vanish.
  private readonly pendingDeliveries = new Map<string, unknown[]>();
  private static readonly MAX_PENDING_DELIVERIES_PER_PANEL = 256;
  private readonly panelRuntime: PanelRuntimeClient;
  private readonly browserData: BrowserDataClient;
  private readonly workspaceRpc: WorkspaceRpcClient;
  private readonly runtimeConnectionBySlot = new Map<
    string,
    { runtimeEntityId: PanelEntityId; connectionId: string }
  >();
  readonly registration: PanelHostRegistration;
  constructor(
    private readonly deps: {
      serverUrl: string;
      transport: MobileRpcClient;
      onTreeUpdated?: (snapshot: PanelTreeSnapshot) => void;
      getSelfUserId: () => string | null;
      navigateToPanel: (panelId: string) => void;
      clientSessionId: string;
    }
  ) {
    this.registration = createPanelHostRegistration({
      clientSessionId: deps.clientSessionId,
      label: "Mobile",
      platform: "mobile",
      supportsCdp: false,
      loadOnLeaseAssignment: false,
    });
    this.panelRuntime = createPanelRuntimeClient(this.deps.transport);
    this.workspaceRpc = createWorkspaceRpcClient(this.deps.transport);
    this.browserData = createBrowserDataClient({
      call: (service: string, method: string, args: unknown[]) =>
        this.deps.transport.call("main", `${service}.${method}`, args),
    });
  }
  get registry(): PanelRegistry {
    if (!this.registryInstance) throw new Error("Panels not initialized");
    return this.registryInstance;
  }
  /**
   * Tree mutations route through the single server authority (panelTree); the
   * mobile mirror updates reactively from the panel-tree-updated broadcast (the
   * UI materializes panels from the tree atom). Mobile connects as a native
   * `shell:${deviceId}` host, which panelTree's policy allows.
   */
  private callPanelTree<T = unknown>(method: string, args: unknown[]): Promise<T> {
    return this.deps.transport.call("main", `panelTree.${method}`, args) as Promise<T>;
  }
  async init(workspaceId: string, _workspaceConfig?: WorkspaceConfig): Promise<void> {
    if (!this.panelManager) {
      const core = createMobileShellCore({
        workspaceId,
        serverUrl: this.deps.serverUrl,
        transport: this.deps.transport,
        onTreeUpdated: this.deps.onTreeUpdated,
      });
      this.panelManager = core.panelManager;
      this.registryInstance = core.registry;
      this.bridgeAdapterInstance = createBridgeAdapter({
        panelManager: core.panelManager,
        transport: this.deps.transport,
        getPanelInit: (panelId) => this.getPanelInit(panelId),
        callbacks: {
          navigateToPanel: this.deps.navigateToPanel,
        },
        deliverToPanel: (panelId, envelope) => this.deliverToPanel(panelId, envelope),
        getPanelLease: (panelId) => this.runtimeConnectionBySlot.get(panelId),
      });
    }
    const initialTheme = Appearance.getColorScheme() === "light" ? "light" : "dark";
    this.panelManager.setCurrentTheme(initialTheme);
    await this.panelRuntime.registerClient(this.registration);
    // The server is the sole tree authority and seeds initPanels for the
    // authenticated owner. Mobile only syncs the canonical forest.
    await this.panelManager.syncSnapshot();
    await this.syncRuntimeLeases();
    const firstRoot = this.getPreferredRoot();
    if (firstRoot) {
      await this.panelManager.notifyFocused(asPanelSlotId(firstRoot.id));
      this.deps.navigateToPanel(firstRoot.id);
    }
  }
  async refresh(): Promise<void> {
    await this.requireManager().syncSnapshot();
    await this.syncRuntimeLeases();
  }
  async recoverSnapshot(): Promise<void> {
    await this.requireManager().syncSnapshot();
    await this.syncRuntimeLeases();
  }
  applyTreeSnapshot(snapshot: PanelTreeSnapshot): boolean {
    return this.requireManager().applyForestSnapshot(snapshot);
  }
  getTreeSnapshot(): PanelTreeSnapshot {
    return this.registry.getPanelTreeSnapshot();
  }
  getPreferredRoot() {
    return preferredMobileRoot(this.getTreeSnapshot().forest, this.deps.getSelfUserId());
  }
  getCollapsedIds(): string[] {
    return this.registry.getCollapsedIds();
  }
  async archive(panelId: string): Promise<void> {
    await this.callPanelTree("archive", [panelId]);
  }
  async movePanel(
    panelId: string,
    newParentId: string | null,
    targetPosition: number
  ): Promise<void> {
    await this.callPanelTree("movePanel", [{ panelId, newParentId, targetPosition }]);
  }
  async createAboutPanel(page: string): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      `about/${page}`,
      { name: `${page}~${Date.now().toString(36)}` },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async createFromSource(
    source: string,
    options?: {
      name?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      { name: options?.name, contextId: options?.contextId, stateArgs: options?.stateArgs },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async focus(panelId: string): Promise<void> {
    await this.requireManager().notifyFocused(asPanelSlotId(panelId));
    this.deps.navigateToPanel(panelId);
  }
  async createChildPanel(
    parentId: string,
    source: string,
    options?: {
      name?: string;
      contextId?: string;
      focus?: boolean;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      {
        parentId,
        name: options?.name,
        contextId: options?.contextId,
        ref: options?.ref,
        stateArgs: options?.stateArgs,
      },
    ]);
    if (options?.focus !== false) this.deps.navigateToPanel(result.id);
    return result;
  }
  async createBrowserUrlPanel(
    parentId: string | null,
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      url,
      { parentId: parentId ?? undefined, name: options?.name },
    ]);
    if (options?.focus !== false) this.deps.navigateToPanel(result.id);
    return result;
  }
  async createRootPanel(
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      name?: string;
      focus?: boolean;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      {
        parentId: null,
        ref: options?.ref,
        contextId: options?.contextId,
        name: options?.name,
        focus: options?.focus,
        stateArgs: options?.stateArgs,
      },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.callPanelTree("setCollapsed", [panelId, collapsed]);
  }
  async expandIds(panelIds: string[]): Promise<void> {
    await this.callPanelTree("expandIds", [panelIds]);
  }
  async notifyFocused(panelId: string): Promise<void> {
    await this.requireManager().notifyFocused(asPanelSlotId(panelId));
  }
  async updateStateArgs(
    panelId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.callPanelTree<Record<string, unknown>>("setStateArgs", [panelId, updates]);
  }
  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.requireManager().updateTitle(asPanelSlotId(panelId), title);
    this.emitTreeUpdated();
  }
  async updateBrowserUrl(panelId: string, url: string): Promise<void> {
    await this.callPanelTree("navigate", [panelId, url, undefined]);
  }
  async navigatePanel(
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id?: string; title?: string }>("navigate", [
      panelId,
      source,
      options,
    ]);
    return { id: result?.id ?? panelId, title: result?.title ?? "" };
  }
  async getAddressOptions(source: string): Promise<PanelAddressOptions> {
    return getSharedPanelAddressOptions({
      source,
      repoProvider: {
        sourceTree: () => this.workspaceRpc.sourceTree(),
      },
    });
  }
  async getBrowserAddressOptions(query: string): Promise<BrowserAddressOptions> {
    return getSharedBrowserAddressOptions({
      query,
      panels: mobilePanelRoots(
        orderMobilePanelForest(this.getTreeSnapshot().forest, this.deps.getSelfUserId())
      ),
      browserData: {
        searchHistoryForAutocomplete: (searchQuery, limit) =>
          this.browserData.searchHistoryForAutocomplete(searchQuery, limit),
        getHistory: (historyQuery) => this.browserData.getHistory(historyQuery),
        searchBookmarks: (searchQuery) => this.browserData.searchBookmarks(searchQuery),
        getSearchEngines: () => this.browserData.getSearchEngines(),
      },
    });
  }
  async recordHistoryVisit(request: RecordHistoryVisitRequest): Promise<void> {
    await this.browserData.recordHistoryVisit(request);
  }
  async updateHistoryTitle(request: UpdateHistoryTitleRequest): Promise<void> {
    await this.browserData.updateHistoryTitle(request);
  }
  async updateTheme(theme: ThemeAppearance): Promise<void> {
    this.requireManager().setCurrentTheme(theme);
  }
  async unload(panelId: string): Promise<void> {
    // Tear down the panel's dedicated relay session (closed regardless of whether
    // it held a runtime lease).
    this.bridgeAdapterInstance?.closePanelSession(panelId);
    const lease = this.runtimeConnectionBySlot.get(panelId);
    this.runtimeConnectionBySlot.delete(panelId);
    if (!lease) return;
    try {
      await this.panelRuntime.release(lease.runtimeEntityId, lease.connectionId);
    } catch (error) {
      console.warn("[MobilePanels] Failed to release panel lease", {
        panelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async getPanelInit(panelId: string): Promise<unknown> {
    const slotId = asPanelSlotId(panelId);
    const panelInit = await this.requireManager().getPanelInit(slotId);
    const lease = this.runtimeConnectionBySlot.get(String(slotId));
    if (!lease || !panelInit || typeof panelInit !== "object") return panelInit;
    return {
      ...(panelInit as Record<string, unknown>),
      connectionId: lease.connectionId,
      clientLabel: "Mobile",
    };
  }
  async acquireLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }> {
    const result = await this.panelRuntime.acquire(
      runtimeEntityId,
      createPanelRuntimeLeaseRequest({
        slotId: panelId,
        clientSessionId: this.deps.clientSessionId,
        connectionId: opts.connectionId,
      })
    );
    if (result.acquired) {
      this.setTrackedRuntimeLease(panelId, runtimeEntityId, opts.connectionId);
    }
    return result;
  }
  async takeOverLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }> {
    const result = await this.panelRuntime.takeOver(
      runtimeEntityId,
      createPanelRuntimeLeaseRequest({
        slotId: panelId,
        clientSessionId: this.deps.clientSessionId,
        connectionId: opts.connectionId,
      })
    );
    if (result.acquired) {
      this.setTrackedRuntimeLease(panelId, runtimeEntityId, opts.connectionId);
    }
    return result;
  }
  handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): void {
    this.registry.applyRuntimeLeaseChanged(event);
    if (event.next?.clientSessionId === this.deps.clientSessionId) {
      this.trackRuntimeLease(event.next);
    } else if (
      event.previous?.clientSessionId === this.deps.clientSessionId ||
      this.runtimeConnectionBySlot.has(String(event.slotId))
    ) {
      this.clearTrackedRuntimeLease(String(event.slotId));
    }
    this.emitTreeUpdated();
  }
  async syncRuntimeLeases(): Promise<void> {
    const snapshot = await this.panelRuntime.getSnapshot();
    this.registry.applyRuntimeLeaseSnapshot(snapshot);
    this.syncTrackedRuntimeLeases(snapshot);
    this.emitTreeUpdated();
  }
  async handleBridgeCall(panelId: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.bridgeAdapterInstance) throw new Error("Panels not initialized");
    return this.bridgeAdapterInstance.handle(panelId, method, args);
  }
  /** Register the host→panel envelope delivery sink (called by the UI layer). */
  setDeliverToPanel(fn: (panelId: string, envelope: unknown) => void): void {
    this.deliverToPanelFn = fn;
    if (this.pendingDeliveries.size === 0) return;
    for (const [panelId, envelopes] of this.pendingDeliveries) {
      for (const envelope of envelopes) fn(panelId, envelope);
    }
    this.pendingDeliveries.clear();
  }
  /**
   * Route one host→panel envelope to the UI sink, or buffer it (bounded) until
   * the sink is registered. Never silently drops: an unbounded backlog trims the
   * oldest with a warning rather than growing without limit.
   */
  private deliverToPanel(panelId: string, envelope: unknown): void {
    if (this.deliverToPanelFn) {
      this.deliverToPanelFn(panelId, envelope);
      return;
    }
    let queue = this.pendingDeliveries.get(panelId);
    if (!queue) {
      queue = [];
      this.pendingDeliveries.set(panelId, queue);
    }
    queue.push(envelope);
    if (queue.length > MobilePanels.MAX_PENDING_DELIVERIES_PER_PANEL) {
      queue.shift();
      console.warn(
        `[MobilePanels] host→panel delivery buffer overflow for ${panelId} — dropping oldest envelope`
      );
    }
  }
  private requireManager(): PanelManager {
    if (!this.panelManager) throw new Error("Panels not initialized");
    return this.panelManager;
  }
  private emitTreeUpdated(): void {
    this.deps.onTreeUpdated?.(this.getTreeSnapshot());
  }
  private trackRuntimeLease(lease: PanelRuntimeLease): void {
    this.setTrackedRuntimeLease(
      String(lease.slotId),
      asPanelEntityId(String(lease.runtimeEntityId)),
      lease.connectionId
    );
  }
  private setTrackedRuntimeLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    connectionId: string
  ): void {
    const existing = this.runtimeConnectionBySlot.get(panelId);
    const changed =
      !existing ||
      existing.runtimeEntityId !== runtimeEntityId ||
      existing.connectionId !== connectionId;
    this.runtimeConnectionBySlot.set(panelId, { runtimeEntityId, connectionId });
    if (changed) this.bridgeAdapterInstance?.closePanelSession(panelId);
  }
  private clearTrackedRuntimeLease(panelId: string): void {
    const tracked = this.runtimeConnectionBySlot.delete(panelId);
    if (tracked) this.bridgeAdapterInstance?.closePanelSession(panelId);
  }
  private syncTrackedRuntimeLeases(snapshot: RuntimeLeaseSnapshot): void {
    const activeSlots = new Set<string>();
    for (const lease of snapshot.leases) {
      if (lease.clientSessionId !== this.deps.clientSessionId) continue;
      activeSlots.add(String(lease.slotId));
      this.trackRuntimeLease(lease);
    }
    for (const slotId of Array.from(this.runtimeConnectionBySlot.keys())) {
      if (!activeSlots.has(slotId)) this.clearTrackedRuntimeLease(slotId);
    }
  }
}
/**
 * Mobile loopback origin fronting the WebRTC pipe (plan §4). Post-cutover the
 * mobile `Credentials` no longer carry a remote `serverUrl` (§8c) — remote is
 * WebRTC, paired by QR (room/fp/sig). SEAM: the mobile WebRTC transport wiring
 * (react-native-webrtc provider + signaling client + on-device loopback bridge)
 * is the mobile analog of the desktop `serverClient` WebRTC selection and is not
 * yet built; `MobileRpcClient` is constructed against this loopback origin, which
 * the on-device bridge will front once wired. Tracked in
 * docs/webrtc-rpc-implementation-log.md.
 */
export const MOBILE_SERVER_LOOPBACK_ORIGIN = "http://127.0.0.1";

export class ShellClient {
  readonly transport: MobileRpcClient;
  readonly panels: MobilePanels;
  readonly workspaces: WorkspaceClient;
  readonly hubControl: ReturnType<typeof createHubControlClient>;
  readonly settings: SettingsClient;
  readonly events: EventsClient;
  readonly shellApproval: ShellApprovalClient;
  readonly panelRuntime: PanelRuntimeClient;
  readonly credentialService: CredentialsClient;
  readonly push: PushClient;
  readonly recovery: RecoveryCoordinator;
  readonly systemAgent: {
    resolveConversation(): Promise<SystemAgentConversation>;
  };
  readonly userNotifications: {
    list(): Promise<UserNotification[]>;
    acknowledge(id: string): Promise<boolean>;
    openChannel(channelId: string): Promise<{ id: string; title: string }>;
  };
  readonly credentials: Credentials;
  // Mutable: starts as the loopback placeholder, then becomes
  // `http://127.0.0.1:<facadePort>` once the panel-asset façade binds (init).
  // `MainScreen` reads this for `buildPanelUrl`, so panel URLs hit the façade.
  serverUrl: string;
  private facade: PanelAssetFacade | null = null;
  private statusUnsub: (() => void) | null = null;
  private navigationListeners = new Set<(panelId: string) => void>();

  /** Listen to an event addressed directly to this authenticated mobile session. */
  onDirectEvent<E extends EventName>(
    event: E,
    listener: (payload: EventPayloads[E]) => void
  ): () => void {
    return this.transport.on(event, ({ payload }) => listener(payload as EventPayloads[E]));
  }
  private panelRecoveryUnsubs: Array<() => void> | null = null;
  private recoveryCompleteListeners = new Set<(kind: RecoveryKind) => void>();
  private workspaceInfo: WorkspaceInfo | null = null;
  private readonly accountProfileClient: MobileAccountProfileClient;
  private panelsInitialized = false;
  private hostTargetReadinessEventsSubscribed = false;
  constructor(config: ShellClientConfig) {
    this.credentials = config.credentials;
    this.serverUrl = MOBILE_SERVER_LOOPBACK_ORIGIN;
    // Remote is WebRTC: the client re-pairs to the stored shell credential's
    // signaling room (no server URL, no native WS grant) — see mobileTransport.ts.
    this.transport = new MobileRpcClient({});
    this.accountProfileClient = new MobileAccountProfileClient(this.transport);
    if (config.onStatusChange) {
      this.statusUnsub = this.transport.onStatusChange(config.onStatusChange);
    }
    this.recovery = createRecoveryCoordinator();
    this.transport.onRecovery("resubscribe", async () => {
      await this.recovery.run("resubscribe");
      smokePhase("workspace-recovery-complete", { kind: "resubscribe" });
      this.emitRecoveryComplete("resubscribe");
    });
    this.transport.onRecovery("cold-recover", async () => {
      await this.recovery.run("cold-recover");
      smokePhase("workspace-recovery-complete", { kind: "cold-recover" });
      this.emitRecoveryComplete("cold-recover");
    });
    this.panels = new MobilePanels({
      serverUrl: MOBILE_SERVER_LOOPBACK_ORIGIN,
      transport: this.transport,
      onTreeUpdated: config.onTreeUpdated,
      getSelfUserId: () => this.currentUserId,
      clientSessionId: config.credentials.deviceId,
      navigateToPanel: (panelId) => {
        for (const listener of this.navigationListeners) listener(panelId);
      },
    });
    const userNotificationStore = createGadServiceClient(this.transport);
    const channelClients = new Map<string, ReturnType<typeof createDurableObjectServiceClient>>();
    const channelClient = (channelId: string) => {
      let client = channelClients.get(channelId);
      if (!client) {
        client = createDurableObjectServiceClient(
          this.transport,
          "vibestudio.channel.v1",
          channelId
        );
        channelClients.set(channelId, client);
      }
      return client;
    };
    this.userNotifications = {
      list: async () =>
        (await userNotificationStore.call<UserNotificationListResult>("listUserNotificationsForMe"))
          .notifications,
      acknowledge: async (id) =>
        (
          await userNotificationStore.call<UserNotificationAcknowledgementResult>(
            "acknowledgeUserNotification",
            { id }
          )
        ).acknowledged,
      openChannel: async (channelId) => {
        const existing = this.findOwnedChannelPanel(channelId);
        if (existing) {
          await this.panels.focus(existing.id);
          return { id: existing.id, title: existing.title };
        }
        const service = channelClient(channelId);
        const [config, contextId] = await Promise.all([
          service.call<{ title?: string } | null>("getConfig"),
          service.call<string | null>("getContextId"),
        ]);
        if (!contextId) {
          throw new Error("This conversation is not ready yet. Please try again in a moment.");
        }
        return this.panels.createFromSource("panels/chat", {
          name: config?.title?.trim() || undefined,
          contextId,
          stateArgs: { channelName: channelId },
        });
      },
    };
    this.workspaces = new WorkspaceClient(this.transport);
    const systemAgentClient = createTypedServiceClient(
      "systemAgent",
      systemAgentMethods,
      (service, method, args) => this.transport.call("main", `${service}.${method}`, args)
    );
    this.systemAgent = {
      resolveConversation: () => systemAgentClient.resolveConversation(),
    };
    this.hubControl = createHubControlClient(this.transport);
    this.settings = new SettingsClient(this.transport);
    this.events = new EventsClient(this.transport, this.recovery);
    this.shellApproval = createShellApprovalClient(this.transport);
    this.panelRuntime = createPanelRuntimeClient(this.transport);
    this.credentialService = createCredentialsClient(this.transport);
    this.push = createPushClient(this.transport);
    this.events.on("panel:runtimeLeaseChanged", (event) => {
      this.panels.handleRuntimeLeaseChanged(event as PanelRuntimeLeaseChangedEvent);
    });
    // State-bearing full snapshots are self-contained. Apply them directly;
    // only reconnect, foreground, and explicit recovery need an aggregate read.
    this.events.on("panel-tree-updated", (event) => {
      this.panels.applyTreeSnapshot(event as PanelTreeSnapshot);
    });
  }
  async init(): Promise<void> {
    const info = await this.connectWorkspace();
    await this.startPanelAssetFacade();
    await this.ensureReactNativeHostTargetReady();
    await this.initPanels(info);
  }

  /**
   * Start the on-device panel-asset façade now that the pipe is up, and point
   * panel URLs at it: panels load `http://127.0.0.1:<port>/{source}/` and the
   * façade proxies each asset request to the remote gateway over the WebRTC pipe.
   * `MainScreen` reads `shellClient.serverUrl` for `buildPanelUrl`, so this must
   * land before the client is published to the UI (`finishConnectedClient`).
   */
  private async startPanelAssetFacade(): Promise<void> {
    if (this.facade) return;
    this.facade = await startPanelAssetFacade(this.transport);
    this.serverUrl = `http://127.0.0.1:${this.facade.port}`;
    smokePhase("workspace-panel-facade-ready", { port: this.facade.port });
  }

  /** Active workspace id, available after connect; null until then. */
  get workspaceId(): string | null {
    return this.workspaceInfo?.config.id ?? null;
  }

  /** Authenticated account id, available after the workspace handshake. */
  get currentUserId(): string | null {
    return this.accountProfileClient.current?.userId ?? null;
  }

  get currentAccountProfile(): MobileAccountProfile | null {
    return this.accountProfileClient.current;
  }

  private findOwnedChannelPanel(channelId: string): Panel | null {
    const userId = this.currentUserId;
    if (!userId) return null;
    const group = this.panels
      .getTreeSnapshot()
      .forest.find((candidate) => candidate.owner === userId);
    if (!group) return null;
    const visit = (panels: Panel[]): Panel | null => {
      for (const panel of panels) {
        if (
          panel.snapshot.source === "panels/chat" &&
          panel.snapshot.stateArgs?.["channelName"] === channelId
        ) {
          return panel;
        }
        const descendant = visit(panel.children);
        if (descendant) return descendant;
      }
      return null;
    };
    return visit(group.rootPanels);
  }

  async refreshAccountProfile(): Promise<MobileAccountProfile> {
    return this.accountProfileClient.refresh();
  }

  async updateAccountProfile(input: MobileAccountProfileUpdate): Promise<MobileAccountProfile> {
    return this.accountProfileClient.update(input);
  }

  async resolveAccountProfiles(
    userIds: readonly string[]
  ): Promise<Record<string, MobileAccountProfile>> {
    if (userIds.length === 0) return {};
    return this.accountProfileClient.resolve(userIds);
  }

  private async connectWorkspace(): Promise<WorkspaceInfo> {
    if (this.workspaceInfo) return this.workspaceInfo;
    smokePhase("workspace-shell-init-start", { serverUrl: this.serverUrl });
    await this.transport.connectAndWait(null);
    smokePhase("workspace-ws-authenticated");
    const info = await this.workspaces.getInfo();
    smokePhase("workspace-info-loaded", { workspaceId: info.config.id });
    await this.refreshAccountProfile();
    this.workspaceInfo = info;
    return info;
  }

  private async ensureReactNativeHostTargetReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let session = await this.workspaces.beginHostTargetLaunch("react-native");
    for (;;) {
      if (session.status === "ready") {
        smokePhase("workspace-host-target-ready", {
          target: session.target,
          appId: session.launch?.status === "ready" ? session.launch.appId : undefined,
          source: session.launch?.status === "ready" ? session.launch.source : undefined,
        });
        return;
      }
      if (session.status === "approval-required") {
        smokePhase("workspace-host-target-approval-required", {
          target: session.target,
          count: session.approvals.length,
        });
        throw new MobileHostTargetApprovalRequiredError(session);
      }
      if (session.status === "preparing" || session.status === "starting") {
        smokePhase("workspace-host-target-preparing", {
          target: session.target,
          status: session.status,
        });
        const observed = await this.waitForHostTargetLaunchSession(
          session.sessionId,
          Math.max(1, deadline - Date.now()),
          session.updatedAt
        );
        if (observed) {
          session = observed;
          continue;
        }
        const refreshed = await this.workspaces.getHostTargetLaunchSession(session.sessionId);
        if (refreshed) {
          session = refreshed;
          continue;
        }
        throw new Error(formatHostTargetLaunchSession(session));
      }
      throw new Error(formatHostTargetLaunchSession(session));
    }
  }

  private async waitForHostTargetLaunchSession(
    sessionId: string,
    timeoutMs: number,
    observedUpdatedAt: number
  ): Promise<HostTargetLaunchSessionSnapshot | null> {
    const eventNames = [HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT] as const;
    const needsSubscribe = !this.hostTargetReadinessEventsSubscribed;
    if (needsSubscribe) this.hostTargetReadinessEventsSubscribed = true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubs: Array<() => void> = [];
    let resolvePending!: (value: HostTargetLaunchSessionSnapshot | null) => void;
    const pending = new Promise<HostTargetLaunchSessionSnapshot | null>((resolve) => {
      resolvePending = resolve;
    });
    const finish = (value: HostTargetLaunchSessionSnapshot | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolvePending(value);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    unsubs = eventNames.map((name) =>
      this.events.on(name, (event) => {
        if (isLaunchSessionEventFor(sessionId, name, event)) finish(event);
      })
    );
    if (needsSubscribe) {
      await Promise.all(eventNames.map((name) => this.events.subscribe(name).catch(() => {})));
    }
    // The launch may settle between beginHostTargetLaunch() returning and the
    // server acknowledging our event subscription. Read once after subscribing
    // to close that gap; subsequent changes are covered by the live event.
    const current = await this.workspaces.getHostTargetLaunchSession(sessionId);
    if (current && current.updatedAt !== observedUpdatedAt) {
      finish(current);
    }
    return await pending;
  }

  private async initPanels(info: WorkspaceInfo): Promise<void> {
    if (this.panelsInitialized) return;
    await this.panels.init(info.config.id, info.config);
    smokePhase("workspace-panels-initialized");
    await this.events.subscribe("panel:runtimeLeaseChanged");
    await this.events.subscribe("panel-tree-updated");
    await this.panels.syncRuntimeLeases();
    await drainWorkspaceMutationQueue(this);
    this.registerPanelRecoveryHandlers();
    this.panelsInitialized = true;
  }
  reconnect(): void {
    this.transport.reconnect();
  }
  /**
   * Release reclaimable memory (the panel-asset LRU, up to 256 MiB). Called when
   * the app backgrounds or the OS raises a memory warning; cached assets are
   * content-addressed and re-fetch over the pipe on next use.
   */
  trimMemory(): void {
    this.facade?.trimCache();
  }
  onNavigateToPanel(listener: (panelId: string) => void): () => void {
    this.navigationListeners.add(listener);
    return () => {
      this.navigationListeners.delete(listener);
    };
  }
  onRecoveryComplete(listener: (kind: RecoveryKind) => void): () => void {
    this.recoveryCompleteListeners.add(listener);
    return () => {
      this.recoveryCompleteListeners.delete(listener);
    };
  }
  async handlePanelBridgeCall(panelId: string, method: string, args: unknown[]): Promise<unknown> {
    return this.panels.handleBridgeCall(panelId, method, args);
  }
  private registerPanelRecoveryHandlers(): void {
    if (this.panelRecoveryUnsubs) return;
    this.panelRecoveryUnsubs = [
      this.recovery.registerResubscribeHandler("mobile-panel-tree", async () => {
        await drainWorkspaceMutationQueue(this);
        await this.panels.refresh();
      }),
      this.recovery.registerColdRecoverHandler("mobile-panel-tree", async () => {
        await drainWorkspaceMutationQueue(this);
        await this.panels.recoverSnapshot();
      }),
    ];
  }
  private emitRecoveryComplete(kind: RecoveryKind): void {
    for (const listener of this.recoveryCompleteListeners) listener(kind);
  }
  dispose(): void {
    for (const unsubscribe of this.panelRecoveryUnsubs ?? []) unsubscribe();
    this.panelRecoveryUnsubs = null;
    this.recoveryCompleteListeners.clear();
    void (async () => {
      await this.panelRuntime.unregisterClient(this.credentials.deviceId).catch(() => {});
      await this.facade?.close().catch(() => {});
      this.facade = null;
      this.transport.disconnect();
    })();
    this.statusUnsub?.();
    this.statusUnsub = null;
  }
}
export type MobilePanelsClient = InstanceType<typeof MobilePanels>;
