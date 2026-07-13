/**
 * Capability-catalog assembler.
 *
 * Derives a flat list of `CatalogEntry` rows from the implemented live
 * discovery sources: the dispatcher's service definitions and the runtime
 * surface manifests.
 *
 * Pure function of its inputs → deterministic and trivially testable.
 */
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { RuntimeSurface, RuntimeSurfaceTarget } from "@vibestudio/shared/runtimeSurface";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { callerKindAllowedByPolicy } from "@vibestudio/shared/servicePolicy";
import type { CatalogEntry } from "@vibestudio/shared/serviceSchemas/docs";
import { serializeMethod } from "./serialize.js";

export interface BuildCatalogDeps {
  definitions: ServiceDefinition[];
  runtimeSurfaces?: { panel?: RuntimeSurface; workerRuntime?: RuntimeSurface };
}

const RUNTIME_TARGET_CALLERS: Record<RuntimeSurfaceTarget, CallerKind[]> = {
  panel: ["panel"],
  workerRuntime: ["worker", "do"],
};

export function buildCatalog(deps: BuildCatalogDeps): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const definitionsByName = new Map(
    deps.definitions.map((definition) => [definition.name, definition])
  );

  for (const def of deps.definitions) {
    const agentFacingMethods = Object.entries(def.methods).filter(
      ([, method]) => method.agentFacing !== false
    );
    if (agentFacingMethods.length === 0) continue;
    entries.push({
      id: `service:${def.name}`,
      surface: "service",
      qualifiedName: def.name,
      title: def.name,
      ...(def.description ? { description: def.description } : {}),
      access: { callers: def.policy.allowed },
    });
    for (const [methodName, method] of agentFacingMethods) {
      const ser = serializeMethod(method);
      // Effective caller set: method policy > service policy (mirrors the
      // dispatcher's getMethodPolicy + checkServiceAccess fallback).
      const callers: CallerKind[] = method.policy?.allowed ?? def.policy.allowed;
      // Merge the declared access metadata with the resolved caller set so the
      // catalog surfaces the same gate the dispatcher enforces.
      const access = { ...(method.access ?? {}), callers };
      entries.push({
        id: `service:${def.name}.${methodName}`,
        surface: "service",
        qualifiedName: `${def.name}.${methodName}`,
        parent: `service:${def.name}`,
        title: `${def.name}.${methodName}`,
        ...(method.description ? { description: method.description } : {}),
        access,
        argsSchema: ser.argsSchema,
        ...("returnsSchema" in ser ? { returnsSchema: ser.returnsSchema } : {}),
        ...(method.examples ? { examples: method.examples } : {}),
      });
    }
  }

  for (const surface of Object.values(deps.runtimeSurfaces ?? {})) {
    if (!surface) continue;
    const target = surface.target;
    const callers = RUNTIME_TARGET_CALLERS[target];
    for (const [name, entry] of Object.entries(surface.exports)) {
      const runtimeId = `runtime:${target}.${name}`;
      const schemaDefinition = entry.schemaRef ? definitionsByName.get(entry.schemaRef) : undefined;
      const projectedMembers = (entry.members ?? []).filter(
        (member) => schemaDefinition?.methods[member]
      );
      const documentedMembers = (entry.members ?? []).filter(
        (member) => projectedMembers.includes(member) || entry.methodCatalog?.[member]
      );
      const schemaHint =
        documentedMembers.length > 0
          ? `Typed member docs: ${documentedMembers.map((member) => `docs_open("${runtimeId}.${member}")`).join(", ")}.`
          : "";
      const description = [entry.description, schemaHint].filter(Boolean).join(" ");
      entries.push({
        id: runtimeId,
        surface: "runtime",
        qualifiedName: name,
        title: name,
        ...(description ? { description } : {}),
        ...(entry.members ? { members: entry.members } : {}),
        access: { callers },
      });
      // A schemaRef is an implementation-only bridge from an ergonomic runtime
      // namespace to the Zod contract used by its wire transport. Project the
      // schemas under runtime ids so the public API is fully self-describing
      // without advertising the raw service or teaching agents to call it.
      for (const member of documentedMembers) {
        const method = schemaDefinition?.methods[member];
        const generated = entry.methodCatalog?.[member];
        const serialized = method ? serializeMethod(method) : generated;
        if (!serialized) continue;
        entries.push({
          id: `${runtimeId}.${member}`,
          surface: "runtime",
          qualifiedName: `${name}.${member}`,
          parent: runtimeId,
          title: `${name}.${member}`,
          ...(serialized.description ? { description: serialized.description } : {}),
          access: { ...(serialized.access ?? {}), callers },
          ...(serialized.argsSchema ? { argsSchema: serialized.argsSchema } : {}),
          ...(serialized.returnsSchema ? { returnsSchema: serialized.returnsSchema } : {}),
          ...(serialized.examples ? { examples: serialized.examples } : {}),
        });
      }
    }
  }

  return entries;
}

/**
 * Whether a catalog entry is visible to a caller kind. Mirrors the dispatcher's
 * static gate (`checkServiceAccess`): the `access.callers` array, with the
 * DO userland inheritance rule for service entries. Runtime entries carry
 * target-specific callers because module exports are availability, not service
 * authorization: panels see panel runtime APIs, and workers/DOs see worker
 * runtime APIs. Conditional `restrictedTo` gates are surfaced as metadata, not
 * used to hide the entry.
 */
export function isCatalogEntryVisible(entry: CatalogEntry, callerKind: CallerKind): boolean {
  const callers = (entry.access as { callers?: CallerKind[] } | undefined)?.callers;
  if (!callers) return true;
  if (entry.surface === "runtime") {
    if (callers.includes(callerKind)) return true;
    return callerKind === "do" && callers.includes("worker");
  }
  return callerKindAllowedByPolicy(callerKind, callers);
}
