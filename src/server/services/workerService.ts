/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: launchable worker sources (including manifest entry + durable classes)
 * - listServices: product-owned and workspace-authored services available here
 * - resolveService: workspace-authored services plus product-sealed workspace services
 */

import { z } from "zod";
import type { PrincipalKind } from "@vibestudio/rpc";
import { PRODUCT_WORKSPACE_SERVICES } from "@vibestudio/shared/productWorkspaceServices.mjs";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { findReviewedInternalDurableObjectTarget } from "../reviewedInternalDurableObjectTargets.js";
import { resolveWorkspaceService, type ResolvedWorkspaceService } from "../workspaceServices.js";

type ServiceListRow =
  | {
      origin: "product" | "workspace";
      name: string;
      title?: string;
      description?: string;
      protocols: string[];
      source: string;
      kind: "durable-object";
      className: string;
      defaultObjectKey: string | null;
    }
  | {
      origin: "workspace";
      name: string;
      title?: string;
      description?: string;
      protocols: string[];
      source: string;
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

export function createWorkerService(deps: {
  buildSystem: BuildSystemV2;
  workspaceDecls: WorkspaceDeclarations;
  getCallerContextId?: (callerId: string) => string | null;
  loadContextDeclarations?: (contextId: string) => Promise<WorkspaceDeclarations | null>;
  // Resolution makes a declared target available; it does not create ownership.
  // The resolving subject remains the caller of its subsequent RPC unchanged.
  activateDurableObject?: (args: {
    source: string;
    className: string;
    objectKey: string;
    contextId?: string;
    buildRef?: string;
  }) => Promise<void>;
}): ServiceDefinition {
  const { buildSystem, workspaceDecls } = deps;
  const dynamicWorkspaceServiceLeaf = {
    capability: "workspace-service:*",
    requirement: {
      kind: "selected" as const,
      principals: ["host", "user", "code", "entity"] as const,
    },
    evalAcquisition: { kind: "baseline" as const },
  };
  const reviewedInternalTargetLeaf = {
    capability: "service:workers.resolveDurableObject",
    requirement: {
      kind: "selected" as const,
      principals: ["code"] as const,
    },
    evalAcquisition: { kind: "baseline" as const },
  };
  const preparedResolutionAuthority = (method: "resolveService" | "resolveDurableObject") => {
    const capability = `service:workers.${method}`;
    return {
      // Resolution is a prerequisite for invoking a declared workspace
      // service. Entity-bound agents/DOs must be able to reach this preparer;
      // the selected service leaf below still enforces whether that exact
      // service admits the entity principal.
      requirement: requirementForPrincipals(["user", "host", "code", "entity"], capability),
      resource: { kind: "literal" as const, key: capability },
      prepared: {
        resolver:
          method === "resolveService"
            ? "workers.resolveService.workspace-service"
            : "workers.resolveDurableObject.target",
        leaves:
          method === "resolveDurableObject"
            ? [dynamicWorkspaceServiceLeaf, reviewedInternalTargetLeaf]
            : [dynamicWorkspaceServiceLeaf],
      },
    };
  };

  const methods = {
    listSources: {
      description:
        "List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers)",
      args: z.tuple([]),
      returns: z.array(WorkerSourceSchema),
      access: { sensitivity: "read" as const },
    },
    listServices: {
      description: "List product-owned and workspace-authored services available here",
      args: z.tuple([]),
      access: { sensitivity: "read" as const },
    },
    resolveService: {
      description: "Resolve a workspace service by name or protocol",
      args: z.tuple([z.string(), z.string().nullable().optional()]),
      access: { sensitivity: "read" as const },
      authority: preparedResolutionAuthority("resolveService"),
    },
    resolveDurableObject: {
      description: "Resolve a Durable Object RPC target by source/class/key",
      args: z.tuple([z.string(), z.string(), z.string()]),
      access: { sensitivity: "read" as const },
      authority: preparedResolutionAuthority("resolveDurableObject"),
    },
  };

  return {
    name: "workers",
    description: "Worker discovery and workspace service resolution",
    authority: { principals: ["user", "host", "code"] },
    methods,
    authorityPreparation: {
      "workers.resolveService.workspace-service": async (ctx, [query, objectKey]) => {
        const { service } = await resolveWorkspaceServiceForCaller(
          ctx,
          String(query),
          objectKey == null ? null : String(objectKey)
        );
        const capability = `workspace-service:${service.name}`;
        return [
          {
            capability,
            resourceKey:
              service.kind === "durable-object" ? service.targetId : service.routeBasePath,
            requirement: requirementForPrincipals(service.authority.principals, capability),
          },
        ];
      },
      "workers.resolveDurableObject.target": async (ctx, [source, className, objectKey]) => {
        const scoped = await resolveDurableObjectForCaller(
          ctx,
          String(source),
          String(className),
          String(objectKey)
        );
        const targetId = `do:${String(source)}:${String(className)}:${String(objectKey)}`;
        return scoped.authority.map(({ capability, principals }) => ({
          capability,
          resourceKey: targetId,
          requirement: requirementForPrincipals(principals, capability),
        }));
      },
    },
    handler: defineServiceHandler("workers", methods, {
      listSources: () => {
        const graph = buildSystem.getGraph();
        return graph
          .allNodes()
          .filter((n) => n.kind === "worker")
          .map((n) => ({
            name: n.name,
            source: n.relativePath,
            title: n.manifest.title,
            entry: n.manifest.entry,
            classes: n.manifest.durable?.classes ?? [],
            agent: n.manifest.agent,
          }));
      },
      listServices: async (ctx) => {
        const mainRows = [...listProductServiceRows(), ...listServiceRows(workspaceDecls)];
        const scopedContext = await declarationsForCallerContext(ctx);
        if (!scopedContext) return mainRows;
        const seen = new Set([
          ...PRODUCT_WORKSPACE_SERVICES.flatMap((service) => [service.name, ...service.protocols]),
          ...serviceQueryKeys(workspaceDecls),
        ]);
        return [
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
          const contextId = singleton?.contextId ?? scoped.contextId;
          const buildRef = singleton?.contextId
            ? undefined
            : (scoped.buildRef ?? (scoped.scope === "main" ? "main" : undefined));
          await deps.activateDurableObject?.({
            source: service.source,
            className: service.className,
            objectKey: service.objectKey,
            ...(contextId ? { contextId } : {}),
            ...(buildRef ? { buildRef } : {}),
          });
        }
        return service;
      },
      resolveDurableObject: async (ctx, [source, className, objectKey]) => {
        const scoped = await resolveDurableObjectForCaller(ctx, source, className, objectKey);
        const targetId = `do:${source}:${className}:${objectKey}`;
        const singleton = scoped.decls.singletons.find(source, className);
        const contextId = singleton?.contextId ?? scoped.contextId;
        const buildRef = singleton?.contextId
          ? undefined
          : (scoped.buildRef ?? (scoped.scope === "main" ? "main" : undefined));
        await deps.activateDurableObject?.({
          source,
          className,
          objectKey,
          ...(contextId ? { contextId } : {}),
          ...(buildRef ? { buildRef } : {}),
        });
        return { kind: "durable-object", source, className, objectKey, targetId };
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
    className: string,
    objectKey: string
  ): Promise<ScopedDurableObject> {
    if (source === INTERNAL_DO_SOURCE) {
      const reviewed = findReviewedInternalDurableObjectTarget(source, className, objectKey);
      if (!reviewed) throw new Error(missingDurableObjectMessage(source, className));
      return {
        decls: workspaceDecls,
        scope: "main",
        authority: [
          {
            capability: reviewed.authority.capability,
            principals: reviewed.authority.principals,
          },
        ],
      };
    }

    try {
      assertDurableObjectExists(buildSystem, workspaceDecls, source, className);
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
    assertDurableObjectDeclared(scoped.decls, source, className);
    return {
      ...scoped,
      authority: durableObjectAuthority(scoped.decls, source, className),
    };
  }
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
      description: service.description,
      protocols: service.protocols ?? [],
      source: service.source,
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

function listProductServiceRows(): ServiceListRow[] {
  return PRODUCT_WORKSPACE_SERVICES.map((service) => ({
    origin: "product" as const,
    name: service.name,
    title: service.title,
    description: service.description,
    protocols: [...service.protocols],
    source: service.source,
    kind: "durable-object" as const,
    className: service.durableObject.className,
    defaultObjectKey: service.durableObject.objectKey,
  }));
}

function assertDurableObjectExists(
  buildSystem: BuildSystemV2,
  workspaceDecls: WorkspaceDeclarations,
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

function assertDurableObjectDeclared(
  decls: WorkspaceDeclarations,
  source: string,
  className: string
): void {
  const declared =
    decls.singletons.find(source, className) ||
    decls.services.some(
      (service) => service.source === source && service.durableObject?.className === className
    ) ||
    decls.routes.some(
      (route) => route.source === source && route.durableObject?.className === className
    );
  if (!declared) throw new Error(missingDurableObjectMessage(source, className));
}
