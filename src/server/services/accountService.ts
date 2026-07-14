/**
 * `account` service — profile reads + personalization writes (WP6 §6).
 *
 * Reads (`getProfile` / `resolveProfiles`) are CHILD-LOCAL: they go through the
 * shared identity DB the child opens read-only (`identityDb.resolveUsers`,
 * WP0 §3.7) and project the live `{handle, displayName, color, avatar}` down to
 * userland — userland never opens the DB itself (INV-2). Because callers
 * re-resolve rather than snapshot, an `updateProfile` re-renders everywhere a
 * human is named without any roster rewrite.
 *
 * `updateProfile` is a HUB WRITE: the hub is the SOLE writer of the identity DB
 * (WP0 §2). The child handler authorizes the acting subject and delegates over
 * its authenticated control capability; there is no child-local write mode.
 *
 * Identity here is ATTRIBUTION/personalization for mutually trusting members
 * (plan §0.0) — the self-or-root gate on `updateProfile` is data hygiene (your
 * profile is yours to edit), not an inter-user security wall.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  accountMethods,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/service-schemas/account";
import type { IdentityDb, ResolvedUser } from "@vibestudio/identity/identityDb";

function profileOfResolved(userId: string, resolved: ResolvedUser): AccountProfile {
  return {
    userId,
    handle: resolved.handle,
    displayName: resolved.displayName,
    role: resolved.role,
    ...(resolved.color !== undefined ? { color: resolved.color } : {}),
    ...(resolved.avatarBlob !== undefined ? { avatar: resolved.avatarBlob } : {}),
    ...(resolved.revokedAt !== undefined ? { revoked: true } : {}),
  };
}

export function createAccountService(deps: {
  identityDb: Pick<IdentityDb, "resolveUsers">;
  /**
   * Workspace-bound membership predicate. The child injects this from its
   * bound workspace; userland callers never supply a workspace id.
   */
  isWorkspaceMember: (userId: string) => boolean;
  /** Active account ids visible in this child server's bound workspace,
   * including implicit root membership. */
  listWorkspaceMemberUserIds: () => string[];
  /** Required child→hub mutation channel; children never write identity rows. */
  writeProfile: (
    actor: { userId: string; handle: string },
    input: AccountProfileUpdate & { userId: string }
  ) => Promise<AccountProfile>;
}): ServiceDefinition {
  const requireSubject = (
    subject: { userId: string; handle: string } | undefined,
    method: string
  ) => {
    if (!subject) {
      throw new Error(
        `account.${method} requires an account subject on the connection (WP0 §5.4 bootstrap principals have none)`
      );
    }
    return subject;
  };

  return {
    name: "account",
    description: "Account profiles: live identity projection + personalization",
    // Human-driven surfaces only for the write default; reads widen per-method.
    authority: { principals: ["host", "user", "code"] },
    methods: accountMethods,
    handler: defineServiceHandler("account", accountMethods, {
      getProfile: (ctx, [requested]) => {
        const userId = requested ?? requireSubject(ctx.caller.subject, "getProfile").userId;
        const resolved = deps.identityDb.resolveUsers([userId]).get(userId);
        return resolved ? profileOfResolved(userId, resolved) : null;
      },
      resolveProfiles: (_ctx, [userIds]) => {
        const profiles: Record<string, AccountProfile> = {};
        for (const [userId, resolved] of deps.identityDb.resolveUsers(userIds)) {
          profiles[userId] = profileOfResolved(userId, resolved);
        }
        return profiles;
      },
      isMember: (_ctx, [userId]) => deps.isWorkspaceMember(userId),
      listWorkspaceMembers: () => {
        const userIds = [...new Set(deps.listWorkspaceMemberUserIds())];
        const resolved = deps.identityDb.resolveUsers(userIds);
        return userIds.flatMap((userId) => {
          const user = resolved.get(userId);
          return user && user.revokedAt === undefined ? [profileOfResolved(userId, user)] : [];
        });
      },
      updateProfile: async (ctx, [input]) => {
        const subject = requireSubject(ctx.caller.subject, "updateProfile");
        const targetUserId = input.userId ?? subject.userId;
        if (targetUserId !== subject.userId) {
          // Editing someone ELSE's profile is root-only (WP6 §6) — resolve
          // the caller's CURRENT role live, never a session snapshot.
          const actor = deps.identityDb.resolveUsers([subject.userId]).get(subject.userId);
          if (actor?.role !== "root") {
            throw new Error("Only root may update another user's profile");
          }
        }
        return await deps.writeProfile(subject, { ...input, userId: targetUserId });
      },
    }),
  };
}
