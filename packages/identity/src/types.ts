/**
 * User identity types (WP0 §3.1, plan §2.1).
 *
 * The `User` account row lives in the hub-owned identity DB (`identityDb.ts`);
 * the hub is the sole writer, workspace children read the same DB read-only.
 * `userId` is an ATTRIBUTION/personalization/routing principal for mutually
 * trusting members (plan §0.0) — never an inter-user security token.
 */

export type UserRole = "root" | "admin" | "member";

/** Host-derived projection of a live entity's semantic agent binding. */
export interface AgentBinding {
  entityId: string;
  contextId: string;
  channelId: string;
  agentId: string;
}

export interface User {
  /** Stable principal id: `usr_<base64url18>`; the subject principal. */
  id: string;
  /** Unique server-wide; must match `HANDLE_PATTERN` and not be reserved. */
  handle: string;
  displayName: string;
  role: UserRole;
  /** Inline `data:` URI avatar stored on the account row (WP0 §3.8). */
  avatarBlob?: string;
  /** Hex tint for handle/presence rendering (optional personalization). */
  color?: string;
  createdAt: number;
  /** Inviting user id; absent for root. */
  createdBy?: string;
  revokedAt?: number;
}

/**
 * The STABLE identity stamped on a connection at `handleAuth` (host-verified,
 * never client-asserted). Deliberately minimal: mutable personalization
 * (displayName/avatar/color) and the CURRENT role are resolved LIVE from the
 * shared identity DB (WP0 §3.7) wherever they render — never snapshotted here —
 * so a rename, avatar change, or demotion is never stale on a long-lived
 * connection. Handle is treated as stable for the life of a session (renames
 * take effect on reconnect; WP6).
 */
export interface UserSubject {
  userId: string;
  handle: string;
}

/** Host-owned account-handle syntax. Product projections must preserve or
 * encode this identity; userland naming policy never narrows account creation. */
export const HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Synthetic host principals that can never identify an account row. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["system"]);

/** True iff `handle` matches `HANDLE_PATTERN` and is not reserved. */
export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.has(handle.toLowerCase());
}
