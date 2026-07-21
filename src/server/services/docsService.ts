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

export function createDocsService(deps: {
  dispatcher: ServiceDispatcher;
  runtimeSurfaces: { panel: RuntimeSurface; workerRuntime: RuntimeSurface };
}): ServiceDefinition {
  const index = createCatalogIndex(() => ({
    definitions: deps.dispatcher.getServiceDefinitions(),
    runtimeSurfaces: deps.runtimeSurfaces,
  }));

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
    authority: { principals: ["code", "host", "user", "entity"] },
    methods: docsMethods,
    handler: defineServiceHandler("docs", docsMethods, {
      search: (ctx, [query, opts]) => {
        const kind = ctx.caller.runtime.kind;
        return index.search(query, kind, opts ?? undefined);
      },
      describe: (ctx, [name]) => index.get(name, ctx.caller.runtime.kind),
      getSchema: (ctx, [name]) => {
        const entry = index.get(name, ctx.caller.runtime.kind);
        if (!entry) return null;
        return {
          ...(entry.argsSchema ? { argsSchema: entry.argsSchema } : {}),
          ...(entry.returnsSchema ? { returnsSchema: entry.returnsSchema } : {}),
        };
      },
      listSurfaces: (ctx) => index.listSurfaces(ctx.caller.runtime.kind),
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
