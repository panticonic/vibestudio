import * as fs from "node:fs";
import type { AuthorityGrant, Principal, ResourceScope } from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { ApprovalResourceScope } from "@vibestudio/shared/approvals";
import { parseSha256 } from "@vibestudio/shared/execution/identity";
import { stateLayout } from "../stateLayout.js";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";

export type CapabilityGrantDecision = "session" | "version";

export interface CapabilityGrantIdentity {
  callerId: string;
  repoPath: string;
  executionDigest: string;
}

interface CapabilityGrantFile {
  version: 2;
  grants: AuthorityGrant[];
}

type PersistentGrantBinding = Extract<
  AuthorityGrant["binding"],
  { kind: "exact-execution" | "selector" }
>;

/**
 * The approval system persists the same AuthorityGrant records consumed by the
 * dispatcher. Session records use the identical vocabulary but remain in
 * memory; there is no approval-specific shadow grant representation.
 */
export class CapabilityGrantStore {
  private readonly sessionGrants = new Map<string, AuthorityGrant>();
  private readonly filePath: string;
  private readonly issuer: Principal;
  private persistent: CapabilityGrantFile = { version: 2, grants: [] };

  constructor(opts: { statePath: string; issuer?: Principal }) {
    this.filePath = stateLayout(opts.statePath).capabilityGrantsFile;
    this.issuer = opts.issuer ?? getProductBootManifest().hostPrincipal;
    this.load();
  }

  hasGrant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    resourceScope?: ApprovalResourceScope
  ): boolean {
    return this.hasEffect("allow", capability, resourceKey, identity, resourceScope);
  }

  hasDenial(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    resourceScope?: ApprovalResourceScope
  ): boolean {
    return this.hasEffect("deny", capability, resourceKey, identity, resourceScope);
  }

  grant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    lifetime: CapabilityGrantDecision,
    resourceScope?: ApprovalResourceScope,
    now = Date.now(),
    effect: "allow" | "deny" = "allow",
    issuedBy: Principal = this.issuer,
    provenance = "user-capability-approval"
  ): AuthorityGrant {
    assertExactCodeIdentity(identity);
    const resource = resourceScope ?? exactResourceScope(resourceKey);
    const subject = codePrincipal(identity);
    const next: AuthorityGrant = {
      subject,
      capability,
      resource,
      effect,
      issuedBy,
      createdAt: now,
      constraints: lifetime === "session" ? { sessionId: identity.callerId } : undefined,
      binding:
        lifetime === "session"
          ? {
              kind: "session",
              sessionId: identity.callerId,
              repoPath: identity.repoPath,
              executionDigest: identity.executionDigest,
            }
          : {
              kind: "exact-execution",
              repoPath: identity.repoPath,
              executionDigest: identity.executionDigest,
            },
      provenance: `${provenance}:${lifetime}`,
    };

    const key = capabilityGrantSlot(next);
    if (lifetime === "session") {
      this.sessionGrants.set(key, next);
      return structuredClone(next);
    }

    this.persistent.grants = this.persistent.grants.map((grant) =>
      grant.revokedAt === undefined && capabilityGrantSlot(grant) === key
        ? { ...grant, revokedAt: now }
        : grant
    );
    this.persistent.grants.push(next);
    this.save();
    return structuredClone(next);
  }

  /** Active durable decisions; revoked records remain in the audit file. */
  listPersistent(now = Date.now()): AuthorityGrant[] {
    return this.persistent.grants
      .filter((grant) => isActive(grant, now))
      .map((grant) => structuredClone(grant));
  }

  /** Active in-memory decisions, exposed so the Permissions page can revoke them. */
  listSession(now = Date.now()): AuthorityGrant[] {
    return Array.from(this.sessionGrants.values())
      .filter((grant) => isActive(grant, now))
      .map((grant) => structuredClone(grant));
  }

  revokeSession(id: string): boolean {
    for (const [key, grant] of this.sessionGrants) {
      if (capabilityGrantId(grant) !== id) continue;
      this.sessionGrants.delete(key);
      return true;
    }
    return false;
  }

  revokePersistent(id: string, now = Date.now()): boolean {
    let found = false;
    this.persistent.grants = this.persistent.grants.map((grant) => {
      if (grant.revokedAt !== undefined || capabilityGrantId(grant) !== id) return grant;
      found = true;
      return { ...grant, revokedAt: now };
    });
    if (!found) return false;
    this.save();
    return true;
  }

  private hasEffect(
    effect: AuthorityGrant["effect"],
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    resourceScope?: ApprovalResourceScope
  ): boolean {
    if (!hasExactCodeIdentity(identity)) return false;
    const requested = resourceScope ?? exactResourceScope(resourceKey);
    const now = Date.now();
    return [...this.sessionGrants.values(), ...this.persistent.grants].some(
      (grant) =>
        grant.effect === effect &&
        isActive(grant, now) &&
        grantMatches(grant, capability, resourceKey, requested, identity)
    );
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isCapabilityGrantFile(parsed)) {
        throw new Error(
          `Unsupported capability grant state: ${this.filePath}. Run the scoped runtime-foundations reset before starting the host.`
        );
      }
      this.persistent = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.filePath, this.persistent);
  }
}

export function capabilityGrantId(grant: AuthorityGrant): string {
  return canonicalKey([
    "authority-grant",
    grant.subject,
    grant.capability,
    JSON.stringify(grant.resource),
    grant.effect,
    grant.issuedBy,
    String(grant.createdAt),
    JSON.stringify(grant.binding),
    grant.provenance,
  ]);
}

export function capabilityGrantRepoPath(grant: AuthorityGrant): string | undefined {
  return grant.binding.kind === "principal" ? undefined : grant.binding.repoPath;
}

export function capabilityGrantExecutionDigest(grant: AuthorityGrant): string | undefined {
  switch (grant.binding.kind) {
    case "exact-execution":
    case "session":
      return grant.binding.executionDigest;
    case "selector":
      return grant.binding.resolvedExecutionDigest;
    case "principal":
      return undefined;
  }
}

export function capabilityGrantResourceLabel(resource: ResourceScope): string {
  switch (resource.kind) {
    case "exact":
      return resource.key;
    case "prefix":
      return resource.prefix ? `${resource.prefix}/…` : "All resources";
    case "origin":
      return resource.origin;
    case "domain":
      return `*.${resource.domain}`;
    case "network":
      return "All network destinations";
  }
}

function capabilityGrantSlot(grant: AuthorityGrant): string {
  return canonicalKey([
    "authority-grant-slot",
    grant.subject,
    grant.capability,
    JSON.stringify(grant.resource),
    JSON.stringify(grant.binding),
  ]);
}

function grantMatches(
  grant: AuthorityGrant,
  capability: string,
  resourceKey: string,
  requestedScope: ApprovalResourceScope,
  identity: CapabilityGrantIdentity
): boolean {
  return (
    grant.subject === codePrincipal(identity) &&
    grant.capability === capability &&
    resourceScopeCovers(grant.resource, requestedScope, resourceKey) &&
    bindingMatches(grant, identity)
  );
}

function bindingMatches(grant: AuthorityGrant, identity: CapabilityGrantIdentity): boolean {
  switch (grant.binding.kind) {
    case "session":
      return (
        grant.binding.sessionId === identity.callerId &&
        grant.binding.repoPath === identity.repoPath &&
        grant.binding.executionDigest === identity.executionDigest
      );
    case "exact-execution":
      return (
        grant.binding.repoPath === identity.repoPath &&
        grant.binding.executionDigest === identity.executionDigest
      );
    case "selector":
      // Selector inheritance requires a live resolver proof. This store does not
      // guess from a digest and therefore cannot satisfy one by itself.
      return false;
    case "principal":
      return false;
  }
}

function resourceScopeCovers(
  granted: ResourceScope,
  requested: ApprovalResourceScope,
  requestedKey: string
): boolean {
  switch (granted.kind) {
    case "network":
      return true;
    case "domain": {
      const hostname =
        requested.kind === "domain"
          ? requested.domain
          : requested.kind === "origin"
            ? originHostname(requested.origin)
            : requested.kind === "exact"
              ? originHostname(requested.key)
              : null;
      return hostname ? domainCovers(granted.domain, hostname) : false;
    }
    case "origin":
      return requested.kind === "origin"
        ? requested.origin === granted.origin
        : requested.kind === "exact" && requested.key === granted.origin;
    case "prefix":
      return requestedKey === granted.prefix || requestedKey.startsWith(`${granted.prefix}/`);
    case "exact":
      return requested.kind === "exact"
        ? granted.key === requested.key
        : granted.key === requestedKey;
  }
}

function isCapabilityGrantFile(value: unknown): value is CapabilityGrantFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    Object.keys(file).length === 2 &&
    file["version"] === 2 &&
    Array.isArray(file["grants"]) &&
    file["grants"].every(isAuthorityGrant)
  );
}

function isAuthorityGrant(value: unknown): value is AuthorityGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  const allowed = new Set([
    "subject",
    "capability",
    "resource",
    "effect",
    "issuedBy",
    "createdAt",
    "expiresAt",
    "revokedAt",
    "constraints",
    "binding",
    "provenance",
  ]);
  return (
    Object.keys(grant).every((key) => allowed.has(key)) &&
    isPrincipal(grant["subject"]) &&
    typeof grant["capability"] === "string" &&
    isResourceScope(grant["resource"]) &&
    (grant["effect"] === "allow" || grant["effect"] === "deny") &&
    isPrincipal(grant["issuedBy"]) &&
    isFiniteNumber(grant["createdAt"]) &&
    (grant["expiresAt"] === undefined || isFiniteNumber(grant["expiresAt"])) &&
    (grant["revokedAt"] === undefined || isFiniteNumber(grant["revokedAt"])) &&
    isConstraints(grant["constraints"]) &&
    isPersistentBinding(grant["binding"]) &&
    bindingAgreesWithSubject(grant["binding"], grant["subject"]) &&
    typeof grant["provenance"] === "string"
  );
}

function isResourceScope(value: unknown): value is ResourceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2) return false;
  switch (scope["kind"]) {
    case "exact":
      return typeof scope["key"] === "string";
    case "prefix":
      return typeof scope["prefix"] === "string";
    case "origin":
      return typeof scope["origin"] === "string";
    case "domain":
      return typeof scope["domain"] === "string";
    case "network":
      return scope["value"] === "*";
    default:
      return false;
  }
}

function isPersistentBinding(value: unknown): value is PersistentGrantBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (binding["kind"] === "exact-execution") {
    return (
      Object.keys(binding).length === 3 &&
      typeof binding["repoPath"] === "string" &&
      hasExactDigest(binding["executionDigest"])
    );
  }
  if (binding["kind"] === "selector") {
    return (
      Object.keys(binding).length === 4 &&
      typeof binding["repoPath"] === "string" &&
      typeof binding["selector"] === "string" &&
      hasExactDigest(binding["resolvedExecutionDigest"])
    );
  }
  return false;
}

function bindingAgreesWithSubject(binding: unknown, subject: unknown): boolean {
  if (!isPersistentBinding(binding) || typeof subject !== "string") return false;
  const digest =
    binding.kind === "exact-execution" ? binding.executionDigest : binding.resolvedExecutionDigest;
  return subject === `code:${binding.repoPath}@${digest}`;
}

function isConstraints(value: unknown): value is AuthorityGrant["constraints"] {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const constraints = value as Record<string, unknown>;
  return (
    Object.keys(constraints).every(
      (key) => key === "sessionId" || key === "minVersion" || key === "maxVersion"
    ) &&
    (constraints["sessionId"] === undefined || typeof constraints["sessionId"] === "string") &&
    (constraints["minVersion"] === undefined || typeof constraints["minVersion"] === "string") &&
    (constraints["maxVersion"] === undefined || typeof constraints["maxVersion"] === "string")
  );
}

function codePrincipal(identity: CapabilityGrantIdentity): Principal {
  return `code:${identity.repoPath}@${identity.executionDigest}`;
}

function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === "string" &&
    (/^(host|user|device|entity):.+$/.test(value) || /^code:[^@]+@[0-9a-f]{64}$/.test(value))
  );
}

function isActive(grant: AuthorityGrant, now: number): boolean {
  return (
    (grant.revokedAt === undefined || grant.revokedAt > now) &&
    (grant.expiresAt === undefined || grant.expiresAt > now)
  );
}

function hasExactDigest(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseSha256(value, "capability grant execution digest");
    return true;
  } catch {
    return false;
  }
}

function hasExactCodeIdentity(identity: CapabilityGrantIdentity): boolean {
  return Boolean(
    identity.callerId && identity.repoPath && hasExactDigest(identity.executionDigest)
  );
}

function assertExactCodeIdentity(identity: CapabilityGrantIdentity): void {
  if (!identity.callerId || !identity.repoPath) {
    throw new Error("Capability grant identity requires callerId and repoPath");
  }
  parseSha256(identity.executionDigest, "capability grant execution digest");
}

function exactResourceScope(key: string): ApprovalResourceScope {
  return { kind: "exact", key };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function originHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function domainCovers(grantedDomain: string, requestedDomain: string): boolean {
  return requestedDomain === grantedDomain || requestedDomain.endsWith(`.${grantedDomain}`);
}
