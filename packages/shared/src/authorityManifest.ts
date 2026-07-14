import type { CapabilityScope, ResourceScope } from "@vibestudio/rpc";
import type { BuildRecipe, CanonicalBuildValue } from "./execution/identity.js";

export interface UnitAuthorityManifest {
  /**
   * Capability/resource envelopes requested by this exact executable build.
   * A request is never a grant. Product/user grants still have to intersect it.
   * A trailing `*` is the only supported capability wildcard.
   */
  requests: readonly CapabilityScope[];
}

export const NO_AUTHORITY_REQUESTS: readonly CapabilityScope[] = Object.freeze([]);

export function parseAuthorityRequests(
  value: unknown,
  label = "vibestudio.authority"
): readonly CapabilityScope[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with a requests array`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record["requests"])) {
    throw new Error(`${label} must contain exactly one requests array`);
  }
  const seen = new Set<string>();
  const requests = record["requests"].map((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error(`${label}.requests[${index}] must be a capability scope`);
    }
    const candidate = request as Record<string, unknown>;
    if (
      Object.keys(candidate).some((key) => key !== "capability" && key !== "resource") ||
      typeof candidate["capability"] !== "string"
    ) {
      throw new Error(`${label}.requests[${index}] has an invalid capability scope shape`);
    }
    const capability = canonicalCapabilityPattern(candidate["capability"]);
    const resource = parseResourceScope(candidate["resource"], `${label}.requests[${index}]`);
    const key = `${capability}\0${JSON.stringify(resource)}`;
    if (seen.has(key)) throw new Error(`${label}.requests contains a duplicate scope`);
    seen.add(key);
    return { capability, resource } satisfies CapabilityScope;
  });
  return Object.freeze(
    requests.sort((a, b) =>
      `${a.capability}\0${JSON.stringify(a.resource)}`.localeCompare(
        `${b.capability}\0${JSON.stringify(b.resource)}`
      )
    )
  );
}

export function authorityRequestsFromManifest(
  manifest: { authority?: unknown },
  label: string
): readonly CapabilityScope[] {
  if (manifest.authority === undefined) {
    throw new Error(`${label} must declare vibestudio.authority.requests`);
  }
  return parseAuthorityRequests(manifest.authority, `${label} vibestudio.authority`);
}

export function authorityRequestsFromRecipe(recipe: BuildRecipe): readonly CapabilityScope[] {
  const raw = recipe.options["authorityRequests"];
  if (!Array.isArray(raw)) {
    throw new Error("Execution recipe is missing immutable authority requests");
  }
  return parseAuthorityRequests(
    { requests: raw },
    `execution recipe ${recipe.target} authorityRequests`
  );
}

export function authorityRequestsAsBuildValue(
  requests: readonly CapabilityScope[]
): readonly CanonicalBuildValue[] {
  return requests.map(
    (scope): CanonicalBuildValue => ({
      capability: scope.capability,
      resource:
        scope.resource.kind === "exact"
          ? { kind: "exact", key: scope.resource.key }
          : scope.resource.kind === "prefix"
            ? { kind: "prefix", prefix: scope.resource.prefix }
            : scope.resource.kind === "origin"
              ? { kind: "origin", origin: scope.resource.origin }
              : scope.resource.kind === "domain"
                ? { kind: "domain", domain: scope.resource.domain }
                : { kind: "network", value: "*" },
    })
  );
}

export function capabilityPatternCovers(pattern: string, capability: string): boolean {
  if (!pattern.endsWith("*")) return pattern === capability;
  return capability.startsWith(pattern.slice(0, -1));
}

function canonicalCapabilityPattern(value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/#-]*(?:\*)?$/.test(value) ||
    value.slice(0, -1).includes("*")
  ) {
    throw new Error(`Invalid capability pattern: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseResourceScope(value: unknown, label: string): ResourceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.resource must be an exact or prefix scope`);
  }
  const scope = value as Record<string, unknown>;
  if (scope["kind"] === "exact") {
    if (Object.keys(scope).length !== 2 || typeof scope["key"] !== "string" || !scope["key"]) {
      throw new Error(`${label}.resource exact scope requires a non-empty key`);
    }
    return { kind: "exact", key: scope["key"] };
  }
  if (scope["kind"] === "prefix") {
    if (Object.keys(scope).length !== 2 || typeof scope["prefix"] !== "string") {
      throw new Error(`${label}.resource prefix scope requires a prefix string`);
    }
    return { kind: "prefix", prefix: scope["prefix"] };
  }
  if (scope["kind"] === "origin") {
    if (Object.keys(scope).length !== 2 || typeof scope["origin"] !== "string") {
      throw new Error(`${label}.resource origin scope requires an origin string`);
    }
    return { kind: "origin", origin: scope["origin"] };
  }
  if (scope["kind"] === "domain") {
    if (Object.keys(scope).length !== 2 || typeof scope["domain"] !== "string") {
      throw new Error(`${label}.resource domain scope requires a domain string`);
    }
    return { kind: "domain", domain: scope["domain"] };
  }
  if (scope["kind"] === "network" && Object.keys(scope).length === 2 && scope["value"] === "*") {
    return { kind: "network", value: "*" };
  }
  throw new Error(`${label}.resource has an unsupported scope`);
}
