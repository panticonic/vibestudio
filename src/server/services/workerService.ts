/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: launchable worker sources (including manifest entry + durable classes)
 * - listServices: manifest-declared workspace services available here
 * - resolveService: manifest-declared workspace services
 */

import { z } from "zod";
import type { PrincipalKind } from "@vibestudio/rpc";
import {
  selectedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { selectedPreparedAuthorityRequirement } from "@vibestudio/shared/typedServiceClient";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
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
  buildRef?: string;
};

type ScopedDurableObject = ScopedDeclarations & {
  authority: Array<{
    capability: string;
    principals: readonly PrincipalKind[];
  }>;
};

const WorkerSourceSchema = z
  .object({
    name: z.string().describe("Workspace package name."),
    source: z.string().describe('Workspace-relative worker source, e.g. "workers/my-worker".'),
    title: z.string().optional().describe("Human-readable worker title, when declared."),
    icon: z.string().optional().describe("Semantic unit icon declared by the worker manifest."),
    entry: z
      .string()
      .optional()
      .describe('Manifest entry point relative to the source directory, e.g. "worker.tsx".'),
    classes: z
      .array(z.object({ className: z.string() }).passthrough())
      .describe("Declared Durable Object classes; empty for a regular worker."),
    agent: z.unknown().optional().describe("Chat-agent manifest metadata, when declared."),
  })
  .strict();

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
  // Resolution makes a declared target available; it does not create ownership.
  // The resolving subject remains the caller of its subsequent RPC unchanged.
  activateDurableObject?: (args: {
    source: string;
    className: string;
    objectKey: string;
    contextId?: string;
    contextPolicy?: "exact" | "initial";
    buildRef?: string;
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
  assertUserlandServiceExposure?: (
    ctx: ServiceContext,
    input: { name: string; provider: string; providerEv: string }
  ) => void | Promise<void>;
}): ServiceDefinition {
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
  const dynamicWorkspaceServiceLeaf = {
    capabilityPrefix: "workspace-service:",
    tier: "gated" as const,
    requirement: selectedPreparedAuthorityRequirement([
      "host",
      "user",
      "code",
      "session",
      "mission",
    ]),
  };
  const preparedResolutionAuthority = (method: "resolveService" | "resolveDurableObject") => {
    const capability = `service:workers.${method}`;
    return {
      // Resolution is a prerequisite for invoking a declared workspace
      // service. Entity-bound agents/DOs must be able to reach this preparer;
      // the selected service leaf below still enforces whether that exact
      // service admits the entity principal.
      requirement: requirementForPrincipals(["user", "host", "code"], capability),
      resource: { kind: "literal" as const, key: capability },
      prepared: {
        resolver:
          method === "resolveService"
            ? "workers.resolveService.workspace-service"
            : "workers.resolveDurableObject.target",
        leaves: [dynamicWorkspaceServiceLeaf],
      },
    };
  };
  const ExactDurableObjectTargetSchema = z
    .object({
      source: z.string().min(1),
      className: z.string().min(1),
      objectKey: z.string().min(1),
      targetId: z.string().optional(),
    })
    .passthrough()
    .superRefine((target, ctx) => {
      if (
        target.targetId !== undefined &&
        target.targetId !== `do:${target.source}:${target.className}:${target.objectKey}`
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "targetId does not match the exact source/class/objectKey target",
        });
      }
    });
  const storageMaintenancePolicy = {
    capability: "workers.storage.reset",
    tier: {
      tier: "critical" as const,
      session: "family" as const,
      residency: "untrusted-execution" as const,
      family: "workers.storage-maintenance",
      rationale:
        "Exact-target durable storage replacement is destructive and individually reviewed",
    },
    presentation: {
      title: "Replace Durable Object storage",
      action: "replace Durable Object storage",
      description: "Back up and replace the persisted storage of one exact Durable Object target.",
      group: "runtime",
      authorityCategory: { domain: "automation" as const, verb: "act" as const },
    },
    authority: { principals: ["user", "host", "code"] as PrincipalKind[] },
    access: { sensitivity: "destructive" as const },
  };

  const methods = defineServiceMethods({
    listSources: {
      tier: {
        tier: "open",
        session: "family",
        residency: "untrusted-execution",
        family: "workers.read",
        rationale:
          "P-discovery: capability discovery and introspection; §2 default {code, session} family",
      },
      description:
        "List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers)",
      args: z.tuple([]),
      returns: z.array(WorkerSourceSchema),
      access: { sensitivity: "read" as const },
    },
    listServices: {
      tier: {
        tier: "open",
        session: "family",
        residency: "untrusted-execution",
        family: "workers.read",
        rationale:
          "P-discovery: capability discovery and introspection; §2 default {code, session} family",
      },
      description:
        "List manifest-declared workspace services visible in the caller's live context; rows include the live docs catalog id. In eval import the top-level workers API from @workspace/runtime. Inside an installed worker, call runtime.workers.listServices() on the createWorkerRuntime(env) result; never construct a worker runtime from eval.",
      args: z.tuple([]),
      access: { sensitivity: "read" as const },
    },
    resolveService: {
      tier: {
        tier: "open",
        session: "family",
        residency: "untrusted-execution",
        family: "workers.read",
        rationale:
          "P-discovery: agent sessions must resolve only the structurally exposed services in their mission envelope",
      },
      description:
        "Resolve a live workspace service by name or protocol. In eval use the top-level workers import from @workspace/runtime; inside an installed worker use runtime.workers on the createWorkerRuntime(env) result. The returned target is called through the matching top-level or worker-runtime rpc API.",
      args: z.tuple([z.string(), z.string().nullable().optional()]),
      access: { sensitivity: "read" as const },
      authority: preparedResolutionAuthority("resolveService"),
    },
    resolveDurableObject: {
      tier: {
        tier: "open",
        session: "family",
        residency: "untrusted-execution",
        family: "workers.read",
        rationale:
          "P-discovery: agent sessions must resolve only the structurally exposed durable targets in their mission envelope",
      },
      description:
        "Resolve and activate a concrete Durable Object RPC target by source/class/key when no declared workspace service fits. The returned target is a lifecycle handle as well as an RPC address: when the caller owns a disposable object, clear any test data and pass that same target to workers.destroy(...) so its durable storage is retired.",
      args: z.tuple([z.string(), z.string(), z.string()]),
      access: { sensitivity: "read" as const },
      authority: preparedResolutionAuthority("resolveDurableObject"),
    },
    resetStorage: {
      ...storageMaintenancePolicy,
      description:
        "Back up, integrity-check, and reset one exact disposable Durable Object storage target. Intent is required audit context; this is not an upgrade path.",
      args: z.tuple([ExactDurableObjectTargetSchema, z.string().trim().min(1).max(500)]),
      returns: z.object({ operationId: z.string() }).strict(),
    },
    listStorageBackups: {
      tier: {
        tier: "open",
        session: "family",
        residency: "untrusted-execution",
        family: "workers.read",
        rationale: "Backup metadata for one exact target is recovery discovery",
      },
      description: "List verified storage backups for one exact Durable Object target.",
      args: z.tuple([ExactDurableObjectTargetSchema]),
      returns: z.array(
        z
          .object({ operationId: z.string(), intent: z.string(), createdAt: z.number() })
          .passthrough()
      ),
      authority: { principals: ["user", "host", "code"] },
      access: { sensitivity: "read" },
    },
    restoreStorageBackup: {
      ...storageMaintenancePolicy,
      description:
        "Back up the current files, verify a named backup, and restore it to the same exact Durable Object target.",
      args: z.tuple([
        ExactDurableObjectTargetSchema,
        z.string().uuid(),
        z.string().trim().min(1).max(500),
      ]),
      returns: z.object({ operationId: z.string() }).strict(),
    },
  });

  return {
    name: "workers",
    description: "Worker discovery and workspace service resolution",
    authority: { principals: ["user", "host", "code"] },
    methods,
    authorityPreparation: {
      "workers.resolveService.workspace-service": async (ctx, [query, objectKey]) => {
        const scoped = await resolveWorkspaceServiceForCaller(
          ctx,
          String(query),
          objectKey == null ? null : String(objectKey)
        );
        const { service } = scoped;
        if (service.origin === "workspace") {
          await deps.assertUserlandServiceExposure?.(ctx, {
            name: service.name,
            provider: service.source,
            providerEv: await exactProviderEv(scoped, service.source),
          });
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
        for (const authority of scoped.authority) {
          if (!authority.capability.startsWith("workspace-service:")) continue;
          if (source !== INTERNAL_DO_SOURCE) {
            await deps.assertUserlandServiceExposure?.(ctx, {
              name: authority.capability.slice("workspace-service:".length),
              provider: String(source),
              providerEv: await exactProviderEv(scoped, String(source)),
            });
          }
        }
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
      resolveService: async (ctx, [query, objectKey]) => {
        const scoped = await resolveWorkspaceServiceForCaller(ctx, query, objectKey);
        const service = scoped.service;
        if (service.kind === "durable-object") {
          const singleton = scoped.decls.singletons.find(service.source, service.className);
          const creatorContextId =
            service.context === "creator"
              ? deps.getCallerContextId?.(ctx.caller.runtime.id)
              : undefined;
          if (service.context === "creator" && !creatorContextId) {
            throw new Error(`Workspace service ${service.name} requires a creator runtime context`);
          }
          const contextId = singleton?.contextId ?? creatorContextId ?? scoped.contextId;
          const buildRef = singleton?.contextId
            ? undefined
            : (scoped.buildRef ?? (scoped.scope === "main" ? "main" : undefined));
          await deps.activateDurableObject?.({
            source: service.source,
            className: service.className,
            objectKey: service.objectKey,
            ...(contextId ? { contextId } : {}),
            ...(service.context === "creator" ? { contextPolicy: "initial" as const } : {}),
            ...(buildRef ? { buildRef } : {}),
          });
        }
        return service;
      },
      resolveDurableObject: async (ctx, [source, className, objectKey]) => {
        const resolvedObjectKey = resolvedDurableObjectKey(ctx, source, className, objectKey);
        const scoped = await resolveDurableObjectForCaller(ctx, source, className);
        const targetId = `do:${source}:${className}:${resolvedObjectKey}`;
        const singleton = scoped.decls.singletons.find(source, className);
        const contextId = singleton?.contextId ?? scoped.contextId;
        const buildRef = singleton?.contextId
          ? undefined
          : (scoped.buildRef ?? (scoped.scope === "main" ? "main" : undefined));
        await deps.activateDurableObject?.({
          source,
          className,
          objectKey: resolvedObjectKey,
          ...(contextId ? { contextId } : {}),
          ...(buildRef ? { buildRef } : {}),
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
  };

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
    return {
      ...scoped,
      service: resolveWorkspaceService(scoped.decls, query, objectKey),
    };
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

  async function exactProviderEv(scoped: ScopedDeclarations, source: string): Promise<string> {
    if (scoped.scope === "main") {
      const ev = buildSystem.getEffectiveVersion(source);
      if (!ev) throw new Error(`No effective version for workspace service provider ${source}`);
      return ev;
    }
    const resolved = await buildSystem.resolveBuildUnit(source, scoped.buildRef);
    if (!resolved) {
      throw new Error(`No exact context build for workspace service provider ${source}`);
    }
    return resolved.effectiveVersion;
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
      presentation: service.presentation,
      protocols: service.protocols ?? [],
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
