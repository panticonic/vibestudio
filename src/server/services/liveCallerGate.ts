import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { MembershipStore } from "@vibestudio/identity/membership";
import type { UserStore } from "@vibestudio/identity/userStore";
import type { IdentityDb } from "@vibestudio/identity/identityDb";
import type { DeviceAuthStore } from "../hostCore/deviceAuthStore.js";
import {
  bindingForLiveAgentEntity,
  ownerForLiveAgentEntity,
} from "../hostCore/auth/agentEntity.js";

/**
 * Build the per-frame identity gate for a workspace child. Authentication is
 * deliberately not treated as a lifetime grant: every persistent WS/Iroh
 * frame must still belong to a live account, a current workspace member, and
 * (for credential-backed callers) the same live device/agent credential.
 */
export function createLiveCallerGate(deps: {
  workspaceId: string;
  userStore: Pick<UserStore, "getUser">;
  membershipStore: Pick<MembershipStore, "has">;
  deviceAuthStore: Pick<DeviceAuthStore, "userFor" | "getAgentCredential">;
  /** Hub-attested client principals, read live from identity.db. */
  clientPrincipals: Pick<IdentityDb, "getClientPrincipal">;
  entityCache: Pick<EntityCache, "resolveActive">;
  isLiveExtension: (callerId: string) => Promise<boolean>;
  /** Browser hosting proves the exact connected document, independently of code admission. */
  isLiveWebsiteExecution?: (
    runtimeId: string,
    website: NonNullable<VerifiedCaller["website"]>
  ) => boolean;
  isLiveSystemRuntime?: (
    callerId: string,
    callerKind: VerifiedCaller["runtime"]["kind"]
  ) => boolean;
  now?: () => number;
}): (caller: VerifiedCaller, authorizedBy?: string) => boolean | Promise<boolean> {
  const now = deps.now ?? Date.now;
  const issuerOwnsUser = (issuerId: string, userId: string): boolean => {
    if (issuerId === "electron-main" || issuerId === "headless-host") {
      return deps.userStore.getUser(userId)?.role === "root";
    }
    if (issuerId.startsWith("shell:")) {
      return deps.deviceAuthStore.userFor(issuerId.slice("shell:".length)) === userId;
    }
    const issuer = deps.entityCache.resolveActive(issuerId) as { ownerUserId?: string } | null;
    return issuer?.ownerUserId === userId;
  };
  return (caller, authorizedBy) => {
    const exactActiveCodeIncarnation = (): boolean => {
      const code = caller.code;
      if (!code) return false;
      const entity = deps.entityCache.resolveActive(caller.runtime.id);
      return (
        entity?.activeAuthority !== undefined &&
        entity.activeExecutionDigest === code.executionDigest &&
        entity.source.repoPath === code.repoPath
      );
    };
    const liveAgentOwner = (): string | null => {
      const binding = caller.agentBinding;
      if (!binding || caller.runtime.id !== `agent:${binding.entityId}`) return null;
      const agentId = caller.agentCredentialId;
      if (!agentId) return null;
      const credential = deps.deviceAuthStore.getAgentCredential(agentId);
      if (
        !credential ||
        credential.revokedAt !== undefined ||
        (credential.expiresAt !== undefined && credential.expiresAt < now()) ||
        credential.entityId !== binding.entityId
      ) {
        return null;
      }
      const entity = deps.entityCache.resolveActive(binding.entityId);
      if (!bindingForLiveAgentEntity(entity, agentId)) return null;
      return ownerForLiveAgentEntity(entity);
    };
    /**
     * A client's credential lives as long as its attested principal row: the
     * session is current only while the row is unrevoked, names this user on a
     * device still theirs, and carries the execution digest the session was
     * admitted with. A workspace that never saw a revoke or rebuild event
     * therefore still closes the stale session at its next frame.
     */
    const liveClientOwner = (): string | null => {
      const principal = deps.clientPrincipals.getClientPrincipal(caller.runtime.id);
      if (
        !principal ||
        principal.revokedAt !== undefined ||
        principal.executionDigest !== caller.code?.executionDigest ||
        deps.deviceAuthStore.userFor(principal.deviceId) !== principal.userId
      ) {
        return null;
      }
      return principal.userId;
    };
    const subject = caller.subject;
    if (subject?.userId === "system") {
      if (caller.runtime.kind === "agent") return liveAgentOwner() === "system";
      if (caller.runtime.kind === "server") return true;
      if (caller.runtime.kind === "extension") {
        return deps.isLiveExtension(caller.runtime.id);
      }
      if (
        caller.runtime.kind === "panel" ||
        caller.runtime.kind === "worker" ||
        caller.runtime.kind === "do"
      ) {
        return (
          exactActiveCodeIncarnation() &&
          (deps.isLiveSystemRuntime?.(caller.runtime.id, caller.runtime.kind) ?? false)
        );
      }
      return deps.isLiveSystemRuntime?.(caller.runtime.id, caller.runtime.kind) ?? false;
    }
    if (!subject) return false;
    const user = deps.userStore.getUser(subject.userId);
    if (!user || user.revokedAt !== undefined) return false;
    if (!deps.membershipStore.has(user.id, deps.workspaceId)) return false;

    if (caller.runtime.kind === "shell") {
      if (caller.runtime.id === "electron-main" || caller.runtime.id === "headless-host") {
        return user.role === "root";
      }
      if (!caller.runtime.id.startsWith("shell:")) return false;
      return deps.deviceAuthStore.userFor(caller.runtime.id.slice("shell:".length)) === user.id;
    }

    if (caller.runtime.kind === "agent") {
      return liveAgentOwner() === user.id;
    }

    if (caller.runtime.kind === "worker" || caller.runtime.kind === "do") {
      const entity = deps.entityCache.resolveActive(caller.runtime.id) as {
        ownerUserId?: string;
      } | null;
      return entity?.ownerUserId === user.id && exactActiveCodeIncarnation();
    }

    if (caller.runtime.kind === "client") {
      return liveClientOwner() === user.id && exactActiveCodeIncarnation();
    }

    if (caller.runtime.kind === "panel") {
      return (
        typeof authorizedBy === "string" &&
        issuerOwnsUser(authorizedBy, user.id) &&
        (caller.website
          ? caller.runtime.kind === "panel" &&
            caller.website.userId === `user:${user.id}` &&
            caller.website.workspaceId === deps.workspaceId &&
            (deps.isLiveWebsiteExecution?.(caller.runtime.id, caller.website) ?? false)
          : exactActiveCodeIncarnation())
      );
    }

    return false;
  };
}
