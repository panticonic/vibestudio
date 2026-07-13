/**
 * Identity-package `UserStore` — business rules over the `users` table (WP0 §3.1).
 *
 * Hub-side: the hub is the sole identity writer, so every mutating method here
 * runs on a read-write `IdentityDb` (a read-only handle throws in the data
 * layer). Caller-ROLE gates (`inviteUser` is root/admin-only, `setRole` is
 * root-only) are enforced by the service layer against `subject.role` — this
 * store enforces the data invariants: handle shape/uniqueness/reservation,
 * single-root bootstrap, and root immutability.
 */

import { randomBytes } from "node:crypto";
import type { IdentityDb } from "./identityDb.js";
import { HANDLE_PATTERN, RESERVED_HANDLES, type User, type UserRole } from "./types.js";

export type UserStoreErrorCode =
  | "HANDLE_INVALID"
  | "HANDLE_RESERVED"
  | "HANDLE_TAKEN"
  | "USER_NOT_FOUND"
  | "ROOT_EXISTS"
  | "ROOT_IMMUTABLE";

/** Typed store error so the service layer can map codes onto auth errors. */
export class UserStoreError extends Error {
  constructor(
    readonly code: UserStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UserStoreError";
  }
}

export function newUserId(): string {
  return `usr_${randomBytes(18).toString("base64url")}`;
}

export class UserStore {
  constructor(
    private readonly db: IdentityDb,
    private readonly now = () => Date.now()
  ) {}

  /** Bootstrap the single root account (WP0 §4). Only when no users exist. */
  createRoot(input: { handle: string; displayName: string }): User {
    if (this.db.hasUsers()) {
      throw new UserStoreError("ROOT_EXISTS", "Root is already bootstrapped: users exist");
    }
    const user: User = {
      id: newUserId(),
      handle: this.claimHandle(input.handle),
      displayName: input.displayName,
      role: "root",
      createdAt: this.now(),
    };
    this.db.insertUser(user);
    return user;
  }

  /**
   * Create an invited user. The root/admin caller-role gate is enforced by the
   * service layer (WP1 §4), not here.
   */
  inviteUser(input: {
    handle: string;
    displayName: string;
    role: "admin" | "member";
    createdBy: string;
  }): User {
    const user: User = {
      id: newUserId(),
      handle: this.claimHandle(input.handle),
      displayName: input.displayName,
      role: input.role,
      createdAt: this.now(),
      createdBy: input.createdBy,
    };
    this.db.insertUser(user);
    return user;
  }

  getUser(userId: string): User | null {
    return this.db.getUserRow(userId);
  }

  getByHandle(handle: string): User | null {
    return this.db.getUserByHandle(handle);
  }

  listUsers(): User[] {
    return this.db.listUsers();
  }

  /**
   * Change a user's role between `admin` and `member`. Root is immutable:
   * the root user cannot be demoted and nobody can be promoted to root
   * (exactly one root, minted at bootstrap).
   */
  setRole(userId: string, role: UserRole): void {
    const user = this.requireUser(userId);
    if (user.role === "root") {
      throw new UserStoreError("ROOT_IMMUTABLE", "Cannot change the root user's role");
    }
    if (role === "root") {
      throw new UserStoreError("ROOT_IMMUTABLE", "Cannot promote a user to root");
    }
    this.db.setUserRole(userId, role);
  }

  /**
   * Patch mutable personalization. A key PRESENT with value `undefined`
   * clears the field; an absent key is untouched. Returns the updated user.
   */
  updateProfile(
    userId: string,
    patch: Partial<Pick<User, "handle" | "displayName" | "avatarBlob" | "color">>
  ): User {
    const user = this.requireUser(userId);
    const normalizedPatch = { ...patch };
    if (patch.handle !== undefined) {
      normalizedPatch.handle =
        patch.handle.toLowerCase() === user.handle.toLowerCase()
          ? this.validateHandle(patch.handle)
          : this.claimHandle(patch.handle);
    }
    // One SQL statement applies the handle and personalization fields together;
    // a uniqueness failure cannot leave a partial profile mutation behind.
    this.db.updateUserProfile(userId, normalizedPatch);
    return this.requireUser(userId);
  }

  /**
   * Revoke a user; the data layer cascades to their devices, agent
   * credentials, memberships, and pending pairing codes in one transaction.
   * Returns false when unknown or already revoked. Root cannot be revoked.
   */
  revokeUser(userId: string, workspaceIds: readonly string[] = []): boolean {
    const user = this.db.getUserRow(userId);
    if (!user || user.revokedAt !== undefined) return false;
    if (user.role === "root") {
      throw new UserStoreError("ROOT_IMMUTABLE", "Cannot revoke the root user");
    }
    return this.db.revokeUser(userId, this.now(), workspaceIds);
  }

  /** Roll back a newly-created invite when its reach route could not be armed. */
  rollbackInvite(userId: string): boolean {
    return this.db.deleteUnactivatedInvite(userId);
  }

  /** Validate shape + reservation + uniqueness; returns the claimed handle. */
  private claimHandle(handle: string): string {
    this.validateHandle(handle);
    if (this.db.getUserByHandle(handle)) {
      throw new UserStoreError("HANDLE_TAKEN", `Handle "${handle}" is already taken`);
    }
    return handle;
  }

  /** Validate shape + reservation without checking ownership/uniqueness. */
  private validateHandle(handle: string): string {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new UserStoreError(
        "HANDLE_INVALID",
        `Handle "${handle}" must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`
      );
    }
    if (RESERVED_HANDLES.has(handle.toLowerCase())) {
      throw new UserStoreError("HANDLE_RESERVED", `Handle "${handle}" is reserved`);
    }
    return handle;
  }

  private requireUser(userId: string): User {
    const user = this.db.getUserRow(userId);
    if (!user) {
      throw new UserStoreError("USER_NOT_FOUND", `Unknown user "${userId}"`);
    }
    return user;
  }
}
