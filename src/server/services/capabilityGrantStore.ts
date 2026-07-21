import { stateLayout } from "../stateLayout.js";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { ApprovalResourceScope } from "@vibestudio/shared/approvals";
import {
  loadVersionedJsonFile,
  saveVersionedJsonFile,
  type VersionedJsonCodec,
} from "../hostCore/versionedJsonStore.js";

export type CapabilityGrantDecision = "session" | "version";

export interface CapabilityGrantIdentity {
  callerId: string;
  repoPath: string;
  effectiveVersion: string;
}

export interface CapabilityGrant {
  effect?: "allow" | "deny";
  capability: string;
  resourceKey: string;
  resourceScope?: ApprovalResourceScope;
  scope: CapabilityGrantDecision;
  callerId?: string;
  repoPath: string;
  effectiveVersion?: string;
  grantedAt: number;
}

interface CapabilityGrantFile {
  grants: CapabilityGrant[];
}

const CAPABILITY_GRANT_SCHEMA_VERSION = 1;

const CAPABILITY_GRANT_CODEC: VersionedJsonCodec<CapabilityGrantFile> = {
  schemaName: "Capability grant store",
  currentVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
  decodeCurrent(value) {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "schemaVersion" && key !== "grants") ||
      !Array.isArray(record["grants"]) ||
      !record["grants"].every(isPersistentCapabilityGrant)
    ) {
      throw new Error("versioned grant store contains invalid data");
    }
    return { grants: record["grants"] };
  },
  unversionedMigration: {
    version: 1,
    name: "recognize-pre-versioning-capability-grants",
    migrate(value) {
      if (!isCapabilityGrantFile(value)) {
        throw new Error("legacy grant store does not match the recognized { grants } schema");
      }
      return { grants: value.grants };
    },
  },
  encode: (value) => ({ grants: value.grants }),
};

export class CapabilityGrantStore {
  private readonly sessionGrants = new Map<string, CapabilityGrant>();
  private readonly filePath: string;
  private persistent: CapabilityGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = stateLayout(opts.statePath).capabilityGrantsFile;
    this.load();
  }

  hasGrant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    resourceScope?: ApprovalResourceScope
  ): boolean {
    const requestedScope = resourceScope ?? exactResourceScope(resourceKey);
    return (
      Array.from(this.sessionGrants.values()).some(
        (grant) =>
          grant.effect !== "deny" &&
          grantMatches(grant, capability, resourceKey, requestedScope, identity)
      ) ||
      this.persistent.grants.some(
        (grant) =>
          grant.effect !== "deny" &&
          grantMatches(grant, capability, resourceKey, requestedScope, identity)
      )
    );
  }

  grant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    scope: CapabilityGrantDecision,
    resourceScope?: ApprovalResourceScope,
    now = Date.now(),
    effect: "allow" | "deny" = "allow"
  ): void {
    const normalizedScope = resourceScope ?? exactResourceScope(resourceKey);
    if (scope === "session") {
      const next: CapabilityGrant = {
        capability,
        resourceKey,
        resourceScope: normalizedScope,
        scope,
        callerId: identity.callerId,
        repoPath: identity.repoPath,
        grantedAt: now,
        effect,
      };
      this.sessionGrants.set(capabilityGrantKey(scope, capability, resourceKey, identity), next);
      return;
    }
    const next: CapabilityGrant = {
      capability,
      resourceKey,
      resourceScope: normalizedScope,
      scope,
      callerId:
        scope === "version" && versionGrantRequiresCaller(identity) ? identity.callerId : undefined,
      repoPath: identity.repoPath,
      effectiveVersion: scope === "version" ? identity.effectiveVersion : undefined,
      grantedAt: now,
      effect,
    };
    this.persistent.grants = [
      ...this.persistent.grants.filter(
        (grant) =>
          !(
            grant.capability === next.capability &&
            grant.resourceKey === next.resourceKey &&
            grant.scope === next.scope &&
            grant.callerId === next.callerId &&
            grant.repoPath === next.repoPath &&
            grant.effectiveVersion === next.effectiveVersion
          )
      ),
      next,
    ];
    this.save();
  }

  hasDenial(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    resourceScope?: ApprovalResourceScope
  ): boolean {
    const requestedScope = resourceScope ?? exactResourceScope(resourceKey);
    return (
      Array.from(this.sessionGrants.values()).some(
        (grant) =>
          grant.effect === "deny" &&
          grantMatches(grant, capability, resourceKey, requestedScope, identity)
      ) ||
      this.persistent.grants.some(
        (grant) =>
          grant.effect === "deny" &&
          grantMatches(grant, capability, resourceKey, requestedScope, identity)
      )
    );
  }

  /** Durable grants only; session decisions intentionally disappear at restart. */
  listPersistent(): CapabilityGrant[] {
    return this.persistent.grants.map((grant) => ({ ...grant }));
  }

  /** Active in-memory decisions, exposed so the trusted Permissions page can revoke them. */
  listSession(): CapabilityGrant[] {
    return Array.from(this.sessionGrants.values(), (grant) => ({ ...grant }));
  }

  revokeSession(id: string): boolean {
    for (const [key, grant] of this.sessionGrants) {
      if (capabilityGrantId(grant) !== id) continue;
      this.sessionGrants.delete(key);
      return true;
    }
    return false;
  }

  revokePersistent(id: string): boolean {
    const before = this.persistent.grants.length;
    this.persistent.grants = this.persistent.grants.filter(
      (grant) => capabilityGrantId(grant) !== id
    );
    if (this.persistent.grants.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    try {
      this.persistent = loadVersionedJsonFile(this.filePath, CAPABILITY_GRANT_CODEC) ?? {
        grants: [],
      };
    } catch (error) {
      throw new Error(
        `Capability grant store ${this.filePath} cannot be loaded without risking data loss: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  private save(): void {
    saveVersionedJsonFile(this.filePath, this.persistent, CAPABILITY_GRANT_CODEC);
  }
}

function isCapabilityGrantFile(value: unknown): value is CapabilityGrantFile {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray((value as { grants?: unknown }).grants) &&
    (value as { grants: unknown[] }).grants.every(isPersistentCapabilityGrant)
  );
}

function isPersistentCapabilityGrant(value: unknown): value is CapabilityGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Partial<CapabilityGrant>;
  const allowedKeys = new Set([
    "capability",
    "resourceKey",
    "resourceScope",
    "scope",
    "callerId",
    "repoPath",
    "effectiveVersion",
    "grantedAt",
    "effect",
  ]);
  return (
    Object.keys(grant).every((key) => allowedKeys.has(key)) &&
    typeof grant.capability === "string" &&
    typeof grant.resourceKey === "string" &&
    isApprovalResourceScope(grant.resourceScope) &&
    grant.scope === "version" &&
    (grant.callerId === undefined || typeof grant.callerId === "string") &&
    typeof grant.repoPath === "string" &&
    typeof grant.effectiveVersion === "string" &&
    (grant.effect === undefined || grant.effect === "allow" || grant.effect === "deny") &&
    Number.isFinite(grant.grantedAt) &&
    (!versionGrantRequiresCaller({
      callerId: grant.callerId ?? "",
      repoPath: grant.repoPath,
      effectiveVersion: grant.effectiveVersion,
    }) ||
      typeof grant.callerId === "string")
  );
}

function isApprovalResourceScope(value: unknown): value is ApprovalResourceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope["kind"] === "exact") {
    return (
      Object.keys(scope).every((key) => key === "kind" || key === "key" || key === "label") &&
      typeof scope["key"] === "string" &&
      (scope["label"] === undefined || typeof scope["label"] === "string")
    );
  }
  if (scope["kind"] === "origin") {
    return Object.keys(scope).length === 2 && typeof scope["origin"] === "string";
  }
  if (scope["kind"] === "domain") {
    return Object.keys(scope).length === 2 && typeof scope["domain"] === "string";
  }
  return scope["kind"] === "network" && Object.keys(scope).length === 2 && scope["value"] === "*";
}

export function capabilityGrantId(grant: CapabilityGrant): string {
  return canonicalKey([
    "capability-grant-record",
    grant.scope,
    grant.capability,
    grant.resourceKey,
    grant.callerId ?? "",
    grant.repoPath,
    grant.effectiveVersion ?? "",
    JSON.stringify(grant.resourceScope ?? null),
    grant.effect ?? "allow",
  ]);
}

export function capabilityGrantKey(
  scope: CapabilityGrantDecision,
  capability: string,
  resourceKey: string,
  identity: CapabilityGrantIdentity
): string {
  return canonicalKey([
    "capability-grant",
    scope,
    capability,
    resourceKey,
    scope === "session" || (scope === "version" && versionGrantRequiresCaller(identity))
      ? identity.callerId
      : "",
    identity.repoPath,
    scope === "version" ? identity.effectiveVersion : "",
  ]);
}

export function versionGrantRequiresCaller(identity: CapabilityGrantIdentity): boolean {
  return identity.effectiveVersion === "internal" || identity.repoPath === "vibestudio/internal";
}

function grantMatches(
  grant: CapabilityGrant,
  capability: string,
  resourceKey: string,
  requestedScope: ApprovalResourceScope,
  identity: CapabilityGrantIdentity
): boolean {
  return (
    grant.capability === capability &&
    resourceScopeCovers(
      grant.resourceScope ?? exactResourceScope(grant.resourceKey),
      requestedScope,
      resourceKey
    ) &&
    principalScopeMatches(grant, identity)
  );
}

function principalScopeMatches(grant: CapabilityGrant, identity: CapabilityGrantIdentity): boolean {
  if (grant.scope === "session") {
    return grant.callerId === identity.callerId;
  }
  if (
    grant.repoPath !== identity.repoPath ||
    grant.effectiveVersion !== identity.effectiveVersion
  ) {
    return false;
  }
  if (versionGrantRequiresCaller(identity)) {
    return grant.callerId === identity.callerId;
  }
  return grant.callerId === undefined || grant.callerId === identity.callerId;
}

function exactResourceScope(key: string): ApprovalResourceScope {
  return { kind: "exact", key };
}

function resourceScopeCovers(
  granted: ApprovalResourceScope,
  requested: ApprovalResourceScope,
  requestedKey: string
): boolean {
  if (granted.kind === "network") {
    return (
      requested.kind === "network" || requested.kind === "origin" || requested.kind === "domain"
    );
  }
  if (granted.kind === "domain") {
    if (requested.kind === "domain") {
      return domainCovers(granted.domain, requested.domain);
    }
    if (requested.kind === "origin") {
      const hostname = originHostname(requested.origin);
      return hostname ? domainCovers(granted.domain, hostname) : false;
    }
    return false;
  }
  if (granted.kind === "origin") {
    return requested.kind === "origin" && requested.origin === granted.origin;
  }
  return requested.kind === "exact" ? granted.key === requested.key : granted.key === requestedKey;
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
