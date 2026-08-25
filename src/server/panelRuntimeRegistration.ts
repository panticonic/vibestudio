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
import {
  normalizePanelEvaluateResult,
  panelEvaluateTimeoutMs,
} from "@vibestudio/shared/panel/evaluate";
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
  approvalQueue?: ApprovalQueue;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
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
      currentHistory: { source: string; context_id: string };
      entity: { id: string };
    } | null;
    if (!detail) return null;
    return {
      id: panelId,
      title: panelId,
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
              container.get<import("./services/fsService.js").FsService>("fsService");
            return (await fsService.handleCall(
              ctx,
              "readFile",
              contextId ? [contextId, filePath, "utf8"] : [filePath, "utf8"]
            )) as string;
          },
          readManagedFiles: async (ctx, patterns, contextId) => {
            const fsService =
              container.get<import("./services/fsService.js").FsService>("fsService");
            return fsService.readManagedFiles(
              ctx,
              patterns,
              contextId ? { explicitContextId: contextId } : undefined
            );
          },
        },
        recordContextIngestion: deps.recordContextIngestion,
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
          evaluate: async (panelId, _requesterEntityId, expression, options) => {
            await ensureCdpTargetReady(panelId);
            // The bound travels with the command so both providers enforce the
            // same one; it is an RPC bound on a host command slot, never an
            // expiry on the authority that permitted the call.
            const result = await bridge.sendHostCommand(panelId, "evaluate", [
              expression,
              { ...(options ?? {}), timeoutMs: panelEvaluateTimeoutMs(options) },
            ]);
            return normalizePanelEvaluateResult(result);
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

  {
    let chromiumFetchDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "chromiumFetch",
      dependencies: ["cdpBridge"],
      async start(resolve) {
        const bridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const { createChromiumFetchService } = await import("./services/chromiumFetchService.js");
        const headlessHost = async (): Promise<string> => {
          const select = () =>
            deps.panelRuntimeCoordinator?.getDefaultCdpHostClient({
              isHostAvailable: (hostConnectionId) => bridge.isProviderConnected(hostConnectionId),
            }) ?? null;
          let client = select();
          if (client?.platform !== "headless" && deps.ensureDefaultHeadlessHost) {
            await deps.ensureDefaultHeadlessHost();
            client = select();
          }
          if (!client || client.platform !== "headless") {
            throw new Error("Managed headless Chromium host is unavailable");
          }
          return client.hostConnectionId ?? client.clientSessionId;
        };
        chromiumFetchDefinition = createChromiumFetchService({
          open: async (url, session) => {
            const hostConnectionId = await headlessHost();
            const response = (await bridge.sendProviderCommand(
              hostConnectionId,
              "chromiumFetch.open",
              [{ url, session }]
            )) as import("./services/chromiumFetchService.js").ChromiumFetchMetadata;
            return { hostConnectionId, response };
          },
          read: (hostConnectionId, responseId, offset, limit) =>
            bridge.sendProviderCommand(hostConnectionId, "chromiumFetch.read", [
              { responseId, offset, limit },
            ]) as Promise<{ bytesBase64: string; done: boolean }>,
          close: async (hostConnectionId, responseId) => {
            await bridge.sendProviderCommand(hostConnectionId, "chromiumFetch.close", [
              { responseId },
            ]);
          },
        });
      },
      getServiceDefinition() {
        if (!chromiumFetchDefinition) throw new Error("chromiumFetch service not initialized");
        return chromiumFetchDefinition;
      },
    });
  }

  {
    // Server-resident panel identity for server-side callers and configured
    // agent tools. The chrome owner keeps composing locally from
    // `panel.getChromeState` because it already owns those presentation facts.
    const { createPanelContextService } = await import("./services/panelContextService.js");
    const serverCtx: ServiceContext = { caller: createHostCaller("server") };
    container.registerRpc(
      createPanelContextService({
        ...panelGateDeps,
        resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
        hasAppCapability: deps.hasAppCapability,
        getTarget: (panelId) => requestPanelMetadataForServices(panelId),
        getPanelDetail: async (panelId) =>
          (await deps.dispatcher.dispatch(serverCtx, "workspace-state", "panelTree.detail", [
            panelId,
          ])) as
            | import("@vibestudio/shared/panel/workspaceStateSnapshot").WorkspacePanelDetail
            | null,
        getSiblings: async (panelId, parentSlotId) => {
          if (parentSlotId === null) return [];
          const page = (await deps.dispatcher.dispatch(
            serverCtx,
            "workspace-state",
            "panelTree.page",
            [{ group: { kind: "children", parentSlotId }, limit: 50 }]
          )) as { nodes: Array<{ slotId: string; title?: string | null }> };
          return page.nodes
            .filter((node) => node.slotId !== panelId)
            .map((node) => ({ slotId: node.slotId, title: node.title ?? null }));
        },
        getLease: (panelId) => {
          const observation = deps.panelRuntimeCoordinator?.observeSlotLifecycle(panelId);
          const route = observation?.route;
          const phase = observation?.attempt?.phase;
          return {
            state: phase === "ready" ? "ready" : route?.connectionId ? "loading" : "unavailable",
            url: route?.view?.url ?? null,
            surface: route?.platform ?? null,
            hostConnectionId: route?.connectionId ?? null,
            holderLabel: route?.holderLabel ?? null,
            supportsCdp: route?.supportsCdp ?? false,
            reachable: route?.reachable ?? false,
          };
        },
      })
    );
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
        getUnitIcon: (source, artifactPath, stateRef) =>
          buildSystem.getUnitIcon(source, artifactPath, stateRef),
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
    let fsServiceInstance: import("./services/fsService.js").FsService;
    container.registerManaged({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = assertPresent(
          resolve<import("./services/fsService.js").FsService>("fsService")
        );
      },
      getServiceDefinition() {
        return createFsServiceDefinition(() => fsServiceInstance);
      },
    });
  }
}
