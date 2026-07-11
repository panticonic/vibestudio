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

const SERVICE = "permissions";
const TRUSTED_PAGE = "about/permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  userlandGrants: UserlandApprovalGrantStore;
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
            resource: grant.resourceKey,
            repoPath: grant.repoPath,
            ...(grant.effectiveVersion ? { effectiveVersion: grant.effectiveVersion } : {}),
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
        return [...capability, ...userland].sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
      }
      if (method === "revoke") {
        const [{ kind, id }] = args as [{ kind: "capability" | "userland"; id: string }];
        const removed =
          kind === "capability"
            ? deps.capabilityGrants.revokePersistent(id)
            : deps.userlandGrants.revokePersistent(id);
        if (!removed)
          throw new ServiceError(SERVICE, method, "Permission grant not found", "ENOENT");
        return;
      }
      throw new ServiceError(SERVICE, method, `Unknown permissions method: ${method}`, "ENOSYS");
    },
  };
}
