/**
 * Host-owned governance ledger.
 *
 * The ledger uses one exact SQLite schema. Transactions make related appends
 * atomic and crash-safe; `approval_id` is the durable idempotency key for the
 * child→hub acknowledgement boundary.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { z } from "zod";

import {
  openCanonicalSqliteDatabase,
  type CanonicalSqliteMigrationPlan,
  type CanonicalSqliteSchema,
} from "@vibestudio/sqlite";
import {
  governanceRecordTimestamp,
  isApprovalProvenanceRecord,
  isMembershipGovernanceRecord,
  type ApprovalProvenanceKind,
  type ApprovalProvenanceRecord,
  type GovernanceRecord,
  type MembershipGovernanceRecord,
} from "./types.js";

const UserActorSchema = z
  .object({
    userId: z.string().min(1),
    handle: z.string().min(1),
    deviceId: z.string().min(1).optional(),
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    approvalId: z.string().min(1),
    approvalKind: z.enum([
      "credential",
      "capability",
      "client-config",
      "credential-input",
      "secret-input",
      "userland",
      "unit-batch",
      "mission-review",
      "device-code",
      "external-agent",
      "browser-permission",
    ]),
    decision: z.enum([
      "once",
      "task",
      "agent",
      "lock",
      "session",
      "version",
      "always",
      "block",
      "deny",
      "dismiss",
      "approve",
      "submit",
    ]),
    granted: z.boolean(),
    workspaceId: z.string().min(1),
    resolvedAt: z.number().finite(),
    resolvedBy: UserActorSchema.extend({ deviceLabel: z.string().min(1).optional() }),
    resolvedVia: z.enum(["shell", "mobile-notification", "app", "server"]),
    requestedBy: z
      .object({
        callerId: z.string().min(1),
        callerKind: z.string().min(1),
        repoPath: z.string().min(1).optional(),
        effectiveVersion: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
      })
      .strict(),
    resource: z
      .object({
        capability: z.string().min(1).optional(),
        key: z.string().min(1).optional(),
        value: z.string().optional(),
        credentialId: z.string().min(1).optional(),
        subjectId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    grantScopeStored: z
      .enum(["task", "agent", "lock", "session", "version", "always", "block", "mission"])
      .nullable()
      .optional(),
  })
  .strict();

const MembershipRecordSchema = z
  .object({
    kind: z.literal("membership"),
    op: z.enum(["invite-user", "revoke-user", "add-member", "remove-member", "role-change"]),
    actor: UserActorSchema,
    target: z.object({ userId: z.string().min(1), handle: z.string().min(1).optional() }).strict(),
    workspaceId: z.string().min(1).optional(),
    role: z.enum(["root", "admin", "member"]).optional(),
    at: z.number().finite(),
  })
  .strict();

export const GovernanceRecordSchema = z.union([MembershipRecordSchema, ApprovalRecordSchema]);

const GOVERNANCE_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "governance_records",
      sql: `CREATE TABLE governance_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_kind TEXT NOT NULL CHECK (record_kind IN ('approval', 'membership')),
        approval_id TEXT UNIQUE,
        membership_op TEXT,
        target_user_id TEXT,
        timestamp REAL NOT NULL,
        workspace_id TEXT,
        user_id TEXT NOT NULL,
        approval_kind TEXT,
        granted INTEGER,
        payload TEXT NOT NULL,
        CHECK (
          (record_kind = 'approval'
            AND approval_id IS NOT NULL
            AND membership_op IS NULL
            AND target_user_id IS NULL
            AND approval_kind IS NOT NULL
            AND granted IN (0, 1))
          OR
          (record_kind = 'membership'
            AND approval_id IS NULL
            AND membership_op IS NOT NULL
            AND target_user_id IS NOT NULL
            AND approval_kind IS NULL
            AND granted IS NULL)
        )
      )`,
    },
    {
      type: "index",
      name: "governance_records_time_idx",
      sql: `CREATE INDEX governance_records_time_idx
        ON governance_records (timestamp DESC, sequence DESC)`,
    },
    {
      type: "index",
      name: "governance_records_membership_idx",
      sql: `CREATE INDEX governance_records_membership_idx
        ON governance_records (membership_op, target_user_id)`,
    },
    {
      type: "index",
      name: "governance_records_workspace_idx",
      sql: `CREATE INDEX governance_records_workspace_idx
        ON governance_records (workspace_id, timestamp DESC)`,
    },
  ],
};

/** Version 1 is the first production baseline; future changes append migrations here. */
const GOVERNANCE_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: GOVERNANCE_SCHEMA,
  migrations: [],
};

export interface GovernanceQueryFilter {
  recordKind?: "approval" | "membership";
  userId?: string;
  approvalKind?: ApprovalProvenanceKind;
  op?: MembershipGovernanceRecord["op"];
  workspaceId?: string;
  granted?: boolean;
}

export interface GovernanceQuery {
  filter?: GovernanceQueryFilter;
  limit?: number;
  after?: number;
}

function matchesFilter(record: GovernanceRecord, filter?: GovernanceQueryFilter): boolean {
  if (!filter) return true;
  if (filter.recordKind === "approval" && !isApprovalProvenanceRecord(record)) return false;
  if (filter.recordKind === "membership" && !isMembershipGovernanceRecord(record)) return false;
  if (filter.workspaceId !== undefined && record.workspaceId !== filter.workspaceId) return false;
  if (filter.userId !== undefined) {
    const userId = isMembershipGovernanceRecord(record)
      ? record.actor.userId
      : record.resolvedBy.userId;
    if (userId !== filter.userId) return false;
  }
  if (
    filter.approvalKind !== undefined &&
    (!isApprovalProvenanceRecord(record) || record.approvalKind !== filter.approvalKind)
  ) {
    return false;
  }
  if (
    filter.op !== undefined &&
    (!isMembershipGovernanceRecord(record) || record.op !== filter.op)
  ) {
    return false;
  }
  if (
    filter.granted !== undefined &&
    (!isApprovalProvenanceRecord(record) || record.granted !== filter.granted)
  ) {
    return false;
  }
  return true;
}

function approvalReplayMatches(
  existing: ApprovalProvenanceRecord,
  candidate: ApprovalProvenanceRecord
): boolean {
  return (
    JSON.stringify({ ...existing, resolvedAt: 0 }) ===
    JSON.stringify({ ...candidate, resolvedAt: 0 })
  );
}

export class GovernanceLog {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(opts?: { databasePath?: string }) {
    const databasePath =
      opts?.databasePath ?? path.join(getCentralDataPath(), "governance", "governance.db");
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      openCanonicalSqliteDatabase(this.db, GOVERNANCE_MIGRATION_PLAN, {
        description: `governance database ${databasePath}`,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async append(record: GovernanceRecord): Promise<void> {
    await this.appendMany([record]);
  }

  async appendMany(records: readonly GovernanceRecord[]): Promise<void> {
    this.assertOpen();
    if (records.length === 0) return;
    const canonical = records.map(
      (record) => GovernanceRecordSchema.parse(record) as GovernanceRecord
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of canonical) this.insertRecord(record);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async query(opts?: GovernanceQuery): Promise<GovernanceRecord[]> {
    this.assertOpen();
    if (opts?.limit !== undefined && opts.limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT payload FROM governance_records
         WHERE (? IS NULL OR timestamp > ?)
         ORDER BY timestamp DESC, sequence DESC`
      )
      .all(opts?.after ?? null, opts?.after ?? null) as Array<Record<string, SQLOutputValue>>;
    const records: GovernanceRecord[] = [];
    for (const row of rows) {
      let raw: unknown;
      try {
        raw = JSON.parse(String(row["payload"]));
      } catch (error) {
        throw new Error("Invalid governance record payload", { cause: error });
      }
      const parsed = GovernanceRecordSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Unsupported governance record: ${parsed.error.message}`);
      }
      const record = parsed.data as GovernanceRecord;
      if (!matchesFilter(record, opts?.filter)) continue;
      records.push(record);
      if (opts?.limit !== undefined && records.length >= Math.trunc(opts.limit)) break;
    }
    return records;
  }

  async hasMembershipOperation(
    op: MembershipGovernanceRecord["op"],
    targetUserId: string
  ): Promise<boolean> {
    this.assertOpen();
    return (
      this.db
        .prepare(
          `SELECT 1 AS one FROM governance_records
           WHERE record_kind = 'membership' AND membership_op = ? AND target_user_id = ?
           LIMIT 1`
        )
        .get(op, targetUserId) !== undefined
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.closed = true;
  }

  private insertRecord(record: GovernanceRecord): void {
    const payload = JSON.stringify(record);
    if (isApprovalProvenanceRecord(record)) {
      const existing = this.db
        .prepare("SELECT payload FROM governance_records WHERE approval_id = ?")
        .get(record.approvalId) as Record<string, SQLOutputValue> | undefined;
      if (existing) {
        const parsed = ApprovalRecordSchema.parse(JSON.parse(String(existing["payload"])));
        if (!approvalReplayMatches(parsed, record)) {
          throw new Error(`Conflicting governance replay for approval ${record.approvalId}`);
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO governance_records
            (record_kind, approval_id, membership_op, target_user_id, timestamp,
             workspace_id, user_id, approval_kind, granted, payload)
           VALUES ('approval', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.approvalId,
          record.resolvedAt,
          record.workspaceId,
          record.resolvedBy.userId,
          record.approvalKind,
          record.granted ? 1 : 0,
          payload
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO governance_records
          (record_kind, approval_id, membership_op, target_user_id, timestamp,
           workspace_id, user_id, approval_kind, granted, payload)
         VALUES ('membership', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .run(
        record.op,
        record.target.userId,
        record.at,
        record.workspaceId ?? null,
        record.actor.userId,
        payload
      );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Governance log is closed");
  }
}
