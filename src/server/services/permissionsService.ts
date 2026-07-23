import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  permissionsMethods,
  type SavedPermissionGrant,
} from "@vibestudio/service-schemas/permissions";
import type { AuthorityGrant, Principal, ResourceScope } from "@vibestudio/rpc";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  credentialUseGrantId,
  type CredentialUseGrantStoreLike,
} from "./credentialUseGrantStore.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import type { BrowserPermissionGrantStore } from "./browserPermissionsService.js";

const SERVICE = "permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  credentialUseGrants: CredentialUseGrantStoreLike;
  browserPermissions: BrowserPermissionGrantStore;
  workspaceId: string;
}): ServiceDefinition {
  return {
    name: SERVICE,
    description: "Trusted review and revocation of durable permission grants",
    authority: { principals: ["user", "host", "code"] },
    methods: permissionsMethods,
    handler: defineServiceHandler(SERVICE, permissionsMethods, {
      list: async (ctx) => {
        await deps.browserPermissions.ensureLoaded();
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const capability: SavedPermissionGrant[] = deps.capabilityGrants
          .listActiveAuthorityGrants()
          .filter((grant) => !grant.capability.startsWith("userland.choice/"))
          .map(savedAuthorityGrant);
        const userland: SavedPermissionGrant[] = deps.capabilityGrants
          .listPersistentUserland()
          .map(({ id, grant }) => ({
            id,
            kind: "userland",
            callerLabel: grant.principal.repoPath || grant.principal.callerId,
            scopeLabel:
              grant.scope === "version"
                ? `Remembered choice: ${grant.choice} (this version)`
                : `Remembered choice: ${grant.choice}`,
            capability: grant.subject.label ?? "Agent choice",
            resource: grant.subject.id,
            ...(grant.principal.repoPath ? { repoPath: grant.principal.repoPath } : {}),
            ...(grant.principal.effectiveVersion
              ? { effectiveVersion: grant.principal.effectiveVersion }
              : {}),
            grantedAt: grant.grantedAt,
          }));
        const credentialUse: SavedPermissionGrant[] = deps.credentialUseGrants
          .listAll()
          .map((grant) => ({
            id: credentialUseGrantId(grant),
            kind: "credential-use",
            callerLabel: grant.scope === "agent" ? grant.agentId : grant.repoPath,
            scopeLabel:
              grant.scope === "agent" ? "Trusted for this agent" : "Trusted for this code version",
            capability: `Credential ${grant.use}: ${grant.action}`,
            resource: grant.resource,
            ...(grant.scope === "version"
              ? { repoPath: grant.repoPath, effectiveVersion: grant.effectiveVersion }
              : {}),
            grantedAt: grant.grantedAt,
          }));
        const browserSites: SavedPermissionGrant[] = deps.browserPermissions
          .list(identity.environmentKey, identity.ownerUserId)
          .map((grant) => ({
            id: deps.browserPermissions.idFor(identity.environmentKey, identity.ownerUserId, grant),
            kind: "browser-site",
            callerLabel: grant.origin,
            scopeLabel:
              grant.decision === "block"
                ? "Blocked for this browser environment"
                : grant.scope === "session"
                  ? "Allowed for this session"
                  : "Always allowed",
            capability: `Website ${grant.capability}`,
            resource: grant.origin,
            grantedAt: grant.updatedAt,
          }));
        return [...capability, ...userland, ...credentialUse, ...browserSites].sort(
          (a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0)
        );
      },
      revoke: async (ctx, [{ kind, id }]) => {
        if (kind === "browser-site") {
          await deps.browserPermissions.ensureLoaded();
          const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
          const removed = await deps.browserPermissions.revokeById(
            identity.environmentKey,
            identity.ownerUserId,
            id
          );
          if (!removed)
            throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
          return;
        }
        const removed =
          kind === "capability"
            ? deps.capabilityGrants.revoke(id)
            : kind === "userland"
              ? deps.capabilityGrants.revokePersistentUserland(id)
              : await deps.credentialUseGrants.revoke(id);
        if (!removed)
          throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
      },
    }),
  };
}

function savedAuthorityGrant(grant: AuthorityGrant): SavedPermissionGrant {
  if (!grant.id) throw new Error("Persisted authority grant has no id");
  const code = codeSubject(grant.subject);
  const sessionScoped = Boolean(grant.constraints?.sessionId);
  return {
    id: grant.id,
    kind: "capability",
    callerLabel: authoritySubjectLabel(grant.subject),
    scopeLabel:
      grant.effect === "deny"
        ? sessionScoped
          ? "Blocked for this session"
          : "Blocked for this code version"
        : sessionScoped
          ? "Allowed for this session"
          : "Trusted for this code version",
    capability: describeCapability(grant.capability).title,
    resource: authorityResourceLabel(grant.resource),
    ...(code ? { repoPath: code.repoPath, effectiveVersion: code.executionDigest } : {}),
    grantedAt: grant.createdAt,
  };
}

function codeSubject(subject: Principal): { repoPath: string; executionDigest: string } | null {
  if (!subject.startsWith("code:")) return null;
  const code = subject.slice("code:".length);
  const separator = code.lastIndexOf("@");
  if (separator <= 0 || separator === code.length - 1) return null;
  return { repoPath: code.slice(0, separator), executionDigest: code.slice(separator + 1) };
}

function authoritySubjectLabel(subject: Principal): string {
  const code = codeSubject(subject);
  if (code) return code.repoPath;
  if (subject.startsWith("session:")) return "This session";
  if (subject.startsWith("mission:")) return "This agent mission";
  if (subject.startsWith("user:")) return "Your account";
  return "Vibestudio";
}

function authorityResourceLabel(resource: ResourceScope): string {
  switch (resource.kind) {
    case "exact":
      return resource.key;
    case "prefix":
      return resource.prefix ? `Anything under ${resource.prefix}` : "Any matching resource";
    case "origin":
      return resource.origin;
    case "domain":
      return resource.domain;
    case "network":
      return "All network destinations";
  }
}
