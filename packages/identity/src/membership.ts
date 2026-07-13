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
 * Membership is a routing/attribution surface for mutually trusting members
 * (plan §0.0) — "which workspaces does the hub offer this user", not an
 * inter-user security boundary.
 */

import type { IdentityDb, WorkspaceMembership } from "./identityDb.js";
import type { UserStore } from "./userStore.js";

export type { WorkspaceMembership } from "./identityDb.js";

export class MembershipStore {
  constructor(
    private readonly db: IdentityDb,
    /** For the implicit-root rule; typically the `UserStore` over the same DB. */
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
  add(userId: string, workspaceId: string, addedBy: string): WorkspaceMembership {
    const membership: WorkspaceMembership = {
      userId,
      workspaceId,
      addedBy,
      addedAt: this.now(),
    };
    this.db.addMembership(membership);
    return membership;
  }

  /**
   * Remove a stored membership. No-op (returns false) for root — root is
   * implicitly a member of every workspace and cannot be removed from one.
   */
  remove(userId: string, workspaceId: string): boolean {
    if (this.users.getUser(userId)?.role === "root") return false;
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
   * Stored workspaceIds this user was explicitly added to. Root is NOT
   * special-cased here — the CALLER resolves root's implicit all-workspaces
   * membership against the registry (WP2 §2).
   */
  list(userId: string): string[] {
    return this.db.listWorkspacesForUser(userId);
  }

  listMembers(workspaceId: string): WorkspaceMembership[] {
    return this.db.listMembers(workspaceId);
  }

  /**
   * The load-bearing entry predicate: true for role `root` WITHOUT a stored
   * row (implicit-root rule, WP0 §3.5), else true iff a row exists. Admins
   * manage membership but only ENTER workspaces they were added to.
   */
  has(userId: string, workspaceId: string): boolean {
    if (this.users.getUser(userId)?.role === "root") return true;
    return this.db.isMember(userId, workspaceId);
  }
}
