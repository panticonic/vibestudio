import type { CapabilityScope, ResourceScope } from "@vibestudio/rpc";
import type { BuildRecipe, CanonicalBuildValue } from "./execution/identity.js";

export interface UnitAuthorityManifest {
  /**
   * Capability/resource envelopes requested by this exact executable build.
   * A request is never a grant. Product/user grants still have to intersect it.
   * A trailing `*` is the only supported capability wildcard.
   */
  requests: readonly UnitAuthorityRequest[];
}

export type AuthorityRequestTier = "gated" | "critical";
export type AuthorityEvidenceClass = "exact" | "bounded-dynamic" | "intentional-broad";

export interface UnitAuthorityRequest extends CapabilityScope {
  tier: AuthorityRequestTier;
  evidence: AuthorityEvidenceClass;
  /** Dependency packages initially routed this endowment; absent means first-party code only. */
  packages?: readonly string[];
}

export const NO_AUTHORITY_REQUESTS: readonly UnitAuthorityRequest[] = Object.freeze([]);

/**
 * Host runtime protocol used by every extension bundle, independently of the
 * extension's own source. These requests are sealed into the effective build
 * authority because childRuntime performs them as part of activation.
 */
export function parseAuthorityRequests(
  value: unknown,
  label = "vibestudio.authority",
  options: { allowCapabilityWildcards?: boolean } = {}
): readonly UnitAuthorityRequest[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with a requests array`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["requests"])) {
    throw new Error(`${label} must contain a requests array`);
  }
  const seen = new Set<string>();
  const requests = record["requests"].map((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error(`${label}.requests[${index}] must be a capability scope`);
    }
    const candidate = request as Record<string, unknown>;
    const requestLabel = `${label}.requests[${index}]`;
    const unknownKeys = Object.keys(candidate).filter(
      (key) => !["capability", "resource", "tier", "evidence", "packages"].includes(key)
    );
    if (unknownKeys.length > 0) {
      throw new Error(`${requestLabel} has unknown field(s): ${unknownKeys.join(", ")}`);
    }
    if (typeof candidate["capability"] !== "string") {
      throw new Error(`${requestLabel}.capability must be a string`);
    }
    if (!(["gated", "critical"] as const).includes(candidate["tier"] as never)) {
      throw new Error(
        `${requestLabel}.tier must be "gated" or "critical"; RPC receiver tier "open" is not a manifest request tier`
      );
    }
    if (
      !(["exact", "bounded-dynamic", "intentional-broad"] as const).includes(
        candidate["evidence"] as never
      )
    ) {
      throw new Error(
        `${requestLabel}.evidence must be "exact", "bounded-dynamic", or "intentional-broad"`
      );
    }
    const capability = canonicalCapabilityPattern(
      candidate["capability"],
      options.allowCapabilityWildcards === true
    );
    const resource = parseResourceScope(candidate["resource"], requestLabel);
    const packages = parsePackages(candidate["packages"], requestLabel);
    const evidence = candidate["evidence"] as AuthorityEvidenceClass;
    if (evidence === "exact" && resource.kind !== "exact") {
      throw new Error(`${label}.requests[${index}] exact evidence requires an exact resource`);
    }
    if (
      evidence === "intentional-broad" &&
      !(resource.kind === "prefix" && resource.prefix === "") &&
      resource.kind !== "network"
    ) {
      throw new Error(`${label}.requests[${index}] intentional-broad evidence requires a broad resource`);
    }
    const tier = candidate["tier"] as AuthorityRequestTier;
    const key = `${capability}\0${tier}\0${JSON.stringify(resource)}\0${JSON.stringify(packages)}`;
    if (seen.has(key)) throw new Error(`${label}.requests contains a duplicate scope`);
    seen.add(key);
    return {
      capability,
      resource,
      tier,
      evidence,
      ...(packages ? { packages } : {}),
    } satisfies UnitAuthorityRequest;
  });
  return Object.freeze(
    requests.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}

export function parseUnitAuthorityManifest(
  value: unknown,
  label = "vibestudio.authority"
): UnitAuthorityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const unknownKeys = keys.filter((key) => key !== "requests");
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (keys.length === 0) {
    throw new Error(`${label} must contain a requests array`);
  }
  return Object.freeze({
    requests: parseAuthorityRequests(value, label),
  });
}

export function authorityRequestsFromManifest(
  manifest: { authority?: unknown },
  label: string
): readonly UnitAuthorityRequest[] {
  if (manifest.authority === undefined) {
    throw new Error(`${label} must declare vibestudio.authority.requests`);
  }
  return parseUnitAuthorityManifest(manifest.authority, `${label} vibestudio.authority`).requests;
}

export function authorityRequestsFromRecipe(recipe: BuildRecipe): readonly UnitAuthorityRequest[] {
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
  requests: readonly UnitAuthorityRequest[]
): readonly CanonicalBuildValue[] {
  return requests.map(
    (scope): CanonicalBuildValue => ({
      capability: scope.capability,
      tier: scope.tier,
      evidence: scope.evidence,
      ...(scope.packages ? { packages: [...scope.packages] } : {}),
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

function parsePackages(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry !== entry.trim() ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(entry)
    )
  ) {
    throw new Error(`${label}.packages must be a non-empty package-name array`);
  }
  const packages = [...new Set(value)].sort();
  if (packages.length !== value.length) throw new Error(`${label}.packages contains duplicates`);
  return Object.freeze(packages);
}

export function capabilityPatternCovers(pattern: string, capability: string): boolean {
  if (!pattern.endsWith("*")) return pattern === capability;
  return capability.startsWith(pattern.slice(0, -1));
}

function canonicalCapabilityPattern(value: string, allowWildcard = false): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/#-]*(?:\*)?$/.test(value) ||
    value.slice(0, -1).includes("*") ||
    (!allowWildcard && value.endsWith("*"))
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
