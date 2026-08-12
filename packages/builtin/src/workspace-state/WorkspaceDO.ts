/**
 * WorkspaceDO — durable workspace state store.
 *
 * Replaces PanelStoreDO with a unified entity/slot model. Entity rows are
 * immutable in their identity columns (write-once) and mutable in their
 * lifecycle columns (status, retired_at, cleanup_complete). Slot rows hold
 * the panel-tree position; slot_history holds the navigation history.
 *
 * This pre-release store has one exact current schema. Prior workspace
 * databases are intentionally unsupported and must be recreated.
 */

import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import type { SchemaSqlStorage } from "@vibestudio/durable/schema";
import type { AgentExecutionTestPolicy } from "@vibestudio/rpc";
import {
  IdentityCollisionError,
  canonicalEntityId,
  type EntityActivationInput,
  type EntityKind,
  type EntityRecord,
  type EntityReservationInput,
} from "@vibestudio/shared/runtime/entitySpec";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import type {
  IndexablePanel,
  PanelSearchResult,
  PanelSourceUsage,
} from "@vibestudio/shared/panelSearchTypes";
import { normalizePanelTitle } from "@vibestudio/shared/panel/title";
import { isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import { SlotIdentityCollisionError } from "@vibestudio/shared/panelIdUtils";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  DURABLE_WORK_QUEUES,
  type DurableWorkQueue,
  type DurableWorkReadyHint,
} from "@vibestudio/shared/durableWork";
import type {
  WorkspacePanelDetail,
  WorkspacePanelCloseCleanupPage,
  WorkspacePanelCloseCleanupPageInput,
  WorkspacePanelCloseResult,
  WorkspacePanelTreePage,
  WorkspacePanelTreePageInput,
  WorkspacePanelTreePath,
  WorkspacePanelTreePlacement,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeRootGroupPageInput,
  WorkspacePanelTreeSearchInput,
  WorkspacePanelTreeSearchPage,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";

const PANEL_TREE_ORDER_STEP = 1_024;

interface DbEntityRow {
  id: string;
  kind: EntityKind;
  source_repo_path: string;
  source_effective_version: string;
  active_build_key: string | null;
  active_execution_digest: string | null;
  active_authority: string | null;
  context_id: string;
  class_name: string | null;
  key: string;
  state_args: string | null;
  /** NULL means a self binding when agent_channel_id is present. */
  agent_entity_id: string | null;
  agent_channel_id: string | null;
  parent_id: string | null;
  owner_user_id: string | null;
  created_at: number;
  status: "preparing" | "active" | "retired";
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
  current_history_cursor?: number | null;
  history_count?: number;
  sort_key: number;
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

export type EntityActivateInput = EntityActivationInput;

export interface SlotCreateInput {
  slotId: string;
  parentSlotId: string | null;
  placement?: WorkspacePanelTreePlacement;
  initialEntry?: {
    entryKey: string;
    entityId: string;
    source: string;
    contextId: string;
    stateArgs?: unknown;
    options?: unknown;
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

export interface SlotCommitPreparedNavigationInput {
  slotId: string;
  expectedCurrentEntityId: string;
  mutation:
    | { kind: "append"; entry: SlotHistoryEntryInput }
    | { kind: "replace"; entry: SlotHistoryEntryInput }
    | { kind: "select"; entryKey: string };
}

export interface SlotCommitPreparedNavigationResult {
  previousEntityId: string;
  currentEntityId: string;
  currentEntryKey: string;
  cursor: number;
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
const PANEL_TREE_REVISION_KEY = "panel_tree_revision";
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
  "do_alarm_test_policies",
  "durable_work_owners",
  "context_edges",
] as const;

function serializeActiveAuthority(authority: UnitAuthorityManifest | undefined): string | null {
  if (authority === undefined) return null;
  // Parse at the durable boundary so records can only contain the canonical,
  // closed authority shape regardless of which host writer supplied it.
  return JSON.stringify(parseUnitAuthorityManifest(authority, "entity activeAuthority"));
}

function validateActiveExecutionDigest(digest: string | undefined): string | null {
  if (digest === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("entity activeExecutionDigest must be a lowercase SHA-256 digest");
  }
  return digest;
}

function validateActiveBuildKey(buildKey: string | undefined): string | null {
  if (buildKey === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(buildKey)) {
    throw new Error("entity activeBuildKey must be a lowercase SHA-256 build key");
  }
  return buildKey;
}

const WORKSPACE_ENTITY_COLUMNS = [
  "id",
  "kind",
  "source_repo_path",
  "source_effective_version",
  "active_build_key",
  "active_execution_digest",
  "active_authority",
  "context_id",
  "class_name",
  "key",
  "state_args",
  "agent_entity_id",
  "agent_channel_id",
  "parent_id",
  "owner_user_id",
  "created_at",
  "status",
  "retired_at",
  "cleanup_complete",
  "error",
  "display_title",
] as const;
const WORKSPACE_ALARM_COLUMNS = [
  "source",
  "class_name",
  "object_key",
  "wake_at",
  "dispatch_generation",
  "dispatch_owner",
] as const;

function assertWorkspaceEntityColumns(sql: SchemaSqlStorage, label: string): void {
  const columns = sql
    .exec(`PRAGMA table_info(entities)`)
    .toArray()
    .map((column) => String(column["name"]));
  if (JSON.stringify(columns) !== JSON.stringify(WORKSPACE_ENTITY_COLUMNS)) {
    throw new Error(`${label} entities schema is unknown: ${JSON.stringify(columns)}`);
  }
}

function assertWorkspaceEntityStatuses(
  sql: SchemaSqlStorage,
  allowed: readonly string[],
  label: string
): void {
  const placeholders = allowed.map(() => "?").join(", ");
  const unknown = sql
    .exec(`SELECT status FROM entities WHERE status NOT IN (${placeholders}) LIMIT 1`, ...allowed)
    .toArray()[0];
  if (unknown) {
    throw new Error(`${label} contains unknown entity status ${String(unknown["status"])}`);
  }
}

function assertWorkspaceAlarmColumns(sql: SchemaSqlStorage, label: string): void {
  const columns = sql
    .exec(`PRAGMA table_info(do_alarms)`)
    .toArray()
    .map((column) => String(column["name"]));
  if (JSON.stringify(columns) !== JSON.stringify(WORKSPACE_ALARM_COLUMNS)) {
    throw new Error(`${label} do_alarms schema is unknown: ${JSON.stringify(columns)}`);
  }
}

export class WorkspaceDO extends DurableObjectBase {
  static override rpcMethods = workspaceStateEngineMethods;
  static override schemaVersion = 31;

  protected override schemaProductionBaseline() {
    return { version: 31, name: "workspace-state-v31" } as const;
  }

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override afterSchemaReady(): void {
    this.repairLifecycleInvariants();
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
        source_effective_version TEXT NOT NULL,
        active_build_key TEXT,
        active_execution_digest TEXT,
        active_authority TEXT,
        context_id TEXT NOT NULL,
        class_name TEXT,
        key TEXT NOT NULL,
        state_args TEXT,
        agent_entity_id TEXT REFERENCES entities(id),
        agent_channel_id TEXT,
        parent_id TEXT,
        owner_user_id TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        retired_at INTEGER,
        cleanup_complete INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        display_title TEXT,
        CHECK (agent_entity_id IS NULL OR agent_channel_id IS NOT NULL)
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
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_agent_entity
        ON entities(agent_entity_id) WHERE agent_entity_id IS NOT NULL`
    );

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        slot_id TEXT PRIMARY KEY,
        parent_slot_id TEXT REFERENCES slots(slot_id),
        current_entity_id TEXT REFERENCES entities(id),
        current_entry_key TEXT,
        sort_key INTEGER NOT NULL,
        owner_user_id TEXT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_slots_sibling_page
         ON slots(parent_slot_id, sort_key, created_at DESC, slot_id)
         WHERE closed_at IS NULL`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_slots_owner_root_page
         ON slots(owner_user_id, sort_key, created_at DESC, slot_id)
         WHERE closed_at IS NULL AND parent_slot_id IS NULL`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`);
    // Owner-scoped "just my tree" lookups (WP3). Partial: only open slots — a
    // closed slot's owner is dead weight. The default forest read is still ALL
    // open slots (mutual visibility); this index only backs the optional filter.
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`
    );

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_close_cleanup (
        slot_id TEXT PRIMARY KEY,
        close_id TEXT NOT NULL,
        owner_user_id TEXT,
        entity_id TEXT,
        queued_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_page
         ON panel_close_cleanup(close_id, slot_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_owner_page
         ON panel_close_cleanup(owner_user_id, slot_id)`
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
      CREATE TABLE IF NOT EXISTS panel_source_usage (
        source TEXT PRIMARY KEY,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0
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
    this.createPanelTreeRevisionTracking();
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

  protected createPanelTreeRevisionTracking(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('${PANEL_TREE_REVISION_KEY}', '0')`
    );
    const bumpPanelTreeRevision = `
      INSERT INTO workspace_meta (key, value)
      VALUES ('${PANEL_TREE_REVISION_KEY}', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
    `;
    for (const [name, timing] of [
      ["slots_insert", "AFTER INSERT ON slots"],
      ["slots_update", "AFTER UPDATE ON slots"],
      ["slots_delete", "AFTER DELETE ON slots"],
    ] as const) {
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS panel_tree_revision_${name}
        ${timing} BEGIN
          ${bumpPanelTreeRevision}
        END
      `);
    }
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_tree_revision_history_insert
      AFTER INSERT ON slot_history
      WHEN EXISTS (
        SELECT 1 FROM slots WHERE slot_id = NEW.slot_id AND closed_at IS NULL
      ) BEGIN
        ${bumpPanelTreeRevision}
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_tree_revision_history_update
      AFTER UPDATE ON slot_history
      WHEN EXISTS (
        SELECT 1 FROM slots WHERE slot_id = NEW.slot_id AND closed_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM slots WHERE slot_id = OLD.slot_id AND closed_at IS NULL
      ) BEGIN
        ${bumpPanelTreeRevision}
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_tree_revision_history_delete
      AFTER DELETE ON slot_history
      WHEN EXISTS (
        SELECT 1 FROM slots WHERE slot_id = OLD.slot_id AND closed_at IS NULL
      ) BEGIN
        ${bumpPanelTreeRevision}
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_tree_revision_entity_update
      AFTER UPDATE ON entities
      WHEN EXISTS (
        SELECT 1 FROM slots
        WHERE (current_entity_id = NEW.id OR current_entity_id = OLD.id)
          AND closed_at IS NULL
      ) BEGIN
        ${bumpPanelTreeRevision}
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_tree_revision_entity_delete
      AFTER DELETE ON entities
      WHEN EXISTS (
        SELECT 1 FROM slots
        WHERE current_entity_id = OLD.id AND closed_at IS NULL
      ) BEGIN
        ${bumpPanelTreeRevision}
      END
    `);
  }

  protected override requiredTables(): readonly string[] {
    return WORKSPACE_REQUIRED_TABLES;
  }

  protected override schemaIndexDefinitions(): readonly string[] {
    return [
      `CREATE INDEX idx_entities_status ON entities(status, retired_at)`,
      `CREATE INDEX idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`,
      `CREATE INDEX idx_entities_cleanup
        ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`,
      `CREATE INDEX idx_entities_agent_entity
        ON entities(agent_entity_id) WHERE agent_entity_id IS NOT NULL`,
      `CREATE INDEX idx_slots_parent ON slots(parent_slot_id)`,
      `CREATE INDEX idx_slots_sibling_page
         ON slots(parent_slot_id, sort_key, created_at DESC, slot_id)
         WHERE closed_at IS NULL`,
      `CREATE INDEX idx_slots_owner_root_page
         ON slots(owner_user_id, sort_key, created_at DESC, slot_id)
         WHERE closed_at IS NULL AND parent_slot_id IS NULL`,
      `CREATE INDEX idx_slots_current ON slots(current_entity_id)`,
      `CREATE INDEX idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`,
      `CREATE INDEX idx_panel_close_cleanup_page
         ON panel_close_cleanup(close_id, slot_id)`,
      `CREATE INDEX idx_panel_close_cleanup_owner_page
         ON panel_close_cleanup(owner_user_id, slot_id)`,
      `CREATE INDEX idx_history_entity ON slot_history(entity_id)`,
      `CREATE INDEX idx_history_entry ON slot_history(entry_key)`,
      `CREATE INDEX idx_context_edges_owner ON context_edges(owner_context_id, kind)`,
      `CREATE INDEX idx_context_edges_child ON context_edges(context_id)`,
      `CREATE INDEX idx_lifecycle_leases_refreshed ON lifecycle_leases(refreshed_at)`,
      `CREATE INDEX idx_lifecycle_ops_resume
       ON lifecycle_ops(op_kind, status, source, class_name, object_key)`,
      `CREATE INDEX idx_do_alarms_wake ON do_alarms(wake_at)`,
    ];
  }

  protected override validateSchema(): void {
    super.validateSchema();
    assertWorkspaceEntityColumns(this.sql, `${this.constructor.name} v29`);
    assertWorkspaceEntityStatuses(
      this.sql,
      ["preparing", "active", "retired"],
      `${this.constructor.name} v28`
    );
    assertWorkspaceAlarmColumns(this.sql, `${this.constructor.name} v29`);
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
  @schemaRpc()
  entityActivate(input: EntityActivateInput): EntityRecord {
    const nextBuildKey = validateActiveBuildKey(input.activeBuildKey);
    const nextExecutionDigest = validateActiveExecutionDigest(input.activeExecutionDigest);
    const nextAuthority = serializeActiveAuthority(input.activeAuthority);
    if (nextBuildKey !== null && nextExecutionDigest === null) {
      throw new Error("entity activeBuildKey requires an activeExecutionDigest");
    }
    if (nextAuthority !== null && nextExecutionDigest === null) {
      throw new Error("entity activeAuthority requires an activeExecutionDigest");
    }
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
        if (existing.active_build_key && existing.active_build_key !== nextBuildKey) {
          throw new IdentityCollisionError(id, {
            field: "activeBuildKey",
            existing: existing.active_build_key,
            attempted: nextBuildKey,
          });
        }
        if (
          existing.active_build_key !== nextBuildKey ||
          existing.active_execution_digest !== nextExecutionDigest ||
          existing.active_authority !== nextAuthority
        ) {
          this.sql.exec(
            `UPDATE entities
                SET active_build_key = ?, active_execution_digest = ?, active_authority = ?
              WHERE id = ?`,
            nextBuildKey,
            nextExecutionDigest,
            nextAuthority,
            id
          );
          existing.active_build_key = nextBuildKey;
          existing.active_execution_digest = nextExecutionDigest;
          existing.active_authority = nextAuthority;
        }
        const nextAgentEntityId =
          input.agentBinding === undefined || input.agentBinding.entityId === id
            ? null
            : input.agentBinding.entityId;
        const nextAgentChannelId = input.agentBinding?.channelId ?? null;
        if (input.agentBinding !== undefined && input.agentBinding.contextId !== input.contextId) {
          throw new IdentityCollisionError(id, {
            field: "agentBinding.contextId",
            existing: input.contextId,
            attempted: input.agentBinding.contextId,
          });
        }
        if (
          existing.agent_entity_id !== nextAgentEntityId ||
          existing.agent_channel_id !== nextAgentChannelId
        ) {
          throw new IdentityCollisionError(id, {
            field: "agentBinding",
            existing: {
              entityId: existing.agent_entity_id ?? id,
              contextId: existing.context_id,
              channelId: existing.agent_channel_id,
            },
            attempted: input.agentBinding ?? null,
          });
        }
        const nextOwnerUserId = input.ownerUserId ?? null;
        if (existing.owner_user_id !== nextOwnerUserId) {
          throw new IdentityCollisionError(id, {
            field: "ownerUserId",
            existing: existing.owner_user_id,
            attempted: nextOwnerUserId,
          });
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
          agent_entity_id: existing.agent_entity_id,
          agent_channel_id: existing.agent_channel_id,
          status: "active",
          retired_at: null,
          cleanup_complete: 1,
          error: null,
        });
      }

      const now = Date.now();
      this.sql.exec(
        `INSERT INTO entities (
          id, kind, source_repo_path, source_effective_version, active_build_key,
          active_execution_digest,
          active_authority,
          context_id, class_name, key, state_args, agent_entity_id, agent_channel_id,
          parent_id, owner_user_id, created_at,
          status, retired_at, cleanup_complete, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, NULL)`,
        id,
        input.kind,
        input.source.repoPath,
        input.source.effectiveVersion,
        nextBuildKey,
        nextExecutionDigest,
        nextAuthority,
        input.contextId,
        input.className ?? null,
        input.key,
        input.stateArgs === undefined ? null : JSON.stringify(input.stateArgs),
        input.agentBinding === undefined || input.agentBinding.entityId === id
          ? null
          : input.agentBinding.entityId,
        input.agentBinding?.channelId ?? null,
        input.parentId ?? null,
        input.ownerUserId ?? null,
        now
      );
      const row = this.readEntityRow(id);
      if (!row) throw new Error(`entityActivate: failed to read row after insert: ${id}`);
      return this.rowToEntity(row);
    });
  }

  /**
   * Reserve a code-backed incarnation before its immutable execution image is
   * ready. The `preparing` status keeps it out of active-principal queries.
   */
  @schemaRpc()
  entityReserve(input: EntityReservationInput): EntityRecord {
    if (!["panel", "app", "worker", "do"].includes(input.kind)) {
      throw new Error("entityReserve only accepts code-backed entity kinds");
    }
    if (input.activeBuildKey || input.activeExecutionDigest || input.activeAuthority) {
      throw new Error("An entity reservation cannot carry an execution identity");
    }
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
        if (existing.status === "retired") {
          throw new Error(`Cannot reserve retired entity ${id}`);
        }
        if (input.lifecycleOwner) {
          this.upsertContextEdge({
            contextId: input.contextId,
            ownerContextId: input.lifecycleOwner.contextId,
            kind: "lifecycle",
            ownerEntityId: input.lifecycleOwner.entityId,
          });
        }
        return this.rowToEntity(existing);
      }

      const now = Date.now();
      this.sql.exec(
        `INSERT INTO entities (
          id, kind, source_repo_path, source_effective_version, active_build_key,
          active_execution_digest, active_authority, context_id, class_name, key,
          state_args, agent_entity_id, agent_channel_id, parent_id, owner_user_id,
          created_at, status, retired_at, cleanup_complete, error
        ) VALUES (?, ?, ?, '', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', NULL, 1, NULL)`,
        id,
        input.kind,
        input.source.repoPath,
        input.contextId,
        input.className ?? null,
        input.key,
        input.stateArgs === undefined ? null : JSON.stringify(input.stateArgs),
        input.agentBinding === undefined || input.agentBinding.entityId === id
          ? null
          : input.agentBinding.entityId,
        input.agentBinding?.channelId ?? null,
        input.parentId ?? null,
        input.ownerUserId ?? null,
        now
      );
      if (input.lifecycleOwner) {
        this.upsertContextEdge({
          contextId: input.contextId,
          ownerContextId: input.lifecycleOwner.contextId,
          kind: "lifecycle",
          ownerEntityId: input.lifecycleOwner.entityId,
        });
      }
      const row = this.readEntityRow(id);
      if (!row) throw new Error(`entityReserve: failed to read row after insert: ${id}`);
      return this.rowToEntity(row);
    });
  }

  /**
   * Advance the executable version of one live durable identity without
   * replacing its storage identity. Stable coordinates (kind/source path,
   * context, class, key, owner) remain immutable; only the exact reviewed
   * source version and its sealed execution tuple move together.
   */
  @schemaRpc()
  entityAdvanceExecution(input: EntityActivateInput): EntityRecord {
    return this.ctx.storage.transactionSync(() => this.advanceEntityExecution(input));
  }

  /**
   * Publish one source build to every affected durable identity in one SQLite
   * transaction. Either every entity names the new incarnation or none do.
   */
  @schemaRpc()
  entityAdvanceExecutions(inputs: EntityActivateInput[]): EntityRecord[] {
    if (inputs.length === 0) return [];
    return this.ctx.storage.transactionSync(() =>
      inputs.map((input) => this.advanceEntityExecution(input))
    );
  }

  private advanceEntityExecution(input: EntityActivateInput): EntityRecord {
    const nextBuildKey = validateActiveBuildKey(input.activeBuildKey);
    const nextExecutionDigest = validateActiveExecutionDigest(input.activeExecutionDigest);
    const nextAuthority = serializeActiveAuthority(input.activeAuthority);
    if (nextBuildKey === null || nextExecutionDigest === null || nextAuthority === null) {
      throw new Error(
        "entity execution advance requires a complete build key, execution digest, and authority manifest"
      );
    }
    const id = canonicalEntityId({
      kind: input.kind,
      source: input.source.repoPath,
      className: input.className,
      key: input.key,
    });
    const existing = this.readEntityRow(id);
    if (!existing) throw new Error(`entityAdvanceExecution: unknown entity ${id}`);
    if (existing.status !== "active" && existing.status !== "preparing") {
      throw new Error(`entityAdvanceExecution: entity ${id} is ${existing.status}`);
    }
    this.assertStableIdentityMatches(id, existing, input);
    const nextOwnerUserId = input.ownerUserId ?? null;
    if (existing.owner_user_id !== nextOwnerUserId) {
      throw new IdentityCollisionError(id, {
        field: "ownerUserId",
        existing: existing.owner_user_id,
        attempted: nextOwnerUserId,
      });
    }
    this.sql.exec(
      `UPDATE entities
          SET source_effective_version = ?, active_build_key = ?,
              active_execution_digest = ?, active_authority = ?,
              status = 'active', error = NULL
        WHERE id = ?`,
      input.source.effectiveVersion,
      nextBuildKey,
      nextExecutionDigest,
      nextAuthority,
      id
    );
    const row = this.readEntityRow(id);
    if (!row) throw new Error(`entityAdvanceExecution: failed to read ${id} after update`);
    return this.rowToEntity(row);
  }

  /** Mark a single entity as retired. Idempotent. Returns the retired record (or null if not found). */
  @schemaRpc()
  entityRetire(id: string): EntityRecord | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.readEntityRow(id);
      if (!row) return null;
      if (row.status === "retired") {
        this.clearEntityDoLifecycle(row);
        return this.rowToEntity(row);
      }
      const now = Date.now();
      this.sql.exec(
        `UPDATE entities SET status = 'retired', retired_at = ?, cleanup_complete = 0 WHERE id = ?`,
        now,
        id
      );
      this.clearEntityDoLifecycle(row);
      const updated = this.readEntityRow(id);
      return updated ? this.rowToEntity(updated) : null;
    });
  }

  /** A retired DO cannot retain runnable lifecycle work: its principal is no
   * longer active, so either row would only create an authorization retry loop. */
  private clearEntityDoLifecycle(row: DbEntityRow): void {
    if (row.kind !== "do" || !row.class_name) return;
    const key = {
      source: row.source_repo_path,
      className: row.class_name,
      objectKey: row.key,
    };
    this.lifecycleLeaseClear(key);
    this.alarmClear(key);
    this.sql.exec(
      `DELETE FROM durable_work_owners
        WHERE source = ? AND class_name = ? AND object_key = ?`,
      key.source,
      key.className,
      key.objectKey
    );
  }

  /** Mark cleanup_complete=1 after server-side hooks succeed. */
  @schemaRpc()
  entityCleanupComplete(id: string): void {
    this.sql.exec(`UPDATE entities SET cleanup_complete = 1 WHERE id = ?`, id);
  }

  /** Find rows whose cleanup hooks need retrying. */
  @schemaRpc()
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
  @schemaRpc()
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

  @schemaRpc()
  entityResolve(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    return row ? this.rowToEntity(row) : null;
  }

  @schemaRpc()
  entityResolveActive(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    if (!row || row.status !== "active") return null;
    return this.rowToEntity(row);
  }

  @schemaRpc()
  entityResolveContext(id: string): string | null {
    const row = this.readEntityRow(id);
    return row ? row.context_id : null;
  }

  /**
   * Durable nav→slot mapping: the OPEN slot id whose current runtime entity is
   * `entityId`, or null. Backed by `idx_slots_current`. This is the authoritative,
   * lease-independent way to find the tree slot a panel's runtime entity belongs to.
   */
  @schemaRpc()
  slotResolveByEntity(entityId: string): string | null {
    const row = this.sql
      .exec(`SELECT slot_id FROM slots WHERE current_entity_id = ? AND closed_at IS NULL`, entityId)
      .toArray()[0];
    return row && typeof row["slot_id"] === "string" ? row["slot_id"] : null;
  }

  entityResolveSource(id: string): { repoPath: string; effectiveVersion: string } | null {
    const row = this.readEntityRow(id);
    if (!row) return null;
    return { repoPath: row.source_repo_path, effectiveVersion: row.source_effective_version };
  }

  // ─────────────────────────────────────────────────────────────
  // lifecycle.* operations
  // ─────────────────────────────────────────────────────────────

  @schemaRpc()
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

  @schemaRpc()
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

  /** One-time lifecycle registration. This must precede admitting queue work. */
  @schemaRpc()
  durableWorkOwnerRegister(input: LifecycleKey & { queues: DurableWorkQueue[] }): void {
    this.assertLifecycleKey(input);
    const allowed = new Set<string>(DURABLE_WORK_QUEUES);
    const queues = [...new Set(input.queues)].sort();
    if (queues.length === 0 || queues.some((queue) => !allowed.has(queue))) {
      throw new Error("durableWorkOwnerRegister: invalid queues");
    }
    const entityId = canonicalEntityId({
      kind: "do",
      source: input.source,
      className: input.className,
      key: input.objectKey,
    });
    const entity = this.readEntityRow(entityId);
    if (!entity || entity.status !== "active") {
      throw new Error(
        `durableWorkOwnerRegister: Durable Object ${input.source}:${input.className}:${input.objectKey} is not active`
      );
    }
    this.sql.exec(
      `INSERT INTO durable_work_owners (
         source, class_name, object_key, queues_json, registered_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, class_name, object_key) DO UPDATE SET
         queues_json = excluded.queues_json`,
      input.source,
      input.className,
      input.objectKey,
      JSON.stringify(queues),
      Date.now()
    );
  }

  @schemaRpc()
  durableWorkOwnerList(): DurableWorkReadyHint[] {
    return (
      this.sql
        .exec(
          `SELECT source, class_name, object_key, queues_json
             FROM durable_work_owners
            ORDER BY source, class_name, object_key`
        )
        .toArray() as Array<{
        source: string;
        class_name: string;
        object_key: string;
        queues_json: string;
      }>
    ).map((row) => ({
      owner: {
        source: row.source,
        className: row.class_name,
        objectKey: row.object_key,
      },
      queues: JSON.parse(row.queues_json) as DurableWorkQueue[],
    }));
  }

  /** Register/replace a DO's wake time (absolute epoch ms).
   *
   * Calls without a dispatch claim are fresh scheduling decisions. They fence
   * any in-flight handler by advancing the generation and releasing its claim.
   * Calls carrying a claim are handler acknowledgements and may update only
   * the exact generation owned by that driver activation.
   */
  @schemaRpc()
  alarmSet(
    input: LifecycleKey & {
      wakeAt: number;
      testPolicy?: AgentExecutionTestPolicy;
      dispatchOwner?: string;
      dispatchGeneration?: number;
    }
  ): "accepted" | "stale" {
    this.assertLifecycleKey(input);
    return this.ctx.storage.transactionSync(() => {
      const entityId = canonicalEntityId({
        kind: "do",
        source: input.source,
        className: input.className,
        key: input.objectKey,
      });
      const entity = this.readEntityRow(entityId);
      if (!entity || entity.status !== "active") {
        throw new Error(
          `alarmSet: Durable Object ${input.source}:${input.className}:${input.objectKey} is not active`
        );
      }
      const hasOwner = input.dispatchOwner !== undefined;
      const hasGeneration = input.dispatchGeneration !== undefined;
      if (hasOwner !== hasGeneration) {
        throw new Error("alarmSet: dispatchOwner and dispatchGeneration must be provided together");
      }
      if (hasOwner) {
        if (
          !input.dispatchOwner?.trim() ||
          !Number.isSafeInteger(input.dispatchGeneration) ||
          input.dispatchGeneration! < 1
        ) {
          throw new Error("alarmSet: invalid dispatch claim");
        }
        this.sql.exec(
          `UPDATE do_alarms
              SET wake_at = ?,
                  dispatch_owner = NULL
            WHERE source = ? AND class_name = ? AND object_key = ?
              AND dispatch_owner = ? AND dispatch_generation = ?`,
          Math.round(input.wakeAt),
          input.source,
          input.className,
          input.objectKey,
          input.dispatchOwner,
          input.dispatchGeneration
        );
        if (this.sql.exec(`SELECT changes() AS count`).one()["count"] !== 1) return "stale";
      } else {
        this.sql.exec(
          `INSERT INTO do_alarms (
             source, class_name, object_key, wake_at,
             dispatch_generation, dispatch_owner
           )
           VALUES (?, ?, ?, ?, 0, NULL)
           ON CONFLICT(source, class_name, object_key) DO UPDATE SET
             wake_at = excluded.wake_at,
             dispatch_owner = NULL`,
          input.source,
          input.className,
          input.objectKey,
          Math.round(input.wakeAt)
        );
      }
      if (input.testPolicy) {
        this.sql.exec(
          `INSERT INTO do_alarm_test_policies
             (source, class_name, object_key, test_policy_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source, class_name, object_key)
             DO UPDATE SET test_policy_json = excluded.test_policy_json`,
          input.source,
          input.className,
          input.objectKey,
          JSON.stringify(input.testPolicy)
        );
      }
      return "accepted";
    });
  }

  /** Clear a DO's pending alarm. A claimed acknowledgement is generation-fenced. */
  @schemaRpc()
  alarmClear(
    input: LifecycleKey & { dispatchOwner?: string; dispatchGeneration?: number }
  ): "accepted" | "stale" {
    this.assertLifecycleKey(input);
    return this.ctx.storage.transactionSync(() => {
      const hasOwner = input.dispatchOwner !== undefined;
      const hasGeneration = input.dispatchGeneration !== undefined;
      if (hasOwner !== hasGeneration) {
        throw new Error(
          "alarmClear: dispatchOwner and dispatchGeneration must be provided together"
        );
      }
      if (hasOwner) {
        if (
          !input.dispatchOwner?.trim() ||
          !Number.isSafeInteger(input.dispatchGeneration) ||
          input.dispatchGeneration! < 1
        ) {
          throw new Error("alarmClear: invalid dispatch claim");
        }
        this.sql.exec(
          `DELETE FROM do_alarms
            WHERE source = ? AND class_name = ? AND object_key = ?
              AND dispatch_owner = ? AND dispatch_generation = ?`,
          input.source,
          input.className,
          input.objectKey,
          input.dispatchOwner,
          input.dispatchGeneration
        );
        if (this.sql.exec(`SELECT changes() AS count`).one()["count"] !== 1) return "stale";
      } else {
        this.sql.exec(
          `DELETE FROM do_alarms WHERE source = ? AND class_name = ? AND object_key = ?`,
          input.source,
          input.className,
          input.objectKey
        );
      }
      this.sql.exec(
        `DELETE FROM do_alarm_test_policies
          WHERE source = ? AND class_name = ? AND object_key = ?`,
        input.source,
        input.className,
        input.objectKey
      );
      return "accepted";
    });
  }

  /** Soonest unclaimed wake. Claimed rows remain owned until generation adoption. */
  @schemaRpc()
  alarmNextWakeAt(now: number, exclude: LifecycleKey[] = []): number | null {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("alarmNextWakeAt: invalid now");
    const excluded = new Set(
      exclude.map((key) => {
        this.assertLifecycleKey(key);
        return `${key.source}\u0000${key.className}\u0000${key.objectKey}`;
      })
    );
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key, wake_at, dispatch_owner
           FROM do_alarms`
      )
      .toArray() as Array<{
      source: string;
      class_name: string;
      object_key: string;
      wake_at: number;
      dispatch_owner: string | null;
    }>;
    const wakes = rows
      .filter(
        (row) =>
          row.dispatch_owner === null &&
          !excluded.has(`${row.source}\u0000${row.class_name}\u0000${row.object_key}`)
      )
      .map((row) => row.wake_at);
    return wakes.length === 0 ? null : Math.min(...wakes);
  }

  /**
   * Install the one scheduler generation allowed to claim alarms. Adoption is
   * positive evidence that earlier in-process executors were superseded, so
   * their claims are released atomically. Wall-clock age is irrelevant.
   */
  @schemaRpc()
  alarmAdoptWorker(workerId: string): { previousWorkerId: string | null } {
    if (typeof workerId !== "string" || workerId.length < 8 || workerId.length > 512) {
      throw new Error("alarmAdoptWorker: invalid workerId");
    }
    return this.ctx.storage.transactionSync(() => {
      const previousWorkerId = this.getStateValue("alarm-active-worker");
      this.sql.exec(
        `UPDATE do_alarms
            SET dispatch_owner = NULL
          WHERE dispatch_owner IS NOT NULL`
      );
      this.setStateValue("alarm-active-worker", workerId);
      return { previousWorkerId };
    });
  }

  /** Read-only startup census. The AlarmDriver itself admits work exclusively
   * through alarmClaimDue. */
  @schemaRpc()
  alarmListScheduled(): LifecycleKey[] {
    return (
      this.sql
        .exec(
          `SELECT source, class_name, object_key
             FROM do_alarms
            ORDER BY source, class_name, object_key`
        )
        .toArray() as Array<{ source: string; class_name: string; object_key: string }>
    ).map((row) => ({
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
    }));
  }

  /** Atomically claim due alarms. Rows survive until a generation-fenced
   * handler acknowledgement replaces or clears them. */
  @schemaRpc()
  alarmClaimDue(input: {
    now: number;
    workerId: string;
    limit: number;
    exclude?: LifecycleKey[];
  }): Array<
    LifecycleKey & {
      wakeAt: number;
      dispatchGeneration: number;
      testPolicy?: AgentExecutionTestPolicy;
    }
  > {
    if (!Number.isSafeInteger(input.now) || input.now < 0) {
      throw new Error("alarmClaimDue: invalid now");
    }
    if (!input.workerId.trim()) throw new Error("alarmClaimDue: invalid workerId");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("alarmClaimDue: invalid limit");
    }
    if (this.getStateValue("alarm-active-worker") !== input.workerId) {
      throw new Error("alarmClaimDue: worker generation is not active");
    }
    const excluded = new Set(
      (input.exclude ?? []).map((key) => {
        this.assertLifecycleKey(key);
        return `${key.source}\u0000${key.className}\u0000${key.objectKey}`;
      })
    );
    return this.ctx.storage.transactionSync(() => {
      const candidates = this.sql
        .exec(
          `SELECT a.source, a.class_name, a.object_key, a.wake_at, p.test_policy_json
             FROM do_alarms AS a
             LEFT JOIN do_alarm_test_policies AS p
               ON p.source = a.source
              AND p.class_name = a.class_name
              AND p.object_key = a.object_key
            WHERE a.wake_at <= ?
              AND a.dispatch_owner IS NULL
            ORDER BY a.wake_at, a.source, a.class_name, a.object_key`,
          input.now
        )
        .toArray() as Array<{
        source: string;
        class_name: string;
        object_key: string;
        wake_at: number;
        test_policy_json: string | null;
      }>;
      const selected = candidates
        .filter(
          (row) => !excluded.has(`${row.source}\u0000${row.class_name}\u0000${row.object_key}`)
        )
        .slice(0, input.limit);
      return selected.map((row) => {
        this.sql.exec(
          `UPDATE do_alarms
              SET dispatch_owner = ?,
                  dispatch_generation = dispatch_generation + 1
            WHERE source = ? AND class_name = ? AND object_key = ?
              AND dispatch_owner IS NULL`,
          input.workerId,
          row.source,
          row.class_name,
          row.object_key
        );
        const generation = this.sql
          .exec(
            `SELECT dispatch_generation AS generation
               FROM do_alarms
              WHERE source = ? AND class_name = ? AND object_key = ?`,
            row.source,
            row.class_name,
            row.object_key
          )
          .one()["generation"];
        return {
          source: row.source,
          className: row.class_name,
          objectKey: row.object_key,
          wakeAt: row.wake_at,
          dispatchGeneration: Number(generation),
          ...(row.test_policy_json
            ? { testPolicy: JSON.parse(row.test_policy_json) as AgentExecutionTestPolicy }
            : {}),
        };
      });
    });
  }

  @schemaRpc()
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

  @schemaRpc()
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

  @schemaRpc()
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

  @schemaRpc()
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

  @schemaRpc()
  lifecycleCompleteEpoch(epochId: string): void {
    this.sql.exec(`UPDATE lifecycle_epochs SET status = 'completed' WHERE epoch_id = ?`, epochId);
  }

  @schemaRpc()
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
  @schemaRpc()
  entityListActive(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' ORDER BY created_at`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /** Return active entities of a given kind (used by singleton reconciliation). */
  @schemaRpc()
  entityListActiveByKind(kind: EntityKind): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' AND kind = ? ORDER BY created_at`, kind)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /** Return durable reservations that still need their runtime image activated. */
  @schemaRpc()
  entityListPreparing(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'preparing' ORDER BY created_at`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /** Return preparing reservations of one runtime kind. */
  @schemaRpc()
  entityListPreparingByKind(kind: EntityKind): EntityRecord[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM entities WHERE status = 'preparing' AND kind = ? ORDER BY created_at`,
        kind
      )
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Executable entities that may still run or be selected from panel history.
   * Retired rows with no slot-history reference are deliberately excluded.
   */
  @schemaRpc()
  entityListExecutionRoots(): EntityRecord[] {
    return this.sql
      .exec(
        `SELECT e.*
           FROM entities e
          WHERE e.active_build_key IS NOT NULL
            AND (
              e.status = 'active'
              OR EXISTS (SELECT 1 FROM slot_history h WHERE h.entity_id = e.id)
            )
          ORDER BY e.id`
      )
      .toArray()
      .map((row) => this.rowToEntity(row as unknown as DbEntityRow));
  }

  /**
   * Return every entity record attached to a context, including retired rows.
   * Context ownership must survive entity retirement long enough for the
   * creator to reclaim the now-empty context without acquiring foreign-state
   * authority.
   */
  @schemaRpc()
  entityListByContext(contextId: string): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE context_id = ? ORDER BY created_at`, contextId)
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
  @schemaRpc()
  contextEdgeUpsert(input: {
    contextId: string;
    ownerContextId: string;
    kind: "lifecycle" | "lineage";
    ownerEntityId?: string;
  }): void {
    this.ctx.storage.transactionSync(() => this.upsertContextEdge(input));
  }

  private upsertContextEdge(input: {
    contextId: string;
    ownerContextId: string;
    kind: "lifecycle" | "lineage";
    ownerEntityId?: string;
  }): void {
    if (input.contextId === input.ownerContextId) {
      throw new Error(`A context cannot be its own ${input.kind} owner: ${input.contextId}`);
    }
    if (input.kind === "lifecycle") {
      const owners = this.sql
        .exec(
          `SELECT owner_context_id FROM context_edges
           WHERE context_id = ? AND kind = 'lifecycle'`,
          input.contextId
        )
        .toArray() as unknown as Array<{ owner_context_id: string }>;
      const conflictingOwner = owners.find(
        ({ owner_context_id }) => owner_context_id !== input.ownerContextId
      );
      if (conflictingOwner) {
        throw new Error(
          `Context ${input.contextId} already belongs to lifecycle owner ${conflictingOwner.owner_context_id}; cannot re-parent it to ${input.ownerContextId}`
        );
      }
    }
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
  @schemaRpc()
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
  @schemaRpc()
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
  @schemaRpc()
  contextEdgeDeleteByChild(contextId: string): void {
    this.sql.exec(`DELETE FROM context_edges WHERE context_id = ?`, contextId);
  }

  // ─────────────────────────────────────────────────────────────
  // slot.* operations
  // ─────────────────────────────────────────────────────────────

  private queryPanelTreePage(input: WorkspacePanelTreePageInput): WorkspacePanelTreePage {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    let cursor: [number, number, string] | null = null;
    if (input.cursor) {
      try {
        const parsed = JSON.parse(input.cursor) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          typeof parsed[0] !== "number" ||
          !Number.isSafeInteger(parsed[0]) ||
          typeof parsed[1] !== "number" ||
          !Number.isSafeInteger(parsed[1]) ||
          typeof parsed[2] !== "string"
        ) {
          throw new Error("invalid shape");
        }
        cursor = [parsed[0], parsed[1], parsed[2]];
      } catch {
        throw new Error("Invalid panel-tree page cursor");
      }
    }

    return this.ctx.storage.transactionSync(() => {
      const revisionValue = this.sql
        .exec(`SELECT value FROM workspace_meta WHERE key = ?`, PANEL_TREE_REVISION_KEY)
        .one()["value"];
      const revision = Number(revisionValue);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error(`Invalid panel tree revision: ${String(revisionValue)}`);
      }

      const clauses = ["s.closed_at IS NULL"];
      const values: Array<string | number> = [];
      if (input.group.kind === "roots") {
        clauses.push("s.parent_slot_id IS NULL");
        if (input.group.ownerUserId === null) {
          clauses.push("s.owner_user_id IS NULL");
        } else {
          clauses.push("s.owner_user_id = ?");
          values.push(input.group.ownerUserId);
        }
      } else {
        clauses.push("s.parent_slot_id = ?");
        values.push(input.group.parentSlotId);
      }
      if (cursor) {
        clauses.push(
          `(s.sort_key > ?
            OR (s.sort_key = ? AND s.created_at < ?)
            OR (s.sort_key = ? AND s.created_at = ? AND s.slot_id > ?))`
        );
        values.push(cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2]);
      }

      const rows = this.sql
        .exec(
          `SELECT s.slot_id, s.parent_slot_id, s.owner_user_id, s.sort_key, s.created_at,
                  history.options,
                  COALESCE(e.display_title, s.slot_id) AS title,
                  history.source AS source,
                  CASE
                    WHEN history.source LIKE 'browser:%' THEN 'browser'
                    WHEN history.source IS NOT NULL THEN 'workspace'
                    ELSE NULL
                  END AS surface_kind,
                  e.context_id,
                  e.id AS runtime_entity_id,
                  e.source_effective_version AS effective_version,
                  e.active_build_key AS build_key,
                  (SELECT COUNT(*)
                     FROM slots child
                    WHERE child.parent_slot_id = s.slot_id AND child.closed_at IS NULL) AS child_count
             FROM slots s
             LEFT JOIN entities e ON e.id = s.current_entity_id
             LEFT JOIN slot_history history
               ON history.slot_id = s.slot_id AND history.entry_key = s.current_entry_key
            WHERE ${clauses.join(" AND ")}
            ORDER BY s.sort_key ASC, s.created_at DESC, s.slot_id ASC
            LIMIT ?`,
          ...values,
          limit + 1
        )
        .toArray() as Array<{
        slot_id: string;
        parent_slot_id: string | null;
        owner_user_id: string | null;
        sort_key: number;
        created_at: number;
        title: string;
        child_count: number;
        options: string | null;
        source: string | null;
        surface_kind: "workspace" | "browser" | null;
        context_id: string | null;
        runtime_entity_id: string | null;
        effective_version: string | null;
        build_key: string | null;
      }>;
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible.at(-1);
      return {
        revision,
        group: input.group,
        nodes: visible.map((row) => {
          const placement = this.panelTreePlacementHint(row.options);
          return {
            slotId: row.slot_id as WorkspacePanelTreePage["nodes"][number]["slotId"],
            parentSlotId:
              row.parent_slot_id as WorkspacePanelTreePage["nodes"][number]["parentSlotId"],
            ownerUserId: row.owner_user_id,
            title: row.title,
            createdAt: row.created_at,
            childCount: row.child_count,
            ...(row.source === null ? {} : { source: row.source }),
            ...(row.surface_kind === null ? {} : { kind: row.surface_kind }),
            ...(row.context_id === null ? {} : { contextId: row.context_id }),
            ...(row.runtime_entity_id === null ? {} : { runtimeEntityId: row.runtime_entity_id }),
            ...(row.effective_version === null ? {} : { effectiveVersion: row.effective_version }),
            ...(row.build_key === null ? {} : { buildKey: row.build_key }),
            ...(placement ? { placement } : {}),
          };
        }),
        nextCursor:
          hasMore && last ? JSON.stringify([last.sort_key, last.created_at, last.slot_id]) : null,
      };
    });
  }

  private panelTreeRevision(): number {
    const value = Number(
      this.sql
        .exec(`SELECT value FROM workspace_meta WHERE key = ?`, PANEL_TREE_REVISION_KEY)
        .one()["value"]
    );
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid panel tree revision: ${String(value)}`);
    }
    return value;
  }

  @schemaRpc()
  panelTreeRootGroups(
    input: WorkspacePanelTreeRootGroupPageInput
  ): WorkspacePanelTreeRootGroupPage {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const cursor = input.cursor === undefined ? null : JSON.parse(input.cursor);
    if (
      cursor !== null &&
      (!Array.isArray(cursor) ||
        cursor.length !== 2 ||
        typeof cursor[0] !== "string" ||
        typeof cursor[1] !== "string")
    ) {
      throw new Error("Invalid panel-tree root-group cursor");
    }
    const cursorNull = cursor?.[0] === "0";
    const cursorOwner = cursor?.[1] ?? "";
    const rows = this.sql
      .exec(
        `SELECT owner_user_id, COUNT(*) AS root_count
           FROM slots
          WHERE closed_at IS NULL AND parent_slot_id IS NULL
            AND (? IS NULL OR
              (owner_user_id IS NOT NULL AND ? = 1) OR
              (owner_user_id IS NOT NULL AND owner_user_id > ?))
          GROUP BY owner_user_id
          ORDER BY owner_user_id IS NOT NULL, owner_user_id
          LIMIT ?`,
        cursor === null ? null : 1,
        cursorNull ? 1 : 0,
        cursorOwner,
        limit + 1
      )
      .toArray() as Array<{ owner_user_id: string | null; root_count: number }>;
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const last = visible.at(-1);
    return {
      revision: this.panelTreeRevision(),
      groups: visible.map((row) => ({
        ownerUserId: row.owner_user_id,
        rootCount: row.root_count,
      })),
      nextCursor:
        hasMore && last
          ? JSON.stringify([last.owner_user_id === null ? "0" : "1", last.owner_user_id ?? ""])
          : null,
    };
  }

  @schemaRpc()
  panelTreePage(input: WorkspacePanelTreePageInput): WorkspacePanelTreePage {
    return this.queryPanelTreePage(input);
  }

  @schemaRpc()
  panelTreePath(slotId: string): WorkspacePanelTreePath | null {
    const rows = this.sql
      .exec(
        `WITH RECURSIVE path(slot_id, parent_slot_id, owner_user_id, created_at, depth) AS (
           SELECT slot_id, parent_slot_id, owner_user_id, created_at, 0
             FROM slots WHERE slot_id = ? AND closed_at IS NULL
           UNION ALL
           SELECT parent.slot_id, parent.parent_slot_id, parent.owner_user_id,
                  parent.created_at, path.depth + 1
             FROM slots parent JOIN path ON parent.slot_id = path.parent_slot_id
            WHERE parent.closed_at IS NULL
         )
         SELECT path.slot_id, path.parent_slot_id, path.owner_user_id, path.created_at,
                path.depth, COALESCE(entity.display_title, path.slot_id) AS title,
                history.options, history.source,
                CASE
                  WHEN history.source LIKE 'browser:%' THEN 'browser'
                  WHEN history.source IS NOT NULL THEN 'workspace'
                  ELSE NULL
                END AS surface_kind,
                entity.context_id, entity.id AS runtime_entity_id,
                entity.source_effective_version AS effective_version,
                entity.active_build_key AS build_key,
                (SELECT COUNT(*) FROM slots child
                  WHERE child.parent_slot_id = path.slot_id AND child.closed_at IS NULL)
                  AS child_count
           FROM path
           LEFT JOIN slots slot ON slot.slot_id = path.slot_id
           LEFT JOIN entities entity ON entity.id = slot.current_entity_id
           LEFT JOIN slot_history history
             ON history.slot_id = slot.slot_id AND history.entry_key = slot.current_entry_key
          ORDER BY path.depth DESC`,
        slotId
      )
      .toArray() as Array<{
      slot_id: string;
      parent_slot_id: string | null;
      owner_user_id: string | null;
      created_at: number;
      title: string;
      child_count: number;
      options: string | null;
      source: string | null;
      surface_kind: "workspace" | "browser" | null;
      context_id: string | null;
      runtime_entity_id: string | null;
      effective_version: string | null;
      build_key: string | null;
    }>;
    if (rows.length === 0) return null;
    return {
      revision: this.panelTreeRevision(),
      nodes: rows.map((row) => {
        const placement = this.panelTreePlacementHint(row.options);
        return {
          slotId: row.slot_id as WorkspacePanelTreePath["nodes"][number]["slotId"],
          parentSlotId:
            row.parent_slot_id as WorkspacePanelTreePath["nodes"][number]["parentSlotId"],
          ownerUserId: row.owner_user_id,
          title: row.title,
          createdAt: row.created_at,
          childCount: row.child_count,
          ...(row.source === null ? {} : { source: row.source }),
          ...(row.surface_kind === null ? {} : { kind: row.surface_kind }),
          ...(row.context_id === null ? {} : { contextId: row.context_id }),
          ...(row.runtime_entity_id === null ? {} : { runtimeEntityId: row.runtime_entity_id }),
          ...(row.effective_version === null ? {} : { effectiveVersion: row.effective_version }),
          ...(row.build_key === null ? {} : { buildKey: row.build_key }),
          ...(placement ? { placement } : {}),
        };
      }),
    };
  }

  private panelTreePlacementHint(optionsJson: string | null): {
    disposition?: "side" | "side-if-room" | "replace" | "split-below";
    preferredWidth?: number;
    minWidth?: number;
  } | null {
    if (!optionsJson) return null;
    try {
      const value = JSON.parse(optionsJson) as { placement?: unknown };
      if (!value.placement || typeof value.placement !== "object") return null;
      const raw = value.placement as Record<string, unknown>;
      const disposition =
        raw["disposition"] === "side" ||
        raw["disposition"] === "side-if-room" ||
        raw["disposition"] === "replace" ||
        raw["disposition"] === "split-below"
          ? raw["disposition"]
          : undefined;
      const preferredWidth =
        typeof raw["preferredWidth"] === "number" &&
        Number.isFinite(raw["preferredWidth"]) &&
        raw["preferredWidth"] > 0
          ? raw["preferredWidth"]
          : undefined;
      const minWidth =
        typeof raw["minWidth"] === "number" &&
        Number.isFinite(raw["minWidth"]) &&
        raw["minWidth"] > 0
          ? raw["minWidth"]
          : undefined;
      if (!disposition && preferredWidth === undefined && minWidth === undefined) return null;
      return {
        ...(disposition ? { disposition } : {}),
        ...(preferredWidth !== undefined ? { preferredWidth } : {}),
        ...(minWidth !== undefined ? { minWidth } : {}),
      };
    } catch {
      return null;
    }
  }

  @schemaRpc()
  panelTreeDetail(slotId: string): WorkspacePanelDetail | null {
    return this.ctx.storage.transactionSync(() => {
      const slot = this.sql
        .exec(
          `SELECT s.*, entity.display_title AS current_entity_title,
                  history.cursor AS current_history_cursor,
                  (SELECT COUNT(*) FROM slot_history all_history
                    WHERE all_history.slot_id = s.slot_id) AS history_count
             FROM slots s
             JOIN slot_history history
               ON history.slot_id = s.slot_id AND history.entry_key = s.current_entry_key
             JOIN entities entity ON entity.id = s.current_entity_id
            WHERE s.slot_id = ? AND s.closed_at IS NULL`,
          slotId
        )
        .toArray()[0] as DbSlotRow | undefined;
      if (!slot?.current_entry_key || !slot.current_entity_id) return null;
      const history = this.sql
        .exec(
          `SELECT * FROM slot_history WHERE slot_id = ? AND entry_key = ?`,
          slotId,
          slot.current_entry_key
        )
        .toArray()[0] as DbSlotHistoryRow | undefined;
      const entity = this.sql
        .exec(`SELECT * FROM entities WHERE id = ?`, slot.current_entity_id)
        .toArray()[0] as DbEntityRow | undefined;
      if (!history || !entity) return null;
      return {
        revision: this.panelTreeRevision(),
        slot: slot as unknown as WorkspacePanelDetail["slot"],
        currentHistory: history as unknown as WorkspacePanelDetail["currentHistory"],
        entity: this.rowToEntity(entity),
      };
    });
  }

  private allocatePanelTreeOrderKey(
    parentSlotId: string | null,
    ownerUserId: string | null,
    placement: WorkspacePanelTreePlacement | undefined,
    excludeSlotId?: string
  ): number {
    const anchor = (slotId: string | null | undefined): DbSlotRow | null => {
      if (!slotId) return null;
      const row = this.requireSlot(slotId);
      if (row.closed_at !== null || row.slot_id === excludeSlotId) {
        throw new Error(`Invalid panel-tree placement anchor: ${slotId}`);
      }
      const sameGroup =
        parentSlotId === null
          ? row.parent_slot_id === null && row.owner_user_id === ownerUserId
          : row.parent_slot_id === parentSlotId;
      if (!sameGroup) {
        throw new Error(`Panel-tree placement anchor is not a destination sibling: ${slotId}`);
      }
      return row;
    };
    const before = anchor(placement?.beforeSlotId);
    const after = anchor(placement?.afterSlotId);
    if (before && after && before.sort_key >= after.sort_key) {
      throw new Error("Panel-tree placement anchors are reversed");
    }
    if (before && after) {
      const between = this.sql
        .exec(
          `SELECT slot_id FROM slots
            WHERE closed_at IS NULL
              AND slot_id != ?
              AND sort_key > ? AND sort_key < ?
              AND ((${
                parentSlotId === null
                  ? "parent_slot_id IS NULL AND owner_user_id IS ?"
                  : "parent_slot_id = ?"
              }))
            LIMIT 1`,
          excludeSlotId ?? "",
          before.sort_key,
          after.sort_key,
          parentSlotId === null ? ownerUserId : parentSlotId
        )
        .toArray()[0];
      if (between) throw new Error("Panel-tree placement anchors are not adjacent");
    }

    if (!before && !after) {
      const row = this.sql
        .exec(
          `SELECT MIN(sort_key) AS edge FROM slots
            WHERE closed_at IS NULL
              AND slot_id != ?
              AND ${
                parentSlotId === null
                  ? "parent_slot_id IS NULL AND owner_user_id IS ?"
                  : "parent_slot_id = ?"
              }`,
          excludeSlotId ?? "",
          parentSlotId === null ? ownerUserId : parentSlotId
        )
        .one() as { edge: number | null };
      return (row.edge ?? PANEL_TREE_ORDER_STEP) - PANEL_TREE_ORDER_STEP;
    }
    if (!before) return after!.sort_key - PANEL_TREE_ORDER_STEP;
    if (!after) return before.sort_key + PANEL_TREE_ORDER_STEP;
    const gap = after.sort_key - before.sort_key;
    if (gap > 1) return before.sort_key + Math.floor(gap / 2);

    this.rebalancePanelTreeGroup(parentSlotId, ownerUserId, excludeSlotId);
    return this.allocatePanelTreeOrderKey(parentSlotId, ownerUserId, placement, excludeSlotId);
  }

  private rebalancePanelTreeGroup(
    parentSlotId: string | null,
    ownerUserId: string | null,
    excludeSlotId?: string
  ): void {
    this.sql.exec(
      `WITH ranked AS (
         SELECT slot_id,
                ROW_NUMBER() OVER (ORDER BY sort_key, created_at DESC, slot_id) * ? AS next_key
           FROM slots
          WHERE closed_at IS NULL
            AND slot_id != ?
            AND ${
              parentSlotId === null
                ? "parent_slot_id IS NULL AND owner_user_id IS ?"
                : "parent_slot_id = ?"
            }
       )
       UPDATE slots
          SET sort_key = (SELECT next_key FROM ranked WHERE ranked.slot_id = slots.slot_id)
        WHERE slot_id IN (SELECT slot_id FROM ranked)`,
      PANEL_TREE_ORDER_STEP,
      excludeSlotId ?? "",
      parentSlotId === null ? ownerUserId : parentSlotId
    );
  }

  @schemaRpc()
  slotCreate(input: SlotCreateInput): void {
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(
          `SELECT s.slot_id, s.parent_slot_id, s.current_entity_id, s.current_entry_key,
                  s.closed_at, h.source, h.context_id, h.state_args, h.options
             FROM slots s
             LEFT JOIN slot_history h
               ON h.slot_id = s.slot_id AND h.entry_key = s.current_entry_key
            WHERE s.slot_id = ?`,
          input.slotId
        )
        .toArray()[0] as
        | {
            slot_id: string;
            parent_slot_id: string | null;
            current_entity_id: string | null;
            current_entry_key: string | null;
            closed_at: number | null;
            source: string | null;
            context_id: string | null;
            state_args: string | null;
            options: string | null;
          }
        | undefined;
      if (existing) {
        // Idempotent resume: a retried creation carrying the identical durable
        // identity (slot id, entry key, entity id) converges on the live slot.
        // Any divergence is a typed collision — never a silent overwrite, and
        // distinguishable from transport failure so the caller does not roll
        // back state it did not create.
        this.assertSlotCreateResumable(existing, input);
        return;
      }
      const now = Date.now();
      const ownerUserId =
        input.parentSlotId === null
          ? (this.slotCreationOwnerUserId() ?? null)
          : this.rootOwnerOf(input.parentSlotId);
      const sortKey = this.allocatePanelTreeOrderKey(
        input.parentSlotId,
        ownerUserId,
        input.placement
      );
      this.sql.exec(
        `INSERT INTO slots (slot_id, parent_slot_id, current_entity_id, current_entry_key, sort_key, owner_user_id, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.slotId,
        input.parentSlotId,
        input.initialEntry?.entityId ?? null,
        input.initialEntry?.entryKey ?? null,
        sortKey,
        ownerUserId,
        now
      );
      if (input.initialEntry) {
        this.appendHistoryRow(input.slotId, 0, input.initialEntry, now);
      }
    });
  }

  private assertSlotCreateResumable(
    existing: {
      parent_slot_id: string | null;
      current_entity_id: string | null;
      current_entry_key: string | null;
      closed_at: number | null;
      source: string | null;
      context_id: string | null;
      state_args: string | null;
      options: string | null;
    },
    input: SlotCreateInput
  ): void {
    const slotId = input.slotId;
    if (existing.closed_at !== null) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "closed",
        existing: existing.closed_at,
        attempted: null,
      });
    }
    if (existing.parent_slot_id !== input.parentSlotId) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "parentSlotId",
        existing: existing.parent_slot_id,
        attempted: input.parentSlotId,
      });
    }
    if (existing.current_entry_key !== (input.initialEntry?.entryKey ?? null)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "entryKey",
        existing: existing.current_entry_key,
        attempted: input.initialEntry?.entryKey ?? null,
      });
    }
    if (existing.current_entity_id !== (input.initialEntry?.entityId ?? null)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "entityId",
        existing: existing.current_entity_id,
        attempted: input.initialEntry?.entityId ?? null,
      });
    }
    if (existing.source !== (input.initialEntry?.source ?? null)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "source",
        existing: existing.source,
        attempted: input.initialEntry?.source ?? null,
      });
    }
    if (existing.context_id !== (input.initialEntry?.contextId ?? null)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "contextId",
        existing: existing.context_id,
        attempted: input.initialEntry?.contextId ?? null,
      });
    }
    const attemptedStateArgs = input.initialEntry?.stateArgs;
    const existingStateArgs =
      existing.state_args === null ? undefined : JSON.parse(existing.state_args);
    if (!this.sameOptionalJson(existingStateArgs, attemptedStateArgs)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "stateArgs",
        existing: existingStateArgs,
        attempted: attemptedStateArgs,
      });
    }
    const attemptedOptions = input.initialEntry?.options;
    const existingOptions = existing.options === null ? undefined : JSON.parse(existing.options);
    if (!this.sameOptionalJson(existingOptions, attemptedOptions)) {
      throw new SlotIdentityCollisionError(slotId, {
        field: "options",
        existing: existingOptions,
        attempted: attemptedOptions,
      });
    }
  }

  private sameOptionalJson(existing: unknown, attempted: unknown): boolean {
    if (existing === undefined || attempted === undefined) {
      return existing === attempted;
    }
    return canonicalJson(existing) === canonicalJson(attempted);
  }

  protected slotCreationOwnerUserId(): string | undefined {
    return this.caller?.userId;
  }

  /**
   * Commit the durable half of panel navigation after runtime.createEntity has
   * fully prepared and activated the destination incarnation. History and the
   * slot pointer change in one transaction; the old incarnation remains active
   * until the caller observes this commit and retires it.
   */
  @schemaRpc()
  slotCommitPreparedNavigation(
    input: SlotCommitPreparedNavigationInput
  ): SlotCommitPreparedNavigationResult {
    return this.ctx.storage.transactionSync(() => {
      const slot = this.requireSlot(input.slotId);
      if (slot.closed_at !== null) {
        throw new Error(`Cannot navigate closed slot: ${input.slotId}`);
      }
      if (
        slot.current_entity_id !== input.expectedCurrentEntityId ||
        slot.current_entry_key === null
      ) {
        throw new Error(
          `Slot navigation conflict: ${input.slotId} current entity changed during preparation`
        );
      }

      const previousEntityId = slot.current_entity_id;
      const currentRow = this.sql
        .exec(
          `SELECT cursor FROM slot_history WHERE slot_id = ? AND entry_key = ?`,
          input.slotId,
          slot.current_entry_key
        )
        .toArray()[0] as { cursor: number } | undefined;
      if (!currentRow) {
        throw new Error(
          `Slot ${input.slotId} current entry is missing from history: ${slot.current_entry_key}`
        );
      }

      let target: SlotHistoryEntryInput;
      let cursor: number;
      if (input.mutation.kind === "select") {
        const selected = this.sql
          .exec(
            `SELECT cursor, entry_key, entity_id, source, context_id, state_args, options
               FROM slot_history WHERE slot_id = ? AND entry_key = ?`,
            input.slotId,
            input.mutation.entryKey
          )
          .toArray()[0] as DbSlotHistoryRow | undefined;
        if (!selected) {
          throw new Error(
            `History entry not found: slot=${input.slotId} entry=${input.mutation.entryKey}`
          );
        }
        cursor = selected.cursor;
        target = {
          entryKey: selected.entry_key,
          entityId: selected.entity_id,
          source: selected.source,
          contextId: selected.context_id,
          ...(selected.state_args === null
            ? {}
            : { stateArgs: this.parseJsonOrNull(selected.state_args) }),
          ...(selected.options === null ? {} : { options: this.parseJsonOrNull(selected.options) }),
        };
      } else {
        target = input.mutation.entry;
        if (input.mutation.kind === "append") {
          cursor = currentRow.cursor + 1;
          // Browser-style navigation from a back-history position abandons the
          // forward branch before appending the new destination.
          this.sql.exec(
            `DELETE FROM slot_history WHERE slot_id = ? AND cursor > ?`,
            input.slotId,
            currentRow.cursor
          );
          this.appendHistoryRow(input.slotId, cursor, target, Date.now());
        } else {
          cursor = currentRow.cursor;
          this.sql.exec(
            `DELETE FROM slot_history WHERE slot_id = ? AND cursor = ?`,
            input.slotId,
            cursor
          );
          this.appendHistoryRow(input.slotId, cursor, target, Date.now());
        }
      }

      this.assertCompleteActivePanelIncarnation(target);
      this.sql.exec(
        `UPDATE slots SET current_entity_id = ?, current_entry_key = ? WHERE slot_id = ?`,
        target.entityId,
        target.entryKey,
        input.slotId
      );
      this.refreshSlotSearchableTitle(input.slotId);
      return {
        previousEntityId,
        currentEntityId: target.entityId,
        currentEntryKey: target.entryKey,
        cursor,
      };
    });
  }

  @schemaRpc()
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

  /**
   * Move a slot under a new parent (or to root) and re-position it. Per WP3
   * §10.1, the moved subtree **re-owns** to the destination root's owner — the
   * tree it now lives in — so a panel dragged into another user's tree becomes
   * part of that tree. Moving to root (parentSlotId === null) promotes the
   * subtree to a new top-level tree owned by the acting mover (`ownerUserId`),
   * or keeps its current owner when no mover subject is supplied. Authorization
   * is permissive (any member may restructure any tree); only attribution moves.
   */
  @schemaRpc()
  slotMove(
    slotId: string,
    parentSlotId: string | null,
    placement: WorkspacePanelTreePlacement | undefined,
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
      let destOwner: string | null;
      if (parentSlotId !== null) {
        const parent = this.requireSlot(parentSlotId);
        if (parent.closed_at !== null) {
          throw new Error(`Cannot move slot under closed parent: ${parentSlotId}`);
        }
        const destinationInsideSubtree = this.sql
          .exec(
            `WITH RECURSIVE subtree(slot_id) AS (
               SELECT slot_id FROM slots WHERE slot_id = ?
               UNION ALL
               SELECT child.slot_id
                 FROM slots child JOIN subtree ON child.parent_slot_id = subtree.slot_id
             )
             SELECT 1 AS found FROM subtree WHERE slot_id = ? LIMIT 1`,
            slotId,
            parentSlotId
          )
          .toArray()[0];
        if (destinationInsideSubtree) {
          throw new Error(`Cannot move slot ${slotId} under its own subtree`);
        }
        destOwner = this.rootOwnerOf(parentSlotId);
      } else {
        destOwner = ownerUserId ?? slot.owner_user_id ?? null;
      }

      const sortKey = this.allocatePanelTreeOrderKey(parentSlotId, destOwner, placement, slotId);
      this.sql.exec(
        `UPDATE slots SET parent_slot_id = ?, sort_key = ? WHERE slot_id = ?`,
        parentSlotId,
        sortKey,
        slotId
      );
      // Re-stamp the subtree inside SQLite; application memory stays constant
      // regardless of subtree size.
      this.sql.exec(
        `WITH RECURSIVE subtree(slot_id) AS (
           SELECT slot_id FROM slots WHERE slot_id = ?
           UNION ALL
           SELECT child.slot_id
             FROM slots child JOIN subtree ON child.parent_slot_id = subtree.slot_id
         )
         UPDATE slots SET owner_user_id = ? WHERE slot_id IN (SELECT slot_id FROM subtree)`,
        slotId,
        destOwner
      );
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

  @schemaRpc()
  slotClose(slotId: string): WorkspacePanelCloseResult {
    return this.ctx.storage.transactionSync(() => {
      const root = this.requireSlot(slotId);
      const closeId = slotId;
      if (root.closed_at !== null) {
        const pending = Number(
          (
            this.sql
              .exec(`SELECT COUNT(*) AS count FROM panel_close_cleanup WHERE close_id = ?`, closeId)
              .one() as { count: number }
          ).count
        );
        return { closeId, closedCount: pending };
      }
      const now = Date.now();
      this.sql.exec(
        `WITH RECURSIVE subtree(slot_id, current_entity_id) AS (
           SELECT slot_id, current_entity_id FROM slots
            WHERE slot_id = ? AND closed_at IS NULL
           UNION ALL
           SELECT child.slot_id, child.current_entity_id
             FROM slots child JOIN subtree ON child.parent_slot_id = subtree.slot_id
            WHERE child.closed_at IS NULL
         )
         INSERT OR IGNORE INTO panel_close_cleanup
           (slot_id, close_id, owner_user_id, entity_id, queued_at)
         SELECT subtree.slot_id, ?, slot.owner_user_id, subtree.current_entity_id, ?
           FROM subtree JOIN slots slot ON slot.slot_id = subtree.slot_id`,
        slotId,
        closeId,
        now
      );
      const closedCount = Number(
        (
          this.sql
            .exec(`SELECT COUNT(*) AS count FROM panel_close_cleanup WHERE close_id = ?`, closeId)
            .one() as { count: number }
        ).count
      );
      this.sql.exec(
        `WITH RECURSIVE subtree(slot_id) AS (
           SELECT slot_id FROM slots WHERE slot_id = ? AND closed_at IS NULL
           UNION ALL
           SELECT child.slot_id
             FROM slots child JOIN subtree ON child.parent_slot_id = subtree.slot_id
            WHERE child.closed_at IS NULL
         )
         DELETE FROM panel_search_metadata WHERE slot_id IN (SELECT slot_id FROM subtree)`,
        slotId
      );
      this.sql.exec(
        `WITH RECURSIVE subtree(slot_id) AS (
           SELECT slot_id FROM slots WHERE slot_id = ? AND closed_at IS NULL
           UNION ALL
           SELECT child.slot_id
             FROM slots child JOIN subtree ON child.parent_slot_id = subtree.slot_id
            WHERE child.closed_at IS NULL
         )
         UPDATE slots
            SET closed_at = ?, current_entity_id = NULL, current_entry_key = NULL
          WHERE slot_id IN (SELECT slot_id FROM subtree)`,
        slotId,
        now
      );
      return { closeId, closedCount };
    });
  }

  @schemaRpc()
  slotCloseOwnedRoots(ownerUserId: string): { rootIds: string[]; closedIds: string[] } {
    if (!ownerUserId || ownerUserId === "system") {
      throw new Error("A revocable workspace user id is required");
    }
    const rootIds = this.sql
      .exec(
        `SELECT slot_id
           FROM slots
          WHERE parent_slot_id IS NULL
            AND owner_user_id = ?
            AND closed_at IS NULL
          ORDER BY slot_id`,
        ownerUserId
      )
      .toArray()
      .map((row) => String((row as { slot_id: string }).slot_id));
    for (const slotId of rootIds) this.slotClose(slotId);
    const closedIds = this.sql
      .exec(
        `SELECT slot_id
           FROM panel_close_cleanup
          WHERE owner_user_id = ?
          ORDER BY slot_id`,
        ownerUserId
      )
      .toArray()
      .map((row) => String((row as { slot_id: string }).slot_id));
    return { rootIds, closedIds };
  }

  @schemaRpc()
  slotCloseCleanupPage(input: WorkspacePanelCloseCleanupPageInput): WorkspacePanelCloseCleanupPage {
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const ownerFiltered = Object.prototype.hasOwnProperty.call(input, "ownerUserId");
    const clauses: string[] = [];
    const bindings: Array<string | number | null> = [];
    if (input.closeId !== undefined) {
      clauses.push("close_id = ?");
      bindings.push(input.closeId);
    }
    if (ownerFiltered) {
      clauses.push("owner_user_id IS ?");
      bindings.push(input.ownerUserId ?? null);
    }
    if (input.cursor !== undefined) {
      clauses.push("slot_id > ?");
      bindings.push(input.cursor);
    }
    const rows = this.sql
      .exec(
        `SELECT slot_id, entity_id
           FROM panel_close_cleanup
          ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY slot_id
          LIMIT ?`,
        ...bindings,
        limit + 1
      )
      .toArray() as Array<{ slot_id: string; entity_id: string | null }>;
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => ({
        slotId: row.slot_id as WorkspacePanelCloseCleanupPage["items"][number]["slotId"],
        entityId: row.entity_id as WorkspacePanelCloseCleanupPage["items"][number]["entityId"],
      })),
      nextCursor: hasMore ? (visible.at(-1)?.slot_id ?? null) : null,
    };
  }

  @schemaRpc()
  slotCloseCleanupAck(slotIds: string[]): void {
    if (slotIds.length === 0) return;
    if (slotIds.length > 200) throw new Error("Close cleanup acknowledgement exceeds 200 items");
    this.sql.exec(
      `DELETE FROM panel_close_cleanup WHERE slot_id IN (${slotIds.map(() => "?").join(", ")})`,
      ...slotIds
    );
  }

  @schemaRpc()
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

  @schemaRpc()
  slotHistoryRelative(slotId: string, delta: -1 | 1): DbSlotHistoryRow | null {
    return (
      (this.sql
        .exec(
          `SELECT target.*
             FROM slots slot
             JOIN slot_history current
               ON current.slot_id = slot.slot_id AND current.entry_key = slot.current_entry_key
             JOIN slot_history target
               ON target.slot_id = slot.slot_id AND target.cursor = current.cursor + ?
            WHERE slot.slot_id = ? AND slot.closed_at IS NULL`,
          delta,
          slotId
        )
        .toArray()[0] as DbSlotHistoryRow | undefined) ?? null
    );
  }

  @schemaRpc()
  slotHistoryEntry(slotId: string, entryKey: string): DbSlotHistoryRow | null {
    return (
      (this.sql
        .exec(
          `SELECT cursor, entry_key, entity_id, source, context_id, state_args, options
             FROM slot_history
            WHERE slot_id = ? AND entry_key = ?`,
          slotId,
          entryKey
        )
        .toArray()[0] as DbSlotHistoryRow | undefined) ?? null
    );
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
  @schemaRpc()
  panelIndex(input: IndexablePanel): string | null {
    const now = Date.now();
    let resolvedEntityId: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const normalizedTitle = normalizePanelTitle(input.title);
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
      const ftsTitle = normalizedTitle ?? currentTitle;

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
        normalizedTitle !== undefined &&
        typeof entityIdFromSlot === "string" &&
        entityIdFromSlot.length > 0
      ) {
        this.sql.exec(
          `UPDATE entities SET display_title = ? WHERE id = ?`,
          normalizedTitle,
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
  @schemaRpc()
  panelUpdateTitle(slotId: string, title: string): string | null {
    const row = this.sql
      .exec(`SELECT current_entity_id FROM slots WHERE slot_id = ?`, slotId)
      .toArray()[0];
    const entityId = row?.["current_entity_id"];
    if (typeof entityId !== "string" || entityId.length === 0) return null;
    this.entitySetDisplayTitle(entityId, title);
    return entityId;
  }

  @schemaRpc()
  panelIncrementAccess(slotId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE panel_search_metadata SET access_count = access_count + 1 WHERE slot_id = ?`,
        slotId
      );
      const row = this.sql
        .exec(`SELECT searchable_path FROM panel_search_metadata WHERE slot_id = ?`, slotId)
        .toArray()[0];
      const source = row?.["searchable_path"];
      if (typeof source !== "string" || source.length === 0) return;
      this.sql.exec(
        `INSERT INTO panel_source_usage (source, access_count, last_accessed_at)
         VALUES (?, 1, ?)
         ON CONFLICT(source) DO UPDATE SET
           access_count = panel_source_usage.access_count + 1,
           last_accessed_at = excluded.last_accessed_at`,
        source,
        Date.now()
      );
    });
  }

  @schemaRpc()
  panelSourceUsage(limit = 200): PanelSourceUsage[] {
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const rows = this.sql
      .exec(
        `SELECT source, access_count, last_accessed_at
           FROM panel_source_usage
          ORDER BY access_count DESC, last_accessed_at DESC, source ASC
          LIMIT ?`,
        boundedLimit
      )
      .toArray() as Array<{
      source: string;
      access_count: number;
      last_accessed_at: number;
    }>;
    return rows.map((row) => ({
      source: row.source,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
    }));
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
  @schemaRpc()
  entitySetDisplayTitle(entityId: string, title: string | null): void {
    const stored = normalizePanelTitle(title) ?? null;
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
  @schemaRpc()
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

  @schemaRpc()
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

  @schemaRpc()
  panelTreeSearch(input: WorkspacePanelTreeSearchInput): WorkspacePanelTreeSearchPage {
    const safeQuery = this.sanitizeSearchQuery(input.query);
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    let cursor: [number, string] | null = null;
    if (input.cursor) {
      const parsed = JSON.parse(input.cursor) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== "number" ||
        !Number.isFinite(parsed[0]) ||
        typeof parsed[1] !== "string"
      ) {
        throw new Error("Invalid panel-tree search cursor");
      }
      cursor = [parsed[0], parsed[1]];
    }
    if (!safeQuery) {
      return { revision: this.panelTreeRevision(), hits: [], nextCursor: null };
    }
    const rows = this.sql
      .exec(
        `SELECT * FROM (
           SELECT m.slot_id, bm25(panel_fts) AS rank
             FROM panel_fts
             JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
             JOIN slots s ON s.slot_id = m.slot_id
            WHERE panel_fts MATCH ? AND s.closed_at IS NULL
         ) matches
         WHERE (? IS NULL OR rank > ? OR (rank = ? AND slot_id > ?))
         ORDER BY rank, slot_id
         LIMIT ?`,
        safeQuery,
        cursor === null ? null : 1,
        cursor?.[0] ?? 0,
        cursor?.[0] ?? 0,
        cursor?.[1] ?? "",
        limit + 1
      )
      .toArray() as Array<{ slot_id: string; rank: number }>;
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const hits = visible.flatMap((row) => {
      const path = this.panelTreePath(row.slot_id);
      if (!path) return [];
      const node = path.nodes.at(-1);
      if (!node) return [];
      const ancestorCount = Math.max(0, path.nodes.length - 1);
      const ancestors = path.nodes.slice(Math.max(0, ancestorCount - 12), -1);
      return [
        {
          node,
          ancestors,
          ...(ancestorCount > ancestors.length ? { ancestorsTruncated: true } : {}),
        },
      ];
    });
    const last = visible.at(-1);
    return {
      revision: this.panelTreeRevision(),
      hits,
      nextCursor: hasMore && last ? JSON.stringify([last.rank, last.slot_id]) : null,
    };
  }

  @schemaRpc()
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
    return trimmed
      .replace(/["*():^]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token}"*`)
      .join(" AND ");
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
        dispatch_generation INTEGER NOT NULL DEFAULT 0,
        dispatch_owner TEXT,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_do_alarms_wake ON do_alarms(wake_at)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_alarm_test_policies (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        test_policy_json TEXT NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS durable_work_owners (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        queues_json TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
  }

  /** Recover cross-table lifecycle invariants independently of schema setup. */
  private repairLifecycleInvariants(): void {
    this.sql.exec(`
      DELETE FROM do_alarms
       WHERE EXISTS (
         SELECT 1 FROM entities
          WHERE entities.kind = 'do'
            AND entities.status = 'retired'
            AND entities.source_repo_path = do_alarms.source
            AND entities.class_name = do_alarms.class_name
            AND entities.key = do_alarms.object_key
       )
    `);
    this.sql.exec(`
      DELETE FROM do_alarm_test_policies
       WHERE NOT EXISTS (
         SELECT 1 FROM do_alarms
          WHERE do_alarms.source = do_alarm_test_policies.source
            AND do_alarms.class_name = do_alarm_test_policies.class_name
            AND do_alarms.object_key = do_alarm_test_policies.object_key
       )
    `);
    this.sql.exec(`
      DELETE FROM durable_work_owners
       WHERE NOT EXISTS (
         SELECT 1 FROM entities
          WHERE entities.kind = 'do'
            AND entities.status = 'active'
            AND entities.source_repo_path = durable_work_owners.source
            AND entities.class_name = durable_work_owners.class_name
            AND entities.key = durable_work_owners.object_key
       )
    `);
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
        effectiveVersion: row.source_effective_version,
      },
      ...(row.active_build_key ? { activeBuildKey: row.active_build_key } : {}),
      ...(row.active_execution_digest
        ? { activeExecutionDigest: row.active_execution_digest }
        : {}),
      ...(row.active_authority
        ? {
            activeAuthority: parseUnitAuthorityManifest(
              JSON.parse(row.active_authority),
              `entity ${row.id} active authority`
            ),
          }
        : {}),
      contextId: row.context_id,
      key: row.key,
      createdAt: row.created_at,
      status: row.status,
      cleanupComplete: row.cleanup_complete === 1,
    };
    if (row.class_name) record.className = row.class_name;
    if (row.state_args !== null) record.stateArgs = JSON.parse(row.state_args);
    if (row.agent_channel_id !== null) {
      record.agentBinding = {
        entityId: row.agent_entity_id ?? row.id,
        contextId: row.context_id,
        channelId: row.agent_channel_id,
      };
    }
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
    this.assertStableIdentityMatches(id, existing, input);
    if (existing.source_effective_version !== input.source.effectiveVersion) {
      throw new IdentityCollisionError(id, {
        field: "source.effectiveVersion",
        existing: existing.source_effective_version,
        attempted: input.source.effectiveVersion,
      });
    }
  }

  private assertStableIdentityMatches(
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

  private assertCompleteActivePanelIncarnation(entry: SlotHistoryEntryInput): void {
    const entity = this.readEntityRow(entry.entityId);
    const requiresExecutableImage = entity ? !isBrowserPanelSource(entity.source_repo_path) : true;
    if (
      !entity ||
      entity.kind !== "panel" ||
      entity.status !== "active" ||
      entity.retired_at !== null ||
      entity.cleanup_complete !== 1 ||
      entity.error !== null ||
      (requiresExecutableImage &&
        (entity.active_build_key === null ||
          entity.active_execution_digest === null ||
          entity.active_authority === null))
    ) {
      throw new Error(`Prepared panel incarnation is not active and complete: ${entry.entityId}`);
    }
    if (
      entity.key !== entry.entryKey ||
      entity.source_repo_path !== entry.source ||
      entity.context_id !== entry.contextId
    ) {
      throw new Error(`Prepared panel incarnation does not match history entry: ${entry.entityId}`);
    }
  }

  private requireSlot(slotId: string): DbSlotRow {
    const row = this.slotGet(slotId);
    if (!row) throw new Error(`Slot not found: ${slotId}`);
    return row;
  }
}
