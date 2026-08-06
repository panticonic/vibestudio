import type { ResourceScope } from "@vibestudio/rpc";
import { capabilityPatternCovers } from "../authorityManifest.js";
import { scopeCovers } from "../authorization.js";

/**
 * The canonical resource vocabulary for receiver-owned workspace authority.
 * Runtime handle validation and static manifest checking must use the same
 * fields and codecs; a resource key is not an analyzer-only string.
 */
export interface UserlandReceiverIdentity {
  source: string;
  className: string;
  objectKey?: string;
}

export interface UserlandHandleBinding {
  workspaceId: string;
  canonicalCapability: string;
  definitionDigest: string;
  provider: string;
  receiverSource: string;
  receiverClass: string;
  receiverObjectKey: string;
  resourceType: string;
}

export function userlandReceiverResourceKey(
  resourceType: string,
  source: string,
  className: string,
  objectKey: string
): string {
  return `${resourceType}:do:${source}:${className}:${objectKey}`;
}

export function userlandReceiverResourcePrefix(
  resourceType: string,
  source: string,
  className: string
): string {
  return `${resourceType}:do:${source}:${className}:`;
}

export function userlandHandleResourceKey(resourceType: string, handle: string): string {
  return `${resourceType}:handle:${handle}`;
}

export function userlandHandleResourcePrefix(resourceType: string): string {
  return `${resourceType}:handle:`;
}

export type WorkspaceServiceResourceBinding = {
  source: string;
  target:
    | { kind: "durable-object"; className: string; defaultObjectKey: string | null }
    | { kind: "worker"; routePath: string };
};

export function workspaceServiceResolutionResource(
  binding: WorkspaceServiceResourceBinding,
  objectKeys: readonly string[] | null
): ResourceScope {
  if (binding.target.kind === "worker") {
    return { kind: "exact", key: workspaceWorkerRouteBasePath(binding.source, binding.target.routePath) };
  }
  const keys = objectKeys ?? (binding.target.defaultObjectKey ? [binding.target.defaultObjectKey] : null);
  if (keys && keys.length === 1) {
    return { kind: "exact", key: `do:${binding.source}:${binding.target.className}:${keys[0]}` };
  }
  return {
    kind: "prefix",
    prefix: `do:${binding.source}:${binding.target.className}:`,
  };
}

export function workspaceServiceInvocationResource(
  binding: WorkspaceServiceResourceBinding,
  objectKeys: readonly string[] | null
): ResourceScope {
  if (binding.target.kind === "worker") {
    return { kind: "exact", key: workspaceWorkerRouteBasePath(binding.source, binding.target.routePath) };
  }
  const keys = objectKeys ?? (binding.target.defaultObjectKey ? [binding.target.defaultObjectKey] : null);
  if (keys && keys.length === 1) {
    return { kind: "exact", key: `do:${binding.source}:${binding.target.className}:${keys[0]}` };
  }
  return { kind: "prefix", prefix: `do:${binding.source}:${binding.target.className}:` };
}

function workspaceWorkerRouteBasePath(source: string, routePath: string): string {
  const trimmed = routePath.trim();
  const normalized = !trimmed || trimmed === "/" ? "/" : trimmed.startsWith("/") ? trimmed.replace(/\/+$/u, "") : `/${trimmed.replace(/\/+$/u, "")}`;
  return `/_r/w/${source}${normalized === "/" ? "" : normalized}`;
}


export function userlandReceiverResourceScope(
  resourceType: string,
  receiver: UserlandReceiverIdentity,
  objectKeys: readonly string[] | null
): ResourceScope {
  if (objectKeys && objectKeys.length === 1) {
    return {
      kind: "exact",
      key: userlandReceiverResourceKey(
        resourceType,
        receiver.source,
        receiver.className,
        objectKeys[0]!
      ),
    };
  }
  return {
    kind: "prefix",
    prefix: userlandReceiverResourcePrefix(resourceType, receiver.source, receiver.className),
  };
}

/**
 * Compare the complete opaque-handle binding enforced by the runtime store.
 * `receiverObjectKey` may be abstracted by callers, but when both sides are
 * concrete this is deliberately exact.
 */
export function userlandHandleBindingMatches(
  actual: UserlandHandleBinding,
  expected: UserlandHandleBinding
): boolean {
  return (
    actual.workspaceId === expected.workspaceId &&
    actual.canonicalCapability === expected.canonicalCapability &&
    actual.definitionDigest === expected.definitionDigest &&
    actual.provider === expected.provider &&
    actual.receiverSource === expected.receiverSource &&
    actual.receiverClass === expected.receiverClass &&
    actual.receiverObjectKey === expected.receiverObjectKey &&
    actual.resourceType === expected.resourceType
  );
}

export interface AuthorityEffectCoverageInput {
  capability: string;
  tier: "gated" | "critical";
  resource?: ResourceScope;
  packageName?: string;
}

/**
 * Shared static coverage comparator. Host effects may omit a resource because
 * their reviewed catalog historically compares semantic capability only;
 * userland effects always provide one.
 */
export function authorityRequestCoversEffect(
  request: {
    capability: string;
    tier: "gated" | "critical";
    resource: ResourceScope;
    packages?: readonly string[];
  },
  effect: AuthorityEffectCoverageInput
): boolean {
  if (request.tier !== effect.tier) return false;
  if (!capabilityPatternCovers(request.capability, effect.capability)) return false;
  if (effect.resource && !resourceScopeCoversRequired(request.resource, effect.resource)) {
    return false;
  }
  if (effect.packageName !== undefined) {
    return request.packages?.includes(effect.packageName) === true;
  }
  return true;
}

/** Structural envelope comparison used for static required scopes. */
export function resourceScopeCoversRequired(
  declared: ResourceScope,
  required: ResourceScope
): boolean {
  if (required.kind === "exact") return scopeCovers(declared, required.key);
  if (declared.kind !== required.kind) return false;
  switch (declared.kind) {
    case "prefix":
      return required.kind === "prefix" && required.prefix.startsWith(declared.prefix);
    case "origin":
      return required.kind === "origin" && declared.origin === required.origin;
    case "domain":
      return required.kind === "domain" && declared.domain === required.domain;
    case "network":
      return required.kind === "network";
  }
}
