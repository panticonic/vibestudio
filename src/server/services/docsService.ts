/**
 * Agent-facing capability-catalog service. Replaces `meta` as the discovery
 * entry point: caller-aware search/describe/getSchema/listSurfaces over the
 * unified catalog (services + runtime surface).
 *
 * Per-result filtering (not a service-level gate) keeps the policy permissive
 * while never advertising a method the caller cannot invoke — `index` applies
 * `isCatalogEntryVisible`, which mirrors the dispatcher's static gate.
 */
import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import type { ServiceDispatcher, CallerKind } from "@vibez1/shared/serviceDispatcher";
import type { RuntimeSurface } from "@vibez1/shared/runtimeSurface";
import { checkServiceAccess } from "@vibez1/shared/servicePolicy";
import { docsMethods, type SerializedServiceDefinition } from "@vibez1/shared/serviceSchemas/docs";
import { createCatalogIndex, type CatalogSearchOpts } from "./catalog/catalogIndex.js";
import { serializeDef } from "./catalog/serialize.js";

export function createDocsService(deps: {
  dispatcher: ServiceDispatcher;
  runtimeSurfaces: { panel: RuntimeSurface; workerRuntime: RuntimeSurface };
}): ServiceDefinition {
  const index = createCatalogIndex(() => ({
    definitions: deps.dispatcher.getServiceDefinitions(),
    runtimeSurfaces: deps.runtimeSurfaces,
  }));

  // Per-service view (absorbs meta.listServices/describeService), caller-filtered:
  // serialize the def, then keep only the methods this caller kind may invoke.
  const serializeForCaller = (
    def: ServiceDefinition,
    kind: CallerKind
  ): SerializedServiceDefinition => {
    const full = serializeDef(def) as SerializedServiceDefinition;
    const methods: SerializedServiceDefinition["methods"] = {};
    for (const name of Object.keys(full.methods)) {
      try {
        checkServiceAccess(def.name, kind, deps.dispatcher, name);
        const method = full.methods[name];
        if (method) methods[name] = method;
      } catch {
        // not callable by this caller kind — omit from the per-service view
      }
    }
    return { ...full, methods };
  };

  return {
    name: "docs",
    description:
      "Agent-facing capability catalog: discover services and runtime APIs with typed schemas, access rules, and examples (results filtered to what the caller may invoke).",
    policy: { allowed: ["panel", "app", "worker", "do", "extension", "server", "shell"] },
    methods: docsMethods,
    handler: async (ctx, method, args) => {
      const kind = ctx.caller.runtime.kind;
      switch (method) {
        case "search":
          return index.search(String(args[0]), kind, (args[1] as CatalogSearchOpts) ?? undefined);
        case "describe":
          return index.get(String(args[0]), kind);
        case "getSchema": {
          const entry = index.get(String(args[0]), kind);
          if (!entry) return null;
          return {
            ...(entry.argsSchema ? { argsSchema: entry.argsSchema } : {}),
            ...(entry.returnsSchema ? { returnsSchema: entry.returnsSchema } : {}),
          };
        }
        case "listSurfaces":
          return index.listSurfaces(kind);
        case "listServices":
          return deps.dispatcher
            .getServiceDefinitions()
            .map((def) => serializeForCaller(def, kind))
            .filter((d) => Object.keys(d.methods).length > 0);
        case "describeService": {
          const def = deps.dispatcher
            .getServiceDefinitions()
            .find((d) => d.name === String(args[0]));
          return def ? serializeForCaller(def, kind) : null;
        }
        default:
          throw new Error(`Unknown docs method: ${method}`);
      }
    },
  };
}
