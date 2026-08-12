/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import type { CdpBridge } from "./cdpBridge.js";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import {
  createHostCaller,
  createVerifiedCaller,
  type CallerKind,
  type ServiceContext,
  type ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import type { Workspace, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { HostConfig } from "@vibestudio/shared/hostConfig";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import { assertPresent } from "../lintHelpers";
import { isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import { isPanelEntityId } from "@vibestudio/shared/panel/ids";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import type { SlotRow } from "@vibestudio/shell-core/workspaceStateClient";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { ContextIngestionRecorder } from "./services/contextIntegrityStore.js";
import type { PanelTreeInvalidation } from "@vibestudio/shared/panel/treeIndex";
import {
  callerControlsContextTransition,
  type LifecycleContextControlStore,
} from "./services/lifecycleContextControl.js";

const log = createDevLogger("PanelRuntimeRegistration");

async function waitForCdpTargetRegistered(
  bridge: CdpBridge,
  panelId: string,
  hostConnectionId: string,
  timeoutMs = 30_000
): Promise<void> {
  if (bridge.isTargetRegisteredForHost(panelId, hostConnectionId)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (bridge.isTargetRegisteredForHost(panelId, hostConnectionId)) return;
  }
  throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
}

type PanelAccessMetadata =
  import("./services/panelAccessPermission.js").PanelAccessPermissionTarget;

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

/**
 * Resolve whether a CDP target still names an open authoritative panel slot.
 *
 * This is a product-host control-plane lookup, not a relayed userland call, so
 * it must carry the host principal explicitly. Lookup failures deliberately
 * propagate: only a successful null/closed result proves that a target is
 * stale. Treating an authority or storage failure as "unknown" would tell the
 * provider to permanently forget a live webContents target.
 */
export function createKnownPanelSlotResolver(
  dispatcher: Pick<ServiceDispatcher, "dispatch">
): (targetId: string) => Promise<boolean> {
  const serverCtx: ServiceContext = { caller: createHostCaller("server") };
  return async (targetId: string): Promise<boolean> => {
    const slot = (await dispatcher.dispatch(serverCtx, "workspace-state", "slot.get", [
      targetId,
    ])) as SlotRow | null;
    return Boolean(slot && slot.closed_at == null);
  };
}

export interface CommonDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  workspace: Workspace;
  /** Opaque host-owned identity, including for ephemeral workspaces. */
  workspaceId: string;
  /** User-facing hub catalog name; may differ from an ephemeral child's disk name. */
  activeWorkspaceName: string;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  /** Live config reads and GAD-authoritative protected-main writes. */
  getWorkspaceConfig?: () => WorkspaceConfig;
  persistWorkspaceConfigField?: (ctx: ServiceContext, key: string, value: unknown) => Promise<void>;
  applyPreparedWorkspaceConfig?: (
    ctx: ServiceContext,
    input: {
      expectedBaseDigest: string;
      nextState: WorkspaceConfig;
      resultDigest: string;
      allowedPathScope: string[];
      summary: string;
    }
  ) => Promise<{ changed: boolean; resultDigest: string; config: WorkspaceConfig }>;
  recordContextIngestion?: ContextIngestionRecorder;
  treeScanner?: import("./vcsHost/workspaceTreeScanner.js").WorkspaceTreeScanner;
  adminToken: string;
  hostConfig: HostConfig;
  tokenManager?: import("@vibestudio/shared/tokenManager").TokenManager;
  cdpGrants?: import("@vibestudio/shared/cdpGrants").CdpGrantService;
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
  /** Durable lifecycle edges used to authorize a supervisor's child contexts. */
  lifecycleContextStore: LifecycleContextControlStore;
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
  listRecurringJobs?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceRecurringJobStatus[]>
    | import("./services/workspaceService.js").WorkspaceRecurringJobStatus[];
  approvalQueue?: ApprovalQueue;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
  /** Register a listener that runs after a title is durable in WorkspaceDO. */
  registerEntityTitlePersistedListener?: (
    listener: (
      entityId: string,
      title: string | undefined,
      origin: "set" | "set-explicit" | "mirror" | "clear"
    ) => void | Promise<void>
  ) => () => void;
  /**
   * Register a listener fired whenever the authoritative panel slot/history tree
   * changes (any client). The panel-tree bridge uses it to re-sync its in-memory
   * mirror and re-broadcast `panel-tree-invalidated` so every client converges.
   */
  registerSlotStateListener?: (listener: () => void) => () => void;
}

export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const { container, workspace, workspaceConfig, adminToken, hostConfig } = deps;
  const isKnownPanelSlot = createKnownPanelSlotResolver(deps.dispatcher);

  // Durable slot mutations are performed by several callers (desktop, mobile,
  // panels, and the server itself). Keep the renderer query caches coherent at
  // the server boundary instead of relying on the mutating caller to remember
  // to notify every other client. Multiple writes in one turn share one read
  // and one broadcast; reset=true is intentional because the bounded query
  // cache will retain its coherent pages while refetching current truth.
  if (deps.eventService && deps.registerSlotStateListener) {
    const eventService = deps.eventService;
    const registerSlotStateListener = deps.registerSlotStateListener;
    let invalidationQueued = false;
    const publishPanelTreeInvalidation = async (): Promise<void> => {
      const snapshot = (await deps.dispatcher.dispatch(
        { caller: createHostCaller("server") },
        "workspace-state",
        "panelTree.rootGroups",
        [{ limit: 1 }]
      )) as { revision?: unknown };
      const revision = snapshot.revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error(`Invalid panel tree revision: ${String(revision)}`);
      }
      const event: PanelTreeInvalidation = {
        revision,
        reset: true,
        groups: [],
        changedSlotIds: [],
        removedSlotIds: [],
      };
      eventService.emit("panel-tree-invalidated", event);
    };
    const schedulePanelTreeInvalidation = () => {
      if (invalidationQueued) return;
      invalidationQueued = true;
      queueMicrotask(() => {
        invalidationQueued = false;
        void publishPanelTreeInvalidation().catch((error: unknown) => {
          log.warn(
            `Failed to publish panel-tree invalidation: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      });
    };
    registerSlotStateListener(schedulePanelTreeInvalidation);
    deps.registerEntityTitlePersistedListener?.(async (entityId, title, origin) => {
      const serverCaller = { caller: createHostCaller("server") };
      const slotIdForEntity = async (id: string): Promise<string | undefined> => {
        const slotId = (await deps.dispatcher.dispatch(
          serverCaller,
          "workspace-state",
          "slot.resolveByEntity",
          [id]
        )) as string | null;
        return slotId ?? undefined;
      };
      const directPanelSlot = await slotIdForEntity(entityId);
      if (directPanelSlot) {
        schedulePanelTreeInvalidation();
        eventService.emit("panel-title-updated", {
          panelId: directPanelSlot,
          title: title ?? null,
          explicit: origin === "set-explicit",
        });
        return;
      }

      const owningSlot = await resolveOwningPanelSlot(entityId, {
        isOpenSlot: async (id) => {
          const slot = (await deps.dispatcher.dispatch(
            serverCaller,
            "workspace-state",
            "slot.get",
            [id]
          )) as { closed_at?: number | null } | null;
          return Boolean(slot && slot.closed_at == null);
        },
        resolveOpenSlotForEntity: slotIdForEntity,
        resolveParentId: async (id) => deps.entityCache?.resolveActive(id)?.parentId,
      });
      if (!owningSlot) return;

      // A worker/DO may be the active runtime behind a panel-owned
      // execution. Its title is useful as the panel's inferred label, but
      // must go through the canonical panel write so the next persisted
      // event updates every client consistently.
      if (!title) return;
      await deps.dispatcher.dispatch(serverCaller, "workspace-state", "panel.updateTitle", [
        owningSlot,
        title,
        { explicit: false },
      ]);
    });
  }

  const requestPanelMetadataForServices = async (
    panelId: string,
    _caller: { id: string; kind: CallerKind } = { id: "server", kind: "server" }
  ): Promise<PanelAccessMetadata | null> => {
    const detail = (await deps.dispatcher.dispatch(
      { caller: createHostCaller("server") },
      "workspace-state",
      "panelTree.detail",
      [panelId]
    )) as {
      slot: { current_entity_title?: string | null };
      currentHistory: { source: string; context_id: string };
      entity: { id: string };
    } | null;
    if (!detail) return null;
    return {
      id: panelId,
      title: detail.slot.current_entity_title ?? panelId,
      source: detail.currentHistory.source,
      kind: isBrowserPanelSource(detail.currentHistory.source) ? "browser" : "workspace",
      runtimeEntityId: detail.entity.id,
      contextId: detail.currentHistory.context_id,
    };
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
    isEntityControlledBy: (entityId: string, callerId: string) => {
      const visited = new Set<string>();
      let current = panelGateEntityCache.resolve(entityId);
      while (current && !visited.has(current.id)) {
        if (current.parentId === callerId) return true;
        visited.add(current.id);
        current = current.parentId ? panelGateEntityCache.resolve(current.parentId) : null;
      }
      return false;
    },
    controlsLifecycleContext: (
      callerId: string,
      originContextId: string | null,
      targetContextId: string
    ) =>
      callerControlsContextTransition(
        deps.lifecycleContextStore,
        callerId,
        originContextId,
        targetContextId
      ),
    resolveSubjectCaller: (entityId: string) => {
      const rec = panelGateEntityCache.resolveActive(entityId);
      if (!rec) return null;
      const k = rec.kind;
      if (k !== "panel" && k !== "app" && k !== "worker" && k !== "do") return null;
      if (!rec.activeExecutionDigest || !rec.activeAuthority) return null;
      return createVerifiedCaller(rec.id, k, {
        callerId: rec.id,
        callerKind: k,
        repoPath: rec.source.repoPath,
        effectiveVersion: rec.source.effectiveVersion,
        executionDigest: rec.activeExecutionDigest,
        requested: rec.activeAuthority.requests,
      });
    },
  };

  {
    const { createWorkspaceService } = await import("./services/workspaceService.js");

    container.registerRpc(
      createWorkspaceService({
        workspace,
        workspaceId: deps.workspaceId,
        activeWorkspaceName: deps.activeWorkspaceName,
        treeScanner: deps.treeScanner,
        getConfig: deps.getWorkspaceConfig ?? (() => workspaceConfig),
        setConfigField: async (key, value, ctx) => {
          if (!deps.persistWorkspaceConfigField) {
            throw new Error("GAD-authoritative workspace config publishing is unavailable");
          }
          await deps.persistWorkspaceConfigField(ctx, key, value);
        },
        applyPreparedConfig: (input, ctx) => {
          if (!deps.applyPreparedWorkspaceConfig) {
            throw new Error("Prepared workspace config publishing is unavailable");
          }
          return deps.applyPreparedWorkspaceConfig(ctx, input);
        },
        contextFiles: {
          readFile: async (ctx, filePath, contextId) => {
            const fsService =
              container.get<import("@vibestudio/shared/fsService").FsService>("fsService");
            return (await fsService.handleCall(
              ctx,
              "readFile",
              contextId ? [contextId, filePath, "utf8"] : [filePath, "utf8"]
            )) as string;
          },
          readManagedFiles: async (ctx, patterns, contextId) => {
            const fsService =
              container.get<import("@vibestudio/shared/fsService").FsService>("fsService");
            return fsService.readManagedFiles(
              ctx,
              patterns,
              contextId ? { explicitContextId: contextId } : undefined
            );
          },
        },
        recordContextIngestion: deps.recordContextIngestion,
        listRecurringJobs: deps.listRecurringJobs,
        hasAppCapability: deps.hasAppCapability,
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
          cdpGrants: deps.cdpGrants,
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
      dependencies: ["cdpBridge"],
      async start(resolve) {
        const bridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const { createPanelCdpService } = await import("./services/panelCdpService.js");
        const { CdpHostProviderRpcChannel } = await import("./cdpHostProviderRpcChannel.js");
        const hostProviderChannel = new CdpHostProviderRpcChannel(bridge);
        panelCdpDefinition = createPanelCdpService({
          ...panelGateDeps,
          resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
          hasAppCapability: deps.hasAppCapability,
          recordContextIngestion: deps.recordContextIngestion,
          getTarget: (panelId) => requestPanelMetadataForServices(panelId),
          getEndpoint: async (panelId, requesterEntityId) => {
            await ensureCdpTargetReady(panelId);
            const endpoint = bridge.getCdpEndpoint(panelId, requesterEntityId);
            if (!endpoint) throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
            return endpoint;
          },
          stop: async (panelId, requesterEntityId) => {
            await ensureCdpTargetReady(panelId);
            return bridge.sendTargetCommand(panelId, requesterEntityId, "stop", []);
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
            else log.verbose(message, payload);
          },
        });

        async function ensureCdpTargetReady(panelId: string): Promise<void> {
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
            throw Object.assign(
              new Error(`No presentation host is available for panel: ${panelId}`),
              {
                code: "cdp_no_default_host",
              }
            );
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
        getUnitIcon: (source, artifactPath) => buildSystem.getUnitIcon(source, artifactPath),
        getBuildByKey: (buildKey) => buildSystem.getBuildByKey(buildKey),
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
