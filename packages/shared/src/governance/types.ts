/**
 * Governance & approval-provenance records (WP5 §5/§5.1).
 *
 * A host-owned, append-only ATTRIBUTION/PROVENANCE log for a mutually-trusting
 * team (plan §0.0) — it records WHO approved/denied what and WHO invited/revoked/
 * added whom, and when. It is NOT a tamper-evident security audit against
 * insiders: the host process is the sole trusted writer. The on-disk form is a
 * transactional SQLite ledger with no hash chain (see `governanceLog.ts`).
 *
 * Host-owned (INV-2): the host records its own decisions; it never writes into
 * userland GAD. Identity is the host-verified `subject`, never the wire (INV-3).
 */

/** The nine host approval-queue kinds a resolution can attribute (§5). */
export type ApprovalProvenanceKind =
  | "credential"
  | "capability"
  | "client-config"
  | "credential-input"
  | "secret-input"
  | "userland"
  | "unit-batch"
  | "mission-review"
  | "device-code"
  | "external-agent"
  | "browser-permission";

/** The terminal decision recorded on a resolution (§5). */
export type ApprovalProvenanceDecision =
  | "once"
  | "task"
  | "agent"
  | "lock"
  | "session"
  | "version"
  | "always"
  | "block"
  | "deny"
  | "dismiss"
  | "approve"
  | "submit";

/** The surface the resolver acted from (§5). */
export type ResolvedVia = "shell" | "mobile-notification" | "app" | "server";

/** The grant scope the server persisted for this resolution (null for once/deny). */
export type GrantScopeStored =
  | "task"
  | "agent"
  | "lock"
  | "session"
  | "version"
  | "always"
  | "block"
  | "mission"
  | null;

/** WHO approved — the verified human (INV-3). */
export interface ApprovalResolvedBy {
  userId: string;
  handle: string;
  deviceId?: string;
  deviceLabel?: string;
}

/**
 * WHO/what asked — sourced from `PendingApproval` + `ApprovalRequesterIdentity`.
 * `userId` is stamped onto the pending approval at enqueue time (§5.1) so a
 * resolution record can name both the requester and the resolver.
 */
export interface ApprovalRequestedBy {
  callerId: string;
  callerKind: string;
  repoPath?: string;
  effectiveVersion?: string;
  userId?: string;
}

/** WHAT was approved (§5) — a compact, kind-agnostic descriptor. */
export interface ApprovalResource {
  capability?: string;
  key?: string;
  value?: string;
  credentialId?: string;
  subjectId?: string;
}

/**
 * One record per approval-queue resolution (§5), appended to the host
 * governance log. Grant matching stays code-identity-scoped — this record is
 * purely additive provenance and never fragments a shared grant per user (§8).
 */
export interface ApprovalProvenanceRecord {
  approvalId: string;
  approvalKind: ApprovalProvenanceKind;
  decision: ApprovalProvenanceDecision;
  /** deny/dismiss → false. */
  granted: boolean;
  workspaceId: string;
  resolvedAt: number;
  resolvedBy: ApprovalResolvedBy;
  resolvedVia: ResolvedVia;
  requestedBy: ApprovalRequestedBy;
  resource?: ApprovalResource;
  grantScopeStored?: GrantScopeStored;
}

/**
 * One record per membership-governance op (§5.1), appended to the SAME host
 * governance log by the hub/WP2 membership services (which hold the acting
 * `subject`) — so "who let this person in / who revoked them" is permanently
 * answerable, the primary reason a trusted team still keeps a log.
 */
export interface MembershipGovernanceRecord {
  kind: "membership";
  op: "invite-user" | "revoke-user" | "add-member" | "remove-member" | "role-change";
  /** Who performed it (verified subject). */
  actor: { userId: string; handle: string; deviceId?: string };
  /** Who it was done to. */
  target: { userId: string; handle?: string };
  /** For add/remove-member. */
  workspaceId?: string;
  /** For invite/role-change. */
  role?: "root" | "admin" | "member";
  at: number;
}

/** Everything the host governance log stores — one unified read stream (§7). */
export type GovernanceRecord = ApprovalProvenanceRecord | MembershipGovernanceRecord;

/** True for a `MembershipGovernanceRecord` (`kind: "membership"`). */
export function isMembershipGovernanceRecord(
  record: GovernanceRecord
): record is MembershipGovernanceRecord {
  return (record as Partial<MembershipGovernanceRecord>).kind === "membership";
}

/** True for an `ApprovalProvenanceRecord` (everything without `kind`). */
export function isApprovalProvenanceRecord(
  record: GovernanceRecord
): record is ApprovalProvenanceRecord {
  return (record as Partial<MembershipGovernanceRecord>).kind !== "membership";
}

/** The record's canonical timestamp (approval `resolvedAt` / membership `at`). */
export function governanceRecordTimestamp(record: GovernanceRecord): number {
  return isMembershipGovernanceRecord(record) ? record.at : record.resolvedAt;
}

/**
 * The live `shell-approval:resolved` surface (§6). Carries the resolution
 * snapshot so the approval bar / mobile sheet can render "Approved by @gabriel
 * just now" on an entry that has already been removed — it no longer depends on
 * the entry still existing. It is the `ApprovalProvenanceRecord` minus the
 * host-only `workspaceId` (stamped by the writer): one snapshot feeds both the
 * live event and the durable record, so they can never disagree.
 */
export type ApprovalResolvedEvent = Omit<ApprovalProvenanceRecord, "workspaceId">;
