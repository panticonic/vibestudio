import {
  accountProfileUpdateSchema,
  type AccountProfile,
  type AccountProfileUpdate,
} from "@vibestudio/service-schemas/account";
import type { UserStore } from "@vibestudio/identity/userStore";
import type { User } from "@vibestudio/identity/types";

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

/** Host-core identity profile write shared by hub and single-process hosts. */
export function updateAccountProfile(
  deps: { userStore: Pick<UserStore, "updateProfile"> },
  input: AccountProfileUpdate & { userId: string }
): AccountProfile {
  const validated = accountProfileUpdateSchema.parse(input);
  const userId = validated.userId;
  if (!userId) throw new Error("Account profile updates require a userId");
  const patch: Partial<Pick<User, "handle" | "displayName" | "avatarBlob" | "color">> = {
    ...(validated.handle !== undefined ? { handle: validated.handle } : {}),
    ...(validated.displayName !== undefined ? { displayName: validated.displayName } : {}),
    ...("avatar" in validated ? { avatarBlob: validated.avatar ?? undefined } : {}),
    ...("color" in validated ? { color: validated.color ?? undefined } : {}),
  };
  return profileOfUser(deps.userStore.updateProfile(userId, patch));
}
