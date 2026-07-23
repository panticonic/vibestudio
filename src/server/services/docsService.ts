/**
 * Agent-facing capability-catalog service. Replaces `meta` as the discovery
 * entry point: caller-aware search/describe/getSchema/listSurfaces over the
 * unified catalog (services + runtime surface).
 *
 * Per-result filtering is discovery ergonomics only. Enforcement remains in
 * the compositional dispatcher; discovery uses declared principal shape.
 */
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDispatcher, CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import { docsMethods, type SerializedServiceDefinition } from "@vibestudio/service-schemas/docs";
import { createCatalogIndex } from "./catalog/catalogIndex.js";
import { isServiceMethodVisible } from "./catalog/buildCatalog.js";
import { serializeDef } from "./catalog/serialize.js";
import type { MethodTierDecision } from "@vibestudio/shared/authority/tierTable";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";

export interface LiveWorkspaceServiceDoc {
  declaration: WorkspaceServiceDecl;
  providerEffectiveVersion?: string;
  /** A provider build may be temporarily invalid while an agent is editing it. */
  providerBuildError?: string;
  methods: readonly {
    name: string;
    signature: string;
    description?: string;
    access?: Record<string, unknown>;
  }[];
}

export function createDocsService(deps: {
  dispatcher: ServiceDispatcher;
  runtimeSurfaces: { panel: RuntimeSurface; workerRuntime: RuntimeSurface };
  /** Exact live declaration set for this caller's semantic context. */
  workspaceServicesForCaller?: (
    ctx: Parameters<ServiceDefinition["handler"]>[0]
  ) => readonly LiveWorkspaceServiceDoc[] | Promise<readonly LiveWorkspaceServiceDoc[]>;
  reportWorkspaceDocsError?: (error: unknown) => void;
  tierLookup?: (method: string) => MethodTierDecision | null;
}): ServiceDefinition {
  const indexCache = new Map<string, ReturnType<typeof createCatalogIndex>>();
  let lastWorkspaceDocsError: string | null = null;
  const indexFor = async (
    ctx: Parameters<ServiceDefinition["handler"]>[0],
    includeWorkspace: boolean
  ): Promise<ReturnType<typeof createCatalogIndex>> => {
    let services: readonly LiveWorkspaceServiceDoc[] = [];
    if (includeWorkspace) {
      try {
        services = (await deps.workspaceServicesForCaller?.(ctx)) ?? [];
        lastWorkspaceDocsError = null;
      } catch (error) {
        // Documentation is a repair surface. A malformed in-progress workspace
        // declaration must not hide the stable host/runtime API needed to fix
        // it. The workspace loader/build system remains the authoritative source
        // of the diagnostic; docs degrade to the stable catalog for this read.
        const errorKey = error instanceof Error ? `${error.name}:${error.message}` : String(error);
        if (errorKey !== lastWorkspaceDocsError) {
          lastWorkspaceDocsError = errorKey;
          (
            deps.reportWorkspaceDocsError ??
            ((cause) =>
              console.warn(
                "[docs] Live workspace-service catalog unavailable; serving stable docs:",
                cause
              ))
          )(error);
        }
      }
    }
    const key = JSON.stringify(services);
    const cached = indexCache.get(key);
    if (cached) {
      indexCache.delete(key);
      indexCache.set(key, cached);
      return cached;
    }
    const workspaceCapabilities = services.map((live) => {
      const service = live.declaration;
      return {
        name: service.name,
        ...(service.title ? { title: service.title } : {}),
        ...(service.description ? { description: service.description } : {}),
        source: service.source,
        protocols: service.protocols ?? [],
        principals: service.authority.principals,
        ...(live.providerEffectiveVersion
          ? { providerEffectiveVersion: live.providerEffectiveVersion }
          : {}),
        ...(live.providerBuildError ? { providerBuildError: live.providerBuildError } : {}),
        methods: live.methods,
        target: service.durableObject
          ? { kind: "durable-object" as const, className: service.durableObject.className }
          : { kind: "worker" as const, routePath: service.worker.routePath },
      };
    });
    const index = createCatalogIndex(() => ({
      definitions: deps.dispatcher.getServiceDefinitions(),
      runtimeSurfaces: deps.runtimeSurfaces,
      workspaceCapabilities,
      ...(deps.tierLookup ? { tierLookup: deps.tierLookup } : {}),
    }));
    indexCache.set(key, index);
    if (indexCache.size > 32) {
      const oldestKey = indexCache.keys().next().value;
      if (oldestKey !== undefined) indexCache.delete(oldestKey);
    }
    return index;
  };

  // Per-service discovery view: filter by declared authority principal shape.
  // This is presentation, not an authorization decision.
  const serializeForCaller = (
    def: ServiceDefinition,
    kind: CallerKind
  ): SerializedServiceDefinition => {
    const full = serializeDef(def) as SerializedServiceDefinition;
    const methods: SerializedServiceDefinition["methods"] = {};
    for (const name of Object.keys(full.methods)) {
      const schema = def.methods[name];
      const method = full.methods[name];
      if (schema && method && isServiceMethodVisible(schema, def, kind)) methods[name] = method;
    }
    return { ...full, methods };
  };

  return {
    name: "docs",
    description:
      "Agent-facing capability catalog: discover services and runtime APIs with typed schemas, access rules, and examples (results filtered to what the caller may invoke).",
    authority: { principals: ["code", "host", "user"] },
    methods: docsMethods,
    handler: defineServiceHandler("docs", docsMethods, {
      search: async (ctx, [query, opts]) => {
        const kind = ctx.caller.runtime.kind;
        // Host/runtime catalog rows are stable inputs and must never be held
        // behind builds of unrelated, mutable workspace providers. Only an
        // explicitly workspace-scoped (or all-surface) search needs that live
        // partition.
        const includeWorkspace = !opts?.surface || opts.surface === "workspace";
        return (await indexFor(ctx, includeWorkspace)).search(query, kind, opts ?? undefined);
      },
      describe: async (ctx, [name]) =>
        (await indexFor(ctx, name.startsWith("workspace:"))).get(name, ctx.caller.runtime.kind),
      getSchema: async (ctx, [name]) => {
        const entry = (await indexFor(ctx, name.startsWith("workspace:"))).get(
          name,
          ctx.caller.runtime.kind
        );
        if (!entry) return null;
        return {
          ...(entry.argsSchema ? { argsSchema: entry.argsSchema } : {}),
          ...(entry.returnsSchema ? { returnsSchema: entry.returnsSchema } : {}),
        };
      },
      listSurfaces: async (ctx) =>
        (await indexFor(ctx, true)).listSurfaces(ctx.caller.runtime.kind),
      listServices: (ctx) =>
        deps.dispatcher
          .getServiceDefinitions()
          .map((def) => serializeForCaller(def, ctx.caller.runtime.kind))
          .filter((d) => Object.keys(d.methods).length > 0),
      describeService: (ctx, [name]) => {
        const def = deps.dispatcher.getServiceDefinitions().find((d) => d.name === name);
        return def ? serializeForCaller(def, ctx.caller.runtime.kind) : null;
      },
    }),
  };
}
