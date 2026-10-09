import type { WorkspaceRouteDecl, WorkspaceServiceDecl } from "./types.js";

/** Declaration paths use the same segments as the route dispatch pattern. */
export function normalizeRoutePath(path: string): string {
  return `/${path.trim().split("/").filter(Boolean).join("/")}`;
}

export function hasWorkspaceWorkerRoute(
  routes: readonly WorkspaceRouteDecl[],
  source: string,
  path: string
): boolean {
  const normalized = normalizeRoutePath(path);
  return routes.some(
    (route) =>
      route.source === source &&
      route.worker === true &&
      !route.durableObject &&
      normalizeRoutePath(route.path) === normalized
  );
}

export function requireWorkspaceWorkerRoute(
  routes: readonly WorkspaceRouteDecl[],
  source: string,
  path: string,
  owner: string
): string {
  const normalized = normalizeRoutePath(path);
  if (!hasWorkspaceWorkerRoute(routes, source, normalized)) {
    throw new Error(
      `${owner} references stateless worker route ${normalized}, but that route is not declared for ${source}`
    );
  }
  return normalized;
}

/** Validate HTTP ownership in the joined manifest before exposing a service. */
export function validateWorkspaceRoutes(
  routes: readonly WorkspaceRouteDecl[],
  services: readonly WorkspaceServiceDecl[]
): void {
  for (const route of routes) {
    if (Boolean(route.durableObject) === (route.worker === true)) {
      throw new Error(
        `Workspace route ${route.source} ${route.path} must set exactly one of durableObject or worker: true`
      );
    }
  }
  for (const service of services) {
    if (service.worker) {
      requireWorkspaceWorkerRoute(
        routes,
        service.source,
        service.worker.routePath,
        `Workspace service ${service.name}`
      );
    }
  }
}
