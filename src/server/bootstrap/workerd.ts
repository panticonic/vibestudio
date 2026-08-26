import type { EventService } from "@vibestudio/shared/eventsService";
import type { FsService } from "../services/fsService.js";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { createHostCaller, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import type { UserSubject } from "@vibestudio/identity/types";
import { randomBytes } from "node:crypto";
import { assertPresent } from "../../lintHelpers";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { EgressProxy } from "../services/egressProxy.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import type { RouteRegistry } from "../routeRegistry.js";
import { attestDirectRpc, attestWorkspaceDoRpc } from "../services/authorityRuntime.js";
import type { WorkerdManager, WorkerdWorkspaceProvider } from "../workerdManager.js";
import type { DORef } from "../workerdRpcRelay.js";
import type { RpcServer } from "../rpcServer.js";
import type { ExecutionPublicationPort } from "@vibestudio/shared/execution/retention";
import { isHostIntrinsicDirectMethod } from "@vibestudio/shared/authority/hostIntrinsicDirectMethods";
import { WorkspaceRpcMethodUndeclaredError } from "../workspaceRpcCatalogMismatch.js";

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
  executionPublicationPort?: ExecutionPublicationPort;
  userlandResourceHandles: Pick<
    import("../services/userlandResourceHandleStore.js").UserlandResourceHandleStore,
    | "issueFromPreparation"
    | "resolve"
    | "reconcileProviders"
    | "reconcileProviderDefinitions"
    | "reconcileReceiverClasses"
  >;
  /** Validate the sealed checkout before semantic initialization can begin. */
  assertBootstrapSnapshotUnchanged(): Promise<void>;
  /**
   * Join a registered image identity to its current host-owned execution
   * session and context policy. Egress is long-lived, so these facts must be
   * resolved when a request arrives rather than captured at image startup.
   */
  resolveEgressCaller(caller: VerifiedCaller): VerifiedCaller | null;
  /** Restore the exact active entity incarnation before any userland DO call. */
  ensureUserlandDoReady(ref: DORef): Promise<void>;
  onManagerStarted(manager: WorkerdManager): void;
  /** Sole owner of source-build publication into durable and derived runtime state. */
  publishSourceBuild(
    manager: WorkerdManager,
    source: string,
    doClasses: Array<{ className: string }> | null,
    trigger: import("../buildV2/index.js").ProtectedPublicationEvent | undefined,
    buildKey: string | undefined
  ): Promise<void>;
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
 * resolved from the exact build bound to the object. Unknown workspace methods
 * fail before crossing the receiver boundary.
 */
export function createHostDoAuthorityAttester(input: {
  manager: Pick<WorkerdManager, "resolveDoRpcMethodAuthority" | "describeDoRpcCatalog">;
  workspaceId: string;
  services: WorkspaceDeclarations["services"];
  callerId?: string;
  callerSubject?: UserSubject;
  resourceHandles?: Pick<
    import("../services/userlandResourceHandleStore.js").UserlandResourceHandleStore,
    "resolve"
  >;
}): (ref: DORef, method: string, args: readonly unknown[]) => DirectAuthorityAttestation {
  return (ref, method, args) => {
    const caller = createHostCaller(
      input.callerId ?? "main",
      "server",
      input.callerSubject ?? {
        userId: "system",
        handle: "system",
      }
    );
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

    const matches = input.services.filter((service) => {
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
    const methodAuthority: ReturnType<WorkerdManager["resolveDoRpcMethodAuthority"]> =
      isHostIntrinsicDirectMethod(method)
        ? {
            effect: { kind: "open" } as const,
            access: { tier: "open" as const, sensitivity: "read" as const },
            providerExecutionDigest: "-",
          }
        : input.manager.resolveDoRpcMethodAuthority(
            ref.source,
            ref.className,
            ref.objectKey,
            method
          );
    if (!methodAuthority) {
      const catalog = input.manager.describeDoRpcCatalog(ref.source, ref.className, ref.objectKey);
      throw new WorkspaceRpcMethodUndeclaredError({
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
        method,
        serviceName: service.name,
        ...catalog,
      });
    }
    const receiver = methodAuthority.userlandCapability;
    const resolvedHandle =
      methodAuthority.effect.kind === "userland-capability" &&
      methodAuthority.effect.resource.kind === "opaque-handle" &&
      receiver &&
      input.resourceHandles
        ? input.resourceHandles.resolve(
            String(args[methodAuthority.effect.resource.argument] ?? ""),
            {
              workspaceId: input.workspaceId,
              capability: receiver.canonicalCapability,
              capabilityDefinitionDigest: receiver.definitionDigest,
              provider: ref.source,
              receiverSource: ref.source,
              receiverClass: ref.className,
              receiverObjectKey: ref.objectKey,
              resourceType: receiver.resourceType,
            }
          )
        : undefined;
    const attestation = attestWorkspaceDoRpc({
      ...facts,
      ...(resolvedHandle ? { resourceKey: resolvedHandle.resourceKey } : {}),
      service: { name: service.name, principals: service.authority.principals },
      methodAuthority: {
        effect: methodAuthority.effect,
        ...(receiver ? { capability: receiver.canonicalCapability } : {}),
        tier: methodAuthority.access?.tier ?? "open",
      },
      ...(receiver
        ? {
            receiverAuthority: {
              capabilityDefinitionDigest: receiver.definitionDigest,
              resourceType: receiver.resourceType,
              provider: ref.source,
              providerExecutionDigest: methodAuthority.providerExecutionDigest,
            },
          }
        : {}),
    });
    return {
      ...attestation,
      ...(resolvedHandle
        ? {
            resourceHandle: resolvedHandle.handle,
            resourceSelector: resolvedHandle.selector,
          }
        : {}),
      ...(methodAuthority.producesHandle
        ? {
            handleProduction: {
              capability: methodAuthority.producesHandle.canonicalCapability,
              capabilityDefinitionDigest: methodAuthority.producesHandle.definitionDigest,
              resourceType: methodAuthority.producesHandle.resourceType,
              provider: ref.source,
            },
          }
        : {}),
    };
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
    // that return path available for the whole sandbox generation. The general
    // runtime owns only host-provided programs; workspace source is attached by
    // workerdBootstrapWorkspace once its exact build provider is ready.
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
        getInternalDoEnv: deps.getInternalDoEnv,
        executionPublicationPort: deps.executionPublicationPort,
        routeRegistry: deps.routeRegistry,
        getProxyPort: (caller) => deps.egressProxy.startForCaller(caller),
        getSharedEgressPort: () => deps.egressProxy.startShared(egressSecret),
        registerEgressCaller: (callerId, caller) => egressCallers.set(callerId, caller),
        unregisterEgressCaller: (callerId) => egressCallers.delete(callerId),
        egressSecret,
        getWorkerdGatewayToken: () => deps.gatewayToken,
        resourceHandleLifecycle: {
          reconcileProviderDefinitions: (provider, activeDefinitionDigests) => {
            deps.userlandResourceHandles.reconcileProviderDefinitions(
              deps.workspaceId,
              provider,
              activeDefinitionDigests,
              "capability definitions reconciled"
            );
          },
          reconcileReceiverClasses: (receiverSource, activeClassNames) => {
            deps.userlandResourceHandles.reconcileReceiverClasses(
              deps.workspaceId,
              receiverSource,
              activeClassNames,
              "receiver classes reconciled"
            );
          },
        },
        recordLifecycleEvent: (event) => {
          deps.runtimeDiagnostics.record({
            workspaceId: deps.workspaceId,
            entityId: event.entityId ?? event.source,
            kind: event.kind ?? "worker",
            level: event.level,
            message: event.message,
            source: "lifecycle",
            fields: { callerId: event.callerId, ...event.fields },
          });
          deps.eventService.emit("workspace:unit-log", {
            workspaceId: deps.workspaceId,
            unitName: event.source,
            kind: event.kind === "do" ? "worker" : (event.kind ?? "worker"),
            timestamp: Date.now(),
            level: event.level,
            message: event.message,
            source: "console",
          });
        },
      });
      deps.onManagerStarted(manager);
      deps.egressProxy.setCallerResolver((callerId) => {
        const registered = egressCallers.get(callerId);
        return registered ? deps.resolveEgressCaller(registered) : null;
      });

      const { INTERNAL_DO_SOURCE } = await import("../internalDOs/internalDoLoader.js");
      const { PRODUCT_BUILTIN_CATALOG } =
        await import("@vibestudio/shared/productBuiltinCatalog.generated");
      await manager.registerAllDOClasses(
        PRODUCT_BUILTIN_CATALOG.filter((entry) => entry.workerd.bootstrapPhase === "first").map(
          (entry) => ({ source: INTERNAL_DO_SOURCE, className: entry.className })
        )
      );
      return manager;
    },
    async stop(instance: WorkerdManager | null) {
      await instance?.shutdown();
    },
  });

  deps.container.registerManaged({
    name: "workerdBootstrapWorkspace",
    dependencies: ["workerdManager", "bootstrapBuildSystem"],
    async start(resolve) {
      const manager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const bootstrapBuildSystem = assertPresent(resolve<BuildSystemV2>("bootstrapBuildSystem"));
      manager.bindWorkspaceProvider({
        bindRuntimeImage: (unitPath, ref) => bootstrapBuildSystem.bindRuntimeImage(unitPath, ref),
        getBuildByKey: (key) => bootstrapBuildSystem.getBuildByKey(key),
        getBuildByExecution: (key, executionDigest) =>
          bootstrapBuildSystem.getBuildByExecution(key, executionDigest),
        getManifestRoutes: (source) =>
          deps.workspaceDeclarations.routes.filter((route) => route.source === source),
        getManifestDoClasses: (source) => {
          const node = bootstrapBuildSystem
            .getGraph()
            .allNodes()
            .find((entry) => entry.kind === "worker" && entry.relativePath === source);
          return node?.manifest.durable?.classes ?? [];
        },
        singletonRegistry: deps.workspaceDeclarations.singletons,
      });
      await deps.assertBootstrapSnapshotUnchanged();
      return manager;
    },
  });

  deps.container.registerManaged({
    name: "doDispatch",
    // Workspace dispatch becomes visible only after the exact bootstrap
    // provider is attached. The workerd process itself is already free to boot
    // and host internal programs while that provider is being prepared.
    dependencies: ["workerdManager", "rpcServer", "workerdBootstrapWorkspace"],
    async start(resolve) {
      const { DODispatch } = await import("../doDispatch.js");
      const manager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const rpcServer = assertPresent(resolve<{ server: RpcServer }>("rpcServer")).server;
      const dispatch = new DODispatch(deps.ensureUserlandDoReady);
      dispatch.setTokenManager(deps.tokenManager);
      dispatch.setGetWorkerdGatewayToken(() => deps.gatewayToken);
      dispatch.setGetWorkerdUrl(() => {
        const port = manager.getPort();
        if (!port) throw new Error("workerd not running");
        return `http://127.0.0.1:${port}`;
      });
      dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
      // Typed runtime_restarting failures while a generation transition is in
      // flight, instead of the generic "workerd not running" throw above.
      dispatch.setRuntimeRestartingProbe(() => manager.isGenerationTransitionInFlight());
      dispatch.setAuthorityAttester(
        createHostDoAuthorityAttester({
          manager,
          workspaceId: deps.workspaceId,
          services: deps.workspaceDeclarations.services,
          resourceHandles: deps.userlandResourceHandles,
        })
      );
      dispatch.setAuthorityResultTransform((ref, authorization, result) => {
        const production = authorization.handleProduction;
        if (!production) return result;
        return deps.userlandResourceHandles.issueFromPreparation(
          {
            workspaceId: deps.workspaceId,
            capability: production.capability,
            capabilityDefinitionDigest: production.capabilityDefinitionDigest,
            provider: production.provider,
            receiverSource: ref.source,
            receiverClass: ref.className,
            receiverObjectKey: ref.objectKey,
            resourceType: production.resourceType,
          },
          result
        );
      });
      dispatch.setAuthorityParentRunner((receiverRuntimeId, authorization, invoke) =>
        rpcServer.withAuthorityParent(receiverRuntimeId, authorization, invoke)
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
        getBuildByExecution: (key, executionDigest) =>
          buildSystem.getBuildByExecution(key, executionDigest),
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
      };
      manager.replaceWorkspaceProvider(provider);

      const graphNodes = buildSystem.getGraph().allNodes();
      deps.userlandResourceHandles.reconcileProviders(
        deps.workspaceId,
        graphNodes.map((node) => node.relativePath),
        "workspace providers reconciled"
      );
      for (const node of graphNodes) {
        if (node.kind !== "worker") continue;
        deps.userlandResourceHandles.reconcileReceiverClasses(
          deps.workspaceId,
          node.relativePath,
          (node.manifest.durable?.classes ?? []).map(({ className }) => className),
          "receiver classes reconciled"
        );
      }

      const { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } =
        await import("../internalDOs/internalDoLoader.js");
      await manager.registerAllDOClasses(
        INTERNAL_DO_CLASSES.map((className) => ({ source: INTERNAL_DO_SOURCE, className }))
      );

      const sourceBuildChains = new Map<string, Promise<void>>();
      buildSystem.onPushBuild((source, trigger, buildKey) => {
        const node = buildSystem
          .getGraph()
          .allNodes()
          .find((entry) => entry.relativePath === source);
        const classes = node?.kind === "worker" ? (node.manifest.durable?.classes ?? []) : null;
        const previous = sourceBuildChains.get(source) ?? Promise.resolve();
        // One failed publication must not permanently poison reconciliation
        // for every later build of the same source.
        const next = previous
          .catch(() => undefined)
          .then(async () => {
            await deps.publishSourceBuild(manager, source, classes, trigger, buildKey);
          });
        sourceBuildChains.set(source, next);
        void next
          .catch((error: unknown) => {
            console.error(
              `[WorkerdManager] Failed to reconcile rebuilt source ${source} from ${trigger?.publicationId ?? "an unscoped build"}:`,
              error
            );
          })
          .finally(() => {
            if (sourceBuildChains.get(source) === next) sourceBuildChains.delete(source);
          });
      });

      for (const node of graphNodes) {
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
        graphNodes.filter((node) => node.kind === "worker").map((node) => node.relativePath)
      );
      return manager;
    },
  });
}
