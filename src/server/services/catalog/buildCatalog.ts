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
import { methodTier } from "@vibestudio/shared/authority/tierTable";
import type { MethodTierDecision } from "@vibestudio/shared/authority/tierTable";

export interface BuildCatalogDeps {
  definitions: ServiceDefinition[];
  runtimeSurfaces?: { panel?: RuntimeSurface; workerRuntime?: RuntimeSurface };
  workspaceCapabilities?: readonly WorkspaceCapabilityCatalogEntry[];
  tierLookup?: (method: string) => MethodTierDecision | null;
}

export interface WorkspaceCapabilityCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  source: string;
  protocols: readonly string[];
  principals: readonly PrincipalKind[];
  providerEffectiveVersion?: string;
  providerBuildError?: string;
  methods?: readonly {
    name: string;
    signature: string;
    description?: string;
    access?: Record<string, unknown>;
  }[];
  target: { kind: "durable-object"; className: string } | { kind: "worker"; routePath: string };
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
      const qualifiedMethod = `${def.name}.${methodName}`;
      const reviewedTier = method.tier ?? (deps.tierLookup ?? methodTier)(qualifiedMethod);
      if (!reviewedTier) throw new Error(`Catalog method ${qualifiedMethod} has no reviewed tier`);
      const ser = serializeMethod(method);
      const principals = authorityPrincipals(method, def);
      const access = {
        ...(method.access ?? {}),
        principals,
        tier: reviewedTier.tier,
        sessionAdmission: reviewedTier.session,
      };
      entries.push({
        id: `service:${qualifiedMethod}`,
        surface: "service",
        qualifiedName: qualifiedMethod,
        parent: `service:${def.name}`,
        title: qualifiedMethod,
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
        // Advertise only members that docs_open can actually describe. A
        // runtime namespace may expose extra ergonomic values, but presenting
        // those names as catalog children while get(id) returns null makes the
        // discovery contract self-contradictory.
        ...(documentedMembers.length > 0 ? { members: documentedMembers } : {}),
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
          ...(generated?.signature ? { signature: generated.signature } : {}),
          ...(serialized.description ? { description: serialized.description } : {}),
          access: { ...(serialized.access ?? {}), callers },
          ...(serialized.argsSchema ? { argsSchema: serialized.argsSchema } : {}),
          ...(serialized.returnsSchema ? { returnsSchema: serialized.returnsSchema } : {}),
          ...(serialized.examples ? { examples: serialized.examples } : {}),
        });
      }
    }
  }

  for (const declared of deps.workspaceCapabilities ?? []) {
    const methodNames = (declared.methods ?? []).map((method) => method.name).sort();
    entries.push({
      id: `workspace:${declared.name}`,
      surface: "workspace",
      qualifiedName: declared.name,
      title: declared.title ?? declared.name,
      ...(declared.description ? { description: declared.description } : {}),
      ...(methodNames.length > 0 ? { members: methodNames } : {}),
      access: {
        capability: `workspace-service:${declared.name}`,
        principals: [...declared.principals],
        source: declared.source,
        protocols: [...declared.protocols],
        target: declared.target,
        ...(declared.providerEffectiveVersion
          ? { providerEffectiveVersion: declared.providerEffectiveVersion }
          : {}),
        ...(declared.providerBuildError
          ? { availability: "build-error", providerBuildError: declared.providerBuildError }
          : { availability: "ready" }),
      },
    });
    for (const method of declared.methods ?? []) {
      entries.push({
        id: `workspace:${declared.name}.${method.name}`,
        surface: "workspace",
        qualifiedName: `${declared.name}.${method.name}`,
        parent: `workspace:${declared.name}`,
        title: `${declared.name}.${method.name}`,
        ...(method.description ? { description: method.description } : {}),
        signature: method.signature,
        access: {
          capability: `workspace-service:${declared.name}`,
          principals: [...declared.principals],
          source: declared.source,
          protocols: [...declared.protocols],
          target: declared.target,
          receiver: method.access ?? {},
          ...(declared.providerEffectiveVersion
            ? { providerEffectiveVersion: declared.providerEffectiveVersion }
            : {}),
          ...(declared.providerBuildError
            ? { availability: "build-error", providerBuildError: declared.providerBuildError }
            : { availability: "ready" }),
        },
      });
    }
  }

  return entries;
}

/**
 * Capability discovery is presentation, not an authorization boundary. Runtime
 * exports remain filtered by runtime shape because their availability differs
 * by target. Service entries are filtered by compositional principal shape.
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
      return ["session", "user"];
    case "panel":
    case "app":
    case "worker":
    case "do":
    case "extension":
      return ["code", "session", "user"];
  }
}
