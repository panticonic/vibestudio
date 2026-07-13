import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { MembershipStore } from "@vibestudio/identity/membership";
import type { UserStore } from "@vibestudio/identity/userStore";
import type { DeviceAuthStore } from "../hostCore/deviceAuthStore.js";

/**
 * Build the per-frame identity gate for a workspace child. Authentication is
 * deliberately not treated as a lifetime grant: every persistent WS/WebRTC
 * frame must still belong to a live account, a current workspace member, and
 * (for credential-backed callers) the same live device/agent credential.
 */
export function createLiveCallerGate(deps: {
  workspaceId: string;
  userStore: Pick<UserStore, "getUser">;
  membershipStore: Pick<MembershipStore, "has">;
  deviceAuthStore: Pick<DeviceAuthStore, "userFor" | "getAgentCredential">;
  entityCache: Pick<EntityCache, "resolveActive">;
  isLiveExtension: (callerId: string) => boolean;
  isLiveSystemRuntime?: (
    callerId: string,
    callerKind: VerifiedCaller["runtime"]["kind"]
  ) => boolean;
  now?: () => number;
}): (caller: VerifiedCaller, authorizedBy?: string) => boolean {
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
    const subject = caller.subject;
    if (subject?.userId === "system") {
      if (caller.runtime.kind === "server") return true;
      if (caller.runtime.kind === "extension") {
        return deps.isLiveExtension(caller.runtime.id);
      }
      if (caller.runtime.kind === "app" && authorizedBy === "server") {
        return deps.entityCache.resolveActive(caller.runtime.id)?.kind === "app";
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
      const binding = caller.agentBinding;
      if (!binding || binding.userId !== user.id) return false;
      const credential = deps.deviceAuthStore.getAgentCredential(binding.agentId);
      return (
        credential !== null &&
        credential.revokedAt === undefined &&
        (credential.expiresAt === undefined || credential.expiresAt >= now()) &&
        credential.entityId === binding.entityId &&
        credential.userId === user.id
      );
    }

    if (
      caller.runtime.kind === "panel" ||
      caller.runtime.kind === "worker" ||
      caller.runtime.kind === "do"
    ) {
      const entity = deps.entityCache.resolveActive(caller.runtime.id) as {
        ownerUserId?: string;
      } | null;
      return entity?.ownerUserId === user.id;
    }

    if (caller.runtime.kind === "app") {
      return typeof authorizedBy === "string" && issuerOwnsUser(authorizedBy, user.id);
    }

    return false;
  };
}
