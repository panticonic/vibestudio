import type { CapabilityScope, ResourceScope } from "@vibestudio/rpc";
import type { BuildRecipe, CanonicalBuildValue } from "./execution/identity.js";
import type { AuthorityDomainId, AuthorityVerb } from "./authority/authorityDomains.js";
import type { CapabilityNotability } from "./authority/capabilityNotability.js";

export interface UnitAuthorityManifest {
  /**
   * Capability/resource envelopes requested by this exact executable build.
   * A request is never a grant. Product/user grants still have to intersect it.
   * A trailing `*` is the only supported capability wildcard.
   */
  requests: readonly UnitAuthorityRequest[];
  /**
   * Stable service protocols this unit may resolve. These declarations build
   * the review dependency index; they are not grants. Admission and runtime
   * enforcement remain bound to the concrete workspace-service provider.
   */
  serviceRequests?: readonly WorkspaceServiceProtocolRequest[];
  /** Receiver-owned capabilities provided by this exact executable build. */
  provides: readonly UserlandCapabilityDefinition[];
}

export interface WorkspaceServiceProtocolRequest {
  protocol: string;
  availability: "required" | "optional";
}

export type UserlandGrantScope = "once" | "task" | "agent" | "mission" | "version" | "session";

export interface UserlandCapabilityDefinition {
  name: string;
  title: string;
  action: string;
  description?: string;
  tier: "gated" | "critical";
  sensitivity: "read" | "write" | "admin" | "destructive";
  resourceType: string;
  /** Provider-authored classification shown with immutable issuer chrome. */
  presentation: { domain: AuthorityDomainId; verb: AuthorityVerb };
  /**
   * Whether a reasonable non-technical person would want to know a part can do
   * this before adding it. Provider-authored and required: the platform may
   * promote a definition to `headline`, never demote it
   * (docs/template-install-unit-approval-ux-plan.md §10, U4).
   */
  notability: CapabilityNotability;
  grantScopes: readonly UserlandGrantScope[];
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
export const NO_SERVICE_PROTOCOL_REQUESTS: readonly WorkspaceServiceProtocolRequest[] =
  Object.freeze([]);
export const NO_USERLAND_CAPABILITIES: readonly UserlandCapabilityDefinition[] = Object.freeze([]);

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
    const userlandDefinitionFamily = isUserlandDefinitionFamilyPattern(candidate["capability"]);
    const capability = canonicalCapabilityPattern(
      candidate["capability"],
      options.allowCapabilityWildcards === true || userlandDefinitionFamily
    );
    const resource = parseResourceScope(candidate["resource"], requestLabel);
    const packages = parsePackages(candidate["packages"], requestLabel);
    const evidence = candidate["evidence"] as AuthorityEvidenceClass;
    if (userlandDefinitionFamily && evidence !== "bounded-dynamic") {
      throw new Error(
        `${label}.requests[${index}] a provider-bound userland definition family requires bounded-dynamic evidence`
      );
    }
    if (evidence === "exact" && resource.kind !== "exact") {
      throw new Error(`${label}.requests[${index}] exact evidence requires an exact resource`);
    }
    if (
      evidence === "intentional-broad" &&
      !(resource.kind === "prefix" && resource.prefix === "") &&
      resource.kind !== "network"
    ) {
      throw new Error(
        `${label}.requests[${index}] intentional-broad evidence requires a broad resource`
      );
    }
    const tier = candidate["tier"] as AuthorityRequestTier;
    // Tier is presentation/policy metadata, not a second capability scope.
    // Allowing the same capability/resource once as gated and once as critical
    // creates two review rows with one runtime identity and lets clearance
    // classification select the wrong tier. Package routing is likewise not
    // part of the runtime grant identity.
    const key = `${capability}\0${JSON.stringify(resource)}`;
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
  return Object.freeze(requests.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
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
  const unknownKeys = keys.filter(
    (key) => key !== "requests" && key !== "serviceRequests" && key !== "provides"
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, "requests")) {
    throw new Error(`${label} must contain a requests array`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, "provides")) {
    throw new Error(`${label} must contain a provides array`);
  }
  return Object.freeze({
    requests: parseAuthorityRequests(value, label),
    serviceRequests: parseWorkspaceServiceProtocolRequests(record["serviceRequests"], label),
    provides: parseUserlandCapabilities(record["provides"], label),
  });
}

export function parseWorkspaceServiceProtocolRequests(
  value: unknown,
  label = "vibestudio.authority"
): readonly WorkspaceServiceProtocolRequest[] {
  // An omitted collection has the same stable meaning as an empty collection.
  // There is no permissive fallback: code that resolves a service is rejected
  // by the per-unit proof unless its exact protocol appears here.
  if (value === undefined) return NO_SERVICE_PROTOCOL_REQUESTS;
  if (!Array.isArray(value)) throw new Error(`${label}.serviceRequests must be an array`);
  const seen = new Set<string>();
  const requests = value.map((entry, index) => {
    const entryLabel = `${label}.serviceRequests[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const unknown = Object.keys(candidate).filter(
      (key) => key !== "protocol" && key !== "availability"
    );
    if (unknown.length > 0) {
      throw new Error(`${entryLabel} has unknown field(s): ${unknown.join(", ")}`);
    }
    if (typeof candidate["protocol"] !== "string") {
      throw new Error(`${entryLabel}.protocol must be a string`);
    }
    const protocol = candidate["protocol"].trim();
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(protocol)) {
      throw new Error(`${entryLabel}.protocol is not a canonical protocol identifier`);
    }
    if (candidate["availability"] !== "required" && candidate["availability"] !== "optional") {
      throw new Error(`${entryLabel}.availability must be "required" or "optional"`);
    }
    if (seen.has(protocol)) {
      throw new Error(`${label}.serviceRequests contains duplicate protocol ${protocol}`);
    }
    seen.add(protocol);
    return {
      protocol,
      availability: candidate["availability"],
    } satisfies WorkspaceServiceProtocolRequest;
  });
  return Object.freeze(requests.sort((a, b) => a.protocol.localeCompare(b.protocol)));
}

export function parseUserlandCapabilities(
  value: unknown,
  label = "vibestudio.authority"
): readonly UserlandCapabilityDefinition[] {
  if (!Array.isArray(value)) throw new Error(`${label}.provides must be an array`);
  const seen = new Set<string>();
  const definitions = value.map((entry, index) => {
    const entryLabel = `${label}.provides[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const allowed = new Set([
      "name",
      "title",
      "action",
      "description",
      "tier",
      "sensitivity",
      "resourceType",
      "presentation",
      "notability",
      "grantScopes",
    ]);
    const unknown = Object.keys(candidate).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(`${entryLabel} has unknown field(s): ${unknown.join(", ")}`);
    }
    const name = boundedCapabilityText(candidate["name"], `${entryLabel}.name`, 96);
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(name)) {
      throw new Error(`${entryLabel}.name is not a canonical local capability name`);
    }
    if (seen.has(name)) throw new Error(`${label}.provides contains duplicate capability ${name}`);
    seen.add(name);
    const title = boundedCapabilityText(candidate["title"], `${entryLabel}.title`, 120);
    const action = boundedCapabilityText(candidate["action"], `${entryLabel}.action`, 240);
    const description =
      candidate["description"] === undefined
        ? undefined
        : boundedCapabilityText(candidate["description"], `${entryLabel}.description`, 500);
    const tier = candidate["tier"];
    if (tier !== "gated" && tier !== "critical") {
      throw new Error(`${entryLabel}.tier must be "gated" or "critical"`);
    }
    const sensitivity = candidate["sensitivity"];
    if (!["read", "write", "admin", "destructive"].includes(String(sensitivity))) {
      throw new Error(`${entryLabel}.sensitivity is invalid`);
    }
    const resourceType = boundedCapabilityText(
      candidate["resourceType"],
      `${entryLabel}.resourceType`,
      96
    );
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(resourceType)) {
      throw new Error(`${entryLabel}.resourceType is not canonical`);
    }
    const presentation = candidate["presentation"];
    if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) {
      throw new Error(`${entryLabel}.presentation must declare a domain and verb`);
    }
    const presentationRecord = presentation as Record<string, unknown>;
    const presentationUnknown = Object.keys(presentationRecord).filter(
      (key) => key !== "domain" && key !== "verb"
    );
    if (presentationUnknown.length > 0) {
      throw new Error(
        `${entryLabel}.presentation has unknown field(s): ${presentationUnknown.join(", ")}`
      );
    }
    const domain = presentationRecord["domain"];
    const verb = presentationRecord["verb"];
    if (
      ![
        "files",
        "web",
        "sharing",
        "accounts",
        "automation",
        "people",
        "computer",
        "safety",
      ].includes(String(domain))
    ) {
      throw new Error(`${entryLabel}.presentation.domain is invalid`);
    }
    if (!["see", "act", "manage"].includes(String(verb))) {
      throw new Error(`${entryLabel}.presentation.verb is invalid`);
    }
    if (domain === "safety") {
      throw new Error(`${entryLabel}.presentation cannot declare the Safety controls domain`);
    }
    const notability = candidate["notability"];
    if (notability !== "headline" && notability !== "everyday") {
      throw new Error(`${entryLabel}.notability must be "headline" or "everyday"`);
    }
    if (!Array.isArray(candidate["grantScopes"]) || candidate["grantScopes"].length === 0) {
      throw new Error(`${entryLabel}.grantScopes must be a non-empty array`);
    }
    const grantScopes = candidate["grantScopes"].map((scope) => String(scope));
    const validScopes = new Set<UserlandGrantScope>([
      "once",
      "task",
      "agent",
      "mission",
      "version",
      "session",
    ]);
    if (
      grantScopes.some((scope) => !validScopes.has(scope as UserlandGrantScope)) ||
      new Set(grantScopes).size !== grantScopes.length
    ) {
      throw new Error(`${entryLabel}.grantScopes contains an invalid or duplicate scope`);
    }
    if (!grantScopes.includes("once")) {
      throw new Error(`${entryLabel}.grantScopes must include "once"`);
    }
    if (
      (tier === "critical" || sensitivity === "destructive") &&
      grantScopes.some((scope) => scope !== "once")
    ) {
      throw new Error(`${entryLabel} critical or destructive authority may offer only once`);
    }
    return Object.freeze({
      name,
      title,
      action,
      ...(description === undefined ? {} : { description }),
      tier,
      sensitivity: sensitivity as UserlandCapabilityDefinition["sensitivity"],
      resourceType,
      presentation: {
        domain: domain as AuthorityDomainId,
        verb: verb as AuthorityVerb,
      },
      // Critical or destructive authority is headline whatever the provider
      // says: the platform promotes, and never lets a receiver fold its own
      // most alarming power away (§10).
      notability:
        tier === "critical" || sensitivity === "destructive"
          ? "headline"
          : (notability as CapabilityNotability),
      grantScopes: Object.freeze([...grantScopes].sort() as UserlandGrantScope[]),
    });
  });
  return Object.freeze(definitions.sort((a, b) => a.name.localeCompare(b.name)));
}

function boundedCapabilityText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be non-empty, trimmed, and at most ${maximum} characters`);
  }
  return value;
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
  const packages = [...new Set(value)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
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

function isUserlandDefinitionFamilyPattern(value: string): boolean {
  if (!/^userland:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+#[*]$/u.test(value)) {
    return false;
  }
  const providerAndName = value.slice("userland:".length, -2);
  return !providerAndName.split("/").some((segment) => segment === "." || segment === "..");
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
