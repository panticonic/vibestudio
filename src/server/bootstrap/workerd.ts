import type { EventService } from "@vibestudio/shared/eventsService";
import type { FsService } from "@vibestudio/shared/fsService";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { createHostCaller, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import { PRODUCT_WORKSPACE_SERVICES } from "@vibestudio/shared/productWorkspaceServices.mjs";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc";
import { randomBytes } from "node:crypto";
import { assertPresent } from "../../lintHelpers";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { EgressProxy } from "../services/egressProxy.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import type { RouteRegistry } from "../routeRegistry.js";
import { attestDirectRpc, attestWorkspaceDoRpc } from "../services/authorityRuntime.js";
import { SEMANTIC_CONTROL_PLANE } from "../internalDOs/controlPlane.js";
import type { WorkerdManager, WorkerdWorkspaceProvider } from "../workerdManager.js";
import type { DORef } from "../workerdRpcRelay.js";

export interface WorkerdGatewayBootstrapConfig {
  getPort(): number | null;
  protocol: "http" | "https";
  externalHost: string;
  configuredAliases: string | undefined;
}

export interface WorkerdBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  tokenManager: TokenManager;
  workspacePath: string;
  statePath: string;
  workspaceId: string;
  workspaceDeclarations: WorkspaceDeclarations;
  routeRegistry: RouteRegistry;
  egressProxy: Pick<EgressProxy, "startForCaller" | "startShared" | "setCallerResolver">;
  gatewayToken: string;
  gateway: WorkerdGatewayBootstrapConfig;
  getInternalDoEnv(className: string): Record<string, string>;
  runtimeDiagnostics: Pick<RuntimeDiagnosticsStore, "record">;
  eventService: Pick<EventService, "emit">;
  onManagerStarted(manager: WorkerdManager): void;
}

export function parseGatewayAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
    }
  } catch {
    // Fall through to comma-separated env syntax.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveWorkerdServerAliasUrls(config: WorkerdGatewayBootstrapConfig): string[] {
  const port = config.getPort();
  if (!port) return [];
  const aliases = new Set<string>();
  if (config.configuredAliases) {
    for (const alias of parseGatewayAliases(config.configuredAliases)) aliases.add(alias);
  }
  aliases.add(`${config.protocol}://${config.externalHost}:${port}`);
  return [...aliases];
}

/**
 * One authority mediator for every host-originated direct DO call. Workspace
 * services are discovered from live declarations and their method effect is
 * resolved from the exact build bound to the object. Product-sealed services
 * use the same projection, with their reviewed topology as the sole static
 * input. Unknown workspace methods fail before crossing the receiver boundary.
 */
export function createHostDoAuthorityAttester(input: {
  manager: Pick<WorkerdManager, "resolveDoRpcMethodAuthority">;
  workspaceId: string;
  services: WorkspaceDeclarations["services"];
  callerId?: string;
}): (ref: DORef, method: string) => DirectAuthorityAttestation {
  return (ref, method) => {
    const caller = createHostCaller(input.callerId ?? "main", "server", {
      userId: "system",
      handle: "system",
    });
    const facts = {
      caller,
      source: ref.source,
      className: ref.className,
      objectKey: ref.objectKey,
      method,
      workspaceId: input.workspaceId,
      workspaceMember: true,
      sessionId: `host:${method}`,
    } as const;
    if (method.startsWith("__")) return attestDirectRpc(facts);

    const matches = [...input.services, ...PRODUCT_WORKSPACE_SERVICES].filter((service) => {
      const durableObject = service.durableObject;
      return (
        service.source === ref.source &&
        durableObject?.className === ref.className &&
        (!("objectKey" in durableObject) || durableObject.objectKey === ref.objectKey)
      );
    });
    if (matches.length > 1) {
      throw new Error(
        `Direct DO target ${ref.source}:${ref.className}:${ref.objectKey} has ambiguous workspace service authority`
      );
    }
    const service = matches[0];
    if (!service) return attestDirectRpc(facts);
    const methodAuthority = input.manager.resolveDoRpcMethodAuthority(
      ref.source,
      ref.className,
      ref.objectKey,
      method
    );
    if (!methodAuthority) {
      throw new Error(
        `Live workspace service ${ref.source}:${ref.className}.${method} has no exact build-catalog declaration`
      );
    }
    return attestWorkspaceDoRpc({
      ...facts,
      service: { name: service.name, principals: service.authority.principals },
      methodAuthority: {
        effect: methodAuthority.effect,
        tier: methodAuthority.access?.tier ?? "open",
      },
    });
  };
}

/**
 * Register the workerd process manager and its sole transport dependency.
 *
 * Downstream services depend on `doDispatch` or `workerdManager` through the
 * container graph; this seam owns only process startup, rebuild reconciliation,
 * route publication, attributed egress, and dispatch construction.
 */
export function wireWorkerdCore(deps: WorkerdBootstrapDeps): void {
  const egressCallers = new Map<string, VerifiedCaller>();

  deps.container.registerManaged({
    name: "workerdManager",
    // Workerd calls back into host RPC while activation work and lifecycle
    // release settle. Starting after RpcServer and stopping before it keeps
    // that return path available for the whole sandbox generation.
    dependencies: ["fsService", "rpcServer"],
    async start(resolve) {
      const { WorkerdManager } = await import("../workerdManager.js");
      const { getWorkerdProgramSources } = await import("../workerdProgramLoader.js");
      const fsService = assertPresent(resolve<FsService>("fsService"));
      const egressSecret = randomBytes(32).toString("hex");
      const manager: WorkerdManager = new WorkerdManager({
        tokenManager: deps.tokenManager,
        fsService,
        getServerUrl: () => {
          const port = deps.gateway.getPort();
          if (!port) throw new Error("Gateway port not finalized before workerd startup");
          return `http://127.0.0.1:${port}`;
        },
        getServerAliasUrls: () => resolveWorkerdServerAliasUrls(deps.gateway),
        workerdPrograms: getWorkerdProgramSources(),
        workspaceId: deps.workspaceId,
        workspacePath: deps.workspacePath,
        statePath: deps.statePath,
        routeRegistry: deps.routeRegistry,
        getProxyPort: (caller) => deps.egressProxy.startForCaller(caller),
        getSharedEgressPort: () => deps.egressProxy.startShared(egressSecret),
        registerEgressCaller: (callerId, caller) => egressCallers.set(callerId, caller),
        unregisterEgressCaller: (callerId) => egressCallers.delete(callerId),
        egressSecret,
        getWorkerdGatewayToken: () => deps.gatewayToken,
        recordLifecycleEvent: (event) => {
          deps.runtimeDiagnostics.record({
            workspaceId: deps.workspaceId,
            entityId: event.source,
            kind: "worker",
            level: event.level,
            message: event.message,
            source: "lifecycle",
            fields: { callerId: event.callerId, ...event.fields },
          });
          deps.eventService.emit("workspace:unit-log", {
            workspaceId: deps.workspaceId,
            unitName: event.source,
            kind: "worker",
            timestamp: Date.now(),
            level: event.level,
            message: event.message,
            source: "console",
          });
        },
      });
      deps.onManagerStarted(manager);
      deps.egressProxy.setCallerResolver((callerId) => egressCallers.get(callerId) ?? null);

      await manager.registerAllDOClasses([
        {
          source: SEMANTIC_CONTROL_PLANE.source,
          className: SEMANTIC_CONTROL_PLANE.className,
        },
      ]);

      return manager;
    },
    async stop(instance: WorkerdManager | null) {
      await instance?.shutdown();
    },
  });

  deps.container.registerManaged({
    name: "doDispatch",
    dependencies: ["workerdManager"],
    async start(resolve) {
      const { DODispatch } = await import("../doDispatch.js");
      const manager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const dispatch = new DODispatch();
      dispatch.setTokenManager(deps.tokenManager);
      dispatch.setGetWorkerdGatewayToken(() => deps.gatewayToken);
      dispatch.setGetWorkerdUrl(() => {
        const port = manager.getPort();
        if (!port) throw new Error("workerd not running");
        return `http://127.0.0.1:${port}`;
      });
      dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
      dispatch.setAuthorityAttester(
        createHostDoAuthorityAttester({
          manager,
          workspaceId: deps.workspaceId,
          services: deps.workspaceDeclarations.services,
        })
      );
      return dispatch;
    },
  });

  deps.container.registerManaged({
    name: "workerdWorkspace",
    dependencies: ["workerdManager", "buildSystem"],
    async start(resolve) {
      const manager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const buildSystem = assertPresent(resolve<BuildSystemV2>("buildSystem"));
      const provider: WorkerdWorkspaceProvider = {
        bindRuntimeImage: (unitPath, ref) => buildSystem.bindRuntimeImage(unitPath, ref),
        getBuildByKey: (key) => buildSystem.getBuildByKey(key),
        getManifestRoutes: (source) =>
          deps.workspaceDeclarations.routes.filter((route) => route.source === source),
        getManifestDoClasses: (source) => {
          const node = buildSystem
            .getGraph()
            .allNodes()
            .find((entry) => entry.kind === "worker" && entry.relativePath === source);
          return node?.manifest.durable?.classes ?? [];
        },
        singletonRegistry: deps.workspaceDeclarations.singletons,
        getInternalDoEnv: deps.getInternalDoEnv,
      };
      manager.bindWorkspaceProvider(provider);

      const { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } =
        await import("../internalDOs/internalDoLoader.js");
      const remainingInternalClasses = INTERNAL_DO_CLASSES.filter(
        (className) => className !== SEMANTIC_CONTROL_PLANE.className
      ).map((className) => ({ source: INTERNAL_DO_SOURCE, className }));
      await manager.registerAllDOClasses(remainingInternalClasses);

      buildSystem.onPushBuild((source, trigger, buildKey) => {
        const node = buildSystem
          .getGraph()
          .allNodes()
          .find((entry) => entry.relativePath === source);
        const classes = node?.kind === "worker" ? (node.manifest.durable?.classes ?? []) : null;
        void manager.onSourceRebuilt(source, classes, trigger, buildKey).catch((error: unknown) => {
          console.error(
            `[WorkerdManager] Failed to reconcile rebuilt source ${source} from ${trigger?.publicationId ?? "an unscoped build"}:`,
            error
          );
        });
      });

      for (const node of buildSystem.getGraph().allNodes()) {
        if (node.kind !== "worker" || !node.manifest.durable) continue;
        for (const cls of node.manifest.durable.classes) {
          deps.routeRegistry.registerDoRoutes(
            node.relativePath,
            cls.className,
            deps.workspaceDeclarations.routes.filter((route) => route.source === node.relativePath),
            deps.workspaceDeclarations.singletons
          );
        }
      }
      manager.reconcileManifestRoutes(
        buildSystem
          .getGraph()
          .allNodes()
          .filter((node) => node.kind === "worker")
          .map((node) => node.relativePath)
      );
      return manager;
    },
  });
}
