import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { decodePanelStateArgs } from "@vibestudio/shared/panelStateArgs";
import type { ThemeAppearance } from "@vibestudio/shared/types";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { Appearance, Platform } from "react-native";
import { WorkspaceClient } from "@vibestudio/service-schemas/clients/shellWorkspaceClient";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import {
  PanelTreeCache,
  type PanelTreeCacheSnapshot,
  type PanelTreeQuerySource,
} from "@vibestudio/shell-core/panelTreeCache";
import type { RecoveryCoordinator, RecoveryKind } from "@vibestudio/shell-core/recoveryCoordinator";
import type { PanelManager } from "@vibestudio/shell-core/panelManager";
import type {
  PanelHost,
  PanelHostRegistration,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@vibestudio/shared/panel/panelLease";
import type { PanelPageObservation } from "@vibestudio/shared/panel/observation";
import type { PanelTreeInvalidation } from "@vibestudio/shared/panel/treeIndex";
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
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { pushMethods } from "@vibestudio/service-schemas/push";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { workspaceStateMethods } from "@vibestudio/service-schemas/workspaceState";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import {
  createDurableObjectServiceClient,
  createGadServiceClient,
} from "@vibestudio/shared/workspaceServiceRpc";
import {
  type UserNotification,
  type UserNotificationAcknowledgementResult,
  type UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import {
  HostLaunchClient,
  type HostLaunchResult,
} from "@vibestudio/service-schemas/clients/hostLaunchClient";
import {
  MobileAccountProfileClient,
  type MobileAccountProfile,
  type MobileAccountProfileUpdate,
} from "./accountProfileClient";
import {
  clearMobileShellStartupSnapshot,
  loadMobileShellStartupSnapshot,
  saveMobileShellStartupSnapshot,
  type MobileShellStartupSnapshot,
} from "./shellStartupSnapshot";
import type { PaletteCommand, Panel } from "@vibestudio/shared/types";
import { PanelCommandRegistry } from "@vibestudio/shell-core/panelCommandRegistry";

export type { MobileAccountProfile, MobileAccountProfileUpdate } from "./accountProfileClient";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[VibestudioMobileSmoke] phase=${phase}${suffix}`);
}

export interface ShellClientConfig {
  credentials: Credentials;
  serverIdentity: string;
  onTreeInvalidated?: (event: PanelTreeInvalidation) => void;
  onPanelsChanged?: () => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onReadinessChange?: (readiness: "shell-ready" | "reconciled" | "failed") => void;
}

export interface Credentials {
  deviceId: string;
}
function createShellApprovalClient(transport: MobileRpcClient) {
  return createTypedServiceClient("shellApproval", shellApprovalMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createBlobstoreClient(transport: MobileRpcClient) {
  return createTypedServiceClient("blobstore", blobstoreMethods, (service, method, args) =>
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

function createWorkspaceStateRpcClient(transport: MobileRpcClient) {
  return createTypedServiceClient(
    "workspace-state",
    workspaceStateMethods,
    (service, method, args) => transport.call("main", `${service}.${method}`, args)
  );
}

function createHubControlClient(transport: MobileRpcClient) {
  return createTypedServiceClient("hubControl", hubControlMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

type ShellApprovalClient = ReturnType<typeof createShellApprovalClient>;
type BlobstoreClient = ReturnType<typeof createBlobstoreClient>;
type PanelRuntimeClient = ReturnType<typeof createPanelRuntimeClient>;
type CredentialsClient = ReturnType<typeof createCredentialsClient>;
type PushClient = ReturnType<typeof createPushClient>;
type WorkspaceRpcClient = ReturnType<typeof createWorkspaceRpcClient>;
type WorkspaceStateRpcClient = ReturnType<typeof createWorkspaceStateRpcClient>;
type WorkspaceInfo = Awaited<ReturnType<WorkspaceClient["getInfo"]>>;

export class MobileHostTargetApprovalRequiredError extends Error {
  readonly approvals: PendingUnitInstallReviewApproval[];

  constructor(launch: Extract<HostLaunchResult, { status: "approval-required" }>) {
    super("Approve the workspace mobile app before opening panels.");
    this.name = "MobileHostTargetApprovalRequiredError";
    this.approvals = launch.approvals;
  }
}

class MobilePanels implements PanelHost {
  private panelManager: PanelManager | null = null;
  private registryInstance: PanelRegistry | null = null;
  private bridgeAdapterInstance: ReturnType<typeof createBridgeAdapter> | null = null;
  readonly treeCache: PanelTreeCache;
  // Set by the UI (MainScreen) so the panel-RPC relay can push server replies +
  // events into the right panel's webview. A mutable field (not a constructor
  // dep) because the webview refs live in the UI, which mounts after init().
  private deliverToPanelFn: ((panelId: string, envelope: unknown) => boolean) | null = null;
  // Host→panel envelopes that arrived before the UI registered its delivery sink
  // (init() completes before MainScreen mounts). Bounded per panel; flushed in
  // order by setDeliverToPanel so relay replies/events never silently vanish.
  private readonly pendingDeliveries = new Map<string, unknown[]>();
  private static readonly MAX_PENDING_DELIVERIES_PER_PANEL = 256;
  private readonly panelRuntime: PanelRuntimeClient;
  private readonly browserData: BrowserDataClient;
  private readonly workspaceRpc: WorkspaceRpcClient;
  private readonly workspaceState: WorkspaceStateRpcClient;
  private readonly runtimeConnectionBySlot = new Map<
    string,
    { runtimeEntityId: PanelEntityId; connectionId: string }
  >();
  private registered = false;
  readonly registration: PanelHostRegistration;
  constructor(
    private readonly deps: {
      serverUrl: string;
      transport: MobileRpcClient;
      onTreeInvalidated?: (event: PanelTreeInvalidation) => void;
      onPanelsChanged?: () => void;
      getSelfUserId: () => string | null;
      navigateToPanel: (panelId: string) => void;
      onPanelCommandContribution: (panelId: string, payload: unknown) => void;
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
    this.workspaceState = createWorkspaceStateRpcClient(this.deps.transport);
    this.browserData = createBrowserDataClient({
      callService: (service: string, method: string, args: unknown[]) =>
        this.deps.transport.call("main", `${service}.${method}`, args),
    });
    const source: PanelTreeQuerySource = {
      rootGroups: (input) => this.workspaceState.panelTree.rootGroups(input),
      page: (input) => this.workspaceState.panelTree.page(input),
      path: (slotId) => this.workspaceState.panelTree.path(slotId),
      search: (input) => this.workspaceState.panelTree.search(input),
    };
    this.treeCache = new PanelTreeCache(source, {
      pageSize: 50,
      maxGroups: 48,
      maxNodes: 1_500,
      maxPaths: 96,
    });
  }
  get registry(): PanelRegistry {
    if (!this.registryInstance) throw new Error("Panels not initialized");
    return this.registryInstance;
  }
  prepare(
    workspaceId: string,
    restored?: { tree: PanelTreeCacheSnapshot; rootPanels: Panel[] }
  ): void {
    if (!this.panelManager) {
      const core = createMobileShellCore({
        workspaceId,
        serverUrl: this.deps.serverUrl,
        transport: this.deps.transport,
        onPresentationUpdated: () => this.deps.onPanelsChanged?.(),
      });
      this.panelManager = core.panelManager;
      this.registryInstance = core.registry;
      this.bridgeAdapterInstance = createBridgeAdapter({
        panelManager: core.panelManager,
        transport: this.deps.transport,
        getPanelInit: (panelId) => this.getPanelInit(panelId),
        callbacks: {
          navigateToPanel: this.deps.navigateToPanel,
          handleShellEvent: (panelId, event, payload) => {
            if (event !== "runtime:palette-contribution") return false;
            this.deps.onPanelCommandContribution(panelId, payload);
            return true;
          },
        },
        deliverToPanel: (panelId, envelope) => this.deliverToPanel(panelId, envelope),
        getPanelLease: (panelId) => this.runtimeConnectionBySlot.get(panelId),
      });
    }
    const initialTheme = Appearance.getColorScheme() === "light" ? "light" : "dark";
    this.panelManager.setCurrentTheme(initialTheme);
    if (restored) {
      this.treeCache.restore(restored.tree);
      this.registry.populateFromServer(restored.rootPanels);
      this.panelManager.syncEntityCachesFromRegistry();
    }
  }

  async loadTreeForPaint(workspaceConfig?: WorkspaceConfig): Promise<void> {
    const panelManager = this.requireManager();
    await this.ensureRegistered();
    const groups = await this.treeCache.loadRootGroups(true);
    await Promise.all(
      groups.groups.map((group) =>
        this.treeCache.loadFirst({ kind: "roots", ownerUserId: group.ownerUserId })
      )
    );
    const existingSources = new Set(
      groups.groups.flatMap(
        (group) =>
          this.treeCache
            .getGroup({
              kind: "roots",
              ownerUserId: group.ownerUserId,
            })
            ?.nodes.flatMap((node) => (node.source ? [node.source] : [])) ?? []
      )
    );
    for (const initial of workspaceConfig?.initPanels ?? []) {
      if (existingSources.has(initial.source)) continue;
      await panelManager.create(initial.source, {
        isRoot: true,
        addAsRoot: true,
        stateArgs: initial.stateArgs,
      });
      existingSources.add(initial.source);
    }
    const roots = (
      await Promise.all(
        groups.groups.flatMap(
          (group) =>
            this.treeCache
              .getGroup({ kind: "roots", ownerUserId: group.ownerUserId })
              ?.nodes.map((node) => panelManager.refreshPanel(asPanelSlotId(node.slotId))) ?? []
        )
      )
    ).filter((panel): panel is Panel => panel !== null);
    this.registry.repopulate(roots);
    const ownGroup =
      groups.groups.find((group) => group.ownerUserId === this.deps.getSelfUserId()) ??
      groups.groups[0];
    const firstRoot = ownGroup
      ? this.treeCache.getGroup({
          kind: "roots",
          ownerUserId: ownGroup.ownerUserId,
        })?.nodes[0]
      : undefined;
    if (firstRoot) {
      const slotId = asPanelSlotId(firstRoot.slotId);
      const panel = await panelManager.getPanel(slotId);
      if (panel) {
        await panelManager.notifyFocused(slotId);
        this.deps.navigateToPanel(firstRoot.slotId);
      }
    }
  }

  async reconcile(workspaceConfig?: WorkspaceConfig): Promise<void> {
    await this.loadTreeForPaint(workspaceConfig);
    await this.syncRuntimeLeases();
  }

  async completeColdStart(): Promise<void> {
    await this.ensureRegistered();
    await this.syncRuntimeLeases();
  }

  showRestoredPanel(preferredPanelId: string | null): void {
    const panelId =
      (preferredPanelId && this.registry.getPanel(preferredPanelId)
        ? preferredPanelId
        : this.registry.getRootPanels()[0]?.id) ?? null;
    if (panelId) this.deps.navigateToPanel(panelId);
  }

  startupSnapshot(): { tree: PanelTreeCacheSnapshot; rootPanels: Panel[] } | null {
    const tree = this.treeCache.snapshot();
    if (!tree) return null;
    return { tree, rootPanels: this.registry.getSerializablePanelTree() };
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    await this.panelRuntime.registerClient(this.registration);
    this.registered = true;
  }
  async refresh(): Promise<void> {
    this.treeCache.clear();
    const groups = await this.treeCache.loadRootGroups(true);
    await Promise.all(
      groups.groups.map((group) =>
        this.treeCache.loadFirst({ kind: "roots", ownerUserId: group.ownerUserId })
      )
    );
    await this.syncRuntimeLeases();
  }
  invalidateTree(event: PanelTreeInvalidation): void {
    this.treeCache.invalidate(event);
    this.deps.onTreeInvalidated?.(event);
    const panelManager = this.panelManager;
    if (!panelManager) return;

    for (const panelId of event.removedSlotIds) {
      if (this.registry.getPanel(panelId)) this.registry.removePanel(panelId);
    }
    const residentChanged = event.changedSlotIds.filter((panelId) =>
      Boolean(this.registry.getPanel(panelId))
    );
    if (residentChanged.length === 0) return;
    void Promise.all(
      residentChanged.map((panelId) => panelManager.refreshPanel(asPanelSlotId(panelId)))
    )
      .then(() => this.deps.onPanelsChanged?.())
      .catch((error: unknown) => {
        console.warn("[MobilePanels] Failed to refresh changed panel presentations", {
          revision: event.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  handleExecutionActivated(activation: EventPayloads["panel:executionActivated"]): void {
    const panel = this.registry.getPanel(activation.panelId);
    if (!panel || panel.runtimeEntityId !== activation.runtimeEntityId) return;
    panel.effectiveVersion = activation.effectiveVersion;
    panel.buildKey = activation.buildKey;
    panel.executionDigest = activation.executionDigest;
    panel.authorityRequests = activation.authorityRequests;
    this.deps.onPanelsChanged?.();
  }
  async observe(
    panelId: string
  ): Promise<import("@vibestudio/shared/panel/observation").PanelObservation> {
    const detail = await this.workspaceState.panelTree.detail(panelId);
    if (!detail) throw new Error(`Panel not found: ${panelId}`);
    const runtime = await this.panelRuntime.observeSlot(panelId);
    const options = detail.currentHistory.options
      ? (JSON.parse(detail.currentHistory.options) as { ref?: string })
      : {};
    const attempt = runtime.attempt?.runtimeEntityId === detail.entity.id ? runtime.attempt : null;
    const phase = attempt?.phase ?? ("pending" as const);
    return {
      panelId,
      title: detail.slot.current_entity_title ?? panelId,
      source: detail.currentHistory.source,
      kind: detail.currentHistory.source.startsWith("browser:") ? "browser" : "workspace",
      parentId: detail.slot.parent_slot_id,
      contextId: detail.currentHistory.context_id,
      requestedRef: options.ref ?? "latest",
      runtimeEntityId: detail.entity.id,
      attemptId: attempt?.attemptId ?? "unknown-attempt",
      attemptRef: attempt
        ? { epoch: attempt.epoch, attemptId: attempt.attemptId }
        : { epoch: runtime.version.epoch, attemptId: "unknown-attempt" },
      effectiveVersion: detail.entity.source.effectiveVersion || null,
      buildKey: detail.entity.activeBuildKey ?? null,
      phase,
      ...(runtime.route.connectionId
        ? {
            host: {
              holderLabel: runtime.route.holderLabel,
              platform: runtime.route.platform,
              supportsInspection: runtime.route.supportsCdp,
              reachable: runtime.route.reachable,
              view: {
                exists: runtime.route.view !== undefined,
                ...(runtime.route.view ?? {}),
              },
              boot:
                phase === "loading" ||
                phase === "booting" ||
                phase === "ready" ||
                phase === "failed"
                  ? { kind: "observed" as const, observation: { phase } }
                  : { kind: "unavailable" as const },
            },
          }
        : {}),
      updatedAt: attempt?.updatedAt ?? Date.now(),
    };
  }
  getTreePath(panelId: string) {
    return this.treeCache.loadPath(asPanelSlotId(panelId));
  }
  queryTreePage(input: import("@vibestudio/shared/panel/treeIndex").PanelTreePageInput) {
    return this.workspaceState.panelTree.page(input);
  }
  async getStateArgs(panelId: string): Promise<Record<string, unknown>> {
    const detail = await this.workspaceState.panelTree.detail(panelId);
    if (!detail) throw new Error(`Panel not found: ${panelId}`);
    return decodePanelStateArgs(detail.currentHistory.state_args);
  }
  async recoverSnapshot(): Promise<void> {
    await this.refresh();
  }
  getCollapsedIds(): string[] {
    return this.registry.getCollapsedIds();
  }
  getPreferredRootId(): string | null {
    const groups = this.treeCache.getRootGroups().groups;
    const preferred =
      groups.find((group) => group.ownerUserId === this.deps.getSelfUserId()) ?? groups[0];
    if (!preferred) return null;
    return (
      this.treeCache.getGroup({
        kind: "roots",
        ownerUserId: preferred.ownerUserId,
      })?.nodes[0]?.slotId ?? null
    );
  }
  async archive(panelId: string): Promise<void> {
    await this.requireManager().close(asPanelSlotId(panelId));
  }
  async movePanel(
    panelId: string,
    newParentId: string | null,
    placement?: { beforePanelId?: string | null; afterPanelId?: string | null }
  ): Promise<void> {
    await this.requireManager().movePanel(
      asPanelSlotId(panelId),
      newParentId ? asPanelSlotId(newParentId) : null,
      placement
        ? {
            beforeSlotId:
              placement.beforePanelId === null
                ? null
                : placement.beforePanelId === undefined
                  ? undefined
                  : asPanelSlotId(placement.beforePanelId),
            afterSlotId:
              placement.afterPanelId === null
                ? null
                : placement.afterPanelId === undefined
                  ? undefined
                  : asPanelSlotId(placement.afterPanelId),
          }
        : undefined
    );
  }
  async createAboutPanel(page: string): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.requireManager().create(`about/${page}`, {
      isRoot: true,
      addAsRoot: true,
    });
    this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
  }
  async createFromSource(
    source: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.requireManager().create(source, {
      isRoot: true,
      addAsRoot: true,
      title: options?.title,
      slug: options?.slug,
      contextId: options?.contextId,
      stateArgs: options?.stateArgs,
    });
    this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
  }
  async focus(panelId: string): Promise<void> {
    const manager = this.requireManager();
    const slotId = asPanelSlotId(panelId);
    const panel = await manager.getPanel(slotId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    await manager.notifyFocused(slotId);
    this.deps.navigateToPanel(panelId);
  }
  async createChildPanel(
    parentId: string,
    source: string,
    options?: {
      title?: string;
      slug?: string;
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
    const result = await this.requireManager().create(source, {
      parentId: asPanelSlotId(parentId),
      title: options?.title,
      slug: options?.slug,
      ref: options?.ref,
      contextId: options?.contextId,
      stateArgs: options?.stateArgs,
    });
    if (options?.focus !== false) this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
  }
  async createBrowserUrlPanel(
    parentId: string | null,
    url: string,
    options?: {
      title?: string;
      slug?: string;
      name?: string;
      focus?: boolean;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.requireManager().createBrowser(
      parentId ? asPanelSlotId(parentId) : null,
      url,
      { title: options?.title, slug: options?.slug }
    );
    if (options?.focus !== false) this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
  }
  async createRootPanel(
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      title?: string;
      slug?: string;
      name?: string;
      focus?: boolean;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.requireManager().create(source, {
      isRoot: true,
      addAsRoot: true,
      ref: options?.ref,
      contextId: options?.contextId,
      title: options?.title,
      slug: options?.slug,
      stateArgs: options?.stateArgs,
    });
    if (options?.focus !== false) this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
  }
  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.requireManager().setCollapsed(asPanelSlotId(panelId), collapsed);
  }
  async expandIds(panelIds: string[]): Promise<void> {
    await this.requireManager().expandIds(panelIds);
  }
  async notifyFocused(panelId: string): Promise<void> {
    await this.requireManager().notifyFocused(asPanelSlotId(panelId));
  }
  async updateStateArgs(
    panelId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.requireManager().updateStateArgs(asPanelSlotId(panelId), updates);
  }
  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.requireManager().updateTitle(asPanelSlotId(panelId), title);
  }
  async updateBrowserUrl(panelId: string, url: string): Promise<void> {
    await this.requireManager().navigate(asPanelSlotId(panelId), url);
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
    const result = await this.requireManager().navigate(asPanelSlotId(panelId), source, options);
    return { id: result.panelId, title: result.title };
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
      panels: this.registry.getRootPanels(),
      browserData: {
        searchHistoryForAutocomplete: (searchQuery, limit) =>
          this.browserData.searchHistoryForAutocomplete(searchQuery, limit),
        getHistory: (historyQuery) => this.browserData.getHistory(historyQuery),
        searchBookmarks: (searchQuery) => this.browserData.searchBookmarks(searchQuery),
        getSearchEngines: () => this.browserData.getSearchEngines(),
      },
    });
  }
  async getPageFaviconDataUrl(pageUrl: string): Promise<string | null> {
    const favicon = await this.browserData.getPageFavicon(pageUrl);
    return favicon ? `data:${favicon.mime_type};base64,${favicon.image_data}` : null;
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
  async reportView(
    runtimeEntityId: PanelEntityId,
    connectionId: string,
    observation: PanelPageObservation
  ): Promise<"reported" | "stale"> {
    return this.panelRuntime.reportView(runtimeEntityId, connectionId, {
      url: observation.view.url,
      loading: observation.view.loading,
      boot: observation.boot,
    });
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
  }
  async syncRuntimeLeases(): Promise<void> {
    const snapshot = await this.panelRuntime.getSnapshot();
    this.registry.applyRuntimeLeaseSnapshot(snapshot);
    this.syncTrackedRuntimeLeases(snapshot);
  }
  async handleBridgeCall(panelId: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.bridgeAdapterInstance) throw new Error("Panels not initialized");
    return this.bridgeAdapterInstance.handle(panelId, method, args);
  }
  /** Register the host→panel envelope delivery sink (called by the UI layer). */
  setDeliverToPanel(fn: (panelId: string, envelope: unknown) => boolean): void {
    this.deliverToPanelFn = fn;
    this.flushPanelDeliveries();
  }
  /** Retry replies/events that arrived while their native WebView ref was absent. */
  flushPanelDeliveries(panelId?: string): void {
    const targets = panelId ? [panelId] : [...this.pendingDeliveries.keys()];
    for (const target of targets) {
      const queue = this.pendingDeliveries.get(target);
      if (!queue?.length || !this.deliverToPanelFn) continue;
      let delivered = 0;
      while (delivered < queue.length && this.deliverToPanelFn(target, queue[delivered])) {
        delivered += 1;
      }
      if (delivered === queue.length) {
        this.pendingDeliveries.delete(target);
      } else if (delivered > 0) {
        queue.splice(0, delivered);
      }
    }
  }
  /**
   * Route one host→panel envelope to the UI sink, or buffer it (bounded) until
   * the sink is registered. Never silently drops: an unbounded backlog trims the
   * oldest with a warning rather than growing without limit.
   */
  private deliverToPanel(panelId: string, envelope: unknown): void {
    if (this.deliverToPanelFn?.(panelId, envelope)) {
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
  readonly events: EventsClient;
  readonly shellApproval: ShellApprovalClient;
  /** Content-addressed reads used by approval diff review and file inspection. */
  readonly blobstore: BlobstoreClient;
  readonly panelRuntime: PanelRuntimeClient;
  readonly credentialService: CredentialsClient;
  readonly push: PushClient;
  readonly hostLaunch: HostLaunchClient;
  readonly recovery: RecoveryCoordinator;
  readonly userNotifications: {
    list(): Promise<UserNotification[]>;
    acknowledge(id: string): Promise<boolean>;
    openChannel(channelId: string): Promise<{ id: string; title: string }>;
  };
  readonly credentials: Credentials;
  private readonly serverIdentity: string;
  // Mutable: starts as the loopback placeholder, then becomes
  // `http://127.0.0.1:<facadePort>` once the panel-asset façade binds (init).
  // `MainScreen` reads this for `buildPanelUrl`, so panel URLs hit the façade.
  serverUrl: string;
  private facade: PanelAssetFacade | null = null;
  private statusUnsub: (() => void) | null = null;
  private readonly panelCommandRegistry = new PanelCommandRegistry();
  readonly panelCommands: {
    get(panelId: string): PaletteCommand[];
    clear(panelId: string): void;
  };
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
  private reconciliation: Promise<void> | null = null;
  private disposed = false;
  private readonly onReadinessChange?: ShellClientConfig["onReadinessChange"];
  constructor(config: ShellClientConfig) {
    this.credentials = config.credentials;
    this.serverIdentity = config.serverIdentity.toLowerCase();
    this.onReadinessChange = config.onReadinessChange;
    this.serverUrl = MOBILE_SERVER_LOOPBACK_ORIGIN;
    // Remote is WebRTC: the client re-pairs to the stored shell credential's
    // signaling room (no server URL, no native WS grant) — see mobileTransport.ts.
    this.transport = new MobileRpcClient({});
    this.panelCommands = {
      get: (panelId) => this.panelCommandRegistry.get(panelId),
      clear: (panelId) => this.panelCommandRegistry.clear(panelId),
    };
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
      onTreeInvalidated: config.onTreeInvalidated,
      onPanelsChanged: config.onPanelsChanged,
      getSelfUserId: () => this.currentUserId,
      clientSessionId: config.credentials.deviceId,
      navigateToPanel: (panelId) => {
        for (const listener of this.navigationListeners) listener(panelId);
      },
      onPanelCommandContribution: (panelId, payload) => {
        this.panelCommandRegistry.accept({
          caller: { callerId: panelId, callerKind: "panel", callerPanelId: panelId },
          payload,
        });
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
        const existing = await this.findOwnedChannelPanel(channelId);
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
    this.hubControl = createHubControlClient(this.transport);
    this.events = new EventsClient(this.transport, this.recovery);
    this.shellApproval = createShellApprovalClient(this.transport);
    this.blobstore = createBlobstoreClient(this.transport);
    this.panelRuntime = createPanelRuntimeClient(this.transport);
    this.credentialService = createCredentialsClient(this.transport);
    this.push = createPushClient(this.transport);
    this.hostLaunch = new HostLaunchClient((service, method, args) =>
      this.transport.call("main", `${service}.${method}`, args)
    );
    this.events.on("panel:runtimeLeaseChanged", (event) => {
      this.panels.handleRuntimeLeaseChanged(event as PanelRuntimeLeaseChangedEvent);
    });
    this.events.on("panel-tree-invalidated", (event) => {
      this.panels.invalidateTree(event as PanelTreeInvalidation);
    });
    this.events.on("panel:executionActivated", (event) => {
      this.panels.handleExecutionActivated(event as EventPayloads["panel:executionActivated"]);
    });
  }
  async init(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let recoveryAttempt = 0;
    for (;;) {
      try {
        const info = await this.connectWorkspace();
        await this.startPanelAssetFacade(info.config.id);
        let restored = await loadMobileShellStartupSnapshot(this.serverIdentity, info.config.id);
        try {
          this.panels.prepare(
            info.config.id,
            restored ? { tree: restored.tree, rootPanels: restored.rootPanels } : undefined
          );
        } catch (error) {
          if (!restored) throw error;
          await clearMobileShellStartupSnapshot(this.serverIdentity, info.config.id);
          restored = null;
          this.panels.prepare(info.config.id);
          smokePhase("workspace-shell-snapshot-rejected");
        }
        if (restored) {
          this.panels.showRestoredPanel(restored.preferredPanelId);
          smokePhase("workspace-shell-ready", {
            source: "durable-snapshot",
            revision: restored.tree.revision,
          });
        } else {
          await this.panels.loadTreeForPaint(info.config);
          await this.persistStartupSnapshot(info.config.id);
          smokePhase("workspace-shell-ready", { source: "live-tree" });
        }
        this.onReadinessChange?.("shell-ready");
        this.reconciliation = this.reconcileAfterPaint(info, Boolean(restored));
        return;
      } catch (error) {
        if (
          (error as { code?: unknown } | null)?.code !== "CONNECTION_LOST" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        recoveryAttempt += 1;
        smokePhase("workspace-init-retry", {
          attempt: recoveryAttempt,
          message: error instanceof Error ? error.message : String(error),
        });
        await this.transport.waitUntilConnected(deadline - Date.now());
      }
    }
  }

  /**
   * Start the on-device panel-asset façade now that the pipe is up, and point
   * panel URLs at it: panels load `http://127.0.0.1:<port>/{source}/` and the
   * façade proxies each asset request to the remote gateway over the WebRTC pipe.
   * `MainScreen` reads `shellClient.serverUrl` for `buildPanelUrl`, so this must
   * land before the client is published to the UI (`finishConnectedClient`).
   */
  private async startPanelAssetFacade(workspaceIdentity: string): Promise<void> {
    if (this.facade) return;
    this.facade = await startPanelAssetFacade(this.transport, {
      serverIdentity: this.serverIdentity,
      workspaceIdentity,
    });
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

  private async findOwnedChannelPanel(
    channelId: string
  ): Promise<{ id: string; title: string } | null> {
    const userId = this.currentUserId;
    if (!userId) return null;
    const findInGroup = async (
      group: import("@vibestudio/shared/panel/treeIndex").PanelTreeGroup
    ): Promise<{ id: string; title: string } | null> => {
      let cursor: string | undefined;
      do {
        const page = await this.panels.queryTreePage({
          group,
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        for (const node of page.nodes) {
          const [observation, stateArgs] = await Promise.all([
            this.panels.observe(node.slotId),
            this.panels.getStateArgs(node.slotId),
          ]);
          if (observation.source === "panels/chat" && stateArgs["channelName"] === channelId) {
            return { id: node.slotId, title: node.title };
          }
          if (node.childCount > 0) {
            const nested = await findInGroup({
              kind: "children",
              parentSlotId: node.slotId,
            });
            if (nested) return nested;
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return null;
    };
    return findInGroup({ kind: "roots", ownerUserId: userId });
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
    this.workspaceInfo = info;
    return info;
  }

  private async reconcileAfterPaint(info: WorkspaceInfo, refreshTree: boolean): Promise<void> {
    try {
      const deferredResults = Promise.allSettled([
        this.refreshAccountProfile(),
        this.ensureReactNativeHostTargetReady(),
      ]);
      await (refreshTree ? this.panels.reconcile(info.config) : this.panels.completeColdStart());
      if (this.disposed) return;
      await this.events.subscribe("panel:runtimeLeaseChanged");
      await this.events.subscribe("panel-tree-invalidated");
      await this.events.subscribe("panel:executionActivated");
      await drainWorkspaceMutationQueue(this);
      this.registerPanelRecoveryHandlers();
      const [profile, host] = await deferredResults;
      if (profile.status === "rejected") {
        console.warn("[ShellClient] Deferred account profile load failed", profile.reason);
      }
      if (host.status === "rejected") throw host.reason;
      await this.persistStartupSnapshot(info.config.id);
      smokePhase("workspace-reconciled");
      this.onReadinessChange?.("reconciled");
    } catch (error) {
      smokePhase("workspace-reconcile-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn("[ShellClient] Deferred workspace reconciliation failed", error);
      this.onReadinessChange?.("failed");
    }
  }

  private async persistStartupSnapshot(workspaceIdentity: string): Promise<void> {
    const snapshot = this.panels.startupSnapshot();
    if (!snapshot) return;
    const record: MobileShellStartupSnapshot = {
      schemaVersion: 1,
      serverIdentity: this.serverIdentity,
      workspaceIdentity,
      capturedAt: Date.now(),
      preferredPanelId: this.panels.getPreferredRootId(),
      ...snapshot,
    };
    await saveMobileShellStartupSnapshot(record);
  }

  private async ensureReactNativeHostTargetReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const launch = await this.hostLaunch.launch("react-native");
      if (launch.status === "ready") {
        smokePhase("workspace-host-target-ready", {
          target: launch.target,
          appId: launch.entity.identity.entityId,
          source: launch.entity.source,
        });
        return;
      }
      if (launch.status === "approval-required") {
        smokePhase("workspace-host-target-approval-required", {
          target: launch.target,
          count: launch.approvals.length,
        });
        throw new MobileHostTargetApprovalRequiredError(launch);
      }
      if (launch.status === "preparing") {
        smokePhase("workspace-host-target-preparing", { target: launch.target });
        if (Date.now() >= deadline) throw new Error(launch.reason);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      throw new Error(launch.reason);
    }
  }

  reconnect(): void {
    this.transport.reconnect();
  }
  retryWorkspaceSetup(): void {
    if (!this.workspaceInfo) return;
    this.onReadinessChange?.("shell-ready");
    this.reconciliation = this.reconcileAfterPaint(this.workspaceInfo, true);
  }
  /** Test/diagnostic boundary for work intentionally deferred past first paint. */
  async whenReconciled(): Promise<void> {
    await this.reconciliation;
  }
  /** Enforce the durable panel-asset byte cap after native memory pressure. */
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
    this.disposed = true;
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
    this.panelCommandRegistry.clear();
  }
}
export type MobilePanelsClient = InstanceType<typeof MobilePanels>;
