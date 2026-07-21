import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  permissionsMethods,
  type SavedPermissionGrant,
} from "@vibestudio/service-schemas/permissions";
import { capabilityGrantId, type CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  userlandApprovalGrantId,
  type UserlandApprovalGrantStore,
} from "./userlandApprovalGrantStore.js";
import {
  credentialUseGrantId,
  type CredentialUseGrantStoreLike,
} from "./credentialUseGrantStore.js";

const SERVICE = "permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  userlandGrants: UserlandApprovalGrantStore;
  credentialUseGrants: CredentialUseGrantStoreLike;
}): ServiceDefinition {
  return {
    name: SERVICE,
    description: "Trusted review and revocation of durable permission grants",
    authority: { principals: ["user", "host", "code"] },
    methods: permissionsMethods,
    handler: defineServiceHandler(SERVICE, permissionsMethods, {
      list: () => {
        const capability: SavedPermissionGrant[] = deps.capabilityGrants
          .listPersistent()
          .map((grant) => ({
            id: capabilityGrantId(grant),
            kind: "capability",
            callerLabel: grant.repoPath || grant.callerId || "App",
            scopeLabel:
              grant.effect === "deny"
                ? "Blocked for this code version"
                : "Trusted for this code version",
            capability: grant.capability,
            resource:
              grant.capability === "network" && grant.resourceKey === "network:*"
                ? "All network destinations"
                : grant.resourceKey,
            repoPath: grant.repoPath,
            ...(grant.effectiveVersion ? { effectiveVersion: grant.effectiveVersion } : {}),
            grantedAt: grant.grantedAt,
          }));
        const sessionCapability: SavedPermissionGrant[] = deps.capabilityGrants
          .listSession()
          .map((grant) => ({
            id: capabilityGrantId(grant),
            kind: "capability",
            callerLabel: grant.repoPath || grant.callerId || "App",
            scopeLabel:
              grant.effect === "deny"
                ? "Blocked for this session"
                : "Allowed until Vibestudio restarts",
            capability: grant.capability,
            resource:
              grant.capability === "network" && grant.resourceKey === "network:*"
                ? "All network destinations"
                : grant.resourceKey,
            repoPath: grant.repoPath,
            grantedAt: grant.grantedAt,
          }));
        const userland: SavedPermissionGrant[] = deps.userlandGrants
          .listPersistent()
          .map((grant) => ({
            id: userlandApprovalGrantId(grant),
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
            callerLabel: grant.repoPath || grant.bindingId,
            scopeLabel: "Trusted for this code version",
            capability: `Credential ${grant.use}: ${grant.action}`,
            resource: grant.resource,
            ...(grant.repoPath ? { repoPath: grant.repoPath } : {}),
            ...(grant.effectiveVersion ? { effectiveVersion: grant.effectiveVersion } : {}),
            grantedAt: grant.grantedAt,
          }));
        return [...sessionCapability, ...capability, ...userland, ...credentialUse].sort(
          (a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0)
        );
      },
      revoke: async (_ctx, [{ kind, id }]) => {
        const removed =
          kind === "capability"
            ? deps.capabilityGrants.revokePersistent(id) || deps.capabilityGrants.revokeSession(id)
            : kind === "userland"
              ? deps.userlandGrants.revokePersistent(id)
              : await deps.credentialUseGrants.revoke(id);
        if (!removed)
          throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
      },
    }),
  };
}
