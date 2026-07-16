/**
 * SubagentRunStore — durable bookkeeping for the subagent runs a supervising
 * vessel owns, plus the per-channel turn-final wake cursor.
 *
 * The log is the source of truth for a run's transcript (the task channel) and
 * its trajectory record (parent invocation events); this table is the vessel's
 * live INDEX over those — enough to route `complete`, gate depth/fan-out, drive
 * supervision tools, and re-home teardown after hibernation. Every field is
 * derived from durable inputs at spawn, so a replay reconstructs it
 * deterministically.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { AgenticEvent } from "@workspace/agentic-protocol";
import { assertExactSqlTableSchema } from "./sql-table-schema.js";

export type SubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export type SubagentRunIntegration = "integrated" | "conflicted" | "discarded";

/** The reasoning engine behind a subagent: "pi" is the in-process vessel; any
 *  other string names an extension-owned external launcher. */
export type SubagentAgentKind = string;

export interface SubagentRunRow {
  runId: string;
  taskChannelId: string;
  parentContextId: string | null;
  childContextId: string;
  childEntityId: string;
  childParticipantId: string | null;
  parentChannelId: string;
  mode: "fresh" | "fork";
  label: string;
  depth: number;
  status: SubagentRunStatus;
  integration: SubagentRunIntegration | null;
  startedAt: number;
  lastActivityAt: number;
  /** Reasoning engine kind (default "pi"). */
  agentKind: SubagentAgentKind;
  /** External session entity id for extension-launched kinds, or null. */
  externalSessionEntityId: string | null;
}

export type SubagentRunReferenceResolution =
  | { kind: "exact" | "abbreviated"; run: SubagentRunRow }
  | { kind: "ambiguous" }
  | null;

const MIN_ABBREVIATED_RUN_ID_LENGTH = 16;
const SUBAGENT_RUN_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const satisfies readonly SubagentRunStatus[];
const SUBAGENT_RUN_INTEGRATIONS = [
  "integrated",
  "conflicted",
  "discarded",
] as const satisfies readonly SubagentRunIntegration[];

function stripTrailingEllipsis(reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed.endsWith("...")) return trimmed.slice(0, -3).trimEnd();
  if (trimmed.endsWith("…")) return trimmed.slice(0, -1).trimEnd();
  return null;
}

/** Return edit distance when it is within `limit`, otherwise stop early. */
function boundedEditDistance(left: string, right: string, limit: number): number | null {
  if (Math.abs(left.length - right.length) > limit) return null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost
      );
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > limit) return null;
    previous = current;
  }
  const distance = previous[right.length]!;
  return distance <= limit ? distance : null;
}

function abbreviatedReferenceScore(reference: string, runId: string): number | null {
  const maxDistance = reference.length >= 32 ? 2 : 1;
  let best: number | null = null;
  const shortest = Math.max(1, reference.length - maxDistance);
  const longest = Math.min(runId.length, reference.length + maxDistance);
  for (let length = shortest; length <= longest; length += 1) {
    const distance = boundedEditDistance(reference, runId.slice(0, length), maxDistance);
    if (distance !== null && (best === null || distance < best)) best = distance;
  }
  return best;
}

interface SubagentRunSqlRow {
  run_id: string;
  task_channel_id: string;
  parent_context_id?: string | null;
  child_context_id: string;
  child_entity_id: string;
  child_participant_id: string | null;
  parent_channel_id: string;
  mode: string;
  label: string;
  depth: number;
  status: string;
  integration_status: string | null;
  started_at: number;
  last_activity_at: number;
  agent_kind: string;
  external_session_entity_id: string | null;
}

interface SubagentProgressOutboxSqlRow {
  sequence: number;
  idempotency_key: string;
  run_id: string;
  message_seq: number;
  parent_channel_id: string;
  participant_id: string;
  event_json: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

export interface SubagentProgressOutboxEntry {
  sequence: number;
  idempotencyKey: string;
  runId: string;
  messageSeq: number;
  parentChannelId: string;
  participantId: string;
  event: AgenticEvent<"invocation.progress">;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

export interface SubagentProgressOutboxDiagnostics {
  pending: number;
  oldestCreatedAt: number | null;
  failures: Array<{
    idempotencyKey: string;
    runId: string;
    messageSeq: number;
    attempts: number;
    nextAttemptAt: number;
    lastError: string;
  }>;
}

function toProgressOutboxEntry(row: SubagentProgressOutboxSqlRow): SubagentProgressOutboxEntry {
  return {
    sequence: Number(row.sequence),
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    messageSeq: Number(row.message_seq),
    parentChannelId: row.parent_channel_id,
    participantId: row.participant_id,
    event: JSON.parse(row.event_json) as AgenticEvent<"invocation.progress">,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
  };
}

function toRow(row: SubagentRunSqlRow): SubagentRunRow {
  const mode = exactEnum("mode", row.mode, ["fresh", "fork"] as const);
  const status = exactEnum("status", row.status, SUBAGENT_RUN_STATUSES);
  const integration =
    row.integration_status === null
      ? null
      : exactEnum("integration_status", row.integration_status, SUBAGENT_RUN_INTEGRATIONS);
  if (typeof row.agent_kind !== "string" || row.agent_kind.trim().length === 0) {
    throw new Error(`Invalid subagent_runs.agent_kind: ${JSON.stringify(row.agent_kind)}`);
  }
  return {
    runId: row.run_id,
    taskChannelId: row.task_channel_id,
    parentContextId: row.parent_context_id ?? null,
    childContextId: row.child_context_id,
    childEntityId: row.child_entity_id,
    childParticipantId: row.child_participant_id ?? null,
    parentChannelId: row.parent_channel_id,
    mode,
    label: row.label,
    depth: Number(row.depth),
    status,
    integration,
    startedAt: Number(row.started_at),
    lastActivityAt: Number(row.last_activity_at),
    agentKind: row.agent_kind,
    externalSessionEntityId: row.external_session_entity_id ?? null,
  };
}

function exactEnum<const Value extends string>(
  field: string,
  value: unknown,
  allowed: readonly Value[]
): Value {
  if (typeof value === "string" && allowed.includes(value as Value)) return value as Value;
  throw new Error(`Invalid subagent_runs.${field}: ${JSON.stringify(value)}`);
}

export class SubagentRunStore {
  constructor(private sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        run_id TEXT PRIMARY KEY,
        task_channel_id TEXT NOT NULL,
        parent_context_id TEXT,
        child_context_id TEXT NOT NULL,
        child_entity_id TEXT NOT NULL,
        child_participant_id TEXT,
        parent_channel_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        label TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL,
        integration_status TEXT,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        agent_kind TEXT NOT NULL,
        external_session_entity_id TEXT
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "subagent_runs",
      columns: [
        ["run_id", "TEXT", false],
        ["task_channel_id", "TEXT", true],
        ["parent_context_id", "TEXT", false],
        ["child_context_id", "TEXT", true],
        ["child_entity_id", "TEXT", true],
        ["child_participant_id", "TEXT", false],
        ["parent_channel_id", "TEXT", true],
        ["mode", "TEXT", true],
        ["label", "TEXT", true],
        ["depth", "INTEGER", true],
        ["status", "TEXT", true],
        ["integration_status", "TEXT", false],
        ["started_at", "INTEGER", true],
        ["last_activity_at", "INTEGER", true],
        ["agent_kind", "TEXT", true],
        ["external_session_entity_id", "TEXT", false],
      ],
      primaryKey: ["run_id"],
    });
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subagent_wake_cursors (
        channel_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "subagent_wake_cursors",
      columns: [
        ["channel_id", "TEXT", false],
        ["last_seq", "INTEGER", true],
      ],
      primaryKey: ["channel_id"],
    });
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subagent_progress_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        parent_channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    assertExactSqlTableSchema(this.sql, {
      table: "subagent_progress_outbox",
      columns: [
        ["sequence", "INTEGER", false],
        ["idempotency_key", "TEXT", true],
        ["run_id", "TEXT", true],
        ["message_seq", "INTEGER", true],
        ["parent_channel_id", "TEXT", true],
        ["participant_id", "TEXT", true],
        ["event_json", "TEXT", true],
        ["attempts", "INTEGER", true, "0"],
        ["next_attempt_at", "INTEGER", true],
        ["last_error", "TEXT", false],
        ["created_at", "INTEGER", true],
      ],
      primaryKey: ["sequence"],
    });
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS subagent_progress_outbox_run_sequence
      ON subagent_progress_outbox (run_id, sequence)
    `);
  }

  /** Idempotent insert — a re-driven spawn (same runId) is a no-op. */
  insert(row: SubagentRunRow): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO subagent_runs
         (run_id, task_channel_id, parent_context_id, child_context_id, child_entity_id, child_participant_id, parent_channel_id,
          mode, label, depth, status, integration_status, started_at, last_activity_at, agent_kind, external_session_entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.runId,
      row.taskChannelId,
      row.parentContextId,
      row.childContextId,
      row.childEntityId,
      row.childParticipantId,
      row.parentChannelId,
      row.mode,
      row.label,
      row.depth,
      row.status,
      row.integration,
      row.startedAt,
      row.lastActivityAt,
      row.agentKind,
      row.externalSessionEntityId
    );
  }

  get(runId: string): SubagentRunRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM subagent_runs WHERE run_id = ?`, runId)
      .toArray() as unknown as SubagentRunSqlRow[];
    return rows.length > 0 ? toRow(rows[0]!) : null;
  }

  /**
   * Resolve the durable id first, then an explicitly abbreviated display copy.
   * Abbreviations must end in an ellipsis, be long enough to be meaningful,
   * and identify one best run in the caller's parent channel. A tiny edit
   * allowance covers display/model truncation at the boundary without turning
   * arbitrary strings into run handles.
   */
  resolveReference(reference: string, parentChannelId?: string): SubagentRunReferenceResolution {
    const exact = this.get(reference);
    if (exact) return { kind: "exact", run: exact };

    const abbreviated = stripTrailingEllipsis(reference);
    if (!abbreviated || abbreviated.length < MIN_ABBREVIATED_RUN_ID_LENGTH) return null;

    const candidates = this.listAll()
      .filter((run) => !parentChannelId || run.parentChannelId === parentChannelId)
      .map((run) => ({ run, score: abbreviatedReferenceScore(abbreviated, run.runId) }))
      .filter(
        (candidate): candidate is { run: SubagentRunRow; score: number } => candidate.score !== null
      );
    if (candidates.length === 0) return null;
    const bestScore = Math.min(...candidates.map((candidate) => candidate.score));
    const best = candidates.filter((candidate) => candidate.score === bestScore);
    if (best.length !== 1) return { kind: "ambiguous" };
    return { kind: "abbreviated", run: best[0]!.run };
  }

  listAll(): SubagentRunRow[] {
    return (
      this.sql.exec(`SELECT * FROM subagent_runs`).toArray() as unknown as SubagentRunSqlRow[]
    ).map(toRow);
  }

  getByTaskChannel(taskChannelId: string): SubagentRunRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM subagent_runs WHERE task_channel_id = ?`, taskChannelId)
      .toArray() as unknown as SubagentRunSqlRow[];
    return rows.length > 0 ? toRow(rows[0]!) : null;
  }

  listByStatus(status: SubagentRunStatus): SubagentRunRow[] {
    return (
      this.sql
        .exec(`SELECT * FROM subagent_runs WHERE status = ?`, status)
        .toArray() as unknown as SubagentRunSqlRow[]
    ).map(toRow);
  }

  /** Number of live (not-yet-terminal) runs — the fan-out gate. */
  countRunning(): number {
    const row = this.sql
      .exec(`SELECT COUNT(*) AS cnt FROM subagent_runs WHERE status IN ('starting', 'running')`)
      .toArray()[0];
    return Number(row?.["cnt"] ?? 0);
  }

  listLive(): SubagentRunRow[] {
    return (
      this.sql
        .exec(`SELECT * FROM subagent_runs WHERE status IN ('starting', 'running')`)
        .toArray() as unknown as SubagentRunSqlRow[]
    ).map(toRow);
  }

  setStatus(runId: string, status: SubagentRunStatus): void {
    this.sql.exec(`UPDATE subagent_runs SET status = ? WHERE run_id = ?`, status, runId);
  }

  setIntegration(runId: string, integration: SubagentRunIntegration): void {
    this.sql.exec(
      `UPDATE subagent_runs SET integration_status = ? WHERE run_id = ?`,
      integration,
      runId
    );
  }

  setChildParticipantId(runId: string, participantId: string | null): void {
    this.sql.exec(
      `UPDATE subagent_runs SET child_participant_id = ? WHERE run_id = ?`,
      participantId,
      runId
    );
  }

  setExternalSessionEntityId(runId: string, entityId: string | null): void {
    this.sql.exec(
      `UPDATE subagent_runs SET external_session_entity_id = ? WHERE run_id = ?`,
      entityId,
      runId
    );
  }

  setChildEntityId(runId: string, childEntityId: string): void {
    this.sql.exec(
      `UPDATE subagent_runs SET child_entity_id = ? WHERE run_id = ?`,
      childEntityId,
      runId
    );
  }

  setParentContextId(runId: string, contextId: string): void {
    this.sql.exec(
      `UPDATE subagent_runs SET parent_context_id = ? WHERE run_id = ?`,
      contextId,
      runId
    );
  }

  touch(runId: string, at: number): void {
    this.sql.exec(`UPDATE subagent_runs SET last_activity_at = ? WHERE run_id = ?`, at, runId);
  }

  delete(runId: string): void {
    this.sql.exec(`DELETE FROM subagent_runs WHERE run_id = ?`, runId);
  }

  getWakeCursor(channelId: string): number {
    const row = this.sql
      .exec(`SELECT last_seq FROM subagent_wake_cursors WHERE channel_id = ?`, channelId)
      .toArray()[0];
    return Number(row?.["last_seq"] ?? 0);
  }

  setWakeCursor(channelId: string, seq: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO subagent_wake_cursors (channel_id, last_seq) VALUES (?, ?)`,
      channelId,
      seq
    );
  }

  deleteWakeCursor(channelId: string): void {
    this.sql.exec(`DELETE FROM subagent_wake_cursors WHERE channel_id = ?`, channelId);
  }

  /**
   * Durably enqueue a parent-card progress event. The idempotency key is also
   * the target channel publication key, so losing the acknowledgement after a
   * successful publish is safe: the retry resolves to the same channel event.
   */
  enqueueProgress(input: {
    idempotencyKey: string;
    runId: string;
    messageSeq: number;
    parentChannelId: string;
    participantId: string;
    event: AgenticEvent<"invocation.progress">;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO subagent_progress_outbox
         (idempotency_key, run_id, message_seq, parent_channel_id, participant_id,
          event_json, attempts, next_attempt_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      input.idempotencyKey,
      input.runId,
      input.messageSeq,
      input.parentChannelId,
      input.participantId,
      JSON.stringify(input.event),
      input.now,
      input.now
    );
  }

  /**
   * Return due queue heads only. Later events for a run remain blocked behind
   * its oldest outstanding event, while unrelated runs can continue.
   */
  dueProgress(now: number, limit: number): SubagentProgressOutboxEntry[] {
    return (
      this.sql
        .exec(
          `SELECT current.*
           FROM subagent_progress_outbox AS current
           WHERE current.next_attempt_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM subagent_progress_outbox AS earlier
               WHERE earlier.run_id = current.run_id
                 AND earlier.sequence < current.sequence
             )
           ORDER BY current.sequence ASC
           LIMIT ?`,
          now,
          limit
        )
        .toArray() as unknown as SubagentProgressOutboxSqlRow[]
    ).map(toProgressOutboxEntry);
  }

  nextProgressWakeAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(current.next_attempt_at) AS due
         FROM subagent_progress_outbox AS current
         WHERE NOT EXISTS (
           SELECT 1 FROM subagent_progress_outbox AS earlier
           WHERE earlier.run_id = current.run_id
             AND earlier.sequence < current.sequence
         )`
      )
      .toArray()[0];
    const value = row?.["due"];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  completeProgress(sequence: number): void {
    this.sql.exec(`DELETE FROM subagent_progress_outbox WHERE sequence = ?`, sequence);
  }

  failProgress(sequence: number, error: string, nextAttemptAt: number): void {
    this.sql.exec(
      `UPDATE subagent_progress_outbox
       SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
       WHERE sequence = ?`,
      error,
      nextAttemptAt,
      sequence
    );
  }

  progressDiagnostics(): SubagentProgressOutboxDiagnostics {
    const summary = this.sql
      .exec(
        `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest_created_at
         FROM subagent_progress_outbox`
      )
      .toArray()[0];
    const failures = this.sql
      .exec(
        `SELECT idempotency_key, run_id, message_seq, attempts, next_attempt_at, last_error
         FROM subagent_progress_outbox
         WHERE last_error IS NOT NULL
         ORDER BY sequence ASC
         LIMIT 25`
      )
      .toArray() as Array<Record<string, unknown>>;
    return {
      pending: Number(summary?.["pending"] ?? 0),
      oldestCreatedAt:
        typeof summary?.["oldest_created_at"] === "number"
          ? Number(summary["oldest_created_at"])
          : null,
      failures: failures.map((row) => ({
        idempotencyKey: String(row["idempotency_key"]),
        runId: String(row["run_id"]),
        messageSeq: Number(row["message_seq"]),
        attempts: Number(row["attempts"]),
        nextAttemptAt: Number(row["next_attempt_at"]),
        lastError: String(row["last_error"]),
      })),
    };
  }
}
