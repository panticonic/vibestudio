/**
 * `account` service — read-only workspace-scoped profile projections.
 *
 * Reads (`getProfile` / `resolveProfiles`) are CHILD-LOCAL: they go through the
 * shared identity DB the child opens read-only (`identityDb.resolveUsers`,
 * WP0 §3.7) and project the live `{handle, displayName, color, avatar}` down to
 * userland — userland never opens the DB itself (INV-2). Personalization writes
 * go directly to `hubControl.updateProfile` over the client's stable hub
 * session; this child has no write deputy.
 *
 * Identity here is ATTRIBUTION/personalization for mutually trusting members.
 * This is a shared-DB read projection, not an account-control service.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { accountMethods, type AccountProfile } from "@vibestudio/service-schemas/account";
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
    description: "Read-only live account profiles for this workspace",
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
    }),
  };
}
