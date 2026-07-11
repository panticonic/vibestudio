import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import {
  permissionsMethods,
  type SavedPermissionGrant,
} from "@vibestudio/shared/serviceSchemas/permissions";
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
const TRUSTED_PAGE = "about/permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  userlandGrants: UserlandApprovalGrantStore;
  credentialUseGrants: CredentialUseGrantStoreLike;
}): ServiceDefinition {
  return {
    name: SERVICE,
    description: "Trusted review and revocation of durable permission grants",
    policy: { allowed: ["shell", "app", "panel", "server"] },
    methods: permissionsMethods,
    handler: async (ctx, method, args) => {
      const privileged =
        ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server";
      if (!privileged && ctx.caller.code?.repoPath !== TRUSTED_PAGE) {
        throw new ServiceError(
          SERVICE,
          method,
          "Only the trusted Permissions page may inspect grants",
          "EACCES"
        );
      }
      if (method === "list") {
        const capability: SavedPermissionGrant[] = deps.capabilityGrants
          .listPersistent()
          .map((grant) => ({
            id: capabilityGrantId(grant),
            kind: "capability",
            callerLabel: grant.repoPath || grant.callerId || "App",
            scopeLabel:
              grant.effect === "deny"
                ? "Blocked for this code version"
                : grant.scope === "repo"
                  ? "Trusted for this repository"
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
            callerLabel: grant.repoPath || grant.callerId || grant.bindingId,
            scopeLabel:
              grant.scope === "repo"
                ? "Trusted for this repository"
                : "Trusted for this code version",
            capability: `Credential ${grant.use}: ${grant.action}`,
            resource: grant.resource,
            ...(grant.repoPath ? { repoPath: grant.repoPath } : {}),
            ...(grant.effectiveVersion ? { effectiveVersion: grant.effectiveVersion } : {}),
            grantedAt: grant.grantedAt,
          }));
        return [...sessionCapability, ...capability, ...userland, ...credentialUse].sort(
          (a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0)
        );
      }
      if (method === "revoke") {
        const [{ kind, id }] = args as [
          { kind: "capability" | "userland" | "credential-use"; id: string },
        ];
        const removed =
          kind === "capability"
            ? deps.capabilityGrants.revokePersistent(id) || deps.capabilityGrants.revokeSession(id)
            : kind === "userland"
              ? deps.userlandGrants.revokePersistent(id)
              : await deps.credentialUseGrants.revoke(id);
        if (!removed)
          throw new ServiceError(SERVICE, method, "Permission grant not found", "ENOENT");
        return;
      }
      throw new ServiceError(SERVICE, method, `Unknown permissions method: ${method}`, "ENOSYS");
    },
  };
}
