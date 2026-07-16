/**
 * Effect outbox (WS1 §2.1) — ONE table replaces eight. No status column: a
 * row exists ⟺ the effect is unresolved (P1). Resolution = append the
 * outcome event to GAD, THEN delete the row; the reconcile heals both crash
 * directions.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { EffectDescriptor, EffectKind } from "@workspace/agent-loop";
import { assertExactSqlTableSchema } from "./sql-table-schema.js";

export interface OutboxRow {
  effectId: string;
  branchId: string;
  channelId: string;
  kind: EffectKind;
  idempotencyKey: string;
  descriptor: EffectDescriptor;
  attempts: number;
  nextAttemptAt: number | null;
  leaseExpiresAt: number | null;
  createdAt: number;
}

const OUTBOX_EXTERNAL_ID_PREFIX = "outbox:";

export function outboxExternalId(branchId: string, effectId: string): string {
  return `${OUTBOX_EXTERNAL_ID_PREFIX}${encodeURIComponent(branchId)}:${encodeURIComponent(effectId)}`;
}

export function parseOutboxExternalId(
  value: string
): { branchId: string; effectId: string } | null {
  if (!value.startsWith(OUTBOX_EXTERNAL_ID_PREFIX)) return null;
  const encoded = value.slice(OUTBOX_EXTERNAL_ID_PREFIX.length);
  const split = encoded.indexOf(":");
  if (split < 0) return null;
  return {
    branchId: decodeURIComponent(encoded.slice(0, split)),
    effectId: decodeURIComponent(encoded.slice(split + 1)),
  };
}

export function ensureOutboxSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS effect_outbox (
      branch_id        TEXT NOT NULL,
      effect_id        TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      kind             TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL,
      descriptor_json  TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  INTEGER,
      lease_expires_at INTEGER,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (branch_id, effect_id)
    )
  `);
  assertExactSqlTableSchema(sql, {
    table: "effect_outbox",
    columns: [
      ["branch_id", "TEXT", true],
      ["effect_id", "TEXT", true],
      ["channel_id", "TEXT", true],
      ["kind", "TEXT", true],
      ["idempotency_key", "TEXT", true],
      ["descriptor_json", "TEXT", true],
      ["attempts", "INTEGER", true, "0"],
      ["next_attempt_at", "INTEGER", false],
      ["lease_expires_at", "INTEGER", false],
      ["created_at", "INTEGER", true],
    ],
    primaryKey: ["branch_id", "effect_id"],
  });
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_effect_outbox_due ON effect_outbox(next_attempt_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_effect_outbox_effect ON effect_outbox(effect_id)`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_effect_outbox_channel_effect
      ON effect_outbox(channel_id, effect_id)`
  );
}

export function maxAttempts(kind: EffectKind, mutating = false): number {
  switch (kind) {
    case "model_call":
      return 3;
    case "local_tool":
      return mutating ? 1 : 3;
    case "channel_call":
    case "http_call":
      return 5;
    case "credential_wait":
      return Number.POSITIVE_INFINITY; // deadline-only
    case "publish_envelope":
      return 1;
  }
}

export function leaseMs(kind: EffectKind): number {
  switch (kind) {
    case "model_call":
      return 10 * 60 * 1000;
    case "local_tool":
      return 2 * 60 * 1000;
    case "channel_call":
    case "http_call":
      return 60 * 1000;
    case "credential_wait":
      return 60 * 1000;
    case "publish_envelope":
      return 30 * 1000;
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 500 * 2 ** attempts);
}

function mapRow(row: Record<string, unknown>): OutboxRow {
  return {
    effectId: String(row["effect_id"]),
    branchId: String(row["branch_id"]),
    channelId: String(row["channel_id"]),
    kind: String(row["kind"]) as EffectKind,
    idempotencyKey: String(row["idempotency_key"]),
    descriptor: JSON.parse(String(row["descriptor_json"])) as EffectDescriptor,
    attempts: Number(row["attempts"] ?? 0),
    nextAttemptAt: row["next_attempt_at"] == null ? null : Number(row["next_attempt_at"]),
    leaseExpiresAt: row["lease_expires_at"] == null ? null : Number(row["lease_expires_at"]),
    createdAt: Number(row["created_at"] ?? 0),
  };
}

/**
 * Inspect the activation-local outbox without creating or migrating its
 * reconstructible schema. A diagnostic read must not initialize an otherwise
 * unused agent merely because no outbox has existed in this activation yet.
 */
export function inspectEffectOutbox(sql: SqlStorage): OutboxRow[] {
  const tables = sql
    .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_outbox'`)
    .toArray();
  if (tables.length === 0) return [];
  return (sql.exec(`SELECT * FROM effect_outbox`).toArray() as Record<string, unknown>[]).map(
    mapRow
  );
}

export class EffectOutbox {
  constructor(private readonly sql: SqlStorage) {
    ensureOutboxSchema(sql);
  }

  insert(branchId: string, descriptor: EffectDescriptor, nextAttemptAt: number | null): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO effect_outbox (
         effect_id, branch_id, channel_id, kind, idempotency_key,
         descriptor_json, attempts, next_attempt_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      descriptor.effectId,
      branchId,
      descriptor.channelId,
      descriptor.kind,
      descriptor.idempotencyKey,
      JSON.stringify(descriptor),
      nextAttemptAt,
      Date.now()
    );
  }

  delete(branchId: string, effectId: string): void {
    this.sql.exec(
      `DELETE FROM effect_outbox WHERE branch_id = ? AND effect_id = ?`,
      branchId,
      effectId
    );
  }

  get(branchId: string, effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM effect_outbox WHERE branch_id = ? AND effect_id = ?`, branchId, effectId)
      .toArray();
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  }

  getForChannel(channelId: string, effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(
        `SELECT * FROM effect_outbox WHERE channel_id = ? AND effect_id = ?`,
        channelId,
        effectId
      )
      .toArray() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(`ambiguous outbox effect ${effectId} for channel ${channelId}`);
    }
    return mapRow(rows[0]!);
  }

  getUnique(effectId: string): OutboxRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM effect_outbox WHERE effect_id = ?`, effectId)
      .toArray() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(`ambiguous outbox effect ${effectId}; provide branch or channel`);
    }
    return mapRow(rows[0]!);
  }

  forBranch(branchId: string): OutboxRow[] {
    return (
      this.sql
        .exec(
          `SELECT * FROM effect_outbox WHERE branch_id = ? AND kind != 'publish_envelope'`,
          branchId
        )
        .toArray() as Record<string, unknown>[]
    ).map(mapRow);
  }

  all(): OutboxRow[] {
    return inspectEffectOutbox(this.sql);
  }

  /** Rows due for dispatch: unleased (or expired lease) and past nextAttemptAt. */
  due(now: number): OutboxRow[] {
    return (
      this.sql
        .exec(
          `SELECT * FROM effect_outbox
           WHERE (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          now,
          now
        )
        .toArray() as Record<string, unknown>[]
    ).map(mapRow);
  }

  lease(branchId: string, effectId: string, now: number): void {
    const row = this.get(branchId, effectId);
    if (!row) return;
    // Take the row in-flight AND clear next_attempt_at: it still holds the (now-past) dispatch time,
    // and once dispatched the NEXT attempt time is owned by the outcome — deferRedrive's backstop,
    // recordFailure's backoff, or a racing nudge (which re-sets it to a fresh `now`). Leaving the stale
    // past value here makes deferRedrive's "keep an earlier wake" clause preserve an already-due time,
    // so a DEFERRED effect (channel_call/http_call/credential_wait) re-dispatches on every alarm tick
    // (~50ms) until its result arrives — a hot redrive loop instead of the intended ~60s backstop.
    this.sql.exec(
      `UPDATE effect_outbox
       SET lease_expires_at = ?, next_attempt_at = NULL
       WHERE branch_id = ? AND effect_id = ?`,
      now + leaseMs(row.kind),
      branchId,
      effectId
    );
  }

  releaseLease(branchId: string, effectId: string): void {
    this.sql.exec(
      `UPDATE effect_outbox
       SET lease_expires_at = NULL
       WHERE branch_id = ? AND effect_id = ?`,
      branchId,
      effectId
    );
  }

  recordFailure(
    branchId: string,
    effectId: string,
    now: number,
    delayMs?: number
  ): OutboxRow | null {
    const row = this.get(branchId, effectId);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const delay =
      typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs >= 0
        ? delayMs
        : backoffMs(attempts);
    this.sql.exec(
      `UPDATE effect_outbox
       SET attempts = ?,
           lease_expires_at = NULL,
           next_attempt_at = ?
       WHERE branch_id = ? AND effect_id = ?`,
      attempts,
      now + delay,
      branchId,
      effectId
    );
    return this.get(branchId, effectId);
  }

  /**
   * Earliest wake-relevant instant across rows (alarm scheduling). Leased
   * (in-flight) rows become due at lease expiry — that IS orphan recovery
   * for work lost to eviction or a hung stream; unleased rows at their
   * next_attempt_at (0 = now). Lease-awareness keeps the alarm quiet while
   * work is genuinely running instead of hot-polling it.
   */
  earliestDueAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(
           CASE WHEN lease_expires_at IS NOT NULL
                THEN lease_expires_at
                ELSE COALESCE(next_attempt_at, 0)
           END
         ) AS due FROM effect_outbox`
      )
      .toArray()[0];
    const value = row?.["due"];
    return typeof value === "number" ? value : null;
  }
}
