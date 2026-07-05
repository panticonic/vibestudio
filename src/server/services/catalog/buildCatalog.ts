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

  for (const def of deps.definitions) {
    entries.push({
      id: `service:${def.name}`,
      surface: "service",
      qualifiedName: def.name,
      title: def.name,
      ...(def.description ? { description: def.description } : {}),
      access: { callers: def.policy.allowed },
    });
    for (const [methodName, method] of Object.entries(def.methods)) {
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
        ...(method.docs ? { docs: method.docs } : {}),
      });
    }
  }

  for (const surface of Object.values(deps.runtimeSurfaces ?? {})) {
    if (!surface) continue;
    const target = surface.target;
    const callers = RUNTIME_TARGET_CALLERS[target];
    for (const [name, entry] of Object.entries(surface.exports)) {
      // Surface the schemaRef link so an agent can pull the typed method schemas
      // backing this runtime namespace from the corresponding service.
      const schemaHint = entry.schemaRef
        ? `Typed methods are documented under the \`${entry.schemaRef}\` service (e.g. docs_open service:${entry.schemaRef}.<method>).`
        : "";
      const description = [entry.description, schemaHint].filter(Boolean).join(" ");
      entries.push({
        id: `runtime:${target}.${name}`,
        surface: "runtime",
        qualifiedName: name,
        title: name,
        ...(description ? { description } : {}),
        ...(entry.members ? { members: entry.members } : {}),
        access: { callers },
      });
    }
  }

  return entries;
}

/**
 * Whether a catalog entry is visible to a caller kind. Mirrors the dispatcher's
 * static gate (`checkServiceAccess`): the `access.callers` array, with the
 * `do`→`worker` inheritance rule. Runtime entries also carry target-specific
 * callers so panels only see panel runtime APIs, and workers/DOs see worker
 * runtime APIs. Conditional `restrictedTo` gates are surfaced as metadata, not
 * used to hide the entry.
 */
export function isCatalogEntryVisible(entry: CatalogEntry, callerKind: CallerKind): boolean {
  const callers = (entry.access as { callers?: CallerKind[] } | undefined)?.callers;
  if (!callers) return true;
  if (callers.includes(callerKind)) return true;
  if (callerKind === "do" && callers.includes("worker")) return true;
  return false;
}

export function isCatalogEntryDiscoverable(
  entry: CatalogEntry,
  opts?: { includeInternal?: boolean }
): boolean {
  if (opts?.includeInternal) return true;
  return entry.docs?.visibility !== "internal";
}
