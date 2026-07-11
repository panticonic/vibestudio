import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { ApprovalResourceScope } from "@vibestudio/shared/approvals";
import { writeJsonFileAtomic } from "./atomicFile.js";

export type CapabilityGrantDecision = "session" | "version";

export interface CapabilityGrantIdentity {
  callerId: string;
  repoPath: string;
  effectiveVersion: string;
}

export interface CapabilityGrant {
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

export class CapabilityGrantStore {
  private readonly sessionGrants = new Map<string, CapabilityGrant>();
  private readonly filePath: string;
  private persistent: CapabilityGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "capability-grants.json");
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
      Array.from(this.sessionGrants.values()).some((grant) =>
        grantMatches(grant, capability, resourceKey, requestedScope, identity)
      ) ||
      this.persistent.grants.some((grant) =>
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
    now = Date.now()
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

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isCapabilityGrantFile(parsed)) {
        throw new Error("expected the current exact { grants } schema");
      }
      this.persistent = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(
        `[CapabilityGrantStore] Resetting invalid grant store ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      this.persistent = { grants: [] };
      this.save();
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.filePath, this.persistent);
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
