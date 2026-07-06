/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - listServices / resolveService: manifest-declared userland services
 */

import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { callerKindAllowedByPolicy } from "@vibestudio/shared/servicePolicy";
import type { WorkspaceDeclarations } from "@vibestudio/shared/workspace/singletonRegistry";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { resolveUserlandService, type ResolvedUserlandService } from "../userlandServices.js";
import { assertPresent } from "../../lintHelpers";
import { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

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
  }) => Promise<void>;
}): ServiceDefinition {
  const { buildSystem, workspaceDecls } = deps;

  return {
    name: "workers",
    description: "Worker discovery and userland service resolution",
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do", "extension"] },
    methods: {
      listSources: {
        description: "List available worker sources with durable object classes",
        args: z.tuple([]),
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
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "listSources": {
          const graph = buildSystem.getGraph();
          return graph
            .allNodes()
            .filter(
              (n) =>
                n.kind === "worker" && n.manifest.durable && n.manifest.durable.classes.length > 0
            )
            .map((n) => ({
              name: n.name,
              source: n.relativePath,
              title: n.manifest.title,
              classes: assertPresent(n.manifest.durable).classes,
              agent: n.manifest.agent,
            }));
        }

        case "listServices": {
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
        }

        case "resolveService": {
          const scoped = await resolveUserlandServiceForCaller(
            ctx,
            args[0] as string,
            (args[1] as string | null | undefined) ?? undefined
          );
          const service = scoped.service;
          assertUserlandServiceAccess(service.name, service.policy, ctx.caller.runtime.kind);
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
        }

        case "resolveDurableObject": {
          const source = args[0] as string;
          const className = args[1] as string;
          const objectKey = args[2] as string;
          const scoped = await resolveDurableObjectForCaller(ctx, source, className);
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
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
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
      assertDurableObjectExists(
        buildSystem,
        workspaceDecls,
        source,
        className,
        ctx.caller.runtime.kind
      );
      return { decls: workspaceDecls, scope: "main" };
    } catch (err) {
      if (!isMissingDurableObjectError(err, source, className)) throw err;
    }

    const scoped = await declarationsForCallerContext(ctx);
    if (!scoped) throw new Error(missingDurableObjectMessage(source, className));
    assertDurableObjectDeclared(scoped.decls, source, className, ctx.caller.runtime.kind);
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
  className: string,
  callerKind: CallerKind
): void {
  if (
    source === INTERNAL_DO_SOURCE &&
    (INTERNAL_DO_CLASSES as readonly string[]).includes(className)
  ) {
    return;
  }

  const worker = buildSystem
    .getGraph()
    .allNodes()
    .find((node) => node.kind === "worker" && node.relativePath === source);
  const classes = worker?.manifest.durable?.classes ?? [];
  if (classes.some((entry) => entry.className === className)) {
    assertDurableObjectBackingServiceAccess(workspaceDecls, source, className, callerKind);
    return;
  }

  throw new Error(missingDurableObjectMessage(source, className));
}

function assertDurableObjectDeclared(
  decls: WorkspaceDeclarations,
  source: string,
  className: string,
  callerKind: CallerKind
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
  assertDurableObjectBackingServiceAccess(decls, source, className, callerKind);
}

function assertDurableObjectBackingServiceAccess(
  decls: WorkspaceDeclarations,
  source: string,
  className: string,
  callerKind: CallerKind
): void {
  const backingPolicies = decls.services
    .filter(
      (service) => service.source === source && service.durableObject?.className === className
    )
    .map((service) => ({
      name: service.name,
      policy: service.policy as { allowed?: CallerKind[] } | undefined,
    }));
  for (const service of backingPolicies) {
    assertUserlandServiceAccess(service.name, service.policy, callerKind);
  }
}

function assertUserlandServiceAccess(
  serviceName: string,
  policy: { allowed?: CallerKind[] } | undefined,
  callerKind: CallerKind
): void {
  const allowed = policy?.allowed;
  if (!allowed || allowed.length === 0) {
    const err = new Error(
      `Userland service '${serviceName}' has no access policy`
    ) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }
  if (!callerKindAllowedByPolicy(callerKind, allowed)) {
    const err = new Error(
      `Caller kind '${callerKind}' cannot resolve userland service '${serviceName}'`
    ) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }
}
