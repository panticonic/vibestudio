import type { PrincipalKind } from "@vibestudio/rpc";
import type { DORefParam } from "@vibestudio/shared/workspaceServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@vibestudio/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";
import {
  findProductWorkspaceService,
  PRODUCT_WORKSPACE_SERVICES,
} from "@vibestudio/shared/productWorkspaceServices.mjs";

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

export function assertNoProductWorkspaceServiceCollisions(decls: WorkspaceDeclarations): void {
  const productKeys = new Set(
    PRODUCT_WORKSPACE_SERVICES.flatMap((service) => [service.name, ...service.protocols])
  );
  for (const service of decls.services) {
    for (const key of [service.name, ...(service.protocols ?? [])]) {
      if (productKeys.has(key)) {
        throw new Error(
          `Workspace service ${service.name} collides with product-owned service key ${key}`
        );
      }
    }
  }
}

/**
 * Resolve a workspace service by name or protocol. Product-sealed services
 * are resolved from executable product topology; workspace-authored services
 * are resolved from the parsed manifest declarations.
 *
 * For DO-backed services:
 * - If a matching `singletonObjects` row exists, the service is
 *   singleton-backed: `objectKey` is sourced from that row, and callers MAY
 *   override it for fan-out targets (e.g. forked channels).
 * - Otherwise the service is a factory: callers MUST pass an explicit
 *   `objectKey`. Resolving without one throws.
 */
export function resolveWorkspaceService(
  decls: WorkspaceDeclarations,
  query: string,
  objectKey?: string | null
): ResolvedWorkspaceService {
  assertNoProductWorkspaceServiceCollisions(decls);
  const productService = resolveProductWorkspaceService(query, objectKey);
  if (productService) return productService;
  for (const service of decls.services) {
    const protocols = service.protocols ?? [];
    if (service.name !== query && !protocols.includes(query)) continue;
    const resolved = buildResolution(service, decls.singletons, objectKey ?? null, decls.routes);
    return protocols.includes(query) ? { ...resolved, protocol: query } : resolved;
  }
  throw new Error(`No workspace service registered for ${query}`);
}

function resolveProductWorkspaceService(
  query: string,
  objectKey: string | null | undefined
): DurableObjectServiceResolution | null {
  const service = findProductWorkspaceService(query);
  if (!service) return null;
  const { className, objectKey: sealedObjectKey } = service.durableObject;
  if (objectKey != null && objectKey !== sealedObjectKey) {
    throw new Error(
      `Product workspace service ${service.name} has one sealed object key (${sealedObjectKey}); ` +
        `caller-supplied key ${JSON.stringify(objectKey)} is not permitted`
    );
  }
  return {
    kind: "durable-object",
    origin: "product",
    name: service.name,
    title: service.title,
    action: service.action,
    description: service.description,
    presentation: service.presentation,
    ...(service.protocols.includes(query) ? { protocol: query } : {}),
    protocols: [...service.protocols],
    source: service.source,
    authority: { principals: [...service.authority.principals] },
    className,
    objectKey: sealedObjectKey,
    targetId: `do:${service.source}:${className}:${sealedObjectKey}`,
  };
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
    const resolvedObjectKey = overrideObjectKey ?? singletonKey;
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
