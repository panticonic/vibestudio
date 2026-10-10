import { workersMethods } from "@vibestudio/service-schemas/workers";
/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: launchable worker sources (including manifest entry + durable classes)
 * - listServices: manifest-declared workspace services available here
 * - resolveService: manifest-declared workspace services
 */

import type { PrincipalKind } from "@vibestudio/rpc";
import {
  selectedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import { workspaceServiceBindingTier } from "@vibestudio/workspace-contracts/types";
import { hasWorkspaceWorkerRoute } from "@vibestudio/workspace-contracts/workspaceRoutes";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import {
  findProductBuiltinService,
  PRODUCT_BUILTIN_CATALOG,
  productBuiltinByIdentity,
} from "@vibestudio/shared/productBuiltinCatalog.generated";
import { resolveWorkspaceService, type ResolvedWorkspaceService } from "../workspaceServices.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";

type ServiceListRow =
  | {
      origin: "product" | "workspace";
      name: string;
      title?: string;
      action?: string;
      description?: string;
      presentation: { domain: string; verb: string };
      protocols: string[];
      source: string;
      docsId?: string;
      kind: "durable-object";
      className: string;
      defaultObjectKey: string | null;
    }
  | {
      origin: "product" | "workspace";
      name: string;
      title?: string;
      action?: string;
      description?: string;
      presentation: { domain: string; verb: string };
      protocols: string[];
      source: string;
      docsId: string;
      kind: "worker";
      routePath: string;
    };

type ScopedDeclarations = {
  decls: WorkspaceDeclarations;
  scope: "main" | "context";
  contextId?: string;
  buildRef: string;
};

type ScopedDurableObject = ScopedDeclarations & {
  authority: Array<{
    capability: string;
    principals: readonly PrincipalKind[];
  }>;
};

/**
 * Internal (framework-owned) DO storage is host-managed and current-only. Its
 * reset/restore path is the manager-level journaled maintenance flow, never the
 * userland workers API.
 */
function assertUserlandStorageMaintenanceTarget(source: string): void {
  if (source === INTERNAL_DO_SOURCE) {
    throw new Error(
      `Storage maintenance for internal source "${source}" is host-managed and not exposed to userland callers`
    );
  }
}

export function createWorkerService(deps: {
  buildSystem: BuildSystemV2;
  workspaceDecls: WorkspaceDeclarations;
  workspaceId?: string;
  getCallerContextId?: (callerId: string) => string | null;
  loadContextDeclarations?: (contextId: string) => Promise<WorkspaceDeclarations | null>;
  /** Decide whether one exact exported receiver operation may be disclosed to
   * this foreign caller. This is a hard-policy read and must never acquire
   * authority or activate the receiver. */
  canDiscoverCrossWorkspaceMethod?: (
    ctx: ServiceContext,
    input: { target: string; operation: string }
  ) => boolean;
  /**
   * Begin immutable artifact preparation for a structurally resolved service.
   * This is cache work only: it must neither execute nor activate the provider.
   */
  prepareRuntimeImage?: (source: string, buildRef?: string) => void;
  // Resolution makes a declared target available; it does not create ownership.
  // The resolving subject remains the caller of its subsequent RPC unchanged.
  activateDurableObject?: (args: {
    source: string;
    className: string;
    objectKey: string;
    contextId?: string;
    contextPolicy?: "exact" | "initial";
    buildRef: string;
  }) => Promise<void>;
  resetDurableObjectStorage?: (
    target: { source: string; className: string; objectKey: string },
    intent: string
  ) => Promise<{ operationId: string }>;
  listDurableObjectStorageBackups?: (target: {
    source: string;
    className: string;
    objectKey: string;
  }) => Promise<Array<{ operationId: string; intent: string; createdAt: number }>>;
  restoreDurableObjectStorageBackup?: (
    target: { source: string; className: string; objectKey: string },
    operationId: string,
    intent: string
  ) => Promise<{ operationId: string }>;
}): ServiceDefinition & {
  resolveService(
    ctx: ServiceContext,
    query: string,
    objectKey?: string | null
  ): Promise<ResolvedWorkspaceService>;
} {
  const { buildSystem, workspaceDecls } = deps;
  const resolvedDurableObjectKey = (
    ctx: ServiceContext,
    source: string,
    className: string,
    requestedObjectKey: string,
    throughService = false
  ): string => {
    const builtin = productBuiltinByIdentity(source, className);
    if (builtin && !throughService) return requestedObjectKey;
    if (!builtin || builtin.durableObject.keyMode === "caller-supplied") {
      return requestedObjectKey;
    }
    if (!deps.workspaceId) {
      throw new Error("Workspace-scoped builtin resolution is unavailable without a workspace id");
    }
    if (builtin.durableObject.keyMode === "workspace-scoped") {
      if (requestedObjectKey && requestedObjectKey !== deps.workspaceId) {
        throw new Error(`Builtin service ${builtin.name} is scoped to the current workspace`);
      }
      return deps.workspaceId;
    }
    return browserEnvironmentIdentityFromContext(deps.workspaceId, ctx).environmentKey;
  };
  const methods = workersMethods;

  return {
    name: "workers",
    description: "Worker discovery and workspace service resolution",
    authority: { principals: ["user", "host", "code", "website"] },
    methods,
    authorityPreparation: {
      "workers.resolveService.workspace-service": async (ctx, [query, objectKey]) => {
        const scoped = await resolveWorkspaceServiceForCaller(
          ctx,
          String(query),
          objectKey == null ? null : String(objectKey)
        );
        await assertForeignServiceExported(ctx, scoped.service);
        const { service } = scoped;
        const buildRef = scoped.buildRef;
        deps.prepareRuntimeImage?.(service.source, buildRef);
        // A declared binding is reviewed wiring, not an authority-bearing
        // operation. Direct receiver admission already applies the exact same
        // distinction in attestWorkspaceDoRpc; resolution must not invent a
        // second, coarser consent gate in front of the method contract.
        if (
          workspaceServiceBindingTier(service.authority.binding, ctx.caller.code?.repoPath) ===
          "open"
        ) {
          return { selections: [], payload: null };
        }
        const capability = `workspace-service:${service.name}`;
        const serviceTitle = service.title?.trim() || humanizeServiceName(service.name);
        const resourceKey =
          service.kind === "durable-object" ? service.targetId : service.routeBasePath;
        return {
          selections: [
            selectedPreparedAuthoritySelection({
              capability,
              resourceKey,
              requirement: requirementForPrincipals(service.authority.principals, capability),
              challenge: {
                title: `Use ${serviceTitle}`,
                // The reviewed `action` is the provider's one user-facing
                // phrase — "manage panel titles, search, and launcher usage".
                // `description` is the developer summary of what the service
                // stores, which tells a person deciding this nothing about what
                // they are agreeing to. Read the action first and fall back
                // only when a provider declares none.
                description: serviceChallengeDescription(service, serviceTitle),
                deniedReason: `${serviceTitle} access was not approved`,
                dedupKey: `workspace-service:${service.name}:${resourceKey}`,
                resource: { type: "workspace-service", label: "Service", value: serviceTitle },
                operation: {
                  kind: "runtime",
                  verb: service.action,
                  object: { type: "workspace-service", label: "Service", value: serviceTitle },
                  groupKey: `workspace-service:${service.name}`,
                },
                authorityVocabulary: {
                  ...service.presentation,
                  declaredBy: service.source,
                },
                details: [
                  { label: "Provided by", value: service.source },
                  ...(service.protocols.length > 0
                    ? [{ label: "Works with", value: service.protocols.join(", ") }]
                    : []),
                ],
              },
            }),
          ],
          payload: null,
        };
      },
      "workers.resolveDurableObject.target": async (ctx, [source, className, objectKey]) => {
        const resolvedObjectKey = resolvedDurableObjectKey(
          ctx,
          String(source),
          String(className),
          String(objectKey)
        );
        const scoped = await resolveDurableObjectForCaller(ctx, String(source), String(className));
        const targetId = `do:${String(source)}:${String(className)}:${resolvedObjectKey}`;
        return {
          selections: scoped.authority.map(({ capability, principals }) =>
            selectedPreparedAuthoritySelection({
              capability,
              resourceKey: targetId,
              requirement: requirementForPrincipals(principals, capability),
            })
          ),
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("workers", methods, {
      listSources: async (ctx) => {
        const contextId = deps.getCallerContextId?.(ctx.caller.runtime.id);
        const units = await buildSystem.listBuildUnits(contextId ? `ctx:${contextId}` : undefined, [
          "worker",
        ]);
        return units.map((n) => ({
          name: n.unitName,
          source: n.unitPath,
          title: n.manifest.title,
          icon: n.manifest.icon,
          entry: n.manifest.entry,
          classes: n.manifest.durable?.classes ?? [],
          agent: n.manifest.agent,
        }));
      },
      listServices: async (ctx) => {
        const productRows: ServiceListRow[] = PRODUCT_BUILTIN_CATALOG.flatMap((entry) =>
          entry.kind === "service"
            ? [
                {
                  origin: "product" as const,
                  name: entry.name,
                  title: entry.title,
                  description: entry.description,
                  presentation: entry.presentation,
                  protocols: [...entry.protocols],
                  source: INTERNAL_DO_SOURCE,
                  kind: "durable-object" as const,
                  className: entry.className,
                  defaultObjectKey: null,
                },
              ]
            : []
        );
        const productQueries = new Set(productRows.flatMap((row) => [row.name, ...row.protocols]));
        const mainRows = listServiceRows(workspaceDecls).filter(
          (row) =>
            !productQueries.has(row.name) && !row.protocols.some((p) => productQueries.has(p))
        );
        const foreignCaller =
          ctx.caller.workspaceId !== undefined &&
          deps.workspaceId !== undefined &&
          ctx.caller.workspaceId !== deps.workspaceId;
        if (foreignCaller) {
          if (!deps.canDiscoverCrossWorkspaceMethod) return [];
          const providerCatalogs = new Map<
            string,
            Promise<import("../buildV2/index.js").ResolvedWorkspaceRpcCatalog>
          >();
          const disclosed = await Promise.all(
            mainRows.map(async (row): Promise<ServiceListRow | null> => {
              if (row.kind !== "durable-object") return null;
              try {
                const providerKey = `${row.source}\0${row.className}`;
                let providerCatalog = providerCatalogs.get(providerKey);
                if (!providerCatalog) {
                  providerCatalog = buildSystem.resolveWorkspaceRpcCatalog(
                    row.source,
                    row.className
                  );
                  providerCatalogs.set(providerKey, providerCatalog);
                }
                const catalog = await providerCatalog;
                const target = `workspace-service:${row.name}`;
                return catalog.methods.some(
                  (method) =>
                    method.access?.crossWorkspace === true &&
                    deps.canDiscoverCrossWorkspaceMethod!(ctx, {
                      target,
                      operation: method.name,
                    })
                )
                  ? row
                  : null;
              } catch {
                // Discovery is a filtered projection. Invalid, undisclosed, or
                // policy-denied providers reveal no row and no diagnostic.
                return null;
              }
            })
          );
          return disclosed.filter((row): row is ServiceListRow => row !== null);
        }
        const scopedContext = await declarationsForCallerContext(ctx);
        if (!scopedContext) return [...productRows, ...mainRows];
        const seen = new Set([...productQueries, ...serviceQueryKeys(workspaceDecls)]);
        return [
          ...productRows,
          ...mainRows,
          ...listServiceRows(scopedContext.decls).filter((row) => {
            if (seen.has(row.name)) return false;
            return !row.protocols.some((protocol) => seen.has(protocol));
          }),
        ];
      },
      resolveService: (ctx, [query, objectKey]) => resolveService(ctx, query, objectKey),
      resolveDurableObject: async (ctx, [source, className, objectKey]) => {
        const resolvedObjectKey = resolvedDurableObjectKey(ctx, source, className, objectKey);
        const scoped = await resolveDurableObjectForCaller(ctx, source, className);
        const targetId = `do:${source}:${className}:${resolvedObjectKey}`;
        const contextId = scoped.contextId;
        const buildRef = scoped.buildRef;
        await deps.activateDurableObject?.({
          source,
          className,
          objectKey: resolvedObjectKey,
          ...(contextId ? { contextId } : {}),
          buildRef,
        });
        return {
          kind: "durable-object",
          source,
          className,
          objectKey: resolvedObjectKey,
          targetId,
        };
      },
      resetStorage: async (ctx, [target, intent]) => {
        assertUserlandStorageMaintenanceTarget(target.source);
        await resolveDurableObjectForCaller(ctx, target.source, target.className);
        const objectKey = resolvedDurableObjectKey(
          ctx,
          target.source,
          target.className,
          target.objectKey
        );
        if (!deps.resetDurableObjectStorage) {
          throw new Error("Durable Object storage maintenance is unavailable");
        }
        return await deps.resetDurableObjectStorage(
          { source: target.source, className: target.className, objectKey },
          intent
        );
      },
      listStorageBackups: async (ctx, [target]) => {
        assertUserlandStorageMaintenanceTarget(target.source);
        await resolveDurableObjectForCaller(ctx, target.source, target.className);
        const objectKey = resolvedDurableObjectKey(
          ctx,
          target.source,
          target.className,
          target.objectKey
        );
        if (!deps.listDurableObjectStorageBackups) {
          throw new Error("Durable Object storage backup discovery is unavailable");
        }
        return await deps.listDurableObjectStorageBackups({
          source: target.source,
          className: target.className,
          objectKey,
        });
      },
      restoreStorageBackup: async (ctx, [target, operationId, intent]) => {
        assertUserlandStorageMaintenanceTarget(target.source);
        await resolveDurableObjectForCaller(ctx, target.source, target.className);
        const objectKey = resolvedDurableObjectKey(
          ctx,
          target.source,
          target.className,
          target.objectKey
        );
        if (!deps.restoreDurableObjectStorageBackup) {
          throw new Error("Durable Object storage restore is unavailable");
        }
        return await deps.restoreDurableObjectStorageBackup(
          { source: target.source, className: target.className, objectKey },
          operationId,
          intent
        );
      },
    }),
    resolveService,
  };

  async function resolveService(
    ctx: ServiceContext,
    query: string,
    objectKey?: string | null
  ): Promise<ResolvedWorkspaceService> {
    const scoped = await resolveWorkspaceServiceForCaller(ctx, query, objectKey);
    await assertForeignServiceExported(ctx, scoped.service);
    const service = scoped.service;
    if (service.kind === "durable-object") {
      const creatorContextId =
        service.context === "creator"
          ? deps.getCallerContextId?.(ctx.caller.runtime.id)
          : undefined;
      if (service.context === "creator" && !creatorContextId) {
        throw new Error(`Workspace service ${service.name} requires a creator runtime context`);
      }
      const contextId = creatorContextId ?? scoped.contextId;
      await deps.activateDurableObject?.({
        source: service.source,
        className: service.className,
        objectKey: service.objectKey,
        ...(contextId ? { contextId } : {}),
        ...(service.context === "creator" ? { contextPolicy: "initial" as const } : {}),
        buildRef: scoped.buildRef,
      });
    }
    return service;
  }

  async function declarationsForCallerContext(
    ctx: ServiceContext
  ): Promise<ScopedDeclarations | null> {
    const contextId = deps.getCallerContextId?.(ctx.caller.runtime.id);
    if (!contextId) return null;
    const decls = (await deps.loadContextDeclarations?.(contextId)) ?? null;
    if (!decls) return null;
    return {
      decls,
      scope: "context",
      contextId,
      buildRef: `ctx:${contextId}`,
    };
  }

  async function resolveWorkspaceServiceForCaller(
    ctx: ServiceContext,
    query: string,
    objectKey: string | null | undefined
  ): Promise<ScopedDeclarations & { service: ResolvedWorkspaceService }> {
    try {
      return {
        service: resolveWorkspaceService(workspaceDecls, query, objectKey),
        decls: workspaceDecls,
        scope: "main",
        buildRef: "main",
      };
    } catch (err) {
      if (!isMissingServiceError(err, query)) throw err;
    }
    const builtin = findProductBuiltinService(query);
    if (builtin) {
      const requestedObjectKey = objectKey ?? "";
      const resolvedObjectKey = resolvedDurableObjectKey(
        ctx,
        INTERNAL_DO_SOURCE,
        builtin.className,
        requestedObjectKey,
        true
      );
      return {
        decls: workspaceDecls,
        scope: "main",
        buildRef: "main",
        service: {
          kind: "durable-object",
          origin: "product",
          name: builtin.name,
          title: builtin.title,
          action: builtin.action,
          description: builtin.description,
          presentation: builtin.presentation,
          ...((builtin.protocols as readonly string[]).includes(query) ? { protocol: query } : {}),
          protocols: [...builtin.protocols],
          source: INTERNAL_DO_SOURCE,
          authority: { principals: [...builtin.principals] },
          className: builtin.className,
          objectKey: resolvedObjectKey,
          targetId: `do:${INTERNAL_DO_SOURCE}:${builtin.className}:${resolvedObjectKey}`,
        } as ResolvedWorkspaceService,
      };
    }
    const scoped = await declarationsForCallerContext(ctx);
    if (!scoped) throw new Error(`No workspace service registered for ${query}`);
    const service = resolveWorkspaceService(scoped.decls, query, objectKey);
    if (
      service.kind === "worker" &&
      !hasWorkspaceWorkerRoute(workspaceDecls.routes, service.source, service.routePath)
    ) {
      throw new Error(
        `Workspace HTTP service ${service.name} has no published canonical worker route. ` +
          `HTTP services address published canonical workers, not task-context worker versions. ` +
          `Private context-local services use Durable Objects; a context-local HTTP alias may reference an existing published route.`
      );
    }
    return {
      ...scoped,
      ...(service.kind === "worker" ? { buildRef: "main" } : {}),
      service,
    };
  }

  async function assertForeignServiceExported(
    ctx: ServiceContext,
    service: ResolvedWorkspaceService
  ): Promise<void> {
    if (
      ctx.caller.workspaceId === undefined ||
      deps.workspaceId === undefined ||
      ctx.caller.workspaceId === deps.workspaceId
    ) {
      return;
    }
    const deny = () => {
      throw Object.assign(new Error("Cross-workspace RPC is not permitted"), { code: "EACCES" });
    };
    if (service.origin !== "workspace" || service.kind !== "durable-object") return deny();
    try {
      const catalog = await buildSystem.resolveWorkspaceRpcCatalog(
        service.source,
        service.className
      );
      if (!catalog.methods.some((method) => method.access?.crossWorkspace === true)) deny();
    } catch (error) {
      if ((error as { code?: unknown }).code === "EACCES") throw error;
      deny();
    }
  }

  async function resolveDurableObjectForCaller(
    ctx: ServiceContext,
    source: string,
    className: string
  ): Promise<ScopedDurableObject> {
    if (source === INTERNAL_DO_SOURCE) {
      throw new Error(missingDurableObjectMessage(source, className));
    }

    try {
      assertDurableObjectExists(buildSystem, source, className);
      return {
        decls: workspaceDecls,
        scope: "main",
        buildRef: "main",
        authority: durableObjectAuthority(workspaceDecls, source, className),
      };
    } catch (err) {
      if (!isMissingDurableObjectError(err, source, className)) throw err;
    }

    const scoped = await declarationsForCallerContext(ctx);
    if (!scoped) throw new Error(missingDurableObjectMessage(source, className));
    const contextUnits = await buildSystem.listBuildUnits(scoped.buildRef, ["worker"]);
    const worker = contextUnits.find((unit) => unit.unitPath === source);
    if (!worker?.manifest.durable?.classes?.some((entry) => entry.className === className)) {
      throw new Error(missingDurableObjectMessage(source, className));
    }
    return {
      ...scoped,
      authority: durableObjectAuthority(scoped.decls, source, className),
    };
  }
}

/**
 * The sentence a person reads before granting a workspace service.
 *
 * Providers declare both an `action` written for the person deciding and a
 * `description` written for whoever maintains the service. Only the first
 * belongs on an approval.
 */
function serviceChallengeDescription(
  service: { action?: string | undefined; description?: string | undefined },
  serviceTitle: string
): string {
  const action = service.action?.trim();
  if (action) {
    return `${action[0]!.toUpperCase()}${action.slice(1)}${/[.!?]$/u.test(action) ? "" : "."}`;
  }
  return (
    service.description?.trim() || `Use the ${serviceTitle} service provided by this workspace.`
  );
}

function humanizeServiceName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[._:/#-]+/gu, " ")
    .trim()
    .replace(/^./u, (character) => character.toUpperCase());
}

function isMissingServiceError(err: unknown, query: string): boolean {
  return err instanceof Error && err.message === `No workspace service registered for ${query}`;
}

function missingDurableObjectMessage(source: string, className: string): string {
  return `No Durable Object class registered for ${source}:${className}`;
}

function isMissingDurableObjectError(err: unknown, source: string, className: string): boolean {
  return err instanceof Error && err.message === missingDurableObjectMessage(source, className);
}

function serviceQueryKeys(decls: WorkspaceDeclarations): Set<string> {
  const keys = new Set<string>();
  for (const service of decls.services) {
    keys.add(service.name);
    for (const protocol of service.protocols ?? []) keys.add(protocol);
  }
  return keys;
}

function durableObjectAuthority(
  decls: WorkspaceDeclarations,
  source: string,
  className: string
): ScopedDurableObject["authority"] {
  return decls.services
    .filter(
      (service) => service.source === source && service.durableObject?.className === className
    )
    .map((service) => ({
      capability: `workspace-service:${service.name}`,
      principals: service.authority.principals,
    }));
}

function listServiceRows(decls: WorkspaceDeclarations): ServiceListRow[] {
  return decls.services.map((service) => {
    const base = {
      origin: "workspace" as const,
      name: service.name,
      title: service.title,
      action: service.action,
      description: service.description,
      presentation: { ...service.presentation },
      protocols: [...(service.protocols ?? [])],
      source: service.source,
      docsId: `workspace:${service.name}`,
    };
    if (service.durableObject) {
      const singleton = decls.singletons.find(service.source, service.durableObject.className);
      return {
        ...base,
        kind: "durable-object" as const,
        className: service.durableObject.className,
        defaultObjectKey: singleton ? singleton.key : null,
      };
    }
    return {
      ...base,
      kind: "worker" as const,
      routePath: service.worker.routePath,
    };
  });
}

function assertDurableObjectExists(
  buildSystem: BuildSystemV2,
  source: string,
  className: string
): void {
  const worker = buildSystem
    .getGraph()
    .allNodes()
    .find((node) => node.kind === "worker" && node.relativePath === source);
  const classes = worker?.manifest.durable?.classes ?? [];
  if (classes.some((entry) => entry.className === className)) {
    return;
  }

  throw new Error(missingDurableObjectMessage(source, className));
}
