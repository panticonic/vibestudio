import type { DORefParam } from "@vibestudio/shared/workspaceServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@vibestudio/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";
import { requireWorkspaceWorkerRoute } from "@vibestudio/workspace-contracts/workspaceRoutes";

// Keep the resolved shape tied to the canonical declaration. The former local
// shadow type dropped `binding`, which let resolution and receiver admission
// silently apply different policy to the same service.
export type WorkspaceServiceAuthority = WorkspaceServiceDecl["authority"];

import type { ResolvedWorkspaceService } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
export type { ResolvedWorkspaceService } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

/**
 * Resolve a manifest-declared workspace service by name or protocol.
 *
 * For DO-backed services:
 * - If a matching `singletonObjects` row exists, the service is
 *   singleton-backed: `objectKey` is sourced from that row and cannot be
 *   overridden.
 * - Otherwise the service is a factory: callers MUST pass an explicit
 *   `objectKey`. Resolving without one throws.
 */
export function resolveWorkspaceService(
  decls: WorkspaceDeclarations,
  query: string,
  objectKey?: string | null
): ResolvedWorkspaceService {
  for (const service of decls.services) {
    const protocols = service.protocols ?? [];
    if (service.name !== query && !protocols.includes(query)) continue;
    const resolved = buildResolution(service, decls.singletons, objectKey ?? null, decls.routes);
    return protocols.includes(query) ? { ...resolved, protocol: query } : resolved;
  }
  throw new Error(`No workspace service registered for ${query}`);
}

function buildResolution(
  service: WorkspaceServiceDecl,
  singletons: SingletonRegistry,
  overrideObjectKey: string | null,
  routes: WorkspaceDeclarations["routes"]
): ResolvedWorkspaceService {
  const protocols = service.protocols ?? [];
  const authority: WorkspaceServiceAuthority = service.authority;
  const source = service.source;

  if (service.durableObject) {
    const className = service.durableObject.className;
    const singletonKey = singletons.find(source, className)?.key ?? null;
    if (singletonKey !== null && service.durableObject.context === "creator") {
      throw new Error(
        `Workspace service "${service.name}" declares creator-context placement but is backed by ` +
          `singleton ${JSON.stringify(singletonKey)}; creator-context services must be factories.`
      );
    }
    if (singletonKey !== null && overrideObjectKey !== null && overrideObjectKey !== singletonKey) {
      throw new Error(
        `Workspace service "${service.name}" is the singleton ${JSON.stringify(singletonKey)}; ` +
          `caller-supplied key ${JSON.stringify(overrideObjectKey)} is not permitted`
      );
    }
    const resolvedObjectKey = singletonKey ?? overrideObjectKey;
    if (resolvedObjectKey === null) {
      throw new Error(
        `Workspace service "${service.name}" is a factory (no singletonObjects row for ` +
          `source=${source} className=${className}); resolveService requires an explicit objectKey.`
      );
    }
    return {
      kind: "durable-object",
      origin: "workspace",
      name: service.name,
      title: service.title,
      action: service.action,
      description: service.description,
      presentation: service.presentation,
      protocols,
      source,
      authority,
      className,
      ...(service.durableObject.context ? { context: service.durableObject.context } : {}),
      objectKey: resolvedObjectKey,
      targetId: `do:${source}:${className}:${resolvedObjectKey}`,
    };
  }

  // worker-backed
  const routePath = requireWorkspaceWorkerRoute(
    routes,
    source,
    service.worker.routePath,
    `Workspace service ${service.name}`
  );
  return {
    kind: "worker",
    origin: "workspace",
    name: service.name,
    title: service.title,
    action: service.action,
    description: service.description,
    presentation: service.presentation,
    protocols,
    source,
    authority,
    routePath,
    routeBasePath: `/_r/w/${source}${routePath === "/" ? "" : routePath}`,
  };
}

export function toDORef(resolution: ResolvedWorkspaceService): DORefParam {
  if (resolution.kind !== "durable-object") {
    throw new Error(`Workspace service ${resolution.name} is not Durable Object-backed`);
  }
  return {
    source: resolution.source,
    className: resolution.className,
    objectKey: resolution.objectKey,
  };
}
