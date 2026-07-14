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
import type { AuthorityRequirement, PrincipalKind } from "@vibestudio/rpc";
import type { MethodSchema } from "@vibestudio/shared/typedServiceClient";
import type { CatalogEntry } from "@vibestudio/service-schemas/docs";
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
      access: { principals: def.authority.principals },
    });
    for (const [methodName, method] of agentFacingMethods) {
      const ser = serializeMethod(method);
      const principals = authorityPrincipals(method, def);
      const access = { ...(method.access ?? {}), principals };
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
 * Capability discovery is presentation, not an authorization boundary. Runtime
 * exports remain filtered by runtime shape because their availability differs by
 * target. Service entries are filtered by the authority principal vocabulary so
 * the catalog no longer reimplements caller-kind authorization.
 */
export function isCatalogEntryVisible(entry: CatalogEntry, callerKind: CallerKind): boolean {
  if (entry.surface === "runtime") {
    const callers = (entry.access as { callers?: CallerKind[] } | undefined)?.callers;
    if (!callers) return true;
    if (callers.includes(callerKind)) return true;
    return callerKind === "do" && callers.includes("worker");
  }
  const principals = (entry.access as { principals?: PrincipalKind[] } | undefined)?.principals;
  if (!principals) return true;
  return principals.some((principal) => presentationPrincipals(callerKind).includes(principal));
}

export function authorityPrincipals(
  method: MethodSchema,
  service: Pick<ServiceDefinition, "authority">
): PrincipalKind[] {
  const declaration = method.authority ?? service.authority;
  if (!("requirement" in declaration)) return [...new Set(declaration.principals)];
  return [...collectRequirementPrincipals(declaration.requirement)];
}

export function isServiceMethodVisible(
  method: MethodSchema,
  service: Pick<ServiceDefinition, "authority">,
  callerKind: CallerKind
): boolean {
  const available = presentationPrincipals(callerKind);
  return authorityPrincipals(method, service).some((principal) => available.includes(principal));
}

function collectRequirementPrincipals(
  requirement: AuthorityRequirement,
  found = new Set<PrincipalKind>()
): Set<PrincipalKind> {
  if (requirement.kind === "capability") found.add(requirement.principal);
  if (requirement.kind === "all" || requirement.kind === "any") {
    for (const child of requirement.requirements) collectRequirementPrincipals(child, found);
  }
  return found;
}

function presentationPrincipals(callerKind: CallerKind): PrincipalKind[] {
  switch (callerKind) {
    case "server":
      return ["host"];
    case "shell":
      return ["user"];
    case "agent":
      return ["entity", "user"];
    case "panel":
    case "app":
    case "worker":
    case "do":
    case "extension":
      return ["code", "user", "entity"];
  }
}
