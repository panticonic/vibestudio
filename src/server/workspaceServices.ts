import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  type DORefParam,
} from "@vibestudio/shared/workspaceServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@vibestudio/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";
import { SEMANTIC_CONTROL_PLANE } from "./internalDOs/controlPlane.js";

export interface WorkspaceServicePolicy {
  allowed?: CallerKind[];
}

export interface WorkspaceServiceResolution {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
  policy?: WorkspaceServicePolicy;
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
  const controlPlane = resolveSemanticControlPlane(query, objectKey);
  if (controlPlane) return controlPlane;
  for (const service of decls.services) {
    const protocols = service.protocols ?? [];
    if (service.name !== query && !protocols.includes(query)) continue;
    return buildResolution(service, decls.singletons, objectKey ?? null, decls.routes);
  }
  throw new Error(`No workspace service registered for ${query}`);
}

function resolveSemanticControlPlane(
  query: string,
  objectKey: string | null | undefined
): DurableObjectServiceResolution | null {
  const isGad = query === "gad.workspace" || query === GAD_WORKSPACE_SERVICE_PROTOCOL;
  if (!isGad) return null;
  if (objectKey != null && objectKey !== SEMANTIC_CONTROL_PLANE.objectKey) {
    throw new Error(
      `The semantic control plane has one sealed object key (${SEMANTIC_CONTROL_PLANE.objectKey}); ` +
        `caller-supplied key ${JSON.stringify(objectKey)} is not permitted`
    );
  }
  return {
    kind: "durable-object",
    name: "gad.workspace",
    title: "GAD workspace graph",
    description: "Product-sealed semantic workspace authority",
    protocols: [GAD_WORKSPACE_SERVICE_PROTOCOL],
    source: SEMANTIC_CONTROL_PLANE.source,
    policy: {
      allowed: ["app", "panel", "shell", "server", "worker", "do"],
    },
    className: SEMANTIC_CONTROL_PLANE.className,
    objectKey: SEMANTIC_CONTROL_PLANE.objectKey,
    targetId: `do:${SEMANTIC_CONTROL_PLANE.source}:${SEMANTIC_CONTROL_PLANE.className}:${SEMANTIC_CONTROL_PLANE.objectKey}`,
  };
}

function buildResolution(
  service: WorkspaceServiceDecl,
  singletons: SingletonRegistry,
  overrideObjectKey: string | null,
  routes: WorkspaceDeclarations["routes"]
): ResolvedWorkspaceService {
  const protocols = service.protocols ?? [];
  const policy = service.policy as WorkspaceServicePolicy | undefined;
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
      `Workspace service ${service.name} references stateless worker route ${routePath}, but that route is not declared`
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
