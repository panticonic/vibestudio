/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import {
  createOwnerPanelSeedStore,
  createOwnerSeedingPanelTreeBridge,
  createServerPanelTreeBridge,
  waitForCdpTargetRegistered,
} from "./ownerPanelTreeBridge.js";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import {
  createVerifiedCaller,
  type CallerKind,
  type ServiceContext,
  type ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import type { Workspace, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import type { HostConfig } from "@vibestudio/shared/hostConfig";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@vibestudio/shared/hostTargets";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import { assertPresent } from "../lintHelpers";
import { isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import { isPanelEntityId } from "@vibestudio/shared/panel/ids";
import type { SlotRow } from "@vibestudio/shell-core/workspaceStateClient";
import type { AppCapability } from "@vibestudio/shared/unitManifest";

const log = createDevLogger("PanelRuntimeRegistration");

type PanelAccessMetadata =
  import("./services/panelAccessPermission.js").PanelAccessPermissionTarget;

function shouldValidateOpenPanelWorkspaceUnit(source: string): boolean {
  if (!source) return false;
  if (isBrowserPanelSource(source)) return false;
  if (isAboutSource(source)) return false;
  return source === "panels" || source.startsWith("panels/");
}

function panelOpenBuildRef(options: Record<string, unknown>): string | undefined {
  if (typeof options["ref"] === "string" && options["ref"].length > 0) return options["ref"];
  if (typeof options["contextId"] === "string" && options["contextId"].length > 0) {
    return `ctx:${options["contextId"]}`;
  }
  return undefined;
}

export function cdpDefaultHostAssignmentError(
  panelId: string,
  reason: "already_held" | "mobile_held" | "no_default_cdp_host"
): Error | null {
  if (reason === "mobile_held") {
    return Object.assign(
      new Error(`CDP is unavailable while panel ${panelId} is held by a non-CDP host`),
      { code: "cdp_unavailable_mobile_held" }
    );
  }
  if (reason === "no_default_cdp_host") {
    return Object.assign(new Error(`No CDP-capable host is available for panel: ${panelId}`), {
      code: "cdp_no_default_host",
    });
  }
  return null;
}

export interface CommonDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  workspace: Workspace;
  /** User-facing hub catalog name; may differ from an ephemeral child's disk name. */
  activeWorkspaceName: string;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  /** Live config reads and GAD-authoritative protected-main writes. */
  getWorkspaceConfig?: () => WorkspaceConfig;
  persistWorkspaceConfigField?: (ctx: ServiceContext, key: string, value: unknown) => Promise<void>;
  treeScanner?: import("./vcsHost/workspaceTreeScanner.js").WorkspaceTreeScanner;
  adminToken: string;
  hostConfig: HostConfig;
  tokenManager?: import("@vibestudio/shared/tokenManager").TokenManager;
  eventService?: import("@vibestudio/shared/eventsService").EventService;
  grantStore?: import("./services/capabilityGrantStore.js").CapabilityGrantStore;
  /** Whether a workspace-app caller declares a capability (e.g. panel-hosting). */
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  /** Active-entity cache; resolves caller/target contexts and code-identity subjects. */
  entityCache?: import("@vibestudio/shared/runtime/entityCache").EntityCache;
  /** True when the target context already holds state (active entity or materialized folder). */
  contextExists: (contextId: string) => boolean;
  /** Human label for the entity owning the target context, for prompt copy. */
  resolveContextOwnerLabel?: (contextId: string) => string | undefined;
  panelRuntimeCoordinator?: import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator;
  /**
   * Renderer of last resort: spawn (or reuse) the standalone headless host
   * and resolve true once a default CDP host is registered + bridge-connected.
   * Callers retry default lease assignment after a true result.
   */
  ensureDefaultHeadlessHost?: () => Promise<boolean>;
  getGatewayPort?: () => number | null;
  /** Materialize a context's working folder; backs `workspace.ensureContextFolder`. */
  ensureContextFolder?: (contextId: string) => Promise<{ dir: string }>;
  listWorkspaceUnits?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitStatus[]>
    | import("./services/workspaceService.js").WorkspaceUnitStatus[];
  restartWorkspaceUnit?: (
    ctx: import("@vibestudio/shared/serviceDispatcher").ServiceContext,
    name: string
  ) => Promise<void>;
  listWorkspaceUnitLogs?: (
    name: string,
    opts?: {
      since?: number;
      level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
      limit?: number;
    }
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitLogRecord[]>
    | import("./services/workspaceService.js").WorkspaceUnitLogRecord[];
  unitDiagnostics?: (
    name: string,
    opts?: {
      since?: number;
      level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
      limit?: number;
      errorLimit?: number;
    }
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitDiagnostics>
    | import("./services/workspaceService.js").WorkspaceUnitDiagnostics;
  bakeAppDist?: (sourceOrName: string, opts?: { outDir?: string }) => Promise<unknown> | unknown;
  listAppVersions?: (
    sourceOrName: string
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceAppVersions>
    | import("./services/workspaceService.js").WorkspaceAppVersions;
  rollbackAppVersion?: (sourceOrName: string, buildKey?: string) => Promise<unknown> | unknown;
  listRecurringJobs?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceRecurringJobStatus[]>
    | import("./services/workspaceService.js").WorkspaceRecurringJobStatus[];
  listHostTargetCandidates?: (
    target: HostTarget
  ) => Promise<HostTargetCandidate[]> | HostTargetCandidate[];
  getHostTargetSelection?: (
    target: HostTarget
  ) =>
    | Promise<{ selection: HostTargetSelection | null; valid: boolean; reason?: string }>
    | { selection: HostTargetSelection | null; valid: boolean; reason?: string };
  setHostTargetSelection?: (
    target: HostTarget,
    input: HostTargetSelectionInput
  ) => Promise<HostTargetSelection> | HostTargetSelection;
  clearHostTargetSelection?: (target: HostTarget) => Promise<void> | void;
  listHostTargetVersions?: (
    target: HostTarget,
    sourceOrName: string
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceAppVersions>
    | import("./services/workspaceService.js").WorkspaceAppVersions;
  prepareHostTargetPinnedRef?: (
    target: HostTarget,
    sourceOrName: string,
    ref: string
  ) => Promise<unknown> | unknown;
  launchHostTarget?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchResult> | HostTargetLaunchResult;
  beginHostTargetLaunch?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  getHostTargetLaunchSession?: (
    sessionId: string
  ) => Promise<HostTargetLaunchSessionSnapshot | null> | HostTargetLaunchSessionSnapshot | null;
  resolveHostTargetLaunchSessionApproval?: (
    sessionId: string,
    decision: "once" | "deny"
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  cancelHostTargetLaunchSession?: (sessionId: string) => Promise<void> | void;
  approvalQueue?: ApprovalQueue;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
  registerEntityTitleListener?: (
    listener: (
      entityId: string,
      title: string | undefined,
      origin: "set" | "set-explicit" | "mirror" | "clear"
    ) => void | Promise<void>
  ) => () => void;
  /**
   * Register a listener fired whenever the authoritative panel slot/history tree
   * changes (any client). The panel-tree bridge uses it to re-sync its in-memory
   * mirror and re-broadcast `panel-tree-updated` so every client converges.
   */
  registerSlotStateListener?: (listener: () => void) => () => void;
}

export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const { container, workspace, workspaceConfig, adminToken, hostConfig } = deps;
  let serverPanelTreeBridgePromise: Promise<
    (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown>
  > | null = null;
  const getPanelTreeBridge = () => {
    serverPanelTreeBridgePromise ??= createServerPanelTreeBridge({
      container: deps.container,
      dispatcher: deps.dispatcher,
      workspacePath: deps.workspacePath,
      workspaceConfig: deps.workspaceConfig,
      eventService: deps.eventService,
      panelRuntimeCoordinator: deps.panelRuntimeCoordinator,
      ensureDefaultHeadlessHost: deps.ensureDefaultHeadlessHost,
      getGatewayPort: deps.getGatewayPort,
      registerEntityTitleListener: deps.registerEntityTitleListener,
      registerSlotStateListener: deps.registerSlotStateListener,
    });
    return serverPanelTreeBridgePromise;
  };
  const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };
  const isKnownPanelSlot = async (targetId: string): Promise<boolean> => {
    try {
      const slot = (await deps.dispatcher.dispatch(serverCtx, "workspace-state", "slot.get", [
        targetId,
      ])) as SlotRow | null;
      return Boolean(slot && slot.closed_at == null);
    } catch {
      return false;
    }
  };
  const requestPanelMetadataForServices = async (
    panelId: string,
    caller: { id: string; kind: CallerKind } = { id: "server", kind: "server" }
  ): Promise<PanelAccessMetadata | null> => {
    const bridge = await getPanelTreeBridge();
    const meta = (await bridge({
      callerId: caller.id,
      callerKind: caller.kind,
      method: "metadata",
      args: [panelId],
    })) as PanelAccessMetadata | null;
    if (!meta) return null;
    return { ...meta, id: panelId };
  };
  const resolveRequesterPanelMetadataForServices = async (
    caller: import("@vibestudio/shared/serviceDispatcher").VerifiedCaller
  ): Promise<PanelAccessMetadata | null> => {
    if (caller.runtime.kind !== "panel") return null;
    const lease = deps.panelRuntimeCoordinator?.getLease(caller.runtime.id);
    const slotId = lease?.slotId ?? caller.runtime.id;
    return requestPanelMetadataForServices(slotId, {
      id: caller.runtime.id,
      kind: caller.runtime.kind,
    });
  };

  // Shared context-boundary resolvers for the panel control-plane gate. Built from
  // the active-entity cache so the panel-tree and CDP services attribute cross-
  // context prompts to the real subject (the direct caller, or the anchor entity
  // behind a host-mediated server/shell call).
  const panelGateEntityCache = assertPresent(deps.entityCache);
  const panelGateDeps = {
    contextExists: deps.contextExists,
    resolveContextOwnerLabel: deps.resolveContextOwnerLabel,
    resolveCallerContext: async (callerId: string) => panelGateEntityCache.resolveContext(callerId),
    resolveEntityContext: (entityId: string) => panelGateEntityCache.resolveContext(entityId),
    resolveSubjectCaller: (entityId: string) => {
      const rec = panelGateEntityCache.resolveActive(entityId);
      if (!rec) return null;
      const k = rec.kind;
      if (k !== "panel" && k !== "app" && k !== "worker" && k !== "do") return null;
      return createVerifiedCaller(rec.id, k, {
        callerId: rec.id,
        callerKind: k,
        repoPath: rec.source.repoPath,
        effectiveVersion: rec.source.effectiveVersion,
      });
    },
  };

  {
    const { createWorkspaceService } = await import("./services/workspaceService.js");

    container.registerRpc(
      createWorkspaceService({
        workspace,
        activeWorkspaceName: deps.activeWorkspaceName,
        treeScanner: deps.treeScanner,
        getConfig: deps.getWorkspaceConfig ?? (() => workspaceConfig),
        setConfigField: async (key, value, ctx) => {
          if (!deps.persistWorkspaceConfigField) {
            throw new Error("GAD-authoritative workspace config publishing is unavailable");
          }
          await deps.persistWorkspaceConfigField(ctx, key, value);
        },
        listUnits: deps.listWorkspaceUnits,
        restartUnit: deps.restartWorkspaceUnit,
        listUnitLogs: deps.listWorkspaceUnitLogs,
        unitDiagnostics: deps.unitDiagnostics,
        bakeAppDist: deps.bakeAppDist,
        listAppVersions: deps.listAppVersions,
        rollbackAppVersion: deps.rollbackAppVersion,
        listRecurringJobs: deps.listRecurringJobs,
        listHostTargetCandidates: deps.listHostTargetCandidates,
        getHostTargetSelection: deps.getHostTargetSelection,
        setHostTargetSelection: deps.setHostTargetSelection,
        clearHostTargetSelection: deps.clearHostTargetSelection,
        listHostTargetVersions: deps.listHostTargetVersions,
        prepareHostTargetPinnedRef: deps.prepareHostTargetPinnedRef,
        launchHostTarget: deps.launchHostTarget,
        beginHostTargetLaunch: deps.beginHostTargetLaunch,
        getHostTargetLaunchSession: deps.getHostTargetLaunchSession,
        resolveHostTargetLaunchSessionApproval: deps.resolveHostTargetLaunchSessionApproval,
        cancelHostTargetLaunchSession: deps.cancelHostTargetLaunchSession,
        hasAppCapability: deps.hasAppCapability,
        approvalQueue: deps.approvalQueue,
        ensureContextFolder: deps.ensureContextFolder,
      })
    );
  }

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.registerManaged({
      name: "panelHttpServer",
      async start() {
        const server = new PanelHttpServer();
        server.initHandlers();
        return { server, port: 0 };
      },
      async stop(instance: {
        server: import("./panelHttpServer.js").PanelHttpServer;
        port: number;
      }) {
        await instance?.server?.stop();
      },
    });
    container.registerManaged({
      name: "cdpBridge",
      dependencies: ["panelHttpServer"],
      async start(resolve) {
        const { server } = assertPresent(
          resolve<{
            server: import("./panelHttpServer.js").PanelHttpServer;
          }>("panelHttpServer")
        );
        const { CdpBridge } = await import("./cdpBridge.js");
        const cdpBridge = new CdpBridge({
          adminToken,
          port: deps.getGatewayPort?.() ?? hostConfig.gatewayPort,
          protocol: hostConfig.protocol,
          externalHost: hostConfig.externalHost,
          authenticateHostProvider: (token, hostConnectionId) => {
            if (deps.tokenManager?.validateAdminToken(token)) return true;
            const entry = deps.tokenManager?.validateToken(token);
            if (!entry || entry.callerKind !== "shell") return false;
            return Boolean(
              hostConnectionId &&
              deps.panelRuntimeCoordinator?.hasClientHostConnection(
                hostConnectionId,
                entry.callerId
              )
            );
          },
          canRegisterHostProvider: (hostConnectionId, ownerCallerId) =>
            Boolean(
              deps.panelRuntimeCoordinator?.hasClientHostConnection(hostConnectionId, ownerCallerId)
            ),
          resolveHostForTarget: (targetId) => {
            const resolved = deps.panelRuntimeCoordinator?.resolveHostForSlot(targetId);
            if (!resolved) return null;
            return resolved.supportsCdp ? resolved.hostConnectionId : null;
          },
          recoverHostLeaseForTarget: async (targetId, hostConnectionId) => {
            const target = await requestPanelMetadataForServices(targetId);
            if (!target || !target.runtimeEntityId || !isPanelEntityId(target.runtimeEntityId)) {
              return null;
            }
            const lease = deps.panelRuntimeCoordinator?.adoptHostLeaseForSlot(
              targetId,
              target.runtimeEntityId,
              hostConnectionId
            );
            return lease?.supportsCdp ? lease.hostConnectionId : null;
          },
          getTargetInfo: async (targetId) => {
            const target = await requestPanelMetadataForServices(targetId);
            if (!target) return null;
            return { kind: target.kind, source: target.source };
          },
          isPanelKnown: isKnownPanelSlot,
          // Keep a CDP-automated panel loaded (and eviction-exempt) on its
          // serving host while ≥1 CDP client is connected to its target.
          onTargetClientPinChange: (targetId, pinned) => {
            if (pinned) deps.panelRuntimeCoordinator?.pinSlotLoaded(targetId);
            else deps.panelRuntimeCoordinator?.unpinSlotLoaded(targetId);
          },
        });
        deps.panelRuntimeCoordinator?.onLeaseChanged((event) => {
          cdpBridge.handleRuntimeLeaseChanged(event);
        });
        server.setCdpBridge(cdpBridge);
        return cdpBridge;
      },
      async stop(instance: import("./cdpBridge.js").CdpBridge) {
        await instance?.stop();
      },
    });
  }

  {
    let panelCdpDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "panelCdp",
      dependencies: ["cdpBridge", "shellPresence"],
      async start(resolve) {
        const bridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
        const { createPanelCdpService } = await import("./services/panelCdpService.js");
        const { CdpHostProviderRpcChannel } = await import("./cdpHostProviderRpcChannel.js");
        const hostProviderChannel = new CdpHostProviderRpcChannel(bridge);
        panelCdpDefinition = createPanelCdpService({
          ...panelGateDeps,
          approvalQueue: assertPresent(deps.approvalQueue),
          grantStore: assertPresent(deps.grantStore),
          resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
          hasAppCapability: deps.hasAppCapability,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          getTarget: (panelId) => requestPanelMetadataForServices(panelId),
          getEndpoint: async (panelId, requesterEntityId) => {
            await ensureCdpTargetReady(panelId);
            const endpoint = bridge.getCdpEndpoint(panelId, requesterEntityId);
            if (!endpoint) throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
            return endpoint;
          },
          drive: async (panelId, requesterEntityId, command, args) => {
            await ensureCdpTargetReady(panelId);
            if (command === "navigate") {
              const url = typeof args[0] === "string" ? args[0] : "";
              if (!url) throw new Error("Panel navigation URL is required");
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
          },
          consoleHistory: async (panelId, _requesterEntityId, options) => {
            await ensureCdpTargetReady(panelId);
            return bridge.sendHostCommand(panelId, "consoleHistory", [options ?? {}]) as Promise<
              import("./services/panelCdpService.js").PanelConsoleHistoryResult
            >;
          },
          screenshot: async (panelId, _requesterEntityId, options) => {
            await ensureCdpTargetReady(panelId);
            return bridge.sendHostCommand(panelId, "captureScreenshot", [options ?? {}]) as Promise<
              import("./services/panelCdpService.js").PanelScreenshotResult
            >;
          },
          hostProvider: hostProviderChannel,
          logAccess: (event) => {
            const message = event.denied ? "Panel CDP access denied" : "Panel CDP access";
            const payload = {
              method: event.method,
              requesterId: event.requesterId,
              requesterKind: event.requesterKind,
              targetId: event.targetId,
              targetKind: event.targetKind,
              targetSource: event.targetSource,
              ...(event.reason ? { reason: event.reason } : {}),
            };
            if (event.denied) log.warn(message, payload);
            else log.info(message, payload);
          },
        });

        async function ensureCdpTargetReady(panelId: string): Promise<void> {
          const loadViaPanelTree = async () => {
            const panelTreeBridge = await getPanelTreeBridge();
            await panelTreeBridge({
              callerId: "server",
              callerKind: "server",
              method: "ensureLoaded",
              args: [panelId],
            });
          };

          const target = await requestPanelMetadataForServices(panelId);
          const runtimeEntityId = target?.runtimeEntityId ?? panelId;
          let holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
          if (holder && !holder.supportsCdp) {
            throw Object.assign(
              new Error(`CDP is unavailable while panel ${panelId} is held by a non-CDP host`),
              { code: "cdp_unavailable_mobile_held" }
            );
          }
          const coordinator = deps.panelRuntimeCoordinator;
          if ((!holder || !bridge.isProviderConnected(holder.hostConnectionId)) && coordinator) {
            const replaceUnavailableLease = Boolean(holder);
            const assign = () =>
              coordinator.ensureDefaultCdpHostForSlot(panelId, runtimeEntityId, {
                isHostAvailable: (hostConnectionId) => bridge.isProviderConnected(hostConnectionId),
                replaceUnavailableLease,
              });
            let assigned = assign();
            if (
              !assigned.assigned &&
              assigned.reason === "no_default_cdp_host" &&
              deps.ensureDefaultHeadlessHost
            ) {
              // Renderer of last resort: spawn the headless host and retry once.
              if (await deps.ensureDefaultHeadlessHost()) assigned = assign();
            }
            if (assigned.lease) {
              holder = {
                hostConnectionId: assigned.lease.hostConnectionId,
                supportsCdp: assigned.lease.supportsCdp,
              };
            }
            if (!assigned.assigned) {
              const error = cdpDefaultHostAssignmentError(panelId, assigned.reason);
              if (error) throw error;
            }
          }
          if (holder && !bridge.isProviderConnected(holder.hostConnectionId)) {
            throw Object.assign(new Error(`CDP host provider unavailable for panel: ${panelId}`), {
              code: "cdp_host_unavailable",
            });
          }
          if (holder && bridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) return;
          if (!holder && bridge.isTargetRegistered(panelId)) return;
          if (holder) {
            await waitForCdpTargetRegistered(bridge, panelId, holder.hostConnectionId);
          } else {
            await loadViaPanelTree();
            await waitForCdpTargetRegistered(bridge, panelId);
          }
          if (holder && !bridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) {
            throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
          }
          if (!holder && !bridge.isTargetRegistered(panelId)) {
            throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
          }
        }
        return hostProviderChannel;
      },
      async stop(
        instance: import("./cdpHostProviderRpcChannel.js").CdpHostProviderRpcChannel | undefined
      ) {
        instance?.stop();
      },
      getServiceDefinition() {
        if (!panelCdpDefinition) throw new Error("panelCdp service not initialized");
        return panelCdpDefinition;
      },
    });
  }

  {
    let panelTreeDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "panelTree",
      dependencies: ["shellPresence", "buildSystem", "workspace-state", "runtime"],
      async start(resolve) {
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
        const buildSystem = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        const { createPanelTreeService } = await import("./services/panelTreeService.js");
        const bridge = await getPanelTreeBridge();
        // Seed lazily for each authenticated account on its first panel-tree
        // request; there is no ownerless boot tree.
        const ownerAwareBridge = createOwnerSeedingPanelTreeBridge(
          bridge,
          deps.workspaceConfig?.initPanels ?? [],
          createOwnerPanelSeedStore(deps.workspace.statePath)
        );
        panelTreeDefinition = createPanelTreeService({
          ...panelGateDeps,
          approvalQueue: assertPresent(deps.approvalQueue),
          grantStore: assertPresent(deps.grantStore),
          resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
          hasAppCapability: deps.hasAppCapability,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          validateOpenPanelSource: async ({ source, options }) => {
            if (!shouldValidateOpenPanelWorkspaceUnit(source)) return;
            const ref = panelOpenBuildRef(options);
            const unit = await buildSystem.resolveBuildUnit(source, ref);
            if (!unit) {
              throw new Error(
                ref ? `Unknown build unit at ${ref}: ${source}` : `Unknown build unit: ${source}`
              );
            }
          },
          bridge: ownerAwareBridge,
        });
      },
      getServiceDefinition() {
        if (!panelTreeDefinition) throw new Error("panelTree service not initialized");
        return panelTreeDefinition;
      },
    });
  }

  container.registerManaged({
    name: "panelHttpWiring",
    dependencies: ["panelHttpServer", "buildSystem"],
    async start(resolve) {
      const { server: panelHttpServer } = assertPresent(
        resolve<{
          server: import("./panelHttpServer.js").PanelHttpServer;
        }>("panelHttpServer")
      );
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const eventService = assertPresent(deps.eventService);

      const graph = buildSystem.getGraph();
      const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");
      const entries = panelNodes.map((n) => ({
        source: n.relativePath,
        name: n.manifest.title ?? n.name,
      }));
      panelHttpServer.populateSourceRegistry(entries);

      panelHttpServer.setCallbacks({
        getBuild: (source, ref) => buildSystem.getBuild(source, ref),
        onBuildComplete: (source, error) => {
          eventService.emit("build:complete", { source, ...(error ? { error } : {}) });
        },
      });

      buildSystem.onPushBuild((source) => {
        panelHttpServer.invalidateBuild(source);
      });
    },
  });

  {
    const { createFsServiceDefinition } = await import("./services/fsServiceDef.js");
    let fsServiceInstance: import("@vibestudio/shared/fsService").FsService;
    container.registerManaged({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = assertPresent(
          resolve<import("@vibestudio/shared/fsService").FsService>("fsService")
        );
      },
      getServiceDefinition() {
        return createFsServiceDefinition(() => fsServiceInstance);
      },
    });
  }
}
