import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { VCS_SERVICE_PROTOCOL, type DORefParam } from "@vibestudio/shared/userlandServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@vibestudio/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";

export interface UserlandServicePolicy {
  allowed?: CallerKind[];
}

export interface UserlandServiceResolution {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
  policy?: UserlandServicePolicy;
}

export interface DurableObjectServiceResolution extends UserlandServiceResolution {
  kind: "durable-object";
  className: string;
  objectKey: string;
  targetId: string;
}

export interface WorkerServiceResolution extends UserlandServiceResolution {
  kind: "worker";
  routePath: string;
  routeBasePath: string;
}

export type ResolvedUserlandService = DurableObjectServiceResolution | WorkerServiceResolution;

/**
 * Resolve a userland service by name or protocol against the workspace's
 * parsed declarations.
 *
 * For DO-backed services:
 * - If a matching `singletonObjects` row exists, the service is
 *   singleton-backed: `objectKey` is sourced from that row, and callers MAY
 *   override it for fan-out targets (e.g. forked channels).
 * - Otherwise the service is a factory: callers MUST pass an explicit
 *   `objectKey`. Resolving without one throws.
 */
/**
 * The gad-store DO backing the workspace VCS — resolved from the `vcs`
 * SERVICE declaration (protocol `vibestudio.vcs.v1`), i.e. the SAME manifest row
 * userland dispatch resolves through `workers.resolveService`. One source of
 * truth by construction: the store the host attaches to (provenance follower,
 * host `vcs.*` dispatch, bootstrap main-binding) is exactly the store the
 * userland `vcs` service serves; the two can never point at different DOs.
 *
 * Returns null when the workspace declares no singleton-DO-backed `vcs`
 * service — no declaration, a worker-backed one, or a factory DO (no
 * `singletonObjects` row names a concrete object to attach to). The caller
 * disables the durable VCS store with a loud diagnostic; the host never falls
 * back to a hardcoded unit name.
 */
export function resolveVcsStoreBinding(
  decls: WorkspaceDeclarations
): { source: string; className: string; objectKey: string } | null {
  let resolved: ResolvedUserlandService;
  try {
    resolved = resolveUserlandService(decls, VCS_SERVICE_PROTOCOL);
  } catch {
    // Absent declaration or a factory DO service (no singleton row).
    return null;
  }
  if (resolved.kind !== "durable-object") return null;
  return {
    source: resolved.source,
    className: resolved.className,
    objectKey: resolved.objectKey,
  };
}

export function resolveUserlandService(
  decls: WorkspaceDeclarations,
  query: string,
  objectKey?: string | null
): ResolvedUserlandService {
  for (const service of decls.services) {
    const protocols = service.protocols ?? [];
    if (service.name !== query && !protocols.includes(query)) continue;
    return buildResolution(service, decls.singletons, objectKey ?? null, decls.routes);
  }
  throw new Error(`No userland service registered for ${query}`);
}

function buildResolution(
  service: WorkspaceServiceDecl,
  singletons: SingletonRegistry,
  overrideObjectKey: string | null,
  routes: WorkspaceDeclarations["routes"]
): ResolvedUserlandService {
  const protocols = service.protocols ?? [];
  const policy = service.policy as UserlandServicePolicy | undefined;
  const source = service.source;

  if (service.durableObject) {
    const className = service.durableObject.className;
    const singletonKey = singletons.find(source, className)?.key ?? null;
    const resolvedObjectKey = overrideObjectKey ?? singletonKey;
    if (resolvedObjectKey === null) {
      throw new Error(
        `Userland service "${service.name}" is a factory (no singletonObjects row for ` +
          `source=${source} className=${className}); resolveService requires an explicit objectKey.`
      );
    }
    return {
      kind: "durable-object",
      name: service.name,
      title: service.title,
      description: service.description,
      protocols,
      source,
      policy,
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
      `Userland service ${service.name} references stateless worker route ${routePath}, but that route is not declared`
    );
  }
  return {
    kind: "worker",
    name: service.name,
    title: service.title,
    description: service.description,
    protocols,
    source,
    policy,
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

export function toDORef(resolution: ResolvedUserlandService): DORefParam {
  if (resolution.kind !== "durable-object") {
    throw new Error(`Userland service ${resolution.name} is not Durable Object-backed`);
  }
  return {
    source: resolution.source,
    className: resolution.className,
    objectKey: resolution.objectKey,
  };
}
