/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: launchable worker sources (including manifest entry + durable classes)
 * - listServices / resolveService: manifest-declared userland services
 */

import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { resolveUserlandService, type ResolvedUserlandService } from "../userlandServices.js";
import { isReservedProductDo } from "../internalDOs/productBootManifest.js";

type ServiceListRow =
  | {
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
  activateDurableObject?: (args: {
    source: string;
    className: string;
    objectKey: string;
    contextId?: string;
    buildRef?: string;
    ownerUserId?: string;
  }) => Promise<void>;
}): ServiceDefinition {
  const { buildSystem, workspaceDecls } = deps;

  const methods = {
    listSources: {
      description:
        "List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers)",
      args: z.tuple([]),
      returns: z.array(WorkerSourceSchema),
    },
    listServices: {
      description: "List manifest-declared userland services",
      args: z.tuple([]),
    },
    resolveService: {
      description: "Resolve a userland service by name or protocol",
      args: z.tuple([z.string(), z.string().nullable().optional()]),
    },
    resolveDurableObject: {
      description: "Resolve a Durable Object RPC target by source/class/key",
      args: z.tuple([z.string(), z.string(), z.string()]),
    },
  };

  return {
    name: "workers",
    description: "Worker discovery and userland service resolution",
    authority: { principals: ["user", "host", "code"] },
    methods,
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
        const mainRows = listServiceRows(workspaceDecls);
        const scopedContext = await declarationsForCallerContext(ctx);
        if (!scopedContext) return mainRows;
        const seen = serviceQueryKeys(workspaceDecls);
        return [
          ...mainRows,
          ...listServiceRows(scopedContext.decls).filter((row) => {
            if (seen.has(row.name)) return false;
            return !row.protocols.some((protocol) => seen.has(protocol));
          }),
        ];
      },
      resolveService: async (ctx, [query, objectKey]) => {
        const scoped = await resolveUserlandServiceForCaller(ctx, query, objectKey);
        const service = scoped.service;
        await assertUserlandServiceAuthority(
          ctx,
          service.name,
          service.authority.principals,
          service.kind === "durable-object" ? service.targetId : service.routeBasePath
        );
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
            ...(ctx.caller.subject ? { ownerUserId: ctx.caller.subject.userId } : {}),
          });
        }
        return service;
      },
      resolveDurableObject: async (ctx, [source, className, objectKey]) => {
        const scoped = await resolveDurableObjectForCaller(ctx, source, className);
        const targetId = `do:${source}:${className}:${objectKey}`;
        await assertDurableObjectBackingServiceAuthority(
          ctx,
          scoped.decls,
          source,
          className,
          targetId
        );
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
          ...(ctx.caller.subject ? { ownerUserId: ctx.caller.subject.userId } : {}),
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

  async function resolveUserlandServiceForCaller(
    ctx: ServiceContext,
    query: string,
    objectKey: string | null | undefined
  ): Promise<ScopedDeclarations & { service: ResolvedUserlandService }> {
    try {
      return {
        service: resolveUserlandService(workspaceDecls, query, objectKey),
        decls: workspaceDecls,
        scope: "main",
      };
    } catch (err) {
      if (!isMissingServiceError(err, query)) throw err;
    }

    const scoped = await declarationsForCallerContext(ctx);
    if (!scoped) throw new Error(`No userland service registered for ${query}`);
    return {
      ...scoped,
      service: resolveUserlandService(scoped.decls, query, objectKey),
    };
  }

  async function resolveDurableObjectForCaller(
    ctx: ServiceContext,
    source: string,
    className: string
  ): Promise<ScopedDeclarations> {
    try {
      assertDurableObjectExists(buildSystem, workspaceDecls, source, className);
      return { decls: workspaceDecls, scope: "main" };
    } catch (err) {
      if (!isMissingDurableObjectError(err, source, className)) throw err;
    }

    const scoped = await declarationsForCallerContext(ctx);
    if (!scoped) throw new Error(missingDurableObjectMessage(source, className));
    assertDurableObjectDeclared(scoped.decls, source, className);
    return scoped;
  }
}

function isMissingServiceError(err: unknown, query: string): boolean {
  return err instanceof Error && err.message === `No userland service registered for ${query}`;
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

function listServiceRows(decls: WorkspaceDeclarations): ServiceListRow[] {
  return decls.services.map((service) => {
    const base = {
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

function assertDurableObjectExists(
  buildSystem: BuildSystemV2,
  workspaceDecls: WorkspaceDeclarations,
  source: string,
  className: string
): void {
  if (isReservedProductDo(source, className)) {
    return;
  }

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

async function assertDurableObjectBackingServiceAuthority(
  ctx: ServiceContext,
  decls: WorkspaceDeclarations,
  source: string,
  className: string,
  resourceKey: string
): Promise<void> {
  const services = decls.services.filter(
    (service) => service.source === source && service.durableObject?.className === className
  );
  for (const service of services) {
    await assertUserlandServiceAuthority(
      ctx,
      service.name,
      service.authority.principals,
      resourceKey
    );
  }
}

async function assertUserlandServiceAuthority(
  ctx: ServiceContext,
  serviceName: string,
  principals: Parameters<typeof requirementForPrincipals>[0],
  resourceKey: string
): Promise<void> {
  if (!ctx.authority) throw new Error("Compositional authority context is unavailable");
  const capability = `userland-service:${serviceName}`;
  await ctx.authority.assert({
    capability,
    resourceKey,
    requirement: requirementForPrincipals(principals, capability),
  });
}
