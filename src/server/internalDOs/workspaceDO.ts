/**
 * WorkspaceDO — durable workspace state store.
 *
 * Replaces PanelStoreDO with a unified entity/slot model. Entity rows are
 * immutable in their identity columns (write-once) and mutable in their
 * lifecycle columns (status, retired_at, cleanup_complete). Slot rows hold
 * the panel-tree position; slot_history holds the navigation history.
 *
 * Schema v7 ships clean-cut: the upgrade path drops every v6 table and
 * creates the new schema empty. No data migration.
 */

import { DurableObjectBase, rpc, type DurableObjectContext } from "@vibestudio/durable";
import {
  IdentityCollisionError,
  canonicalEntityId,
  type EntityKind,
  type EntityRecord,
  type RuntimeAgentBinding,
} from "../../../packages/shared/src/runtime/entitySpec.js";
import type {
  IndexablePanel,
  PanelSearchResult,
} from "../../../packages/shared/src/panelSearchTypes.js";

interface DbEntityRow {
  id: string;
  kind: EntityKind;
  source_repo_path: string;
  active_execution_digest: string | null;
  context_id: string;
  class_name: string | null;
  key: string;
  state_args: string | null;
  agent_binding: string | null;
  parent_id: string | null;
  owner_user_id: string | null;
  created_at: number;
  status: "active" | "retired";
  retired_at: number | null;
  cleanup_complete: number; // SQLite stores boolean as 0/1
  error: string | null;
}

interface DbContextEdgeRow {
  context_id: string;
  owner_context_id: string;
  kind: "lifecycle" | "lineage";
  owner_entity_id: string | null;
  created_at: number;
}

interface DbSlotRow {
  slot_id: string;
  parent_slot_id: string | null;
  current_entity_id: string | null;
  current_entity_title?: string | null;
  current_entry_key: string | null;
  position_id: string;
  /**
   * Owning-user id (WP3) — the user whose tree this slot belongs to. Stamped at
   * slot creation from the creating caller's `subject.userId`; re-stamped for a
   * whole subtree on a cross-owner move (WP3 §10.1). NULL for pre-identity /
   * system-seeded slots. Attribution only — never an isolation boundary.
   */
  owner_user_id: string | null;
  created_at: number;
  closed_at: number | null;
}

interface DbSlotHistoryRow {
  slot_id: string;
  cursor: number;
  entry_key: string;
  entity_id: string;
  source: string;
  context_id: string;
  state_args: string | null;
  options: string | null;
  recorded_at: number;
}

export interface LifecycleKey {
  source: string;
  className: string;
  objectKey: string;
}

export interface LifecycleLeaseInput extends LifecycleKey {
  detail?: unknown;
}

export interface LifecycleEpochInput {
  kind: "planned" | "crash" | "server_restart";
  reason: string;
  generation: number;
}

export interface LifecycleOpInput {
  epochId: string;
  key: LifecycleKey;
  opKind: "prepare" | "resume";
  status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
  detail?: unknown;
}

export interface LifecycleLease extends LifecycleKey {
  detail: unknown | null;
  createdAt: number;
  refreshedAt: number;
}

export interface LifecycleOp extends LifecycleKey {
  epochId: string;
  opKind: "prepare" | "resume";
  status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
  detail: unknown | null;
  updatedAt: number;
}

export interface EntityActivateInput {
  kind: EntityKind;
  source: { repoPath: string };
  activeExecutionDigest?: string;
  contextId: string;
  className?: string;
  key: string;
  stateArgs?: unknown;
  agentBinding?: RuntimeAgentBinding;
  /** Launch parent (verified caller id) — see EntityRecord.parentId. */
  parentId?: string;
  /**
   * Owning-user id — the creating caller's `subject.userId` (WP0 §6). Stamped
   * write-once onto `entities.owner_user_id` so an agent/worker/DO attributes to
   * the human whose subject launched its lineage. Absent for bootstrap-created
   * entities that have no subject (WP0 §5.4).
   */
  ownerUserId?: string;
}

export interface SlotCreateInput {
  slotId: string;
  parentSlotId: string | null;
  positionId: string;
  /**
   * Owning-user id (WP3) — the creating caller's `subject.userId`, threaded from
   * `panelTreeService`. Stamped write-at-create onto `slots.owner_user_id` so the
   * tree groups under its owner in the forest. Absent for bootstrap/system seeds.
   */
  ownerUserId?: string;
  initialEntry?: {
    entryKey: string;
    entityId: string;
    source: string;
    contextId: string;
    stateArgs?: unknown;
  };
}

export interface SlotHistoryEntryInput {
  entryKey: string;
  entityId: string;
  source: string;
  contextId: string;
  stateArgs?: unknown;
  /** Per-entry navigation options (env/ref) so any client/host reconstructs them. */
  options?: unknown;
}

export interface GcOptions {
  /** Sweep all rows. If false (default), caller must scope by slotId. */
  all?: boolean;
  /** Only sweep entities tied to this slot's history. */
  slotId?: string;
  /** Don't delete rows newer than (now - graceMs). Default: 1 hour. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 60 * 60 * 1000;
const WORKSPACE_REQUIRED_TABLES = [
  "entities",
  "slots",
  "slot_history",
  "panel_search_metadata",
  "workspace_meta",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "recurring_jobs",
  "heartbeat_registry",
  "context_edges",
] as const;

/** One declared recurring job (see meta/vibestudio.yml `recurring:`). */
export interface RecurringJobRow {
  name: string;
  source: string;
  className: string;
  objectKey: string;
  method: string;
  argsJson: string;
  intervalMs: number;
  /** Local-time anchor (minutes after midnight) for day-aligned schedules. */
  atMinutes?: number | null;
  /** Hash of the declared spec; preserves next_run_at across unchanged syncs. */
  specHash: string;
  /** Used for new/changed jobs at sync time. */
  initialNextRunAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number;
  failCount?: number;
  backoffUntil?: number | null;
  lastStartedAt?: number | null;
  lastSucceededAt?: number | null;
  lastFailedAt?: number | null;
  lastError?: string | null;
  lastDurationMs?: number | null;
}

export interface HeartbeatRegistryRow {
  name: string;
  source: string;
  className: string;
  objectKey: string;
  channelId?: string | null;
  participantHandle?: string | null;
  kind: "declarative" | "code-owned";
  status: "running" | "paused" | "stopped";
  nextRunAt?: number | null;
  lastWakeAt?: number | null;
  lastActionSummary?: string | null;
  lastError?: string | null;
  specHash?: string | null;
  updatedAt: number;
}

function rowToRecurringJob(row: Record<string, unknown>): RecurringJobRow {
  const nullableNumber = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    name: String(row["name"]),
    source: String(row["source"]),
    className: String(row["class_name"]),
    objectKey: String(row["object_key"]),
    method: String(row["method"]),
    argsJson: String(row["args_json"]),
    intervalMs: Number(row["interval_ms"]),
    atMinutes: row["at_minutes"] === null ? null : Number(row["at_minutes"]),
    specHash: String(row["spec_hash"]),
    initialNextRunAt: Number(row["next_run_at"]),
    lastRunAt: row["last_run_at"] === null ? null : Number(row["last_run_at"]),
    nextRunAt: Number(row["next_run_at"]),
    failCount: Number(row["fail_count"] ?? 0),
    backoffUntil: nullableNumber("backoff_until"),
    lastStartedAt: nullableNumber("last_started_at"),
    lastSucceededAt: nullableNumber("last_succeeded_at"),
    lastFailedAt: nullableNumber("last_failed_at"),
    lastError:
      row["last_error"] === null || row["last_error"] === undefined
        ? null
        : String(row["last_error"]),
    lastDurationMs: nullableNumber("last_duration_ms"),
  };
}

function rowToHeartbeatRegistry(row: Record<string, unknown>): HeartbeatRegistryRow {
  const nullableNumber = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  const nullableString = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  const kind = row["kind"] === "declarative" ? "declarative" : "code-owned";
  const status =
    row["status"] === "paused" || row["status"] === "stopped" ? row["status"] : "running";
  return {
    name: String(row["name"]),
    source: String(row["source"]),
    className: String(row["class_name"]),
    objectKey: String(row["object_key"]),
    channelId: nullableString("channel_id"),
    participantHandle: nullableString("participant_handle"),
    kind,
    status,
    nextRunAt: nullableNumber("next_run_at"),
    lastWakeAt: nullableNumber("last_wake_at"),
    lastActionSummary: nullableString("last_action_summary"),
    lastError: nullableString("last_error"),
    specHash: nullableString("spec_hash"),
    updatedAt: Number(row["updated_at"]),
  };
}

export class WorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 21;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  // ─────────────────────────────────────────────────────────────
  // Schema
  // ─────────────────────────────────────────────────────────────

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_repo_path TEXT NOT NULL,
        active_execution_digest TEXT,
        context_id TEXT NOT NULL,
        class_name TEXT,
        key TEXT NOT NULL,
        state_args TEXT,
        agent_binding TEXT,
        parent_id TEXT,
        owner_user_id TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        retired_at INTEGER,
        cleanup_complete INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        display_title TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status, retired_at)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_cleanup
        ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`
    );

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        slot_id TEXT PRIMARY KEY,
        parent_slot_id TEXT REFERENCES slots(slot_id),
        current_entity_id TEXT REFERENCES entities(id),
        current_entry_key TEXT,
        position_id TEXT NOT NULL DEFAULT '000001000000',
        owner_user_id TEXT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`);
    // Owner-scoped "just my tree" lookups (WP3). Partial: only open slots — a
    // closed slot's owner is dead weight. The default forest read is still ALL
    // open slots (mutual visibility); this index only backs the optional filter.
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`
    );

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS slot_history (
        slot_id TEXT NOT NULL REFERENCES slots(slot_id),
        cursor INTEGER NOT NULL,
        entry_key TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        source TEXT NOT NULL,
        context_id TEXT NOT NULL,
        state_args TEXT,
        options TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (slot_id, cursor)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entity ON slot_history(entity_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entry ON slot_history(entry_key)`);

    // panel_search_metadata is an FTS5 staging table — per-slot, holds the
    // text we want indexed. `searchable_title` is intentionally a
    // denormalization of `entities.display_title` (the canonical source of
    // truth for titles, accessed via the slot's current_entity_id). The
    // denormalization exists because FTS5 external-content tables require
    // their content columns to live on a regular table, and contentless
    // FTS5 doesn't support the upsert-by-rowid pattern we'd need under
    // workerd. All writes to `searchable_title` flow through one site
    // (`entitySetDisplayTitle`), so there is no second code path that can
    // diverge from the source.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_search_metadata (
        slot_id TEXT PRIMARY KEY,
        searchable_title TEXT NOT NULL DEFAULT '',
        searchable_path TEXT,
        manifest_description TEXT,
        manifest_dependencies TEXT,
        tags TEXT,
        keywords TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS panel_fts USING fts5(
        searchable_title,
        searchable_path,
        manifest_description,
        manifest_dependencies,
        tags,
        keywords,
        content='panel_search_metadata',
        content_rowid='rowid'
      )
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_insert AFTER INSERT ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_delete AFTER DELETE ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_update AFTER UPDATE ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // context_edges — the context-relationship registry. Two edge kinds:
    // 'lifecycle' (subagent contexts — cascaded on destroy, cloned on recursive
    // clone) and 'lineage' (conversation-fork provenance — access-only, never
    // cascaded or cloned-followed). Keyed on kind so a context may carry both a
    // lineage edge (forked from X) and lifecycle edges from other owners.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS context_edges (
        context_id       TEXT NOT NULL,
        owner_context_id TEXT NOT NULL,
        kind             TEXT NOT NULL,
        owner_entity_id  TEXT,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (context_id, owner_context_id, kind)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_context_edges_owner ON context_edges(owner_context_id, kind)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_context_edges_child ON context_edges(context_id)`
    );
    this.createLifecycleTables();
  }

  protected override requiredTables(): readonly string[] {
    return WORKSPACE_REQUIRED_TABLES;
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion === 0) return;
    // Pre-release. Schema changes are destructive — there is no user data to
    // preserve, and we'd rather keep migration code small than carry layered
    // ALTERs forever. Anything older than the current schema gets wiped and
    // recreated by createTables().
    this.sql.exec(`DROP TABLE IF EXISTS panel_fts`);
    this.sql.exec(`DROP TABLE IF EXISTS panel_search_metadata`);
    this.sql.exec(`DROP TABLE IF EXISTS panel_ops`);
    this.sql.exec(`DROP TABLE IF EXISTS panels`);
    this.sql.exec(`DROP TABLE IF EXISTS workspace_meta`);
    this.sql.exec(`DROP TABLE IF EXISTS slot_history`);
    this.sql.exec(`DROP TABLE IF EXISTS slots`);
    this.sql.exec(`DROP TABLE IF EXISTS entities`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_ops`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_leases`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_epochs`);
    this.sql.exec(`DROP TABLE IF EXISTS do_alarms`);
    this.sql.exec(`DROP TABLE IF EXISTS recurring_jobs`);
    this.sql.exec(`DROP TABLE IF EXISTS heartbeat_registry`);
    this.sql.exec(`DROP TABLE IF EXISTS context_edges`);
  }

  getWorkspaceId(): string {
    return this.objectKey;
  }

  // ─────────────────────────────────────────────────────────────
  // entity.* operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Three-way upsert keyed by canonical id derived from identity columns.
   * - No prior row → insert with status='active'.
   * - Prior 'active' row with identical identity → idempotent no-op.
   * - Prior 'retired' row with identical identity → reactivate (flip status).
   * - Prior row with mismatched identity → throw IDENTITY_COLLISION.
   */
  @rpc({ principals: ["host"] })
  entityActivate(input: EntityActivateInput): EntityRecord {
    return this.ctx.storage.transactionSync(() => {
      const id = canonicalEntityId({
        kind: input.kind,
        source: input.source.repoPath,
        className: input.className,
        key: input.key,
      });

      const existing = this.readEntityRow(id);
      if (existing) {
        this.assertIdentityMatches(id, existing, input);
        const nextExecutionDigest = input.activeExecutionDigest ?? null;
        if (existing.active_execution_digest !== nextExecutionDigest) {
          this.sql.exec(
            `UPDATE entities SET active_execution_digest = ? WHERE id = ?`,
            nextExecutionDigest,
            id
          );
          existing.active_execution_digest = nextExecutionDigest;
        }
        const nextAgentBinding =
          input.agentBinding === undefined ? null : JSON.stringify(input.agentBinding);
        if (existing.agent_binding !== null && existing.agent_binding !== nextAgentBinding) {
          throw new IdentityCollisionError(id, {
            field: "agentBinding",
            existing: existing.agent_binding,
            attempted: nextAgentBinding,
          });
        }
        if (existing.agent_binding === null && nextAgentBinding !== null) {
          this.sql.exec(`UPDATE entities SET agent_binding = ? WHERE id = ?`, nextAgentBinding, id);
          existing.agent_binding = nextAgentBinding;
        }
        const nextOwnerUserId = input.ownerUserId ?? null;
        if (
          existing.owner_user_id !== null &&
          nextOwnerUserId !== null &&
          existing.owner_user_id !== nextOwnerUserId
        ) {
          throw new IdentityCollisionError(id, {
            field: "ownerUserId",
            existing: existing.owner_user_id,
            attempted: nextOwnerUserId,
          });
        }
        // Clean-cut recovery for entities activated by the broken multi-user
        // bootstrap/resolve path: ownership is write-once, but a legacy NULL
        // can be filled by the first host-verified owner.
        if (existing.owner_user_id === null && nextOwnerUserId !== null) {
          this.sql.exec(`UPDATE entities SET owner_user_id = ? WHERE id = ?`, nextOwnerUserId, id);
          existing.owner_user_id = nextOwnerUserId;
        }
        if (existing.status === "active") {
          return this.rowToEntity(existing);
        }
        // Reactivate
        this.sql.exec(
          `UPDATE entities SET status = 'active', retired_at = NULL, cleanup_complete = 1, error = NULL WHERE id = ?`,
          id
        );
        return this.rowToEntity({
          ...existing,
          agent_binding: existing.agent_binding,
          status: "active",
          retired_at: null,
          cleanup_complete: 1,
          error: null,
        });
      }

      const now = Date.now();
      this.sql.exec(
        `INSERT INTO entities (
          id, kind, source_repo_path, active_execution_digest,
          context_id, class_name, key, state_args, agent_binding, parent_id, owner_user_id, created_at,
          status, retired_at, cleanup_complete, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, NULL)`,
        id,
        input.kind,
        input.source.repoPath,
        input.activeExecutionDigest ?? null,
        input.contextId,
        input.className ?? null,
        input.key,
        input.stateArgs === undefined ? null : JSON.stringify(input.stateArgs),
        input.agentBinding === undefined ? null : JSON.stringify(input.agentBinding),
        input.parentId ?? null,
        input.ownerUserId ?? null,
        now
      );
      const row = this.readEntityRow(id);
      if (!row) throw new Error(`entityActivate: failed to read row after insert: ${id}`);
      return this.rowToEntity(row);
    });
  }

  /** Mark a single entity as retired. Idempotent. Returns the retired record (or null if not found). */
  @rpc({ principals: ["host"] })
  entityRetire(id: string): EntityRecord | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.readEntityRow(id);
      if (!row) return null;
      if (row.status === "retired") {
        return this.rowToEntity(row);
      }
      const now = Date.now();
      this.sql.exec(
        `UPDATE entities SET status = 'retired', retired_at = ?, cleanup_complete = 0 WHERE id = ?`,
        now,
        id
      );
      if (row.kind === "do" && row.class_name) {
        const lifecycleKey = {
          source: row.source_repo_path,
          className: row.class_name,
          objectKey: row.key,
        };
        this.lifecycleLeaseClear(lifecycleKey);
        this.alarmClear(lifecycleKey);
      }
      const updated = this.readEntityRow(id);
      return updated ? this.rowToEntity(updated) : null;
    });
  }

  /** Mark cleanup_complete=1 after server-side hooks succeed. */
  @rpc({ principals: ["host"] })
  entityCleanupComplete(id: string): void {
    this.sql.exec(`UPDATE entities SET cleanup_complete = 1 WHERE id = ?`, id);
  }

  /** Find rows whose cleanup hooks need retrying. */
  @rpc({ principals: ["host"] })
  entityFindIncompleteCleanups(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE retired_at IS NOT NULL AND cleanup_complete = 0`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Hard-delete retired rows older than the grace window and unreferenced by slot_history.
   * Never deletes active rows; never deletes history-referenced rows. Fires no hooks.
   */
  @rpc({ principals: ["host"] })
  entityGc(opts: GcOptions = {}): string[] {
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const cutoff = Date.now() - graceMs;
    return this.ctx.storage.transactionSync(() => {
      let candidates: Array<{ id: string }>;
      if (opts.all) {
        candidates = this.sql
          .exec(
            `SELECT id FROM entities
             WHERE status = 'retired' AND retired_at IS NOT NULL AND retired_at <= ?
               AND id NOT IN (SELECT entity_id FROM slot_history)`,
            cutoff
          )
          .toArray() as Array<{ id: string }>;
      } else if (opts.slotId) {
        candidates = this.sql
          .exec(
            `SELECT e.id FROM entities e
             WHERE e.status = 'retired' AND e.retired_at IS NOT NULL AND e.retired_at <= ?
               AND e.id IN (SELECT entity_id FROM slot_history WHERE slot_id = ?)
               AND e.id NOT IN (SELECT entity_id FROM slot_history WHERE slot_id != ?)`,
            cutoff,
            opts.slotId,
            opts.slotId
          )
          .toArray() as Array<{ id: string }>;
      } else {
        return [];
      }

      const ids = candidates.map((row) => row.id);
      for (const id of ids) {
        this.sql.exec(`DELETE FROM entities WHERE id = ?`, id);
      }
      return ids;
    });
  }

  // ── Entity reads ──

  @rpc({ principals: ["host"] })
  entityResolve(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    return row ? this.rowToEntity(row) : null;
  }

  @rpc({ principals: ["host"] })
  entityResolveActive(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    if (!row || row.status !== "active") return null;
    return this.rowToEntity(row);
  }

  @rpc({ principals: ["host"] })
  entityResolveContext(id: string): string | null {
    const row = this.readEntityRow(id);
    return row ? row.context_id : null;
  }

  /**
   * Durable nav→slot mapping: the OPEN slot id whose current runtime entity is
   * `entityId`, or null. Backed by `idx_slots_current`. This is the authoritative,
   * lease-independent way to find the tree slot a panel's runtime entity belongs to.
   */
  @rpc({ principals: ["host"] })
  slotResolveByEntity(entityId: string): string | null {
    const row = this.sql
      .exec(`SELECT slot_id FROM slots WHERE current_entity_id = ? AND closed_at IS NULL`, entityId)
      .toArray()[0];
    return row && typeof row["slot_id"] === "string" ? row["slot_id"] : null;
  }

  entityResolveSource(id: string): { repoPath: string } | null {
    const row = this.readEntityRow(id);
    if (!row) return null;
    return { repoPath: row.source_repo_path };
  }

  // ─────────────────────────────────────────────────────────────
  // lifecycle.* operations
  // ─────────────────────────────────────────────────────────────

  @rpc({ principals: ["host"] })
  lifecycleLeaseUpsert(input: LifecycleLeaseInput): void {
    this.assertLifecycleKey(input);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO lifecycle_leases (
        source, class_name, object_key, detail, created_at, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, class_name, object_key) DO UPDATE SET
        detail = excluded.detail,
        refreshed_at = excluded.refreshed_at`,
      input.source,
      input.className,
      input.objectKey,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      now,
      now
    );
  }

  @rpc({ principals: ["host"] })
  lifecycleLeaseClear(input: LifecycleKey): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `DELETE FROM lifecycle_leases WHERE source = ? AND class_name = ? AND object_key = ?`,
      input.source,
      input.className,
      input.objectKey
    );
  }

  // ─────────────────────────────────────────────────────────────
  // do alarms (server-driven; see do_alarms table comment)
  // ─────────────────────────────────────────────────────────────

  /** Register/replace a DO's wake time (absolute epoch ms). */
  @rpc({ principals: ["host"] })
  alarmSet(input: LifecycleKey & { wakeAt: number; bestEffort?: boolean }): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `INSERT INTO do_alarms (source, class_name, object_key, wake_at, best_effort)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, class_name, object_key)
         DO UPDATE SET wake_at = excluded.wake_at, best_effort = excluded.best_effort`,
      input.source,
      input.className,
      input.objectKey,
      Math.round(input.wakeAt),
      input.bestEffort ? 1 : 0
    );
  }

  /** Clear a DO's pending alarm (no-op if none). */
  @rpc({ principals: ["host"] })
  alarmClear(input: LifecycleKey): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `DELETE FROM do_alarms WHERE source = ? AND class_name = ? AND object_key = ?`,
      input.source,
      input.className,
      input.objectKey
    );
  }

  /** Soonest pending wake time, or null when no alarms are scheduled. */
  @rpc({ principals: ["host"] })
  alarmNextWakeAt(): number | null {
    const row = this.sql.exec(`SELECT MIN(wake_at) AS next FROM do_alarms`).toArray()[0] as
      | { next: number | null }
      | undefined;
    return row && row.next !== null ? row.next : null;
  }

  /** Atomically return and delete all alarms due at/before `now`. Each fires once;
   *  recurring DOs re-arm from inside their own `alarm()` handler. */
  @rpc({ principals: ["host"] })
  alarmTakeDue(now: number): Array<LifecycleKey & { wakeAt: number; bestEffort: boolean }> {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec(
          `SELECT source, class_name, object_key, wake_at, best_effort FROM do_alarms WHERE wake_at <= ?`,
          now
        )
        .toArray() as Array<{
        source: string;
        class_name: string;
        object_key: string;
        wake_at: number;
        best_effort: number;
      }>;
      if (rows.length > 0) {
        this.sql.exec(`DELETE FROM do_alarms WHERE wake_at <= ?`, now);
      }
      return rows.map((r) => ({
        source: r.source,
        className: r.class_name,
        objectKey: r.object_key,
        wakeAt: r.wake_at,
        bestEffort: r.best_effort === 1,
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // recurring jobs (declared in meta/vibestudio.yml `recurring:`;
  // driven by the server's RecurringRegistry)
  // ─────────────────────────────────────────────────────────────

  /**
   * Declaratively replace the recurring-job set. Jobs absent from `jobs` are
   * deleted; jobs whose `specHash` is unchanged keep their durable
   * `next_run_at`; new or respecified jobs adopt `initialNextRunAt`.
   */
  @rpc({ principals: ["host"] })
  recurringSync(input: { jobs: RecurringJobRow[] }): void {
    this.ctx.storage.transactionSync(() => {
      const names = input.jobs.map((j) => j.name);
      if (names.length === 0) {
        this.sql.exec(`DELETE FROM recurring_jobs`);
      } else {
        const placeholders = names.map(() => "?").join(", ");
        this.sql.exec(`DELETE FROM recurring_jobs WHERE name NOT IN (${placeholders})`, ...names);
      }
      for (const job of input.jobs) {
        this.sql.exec(
          `INSERT INTO recurring_jobs
             (name, source, class_name, object_key, method, args_json, interval_ms, at_minutes, spec_hash, next_run_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             source = excluded.source,
             class_name = excluded.class_name,
             object_key = excluded.object_key,
             method = excluded.method,
             args_json = excluded.args_json,
             interval_ms = excluded.interval_ms,
             at_minutes = excluded.at_minutes,
             next_run_at = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.next_run_at
               ELSE excluded.next_run_at
             END,
             fail_count = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.fail_count
               ELSE 0
             END,
             backoff_until = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.backoff_until
               ELSE NULL
             END,
             last_error = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.last_error
               ELSE NULL
             END,
             last_failed_at = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.last_failed_at
               ELSE NULL
             END,
             last_duration_ms = CASE
               WHEN recurring_jobs.spec_hash = excluded.spec_hash THEN recurring_jobs.last_duration_ms
               ELSE NULL
             END,
             spec_hash = excluded.spec_hash`,
          job.name,
          job.source,
          job.className,
          job.objectKey,
          job.method,
          job.argsJson,
          job.intervalMs,
          job.atMinutes ?? null,
          job.specHash,
          Math.round(job.initialNextRunAt)
        );
      }
    });
  }

  /** Jobs due at/before `now`. Rows stay put; the registry marks each run. */
  @rpc({ principals: ["host"] })
  recurringDue(now: number): RecurringJobRow[] {
    return (
      this.sql
        .exec(
          `SELECT * FROM recurring_jobs
           WHERE next_run_at <= ? AND COALESCE(backoff_until, 0) <= ?
           ORDER BY next_run_at, name`,
          now,
          now
        )
        .toArray() as Array<Record<string, unknown>>
    ).map(rowToRecurringJob);
  }

  @rpc({ principals: ["host"] })
  recurringMarkRun(input: { name: string; lastRunAt: number; nextRunAt: number }): void {
    this.sql.exec(
      `UPDATE recurring_jobs
       SET last_run_at = ?, last_started_at = ?, next_run_at = ?
       WHERE name = ?`,
      Math.round(input.lastRunAt),
      Math.round(input.lastRunAt),
      Math.round(input.nextRunAt),
      input.name
    );
  }

  @rpc({ principals: ["host"] })
  recurringMarkSucceeded(input: { name: string; finishedAt: number; durationMs: number }): void {
    this.sql.exec(
      `UPDATE recurring_jobs
       SET fail_count = 0,
           backoff_until = NULL,
           last_succeeded_at = ?,
           last_error = NULL,
           last_duration_ms = ?
       WHERE name = ?`,
      Math.round(input.finishedAt),
      Math.max(0, Math.round(input.durationMs)),
      input.name
    );
  }

  @rpc({ principals: ["host"] })
  recurringMarkFailed(input: {
    name: string;
    failedAt: number;
    nextRunAt: number;
    failCount: number;
    error: string;
    durationMs: number;
  }): void {
    this.sql.exec(
      `UPDATE recurring_jobs
       SET fail_count = ?,
           backoff_until = ?,
           next_run_at = ?,
           last_failed_at = ?,
           last_error = ?,
           last_duration_ms = ?
       WHERE name = ?`,
      Math.max(1, Math.round(input.failCount)),
      Math.round(input.nextRunAt),
      Math.round(input.nextRunAt),
      Math.round(input.failedAt),
      input.error.slice(0, 1000),
      Math.max(0, Math.round(input.durationMs)),
      input.name
    );
  }

  @rpc({ principals: ["host"] })
  recurringNextWakeAt(): number | null {
    const row = this.sql
      .exec(`SELECT MIN(next_run_at) AS next FROM recurring_jobs`)
      .toArray()[0] as { next: number | null } | undefined;
    return row && row.next !== null ? row.next : null;
  }

  @rpc({ principals: ["host"] })
  recurringList(): RecurringJobRow[] {
    return (
      this.sql.exec(`SELECT * FROM recurring_jobs ORDER BY name`).toArray() as Array<
        Record<string, unknown>
      >
    ).map(rowToRecurringJob);
  }

  @rpc({ principals: ["host"] })
  heartbeatRegister(input: HeartbeatRegistryRow): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO heartbeat_registry (
         name, source, class_name, object_key, channel_id, participant_handle, kind,
         status, next_run_at, last_wake_at, last_action_summary, last_error, spec_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, source, class_name, object_key) DO UPDATE SET
         channel_id = excluded.channel_id,
         participant_handle = excluded.participant_handle,
         kind = excluded.kind,
         status = excluded.status,
         next_run_at = excluded.next_run_at,
         last_wake_at = excluded.last_wake_at,
         last_action_summary = excluded.last_action_summary,
         last_error = excluded.last_error,
         spec_hash = excluded.spec_hash,
         updated_at = excluded.updated_at`,
      input.name,
      input.source,
      input.className,
      input.objectKey,
      input.channelId ?? null,
      input.participantHandle ?? null,
      input.kind,
      input.status,
      input.nextRunAt ?? null,
      input.lastWakeAt ?? null,
      input.lastActionSummary ?? null,
      input.lastError ?? null,
      input.specHash ?? null,
      Math.round(input.updatedAt || now)
    );
  }

  @rpc({ principals: ["host"] })
  heartbeatRemove(input: {
    name: string;
    source?: string;
    className?: string;
    objectKey?: string;
  }): void {
    if (input.source && input.className && input.objectKey) {
      this.sql.exec(
        `DELETE FROM heartbeat_registry
         WHERE name = ? AND source = ? AND class_name = ? AND object_key = ?`,
        input.name,
        input.source,
        input.className,
        input.objectKey
      );
      return;
    }
    this.sql.exec(`DELETE FROM heartbeat_registry WHERE name = ?`, input.name);
  }

  @rpc({ principals: ["host"] })
  heartbeatList(): HeartbeatRegistryRow[] {
    return (
      this.sql.exec(`SELECT * FROM heartbeat_registry ORDER BY name`).toArray() as Array<
        Record<string, unknown>
      >
    ).map(rowToHeartbeatRegistry);
  }

  @rpc({ principals: ["host"] })
  lifecycleListLeases(): LifecycleLease[] {
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key, detail, created_at, refreshed_at
         FROM lifecycle_leases
         ORDER BY refreshed_at, source, class_name, object_key`
      )
      .toArray() as Array<{
      source: string;
      class_name: string;
      object_key: string;
      detail: string | null;
      created_at: number;
      refreshed_at: number;
    }>;
    return rows.map((row) => ({
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
      detail: this.parseJsonOrNull(row.detail),
      createdAt: row.created_at,
      refreshedAt: row.refreshed_at,
    }));
  }

  @rpc({ principals: ["host"] })
  lifecycleOpenEpoch(input: LifecycleEpochInput): string {
    return this.ctx.storage.transactionSync(() => {
      const seqRow = this.sql
        .exec(
          `SELECT COALESCE(MAX(CAST(substr(epoch_id, 7) AS INTEGER)), 0) + 1 AS seq
           FROM lifecycle_epochs
           WHERE epoch_id LIKE 'epoch-%'`
        )
        .toArray()[0] as { seq: number } | undefined;
      const epochId = `epoch-${String(seqRow?.seq ?? 1).padStart(12, "0")}`;
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO lifecycle_epochs (epoch_id, kind, reason, created_at, generation, status)
         VALUES (?, ?, ?, ?, ?, 'open')`,
        epochId,
        input.kind,
        input.reason,
        now,
        input.generation
      );
      const leases = this.lifecycleListLeases();
      for (const lease of leases) {
        this.insertLifecycleOp(epochId, lease, "prepare", "pending", null, now);
        this.insertLifecycleOp(epochId, lease, "resume", "pending", null, now);
      }
      return epochId;
    });
  }

  @rpc({ principals: ["host"] })
  lifecycleRecordOp(input: LifecycleOpInput): void {
    this.assertLifecycleKey(input.key);
    this.insertLifecycleOp(
      input.epochId,
      input.key,
      input.opKind,
      input.status,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      Date.now()
    );
  }

  @rpc({ principals: ["host"] })
  lifecycleListOps(epochId: string): LifecycleOp[] {
    const rows = this.sql
      .exec(
        `SELECT epoch_id, source, class_name, object_key, op_kind, status, detail, updated_at
         FROM lifecycle_ops
         WHERE epoch_id = ?
         ORDER BY source, class_name, object_key, op_kind`,
        epochId
      )
      .toArray() as Array<{
      epoch_id: string;
      source: string;
      class_name: string;
      object_key: string;
      op_kind: "prepare" | "resume";
      status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
      detail: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      epochId: row.epoch_id,
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
      opKind: row.op_kind,
      status: row.status,
      detail: this.parseJsonOrNull(row.detail),
      updatedAt: row.updated_at,
    }));
  }

  @rpc({ principals: ["host"] })
  lifecycleCompleteEpoch(epochId: string): void {
    this.sql.exec(`UPDATE lifecycle_epochs SET status = 'completed' WHERE epoch_id = ?`, epochId);
  }

  @rpc({ principals: ["host"] })
  lifecycleListResumeTargets(): LifecycleKey[] {
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key FROM lifecycle_leases
         UNION
         SELECT source, class_name, object_key FROM lifecycle_ops
         WHERE op_kind = 'resume' AND status IN ('pending', 'ready', 'timed_out', 'failed')
         ORDER BY source, class_name, object_key`
      )
      .toArray() as Array<{ source: string; class_name: string; object_key: string }>;
    return rows.map((row) => ({
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
    }));
  }

  /** Return all active entities (used by restart revival to re-attach runtime). */
  @rpc({ principals: ["host"] })
  entityListActive(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' ORDER BY created_at`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /** Return active entities of a given kind (used by singleton reconciliation). */
  @rpc({ principals: ["host"] })
  entityListActiveByKind(kind: EntityKind): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' AND kind = ? ORDER BY created_at`, kind)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  // ─────────────────────────────────────────────────────────────
  // context_edges.* — context-relationship registry
  // ─────────────────────────────────────────────────────────────

  /**
   * Idempotently upsert a context-relationship edge. Keyed on
   * (context_id, owner_context_id, kind); `created_at` is preserved on conflict,
   * `owner_entity_id` refreshed.
   */
  @rpc({ principals: ["host"] })
  contextEdgeUpsert(input: {
    contextId: string;
    ownerContextId: string;
    kind: "lifecycle" | "lineage";
    ownerEntityId?: string;
  }): void {
    this.sql.exec(
      `INSERT INTO context_edges (context_id, owner_context_id, kind, owner_entity_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(context_id, owner_context_id, kind)
       DO UPDATE SET owner_entity_id = excluded.owner_entity_id`,
      input.contextId,
      input.ownerContextId,
      input.kind,
      input.ownerEntityId ?? null,
      Date.now()
    );
  }

  /** List edges owned BY a context (the owner side), optionally scoped to one kind. */
  @rpc({ principals: ["host"] })
  contextEdgeListByOwner(input: {
    ownerContextId: string;
    kind?: "lifecycle" | "lineage";
  }): Array<{ contextId: string; kind: "lifecycle" | "lineage"; ownerEntityId: string | null }> {
    const rows = (input.kind
      ? this.sql.exec(
          `SELECT context_id, kind, owner_entity_id FROM context_edges
             WHERE owner_context_id = ? AND kind = ? ORDER BY created_at`,
          input.ownerContextId,
          input.kind
        )
      : this.sql.exec(
          `SELECT context_id, kind, owner_entity_id FROM context_edges
             WHERE owner_context_id = ? ORDER BY created_at`,
          input.ownerContextId
        )
    ).toArray() as unknown as DbContextEdgeRow[];
    return rows.map((row) => ({
      contextId: row.context_id,
      kind: row.kind,
      ownerEntityId: row.owner_entity_id ?? null,
    }));
  }

  /** List edges INTO a context (the child side) — walk up for authz/teardown. */
  @rpc({ principals: ["host"] })
  contextEdgeListByChild(contextId: string): Array<{
    ownerContextId: string;
    kind: "lifecycle" | "lineage";
    ownerEntityId: string | null;
  }> {
    const rows = this.sql
      .exec(
        `SELECT owner_context_id, kind, owner_entity_id FROM context_edges
         WHERE context_id = ? ORDER BY created_at`,
        contextId
      )
      .toArray() as unknown as DbContextEdgeRow[];
    return rows.map((row) => ({
      ownerContextId: row.owner_context_id,
      kind: row.kind,
      ownerEntityId: row.owner_entity_id ?? null,
    }));
  }

  /** Delete every inbound edge of a context (called on teardown). */
  @rpc({ principals: ["host"] })
  contextEdgeDeleteByChild(contextId: string): void {
    this.sql.exec(`DELETE FROM context_edges WHERE context_id = ?`, contextId);
  }

  // ─────────────────────────────────────────────────────────────
  // slot.* operations
  // ─────────────────────────────────────────────────────────────

  @rpc({ principals: ["host"] })
  slotCreate(input: SlotCreateInput): void {
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(`SELECT slot_id FROM slots WHERE slot_id = ?`, input.slotId)
        .toArray()[0];
      if (existing) {
        throw new Error(`Slot already exists: ${input.slotId}`);
      }
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO slots (slot_id, parent_slot_id, current_entity_id, current_entry_key, position_id, owner_user_id, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.slotId,
        input.parentSlotId,
        input.initialEntry?.entityId ?? null,
        input.initialEntry?.entryKey ?? null,
        input.positionId,
        input.ownerUserId ?? null,
        now
      );
      if (input.initialEntry) {
        this.appendHistoryRow(input.slotId, 0, input.initialEntry, now);
      }
    });
  }

  @rpc({ principals: ["host"] })
  slotAppendHistory(slotId: string, entry: SlotHistoryEntryInput): number {
    return this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      const lastRow = this.sql
        .exec(
          `SELECT cursor FROM slot_history WHERE slot_id = ? ORDER BY cursor DESC LIMIT 1`,
          slotId
        )
        .toArray()[0] as { cursor: number } | undefined;
      const cursor = (lastRow?.cursor ?? -1) + 1;
      this.appendHistoryRow(slotId, cursor, entry, Date.now());
      return cursor;
    });
  }

  @rpc({ principals: ["host"] })
  slotSetCurrent(slotId: string, entryKey: string): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      const historyRow = this.sql
        .exec(
          `SELECT entity_id FROM slot_history WHERE slot_id = ? AND entry_key = ?`,
          slotId,
          entryKey
        )
        .toArray()[0] as { entity_id: string } | undefined;
      if (!historyRow) {
        throw new Error(`History entry not found: slot=${slotId} entry=${entryKey}`);
      }
      this.sql.exec(
        `UPDATE slots SET current_entity_id = ?, current_entry_key = ? WHERE slot_id = ?`,
        historyRow.entity_id,
        entryKey,
        slotId
      );
      // The slot now points at a different entity. Refresh the FTS
      // denormalization so search hits the new entity's title.
      this.refreshSlotSearchableTitle(slotId);
    });
  }

  @rpc({ principals: ["host"] })
  slotUpdateCurrentStateArgs(slotId: string, stateArgs: unknown): void {
    this.ctx.storage.transactionSync(() => {
      const slot = this.requireSlot(slotId);
      if (!slot.current_entry_key) {
        throw new Error(`Slot ${slotId} has no current history entry`);
      }
      const serialized = stateArgs === undefined ? null : JSON.stringify(stateArgs);
      this.sql.exec(
        `UPDATE slot_history SET state_args = ? WHERE slot_id = ? AND entry_key = ?`,
        serialized,
        slotId,
        slot.current_entry_key
      );
      if (slot.current_entity_id) {
        this.sql.exec(
          `UPDATE entities SET state_args = ? WHERE id = ?`,
          serialized,
          slot.current_entity_id
        );
      }
    });
  }

  @rpc({ principals: ["host"] })
  slotReplaceHistory(slotId: string, entries: SlotHistoryEntryInput[], cursor: number): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      this.sql.exec(`DELETE FROM slot_history WHERE slot_id = ?`, slotId);
      const now = Date.now();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry) {
          this.appendHistoryRow(slotId, i, entry, now);
        }
      }
      const current = entries[cursor];
      if (current) {
        this.sql.exec(
          `UPDATE slots SET current_entity_id = ?, current_entry_key = ? WHERE slot_id = ?`,
          current.entityId,
          current.entryKey,
          slotId
        );
      } else {
        this.sql.exec(
          `UPDATE slots SET current_entity_id = NULL, current_entry_key = NULL WHERE slot_id = ?`,
          slotId
        );
      }
      this.refreshSlotSearchableTitle(slotId);
    });
  }

  @rpc({ principals: ["host"] })
  slotSetParent(slotId: string, parentSlotId: string | null): void {
    this.requireSlot(slotId);
    this.sql.exec(`UPDATE slots SET parent_slot_id = ? WHERE slot_id = ?`, parentSlotId, slotId);
  }

  @rpc({ principals: ["host"] })
  slotSetPosition(slotId: string, positionId: string): void {
    this.requireSlot(slotId);
    this.sql.exec(`UPDATE slots SET position_id = ? WHERE slot_id = ?`, positionId, slotId);
  }

  /**
   * Move a slot under a new parent (or to root) and re-position it. Per WP3
   * §10.1, the moved subtree **re-owns** to the destination root's owner — the
   * tree it now lives in — so a panel dragged into another user's tree becomes
   * part of that tree. Moving to root (parentSlotId === null) promotes the
   * subtree to a new top-level tree owned by the acting mover (`ownerUserId`),
   * or keeps its current owner when no mover subject is supplied. Authorization
   * is permissive (any member may restructure any tree); only attribution moves.
   */
  @rpc({ principals: ["host"] })
  slotMove(
    slotId: string,
    parentSlotId: string | null,
    positionId: string,
    ownerUserId?: string
  ): void {
    this.ctx.storage.transactionSync(() => {
      const slot = this.requireSlot(slotId);
      if (slot.closed_at !== null) {
        throw new Error(`Cannot move closed slot: ${slotId}`);
      }

      // Resolve and validate the destination before mutating parent links. In
      // particular, persisting a move below one's own descendant would create
      // a cycle before the in-memory registry gets a chance to reject it.
      const subtreeIds = this.collectSubtreeSlotIds(slotId);
      let destOwner: string | null;
      if (parentSlotId !== null) {
        const parent = this.requireSlot(parentSlotId);
        if (parent.closed_at !== null) {
          throw new Error(`Cannot move slot under closed parent: ${parentSlotId}`);
        }
        if (subtreeIds.includes(parentSlotId)) {
          throw new Error(`Cannot move slot ${slotId} under its own subtree`);
        }
        destOwner = this.rootOwnerOf(parentSlotId);
      } else {
        destOwner = ownerUserId ?? slot.owner_user_id ?? null;
      }

      this.sql.exec(
        `UPDATE slots SET parent_slot_id = ?, position_id = ? WHERE slot_id = ?`,
        parentSlotId,
        positionId,
        slotId
      );
      // Re-stamp the whole moved subtree so a subtree stays owner-consistent.
      for (const id of subtreeIds) {
        this.sql.exec(`UPDATE slots SET owner_user_id = ? WHERE slot_id = ?`, destOwner, id);
      }
    });
  }

  /**
   * Walk up the parent chain from `slotId` to its root and return that root's
   * `owner_user_id`. Cycle-guarded (the tree shouldn't contain cycles, but a
   * bad move must not spin). Returns null if a chain link is missing.
   */
  private rootOwnerOf(slotId: string): string | null {
    const seen = new Set<string>();
    let cur: string | null = slotId;
    let owner: string | null = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = this.sql
        .exec(`SELECT parent_slot_id, owner_user_id FROM slots WHERE slot_id = ?`, cur)
        .toArray()[0] as
        | { parent_slot_id: string | null; owner_user_id: string | null }
        | undefined;
      if (!row) break;
      owner = row.owner_user_id ?? null;
      if (row.parent_slot_id === null) break;
      cur = row.parent_slot_id;
    }
    return owner;
  }

  /** Collect `slotId` and every descendant (by parent_slot_id). Cycle-guarded. */
  private collectSubtreeSlotIds(slotId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const queue = [slotId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      const children = this.sql
        .exec(`SELECT slot_id FROM slots WHERE parent_slot_id = ?`, id)
        .toArray() as Array<{ slot_id: string }>;
      for (const child of children) queue.push(child.slot_id);
    }
    return ids;
  }

  @rpc({ principals: ["host"] })
  slotClose(slotId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      this.sql.exec(
        `UPDATE slots SET closed_at = ?, current_entity_id = NULL, current_entry_key = NULL WHERE slot_id = ?`,
        Date.now(),
        slotId
      );
      this.sql.exec(`DELETE FROM panel_search_metadata WHERE slot_id = ?`, slotId);
    });
  }

  @rpc({ principals: ["host"] })
  slotGet(slotId: string): DbSlotRow | null {
    const row = this.sql
      .exec(
        `SELECT s.*, e.display_title AS current_entity_title
         FROM slots s
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE s.slot_id = ?`,
        slotId
      )
      .toArray()[0] as DbSlotRow | undefined;
    return row ?? null;
  }

  /**
   * All open slots, each carrying `owner_user_id` (WP3). Returns every owner's
   * slots by default — mutual visibility is the feature (plan §0.0); the forest
   * grouping happens client-side by owner. `filter.owner` narrows to one user's
   * tree for a "just my tree" view (backed by idx_slots_owner) but is NOT the
   * default.
   */
  @rpc({ principals: ["host"] })
  slotListOpen(filter?: { owner?: string }): DbSlotRow[] {
    if (filter?.owner !== undefined) {
      return this.sql
        .exec(
          `SELECT s.*, e.display_title AS current_entity_title
           FROM slots s
           LEFT JOIN entities e ON s.current_entity_id = e.id
           WHERE s.closed_at IS NULL AND s.owner_user_id = ?
           ORDER BY s.position_id, s.created_at, s.slot_id`,
          filter.owner
        )
        .toArray() as unknown as DbSlotRow[];
    }
    return this.sql
      .exec(
        `SELECT s.*, e.display_title AS current_entity_title
         FROM slots s
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE s.closed_at IS NULL
         ORDER BY s.position_id, s.created_at, s.slot_id`
      )
      .toArray() as unknown as DbSlotRow[];
  }

  @rpc({ principals: ["host"] })
  slotHistory(slotId: string): DbSlotHistoryRow[] {
    return this.sql
      .exec(`SELECT * FROM slot_history WHERE slot_id = ? ORDER BY cursor`, slotId)
      .toArray() as unknown as DbSlotHistoryRow[];
  }

  // ─────────────────────────────────────────────────────────────
  // panel search (FTS5 over panel_search_metadata)
  // ─────────────────────────────────────────────────────────────

  /**
   * Upsert the slot-static search metadata for a panel and stamp the initial
   * title onto the slot's current entity (the canonical title store).
   * Returns the slot's current entity id when one is bound, so callers (the
   * workspace-state RPC handler) can refresh their entity-keyed caches.
   */
  @rpc({ principals: ["host"] })
  panelIndex(input: IndexablePanel): string | null {
    const now = Date.now();
    let resolvedEntityId: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const trimmedTitle = typeof input.title === "string" ? input.title.trim() : "";
      const slot = this.sql
        .exec(`SELECT current_entity_id FROM slots WHERE slot_id = ?`, input.id)
        .toArray()[0];
      const entityIdFromSlot = slot?.["current_entity_id"];
      const currentTitle =
        typeof entityIdFromSlot === "string" && entityIdFromSlot.length > 0
          ? ((this.sql
              .exec(`SELECT display_title FROM entities WHERE id = ?`, entityIdFromSlot)
              .toArray()[0]?.["display_title"] as string | null | undefined) ?? "")
          : "";
      const ftsTitle = trimmedTitle.length > 0 ? trimmedTitle : currentTitle;

      const existing = this.sql
        .exec(`SELECT rowid FROM panel_search_metadata WHERE slot_id = ?`, input.id)
        .toArray()[0];
      if (existing) {
        this.sql.exec(
          `UPDATE panel_search_metadata SET
            searchable_title = ?, searchable_path = ?, manifest_description = ?,
            manifest_dependencies = ?, tags = ?, keywords = ?, last_indexed_at = ?
          WHERE slot_id = ?`,
          ftsTitle,
          input.path ?? null,
          input.manifestDescription ?? null,
          input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.keywords ? JSON.stringify(input.keywords) : null,
          now,
          input.id
        );
      } else {
        this.sql.exec(
          `INSERT INTO panel_search_metadata (
            slot_id, searchable_title, searchable_path, manifest_description,
            manifest_dependencies, tags, keywords, access_count, last_indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          input.id,
          ftsTitle,
          input.path ?? null,
          input.manifestDescription ?? null,
          input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.keywords ? JSON.stringify(input.keywords) : null,
          now
        );
      }
      // The canonical title lives on the entity row. Stamp the manifest
      // title there so approval UIs (which look up by entity id) and the
      // FTS denormalization above agree from the moment the panel exists.
      if (
        trimmedTitle.length > 0 &&
        typeof entityIdFromSlot === "string" &&
        entityIdFromSlot.length > 0
      ) {
        this.sql.exec(
          `UPDATE entities SET display_title = ? WHERE id = ?`,
          trimmedTitle,
          entityIdFromSlot
        );
        resolvedEntityId = entityIdFromSlot;
      }
    });
    return resolvedEntityId;
  }

  /**
   * Update a panel's title by slot id. The shell-side `searchIndex.updateTitle`
   * API is keyed by slot id (the caller never has the per-entity id at hand),
   * so this is the surface that bridges to the entity-keyed source of truth.
   *
   * Resolves the slot's current entity and delegates to
   * `entitySetDisplayTitle`. Returns the resolved entity id (or null when
   * the slot is empty / closed) so callers can mirror the change into their
   * entity-keyed caches without a second round-trip.
   */
  @rpc({ principals: ["host"] })
  panelUpdateTitle(slotId: string, title: string): string | null {
    const row = this.sql
      .exec(`SELECT current_entity_id FROM slots WHERE slot_id = ?`, slotId)
      .toArray()[0];
    const entityId = row?.["current_entity_id"];
    if (typeof entityId !== "string" || entityId.length === 0) return null;
    this.entitySetDisplayTitle(entityId, title);
    return entityId;
  }

  @rpc({ principals: ["host"] })
  panelIncrementAccess(entityId: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET access_count = access_count + 1 WHERE slot_id = ?`,
      entityId
    );
  }

  /**
   * Set the display title for an entity. This is the canonical write site
   * for titles — both `entities.display_title` (the source of truth) and
   * the FTS denormalization in `panel_search_metadata.searchable_title`
   * (for panel entities that are currently bound to a slot) are updated in
   * one transaction.
   *
   * Pass null or an empty string to clear the entity title; we keep the
   * FTS staging row's title alone in that case (rather than blanking it) so
   * the panel stays findable in search.
   */
  @rpc({ principals: ["host"] })
  entitySetDisplayTitle(entityId: string, title: string | null): void {
    const normalized = typeof title === "string" ? title.trim() : "";
    const stored = normalized.length > 0 ? normalized : null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE entities SET display_title = ? WHERE id = ?`, stored, entityId);
      if (stored === null) return;
      const slot = this.sql
        .exec(
          `SELECT slot_id FROM slots WHERE current_entity_id = ? AND closed_at IS NULL`,
          entityId
        )
        .toArray()[0];
      if (slot && typeof slot["slot_id"] === "string") {
        this.sql.exec(
          `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
          stored,
          Date.now(),
          slot["slot_id"]
        );
      }
    });
  }

  /**
   * Return every active entity that has a non-empty display_title. Used to
   * seed the server-side in-process cache at boot so synchronous title
   * lookups (e.g. when building a pending approval) don't have to round-trip
   * to the DO on the hot path.
   */
  @rpc({ principals: ["host"] })
  entityListDisplayTitles(): Array<{ id: string; title: string }> {
    return this.sql
      .exec(
        `SELECT id, display_title
         FROM entities
         WHERE status = 'active' AND display_title IS NOT NULL AND display_title != ''`
      )
      .toArray() as Array<{ id: string; title: string }>;
  }

  /**
   * Pull the current title from the slot's current entity into the FTS
   * staging column. Used when history navigation swaps the current entity
   * (the new entity may have a different display_title). No-op when the
   * slot has no metadata row or no current entity.
   */
  private refreshSlotSearchableTitle(slotId: string): void {
    const row = this.sql
      .exec(
        `SELECT e.display_title AS title
         FROM slots s
         JOIN entities e ON s.current_entity_id = e.id
         WHERE s.slot_id = ?`,
        slotId
      )
      .toArray()[0] as { title: string | null } | undefined;
    if (!row) return;
    const title = (row.title ?? "").toString();
    this.sql.exec(
      `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
      title,
      Date.now(),
      slotId
    );
  }

  @rpc({ principals: ["host"] })
  panelSearch(query: string, limit = 50): PanelSearchResult[] {
    const safeQuery = this.sanitizeSearchQuery(query);
    if (!safeQuery) return [];
    // The displayable title is sourced from entities.display_title (the
    // canonical store) via the slot's current_entity_id. The FTS index
    // itself is built over panel_search_metadata.searchable_title, which is
    // a denormalization maintained by entitySetDisplayTitle.
    const rows = this.sql
      .exec(
        `SELECT m.slot_id AS id,
                COALESCE(e.display_title, m.searchable_title) AS title,
                m.access_count AS access_count,
                bm25(panel_fts) AS relevance
         FROM panel_fts
         JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
         JOIN slots s ON m.slot_id = s.slot_id
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE panel_fts MATCH ? AND s.closed_at IS NULL
         ORDER BY relevance, m.access_count DESC
         LIMIT ?`,
        safeQuery,
        limit
      )
      .toArray() as Array<{
      id: string;
      title: string;
      access_count: number;
      relevance: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      relevance: row.relevance,
      accessCount: row.access_count,
    }));
  }

  @rpc({ principals: ["host"] })
  panelRebuildIndex(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM panel_search_metadata`);
      // Rebuild from open slots + their current entity. Title is sourced
      // from entities.display_title; when no title was ever stamped (panel
      // existed before this feature, or the agent never called set_title)
      // we backfill from stateArgs.title → entity key → slot id, then
      // mirror that into the FTS staging column.
      const rows = this.sql
        .exec(
          `SELECT s.slot_id AS slot_id, e.id AS entity_id, e.state_args AS state_args,
                  e.source_repo_path AS source_repo_path, e.key AS key,
                  e.display_title AS display_title
           FROM slots s
           LEFT JOIN entities e ON s.current_entity_id = e.id
           WHERE s.closed_at IS NULL`
        )
        .toArray() as Array<{
        slot_id: string;
        entity_id: string | null;
        state_args: string | null;
        source_repo_path: string | null;
        key: string | null;
        display_title: string | null;
      }>;
      const now = Date.now();
      for (const row of rows) {
        let title: string = row.display_title ?? "";
        if (!title && row.entity_id) {
          // Backfill a best-effort title onto the entity row.
          if (row.state_args) {
            try {
              const args = JSON.parse(row.state_args) as { title?: string };
              if (typeof args?.title === "string" && args.title.trim().length > 0) {
                title = args.title;
              }
            } catch {
              // ignore — fall through to other fallbacks
            }
          }
          if (!title) title = row.key || row.slot_id;
          this.sql.exec(`UPDATE entities SET display_title = ? WHERE id = ?`, title, row.entity_id);
        }
        this.sql.exec(
          `INSERT INTO panel_search_metadata (
            slot_id, searchable_title, searchable_path, manifest_description,
            manifest_dependencies, tags, keywords, access_count, last_indexed_at
          ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, ?)`,
          row.slot_id,
          title,
          row.source_repo_path,
          now
        );
      }
    });
  }

  private sanitizeSearchQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return "";
    const escaped = trimmed.replace(/["*():^]/g, " ").trim();
    return escaped.includes(" ") ? `"${escaped}"` : escaped;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private createLifecycleTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_epochs (
        epoch_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_leases (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        refreshed_at INTEGER NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_leases_refreshed ON lifecycle_leases(refreshed_at)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_ops (
        epoch_id TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (epoch_id, source, class_name, object_key, op_kind)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_ops_resume
       ON lifecycle_ops(op_kind, status, source, class_name, object_key)`
    );
    // Durable DO alarm schedule. workerd does not implement alarms for
    // SQLite-backed DOs (and never for facets), so the server drives them: a DO
    // registers its wake time here, and the AlarmDriver fires `__alarm` on
    // schedule. Survives server/workerd restart (durable WorkspaceDO storage).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_alarms (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        best_effort INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_do_alarms_wake ON do_alarms(wake_at)`);
    // Declarative recurring jobs from meta/vibestudio.yml `recurring:`. The
    // RecurringRegistry syncs declarations here and dispatches due jobs;
    // durable next_run_at survives restarts without re-running missed bursts.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS recurring_jobs (
        name TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        method TEXT NOT NULL,
        args_json TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        at_minutes INTEGER,
        spec_hash TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        fail_count INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER,
        last_started_at INTEGER,
        last_succeeded_at INTEGER,
        last_failed_at INTEGER,
        last_error TEXT,
        last_duration_ms INTEGER
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_recurring_jobs_next ON recurring_jobs(next_run_at)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_registry (
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        channel_id TEXT,
        participant_handle TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        next_run_at INTEGER,
        last_wake_at INTEGER,
        last_action_summary TEXT,
        last_error TEXT,
        spec_hash TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (name, source, class_name, object_key)
      )
    `);
    const heartbeatColumns = this.sql
      .exec("PRAGMA table_info(heartbeat_registry)")
      .toArray() as Array<{ name?: unknown; pk?: unknown }>;
    const expectedHeartbeatColumns = [
      "name",
      "source",
      "class_name",
      "object_key",
      "channel_id",
      "participant_handle",
      "kind",
      "status",
      "next_run_at",
      "last_wake_at",
      "last_action_summary",
      "last_error",
      "spec_hash",
      "updated_at",
    ];
    const actualNames = heartbeatColumns.map((column) => column.name);
    const actualPrimaryKey = heartbeatColumns
      .filter((column) => typeof column.pk === "number" && column.pk > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((column) => column.name);
    if (
      actualNames.length !== expectedHeartbeatColumns.length ||
      actualNames.some((name, index) => name !== expectedHeartbeatColumns[index]) ||
      actualPrimaryKey.join(",") !== "name,source,class_name,object_key"
    ) {
      throw new Error(
        "Unsupported heartbeat_registry schema; delete this pre-release WorkspaceDO state"
      );
    }
  }

  private insertLifecycleOp(
    epochId: string,
    key: LifecycleKey,
    opKind: "prepare" | "resume",
    status: LifecycleOpInput["status"],
    detail: string | null,
    updatedAt: number
  ): void {
    this.sql.exec(
      `INSERT INTO lifecycle_ops (
        epoch_id, source, class_name, object_key, op_kind, status, detail, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(epoch_id, source, class_name, object_key, op_kind) DO UPDATE SET
        status = excluded.status,
        detail = excluded.detail,
        updated_at = excluded.updated_at`,
      epochId,
      key.source,
      key.className,
      key.objectKey,
      opKind,
      status,
      detail,
      updatedAt
    );
  }

  private assertLifecycleKey(key: LifecycleKey): void {
    if (!key.source || !key.className || !key.objectKey) {
      throw new Error("lifecycle key requires source, className, and objectKey");
    }
  }

  private parseJsonOrNull(value: string | null): unknown | null {
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private entityRetireInTransaction(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    if (!row) return null;
    if (row.status === "retired") {
      return this.rowToEntity(row);
    }
    const now = Date.now();
    this.sql.exec(
      `UPDATE entities SET status = 'retired', retired_at = ?, cleanup_complete = 0 WHERE id = ?`,
      now,
      id
    );
    return this.rowToEntity({
      ...row,
      status: "retired",
      retired_at: now,
      cleanup_complete: 0,
    });
  }

  private readEntityRow(id: string): DbEntityRow | null {
    const row = this.sql.exec(`SELECT * FROM entities WHERE id = ?`, id).toArray()[0] as unknown as
      | DbEntityRow
      | undefined;
    return row ?? null;
  }

  private rowToEntity(row: DbEntityRow): EntityRecord {
    const record: EntityRecord = {
      id: row.id,
      kind: row.kind,
      source: {
        repoPath: row.source_repo_path,
      },
      ...(row.active_execution_digest
        ? { activeExecutionDigest: row.active_execution_digest }
        : {}),
      contextId: row.context_id,
      key: row.key,
      createdAt: row.created_at,
      status: row.status,
      cleanupComplete: row.cleanup_complete === 1,
    };
    if (row.class_name) record.className = row.class_name;
    if (row.state_args !== null) record.stateArgs = JSON.parse(row.state_args);
    if (row.agent_binding !== null) record.agentBinding = JSON.parse(row.agent_binding);
    if (row.parent_id !== null) record.parentId = row.parent_id;
    // Mirror the owning-user stamp onto the cache record so lineage-inheriting
    // callers resolve it synchronously (WP0 §6, principalIdentity.resolveUserSubject).
    if (row.owner_user_id !== null) record.ownerUserId = row.owner_user_id;
    if (row.retired_at !== null) record.retiredAt = row.retired_at;
    if (row.error !== null) record.error = row.error;
    return record;
  }

  private assertIdentityMatches(
    id: string,
    existing: DbEntityRow,
    input: EntityActivateInput
  ): void {
    const checks: Array<{ field: string; existing: unknown; attempted: unknown }> = [
      { field: "kind", existing: existing.kind, attempted: input.kind },
      {
        field: "source.repoPath",
        existing: existing.source_repo_path,
        attempted: input.source.repoPath,
      },
      { field: "contextId", existing: existing.context_id, attempted: input.contextId },
      { field: "className", existing: existing.class_name, attempted: input.className ?? null },
      { field: "key", existing: existing.key, attempted: input.key },
    ];
    for (const check of checks) {
      if (check.existing !== check.attempted) {
        throw new IdentityCollisionError(id, check);
      }
    }
  }

  private appendHistoryRow(
    slotId: string,
    cursor: number,
    entry: SlotHistoryEntryInput,
    now: number
  ): void {
    this.sql.exec(
      `INSERT INTO slot_history (slot_id, cursor, entry_key, entity_id, source, context_id, state_args, options, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slotId,
      cursor,
      entry.entryKey,
      entry.entityId,
      entry.source,
      entry.contextId,
      entry.stateArgs === undefined ? null : JSON.stringify(entry.stateArgs),
      entry.options === undefined ? null : JSON.stringify(entry.options),
      now
    );
  }

  private requireSlot(slotId: string): DbSlotRow {
    const row = this.slotGet(slotId);
    if (!row) throw new Error(`Slot not found: ${slotId}`);
    return row;
  }
}
