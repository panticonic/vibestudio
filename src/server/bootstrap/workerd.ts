import type { EventService } from "@vibestudio/shared/eventsService";
import type { FsService } from "@vibestudio/shared/fsService";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import { randomBytes } from "node:crypto";
import { assertPresent } from "../../lintHelpers";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { EgressProxy } from "../services/egressProxy.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import type { RouteRegistry } from "../routeRegistry.js";
import type { WorkerdManager } from "../workerdManager.js";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import { attestDirectRpc } from "../services/authorityRuntime.js";

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
  entityCache: Pick<EntityCache, "resolveActive">;
  egressProxy: Pick<EgressProxy, "startForCaller" | "startShared" | "setCallerResolver">;
  gatewayToken: string;
  gateway: WorkerdGatewayBootstrapConfig;
  getProductDoEnv(source: string, className: string): Record<string, string>;
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
    dependencies: ["buildSystem", "fsService"],
    async start(resolve) {
      const { WorkerdManager } = await import("../workerdManager.js");
      const { getWorkerdProgramSources } = await import("../workerdProgramLoader.js");
      const {
        PRODUCT_SEED_DOS,
        WORKSPACE_DO_CLASS,
        WORKSPACE_DO_SOURCE,
        getProductExecutionArtifact,
        getProductBootManifest,
        productSeedHostCapabilities,
        resolveProductSeedArtifact,
      } = await import("../internalDOs/productBootManifest.js");
      const buildSystem = assertPresent(resolve<BuildSystemV2>("buildSystem"));
      const fsService = assertPresent(resolve<FsService>("fsService"));
      const egressSecret = randomBytes(32).toString("hex");
      const manager: WorkerdManager = new WorkerdManager({
        hostPrincipal: getProductBootManifest().hostPrincipal,
        tokenManager: deps.tokenManager,
        fsService,
        getServerUrl: () => {
          const port = deps.gateway.getPort();
          if (!port) throw new Error("Gateway port not finalized before workerd startup");
          return `http://127.0.0.1:${port}`;
        },
        getServerAliasUrls: () => resolveWorkerdServerAliasUrls(deps.gateway),
        resolveExecutionArtifact: (unitPath, ref) => {
          const productSeed = resolveProductSeedArtifact(unitPath);
          if (productSeed) {
            if (ref !== undefined) {
              throw new Error(`Exact product seed ${unitPath} does not accept a moving ref`);
            }
            return Promise.resolve(productSeed);
          }
          return buildSystem.resolveExecutionArtifact(unitPath, ref);
        },
        getExecutionArtifact: (executionDigest) =>
          getProductExecutionArtifact(executionDigest) ??
          buildSystem.getExecutionArtifact(executionDigest),
        workerdPrograms: getWorkerdProgramSources(),
        workspacePath: deps.workspacePath,
        statePath: deps.statePath,
        routeRegistry: deps.routeRegistry,
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
        getProxyPort: (caller) => deps.egressProxy.startForCaller(caller),
        getSharedEgressPort: () => deps.egressProxy.startShared(egressSecret),
        registerEgressCaller: (callerId, caller) => egressCallers.set(callerId, caller),
        unregisterEgressCaller: (callerId) => egressCallers.delete(callerId),
        egressSecret,
        getWorkerdGatewayToken: () => deps.gatewayToken,
        getProductDoEnv: deps.getProductDoEnv,
        getProductDoCapabilities: (source, className) =>
          productSeedHostCapabilities(source, className),
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

      // An explicit empty class list reconciles manifest removals instead of
      // leaving stale DO services bound after a rebuild.
      buildSystem.onPushBuild((source, trigger) => {
        const head = trigger?.head ?? "main";
        if (head !== "main") {
          manager.onSourceRebuilt(source, null, trigger).catch((error: unknown) => {
            console.error(
              `[WorkerdManager] Failed to handle rebuilt source ${source}@${head}:`,
              error
            );
          });
          return;
        }

        const node = buildSystem
          .getGraph()
          .allNodes()
          .find((entry) => entry.relativePath === source);
        const manifest = node?.manifest as Record<string, unknown> | undefined;
        const durable = manifest?.["durable"] as
          | { classes?: Array<{ className: string }> }
          | undefined;
        manager.onSourceRebuilt(source, durable?.classes ?? [], trigger).catch((error: unknown) => {
          console.error(`[WorkerdManager] Failed to handle rebuilt source ${source}:`, error);
        });
      });

      const productDos = [
        { source: WORKSPACE_DO_SOURCE, className: WORKSPACE_DO_CLASS },
        ...PRODUCT_SEED_DOS.map(({ source, className }) => ({ source, className })),
      ];
      console.log(
        "[WorkerdManager] Verifying bootstrap and exact product-seed DO artifacts:",
        productDos.map((entry) => `${entry.source}:${entry.className}`).join(", ")
      );
      await manager.registerAllDOClasses(productDos);

      if (deps.workspaceDeclarations.routes.some((route) => route.durableObject)) {
        for (const node of buildSystem.getGraph().allNodes()) {
          if (node.kind !== "worker" || !node.manifest.durable) continue;
          for (const cls of node.manifest.durable.classes) {
            try {
              const sourceRoutes = deps.workspaceDeclarations.routes.filter(
                (route) => route.source === node.relativePath
              );
              deps.routeRegistry.registerDoRoutes(
                node.relativePath,
                cls.className,
                sourceRoutes,
                deps.workspaceDeclarations.singletons
              );
            } catch (error) {
              console.warn(
                `[WorkerdManager] Failed to register DO routes for ${node.relativePath}:${cls.className}:`,
                error instanceof Error ? error.message : error
              );
            }
          }
        }
      }

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
      dispatch.setAuthorityAttester((ref, method) =>
        attestDirectRpc({
          caller: createHostCaller("main", "server", {
            userId: "system",
            handle: "system",
          }),
          source: ref.source,
          className: ref.className,
          objectKey: ref.objectKey,
          method,
          workspaceId: deps.workspaceId,
          workspaceMember: true,
          sessionId: `host:${method}`,
        })
      );
      dispatch.setEnsureDO((source, className, objectKey) => {
        const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
        const record = deps.entityCache.resolveActive(targetId);
        return manager.ensureDO(source, className, objectKey, {
          contextId: record?.contextId,
        });
      });
      return dispatch;
    },
  });
}
