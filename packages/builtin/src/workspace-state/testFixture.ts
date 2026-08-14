/**
 * Test-only subclass of WorkspaceDO that omits the FTS5 virtual table.
 *
 * sql.js (used by `createTestDO`) does not include the fts5 module, so a
 * `CREATE VIRTUAL TABLE … USING fts5` statement fails at schema creation.
 * The FTS5 search path is exercised by the workerd-backed integration tests
 * in `internalStorageWorkerd.test.ts`; this subclass exists purely so unit
 * tests can stand WorkspaceDO up under sql.js.
 *
 * Do not use in production code.
 */

import { WorkspaceDO } from "./WorkspaceDO.js";

export class WorkspaceDOTestable extends WorkspaceDO {
  slotCreateAs(
    ownerUserId: string | undefined,
    input: Parameters<WorkspaceDO["slotCreate"]>[0]
  ): void {
    this.slotCreate({ ...input, ...(ownerUserId ? { ownerUserId } : {}) });
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
      `CREATE INDEX idx_slots_current ON slots(current_entity_id)`,
      `CREATE INDEX idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`,
      `CREATE INDEX idx_panel_close_cleanup_page ON panel_close_cleanup(close_id, slot_id)`,
      `CREATE INDEX idx_panel_close_cleanup_owner_page ON panel_close_cleanup(owner_user_id, slot_id)`,
      `CREATE INDEX idx_quickfire_sessions_channel ON quickfire_sessions(channel_id)`,
      `CREATE INDEX idx_quickfire_close_cleanup_page ON quickfire_close_cleanup(close_id, channel_id)`,
      `CREATE INDEX idx_history_entity ON slot_history(entity_id)`,
      `CREATE INDEX idx_history_entry ON slot_history(entry_key)`,
      `CREATE INDEX idx_context_edges_owner ON context_edges(owner_context_id, kind)`,
      `CREATE INDEX idx_context_edges_child ON context_edges(context_id)`,
    ];
  }

  protected override createTables(): void {
    const sql = (this as unknown as { sql: { exec(s: string, ...b: unknown[]): unknown } }).sql;
    sql.exec(`
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
        CHECK (agent_entity_id IS NULL OR agent_channel_id IS NOT NULL)
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status, retired_at)`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_cleanup
        ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_agent_entity
        ON entities(agent_entity_id) WHERE agent_entity_id IS NOT NULL`
    );
    sql.exec(`
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
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_close_cleanup (
        slot_id TEXT PRIMARY KEY,
        close_id TEXT NOT NULL,
        owner_user_id TEXT,
        entity_id TEXT,
        queued_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_page
         ON panel_close_cleanup(close_id, slot_id)`
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_owner_page
         ON panel_close_cleanup(owner_user_id, slot_id)`
    );
    // Keep in sync with WorkspaceDO.createTables() — this fixture hand-copies
    // the durable schema so unit tests can run under sql.js.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS quickfire_sessions (
        slot_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        agent_entity_id TEXT,
        context_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        cleared_at INTEGER,
        promoted_at INTEGER
      )
    `);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_quickfire_sessions_channel
         ON quickfire_sessions(channel_id)`
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS quickfire_close_cleanup (
        channel_id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL,
        close_id TEXT NOT NULL,
        agent_entity_id TEXT,
        context_id TEXT NOT NULL,
        queued_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_quickfire_close_cleanup_page
         ON quickfire_close_cleanup(close_id, channel_id)`
    );
    sql.exec(`
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
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entity ON slot_history(entity_id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entry ON slot_history(entry_key)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.createPanelTreeRevisionTracking();
    sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_epochs (
        epoch_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `);
    sql.exec(`
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
    sql.exec(`
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
    sql.exec(`
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
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_alarm_test_policies (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        test_policy_json TEXT NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS durable_work_owners (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        queues_json TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS context_edges (
        context_id       TEXT NOT NULL,
        owner_context_id TEXT NOT NULL,
        kind             TEXT NOT NULL,
        owner_entity_id  TEXT,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (context_id, owner_context_id, kind)
      )
    `);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_context_edges_owner ON context_edges(owner_context_id, kind)`
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_context_edges_child ON context_edges(context_id)`);
  }
}
