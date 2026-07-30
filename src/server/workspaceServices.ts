import type { PrincipalKind } from "@vibestudio/rpc";
import type { DORefParam } from "@vibestudio/shared/workspaceServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@vibestudio/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";

export interface WorkspaceServiceAuthority {
  principals: PrincipalKind[];
}

export interface WorkspaceServiceResolution {
  origin: "product" | "workspace";
  name: string;
  title?: string;
  action: string;
  description?: string;
  presentation: WorkspaceServiceDecl["presentation"];
  /**
   * The protocol that matched this resolution request. Absent when the caller
   * resolved by service name rather than by one of the declared protocols.
   */
  protocol?: string;
  protocols: string[];
  source: string;
  authority: WorkspaceServiceAuthority;
}

export interface DurableObjectServiceResolution extends WorkspaceServiceResolution {
  kind: "durable-object";
  className: string;
  objectKey: string;
  targetId: string;
}

export interface WorkerServiceResolution extends WorkspaceServiceResolution {
  kind: "worker";
  routePath: string;
  routeBasePath: string;
}

export type ResolvedWorkspaceService = DurableObjectServiceResolution | WorkerServiceResolution;

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
  const authority = service.authority as WorkspaceServiceAuthority;
  const source = service.source;

  if (service.durableObject) {
    const className = service.durableObject.className;
    const singletonKey = singletons.find(source, className)?.key ?? null;
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
      objectKey: resolvedObjectKey,
      targetId: `do:${source}:${className}:${resolvedObjectKey}`,
    };
  }

  // worker-backed
  const routePath = normalizeRoutePath(service.worker.routePath);
  const hasRoute = routes.some(
    (route) =>
      route.source === source &&
      route.worker === true &&
      normalizeRoutePath(route.path) === routePath
  );
  if (!hasRoute) {
    throw new Error(
      `Workspace service ${service.name} references stateless worker route ${routePath}, but that route is not declared`
    );
  }
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

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/")
    ? trimmed.replace(/\/+$/u, "")
    : `/${trimmed.replace(/\/+$/u, "")}`;
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
