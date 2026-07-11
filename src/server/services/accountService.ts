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
import {
  accountMethods,
  accountProfileUpdateSchema,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/shared/serviceSchemas/account";
import type { IdentityDb, ResolvedUser } from "@vibestudio/shared/users/identityDb";
import type { UserStore } from "@vibestudio/shared/users/userStore";
import type { User } from "@vibestudio/shared/users/types";

function profileOfUser(user: User): AccountProfile {
  return {
    userId: user.id,
    handle: user.handle,
    displayName: user.displayName,
    role: user.role,
    ...(user.color !== undefined ? { color: user.color } : {}),
    ...(user.avatarBlob !== undefined ? { avatar: user.avatarBlob } : {}),
    ...(user.revokedAt !== undefined ? { revoked: true } : {}),
  };
}

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

/**
 * The profile WRITE operation (hub-side, WP0 §2). Shared by the in-process
 * `account.updateProfile` handler (pure-local server, writable DB) and the
 * hub's RPC surface (hubServer `account.updateProfile`, wired like
 * `auth.inviteUser`). `UserStore.updateProfile` validates handle changes and
 * applies the complete patch in one SQL statement. Role gating (self, or root
 * for others) is the caller's job — this function implements the operation only.
 */
export function updateAccountProfile(
  deps: { userStore: Pick<UserStore, "updateProfile"> },
  input: AccountProfileUpdate & { userId: string }
): AccountProfile {
  const validated = accountProfileUpdateSchema.parse(input);
  const userId = validated.userId;
  if (!userId) throw new Error("Account profile updates require a userId");
  // null → present-with-undefined (clear); absent key → untouched.
  const patch: Partial<Pick<User, "handle" | "displayName" | "avatarBlob" | "color">> = {
    ...(validated.handle !== undefined ? { handle: validated.handle } : {}),
    ...(validated.displayName !== undefined ? { displayName: validated.displayName } : {}),
    ...("avatar" in validated ? { avatarBlob: validated.avatar ?? undefined } : {}),
    ...("color" in validated ? { color: validated.color ?? undefined } : {}),
  };
  return profileOfUser(deps.userStore.updateProfile(userId, patch));
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
    policy: { allowed: ["server", "shell", "app", "panel"] },
    methods: accountMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "getProfile": {
          const requested = args[0] as string | undefined;
          const userId = requested ?? requireSubject(ctx.caller.subject, "getProfile").userId;
          const resolved = deps.identityDb.resolveUsers([userId]).get(userId);
          return resolved ? profileOfResolved(userId, resolved) : null;
        }
        case "resolveProfiles": {
          const userIds = args[0] as string[];
          const profiles: Record<string, AccountProfile> = {};
          for (const [userId, resolved] of deps.identityDb.resolveUsers(userIds)) {
            profiles[userId] = profileOfResolved(userId, resolved);
          }
          return profiles;
        }
        case "isMember": {
          return deps.isWorkspaceMember(args[0] as string);
        }
        case "listWorkspaceMembers": {
          const userIds = [...new Set(deps.listWorkspaceMemberUserIds())];
          const resolved = deps.identityDb.resolveUsers(userIds);
          return userIds.flatMap((userId) => {
            const user = resolved.get(userId);
            return user && user.revokedAt === undefined ? [profileOfResolved(userId, user)] : [];
          });
        }
        case "updateProfile": {
          const input = args[0] as AccountProfileUpdate;
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
        }
        default:
          throw new Error(`Unknown account method: ${method}`);
      }
    },
  };
}
