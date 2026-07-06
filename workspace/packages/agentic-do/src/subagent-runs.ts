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

export type SubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export type SubagentRunMerge = "merged" | "conflicted" | "discarded";

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
  merge: SubagentRunMerge | null;
  startedAt: number;
  lastActivityAt: number;
  /** Reasoning engine kind (default "pi"). */
  agentKind: SubagentAgentKind;
  /** External session entity id for extension-launched kinds, or null. */
  externalSessionEntityId: string | null;
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
  merge_status: string | null;
  started_at: number;
  last_activity_at: number;
  agent_kind: string | null;
  external_session_entity_id: string | null;
  process_id?: string | null;
}

function toRow(row: SubagentRunSqlRow): SubagentRunRow {
  return {
    runId: row.run_id,
    taskChannelId: row.task_channel_id,
    parentContextId: row.parent_context_id ?? null,
    childContextId: row.child_context_id,
    childEntityId: row.child_entity_id,
    childParticipantId: row.child_participant_id ?? null,
    parentChannelId: row.parent_channel_id,
    mode: row.mode === "fork" ? "fork" : "fresh",
    label: row.label,
    depth: Number(row.depth),
    status: (row.status as SubagentRunStatus) ?? "running",
    merge: (row.merge_status as SubagentRunMerge | null) ?? null,
    startedAt: Number(row.started_at),
    lastActivityAt: Number(row.last_activity_at),
    agentKind: row.agent_kind || "pi",
    externalSessionEntityId: row.external_session_entity_id ?? row.process_id ?? null,
  };
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
        merge_status TEXT,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        agent_kind TEXT,
        external_session_entity_id TEXT
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE subagent_runs ADD COLUMN parent_context_id TEXT`);
    } catch {
      // Existing/new tables may already have the migration.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subagent_wake_cursors (
        channel_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE subagent_runs ADD COLUMN external_session_entity_id TEXT`);
    } catch {
      // Column already exists on fresh/newer stores.
    }
  }

  /** Idempotent insert — a re-driven spawn (same runId) is a no-op. */
  insert(row: SubagentRunRow): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO subagent_runs
         (run_id, task_channel_id, parent_context_id, child_context_id, child_entity_id, child_participant_id, parent_channel_id,
          mode, label, depth, status, merge_status, started_at, last_activity_at, agent_kind, external_session_entity_id)
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
      row.merge,
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

  setMerge(runId: string, merge: SubagentRunMerge): void {
    this.sql.exec(`UPDATE subagent_runs SET merge_status = ? WHERE run_id = ?`, merge, runId);
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
}
