/**
 * Identity-package `MembershipStore` — business rules over the `membership` table
 * (WP0 §3.5 / WP2 §2).
 *
 * One table, one writer, many readers: the hub mutates membership through a
 * read-write `IdentityDb`; workspace children construct this store over a
 * read-only handle and call `has()` / `listMembers()` directly for the entry
 * gate and push audience. `workspaceId` everywhere is the OPAQUE STABLE id
 * from the registry (WP0 §3.5 note), never the display name or path.
 *
 * Personal and System designations are private even to another server root.
 * These application access checks do not provide native process containment.
 */

import type { IdentityDb, WorkspaceMembership } from "./identityDb.js";
import type { UserStore } from "./userStore.js";

export type { WorkspaceMembership } from "./identityDb.js";

export class MembershipStore {
  constructor(
    private readonly db: IdentityDb,
    /** Live account status; server roles do not imply workspace membership. */
    private readonly users: Pick<UserStore, "getUser">,
    private readonly now = () => Date.now()
  ) {}

  // ===========================================================================
  // Writes (hub only; a read-only IdentityDb handle throws in the data layer)
  // ===========================================================================

  /**
   * Idempotent upsert on `(userId, workspaceId)`; a repeat add refreshes
   * `addedBy`/`addedAt`. Does NOT validate that the workspace exists —
   * existence is the registry's concern (WP2 §2).
   */
  add(userId: string, workspaceId: string, addedBy: string, role: "admin" | "member" = "member"): WorkspaceMembership {
    const membership: WorkspaceMembership = {
      userId,
      workspaceId,
      addedBy,
      addedAt: this.now(),
      role,
    };
    this.db.addMembership(membership);
    return membership;
  }

  /**
   * Remove a stored ordinary-workspace membership. Private ownership cannot
   * be removed through membership. Ordinary membership is explicit for every role.
   */
  remove(userId: string, workspaceId: string): boolean {
    if (this.db.getPrivateWorkspaceOwner(workspaceId)) {
      throw new Error("Private workspace ownership cannot be removed through membership");
    }
    return this.db.removeMembership(userId, workspaceId);
  }

  /** Cascade for registry workspace deletion; returns pruned row count. */
  removeWorkspace(workspaceId: string): number {
    return this.db.removeMembershipsForWorkspace(workspaceId);
  }

  /** Cascade for user revocation (WP0 `revokeUser`); returns pruned row count. */
  removeUser(userId: string): number {
    return this.db.removeMembershipsForUser(userId);
  }

  // ===========================================================================
  // Reads (hub AND children)
  // ===========================================================================

  /**
   * Stored workspaceIds this user was explicitly added to.
   */
  list(userId: string): string[] {
    return this.db.listWorkspacesForUser(userId);
  }

  listMembers(workspaceId: string): WorkspaceMembership[] {
    return this.db.listMembers(workspaceId);
  }

  /**
   * The load-bearing entry predicate. A private workspace admits only its live
   * designated owner. Every ordinary workspace requires a stored membership.
   */
  has(userId: string, workspaceId: string): boolean {
    const user = this.users.getUser(userId);
    if (!user || user.revokedAt !== undefined) return false;
    const owner = this.db.getPrivateWorkspaceOwner(workspaceId);
    if (owner) return owner.userId === userId;
    return this.db.isMember(userId, workspaceId);
  }

  /**
   * Who administers the workspace, and so answers decisions about it. A private
   * workspace's owner is its whole authority by construction — the same fact
   * `has` encodes — and holds no stored role to consult. Every ordinary
   * workspace requires the stored admin role.
   */
  isAdmin(userId: string, workspaceId: string): boolean {
    if (!this.has(userId, workspaceId)) return false;
    if (this.db.getPrivateWorkspaceOwner(workspaceId)) return true;
    return this.db.getMembership(userId, workspaceId)?.role === "admin";
  }
}
