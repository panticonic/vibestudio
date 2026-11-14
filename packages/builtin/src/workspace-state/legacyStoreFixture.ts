/**
 * The retired SQLite workspace store's tables as `WorkspaceDO` created them
 * (schema v39), for tests of the legacy import: a store to read from.
 * Test-only.
 */
import type { Database } from "sql.js";

export const LEGACY_STORE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS entities ( id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_repo_path TEXT NOT NULL, source_effective_version TEXT NOT NULL, active_build_key TEXT, active_execution_digest TEXT, active_authority TEXT, execution_authority TEXT, context_id TEXT NOT NULL, class_name TEXT, key TEXT NOT NULL, state_args TEXT, native_owner TEXT, agent_entity_id TEXT REFERENCES entities(id), agent_channel_id TEXT, parent_id TEXT, owner_user_id TEXT, authority_session_id TEXT NOT NULL, clone_provenance TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', retired_at INTEGER, cleanup_complete INTEGER NOT NULL DEFAULT 1, error TEXT, CHECK (agent_entity_id IS NULL OR agent_channel_id IS NOT NULL) )`,
  `CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status, retired_at)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_cleanup ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`,
  `CREATE INDEX IF NOT EXISTS idx_entities_agent_entity ON entities(agent_entity_id) WHERE agent_entity_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS runtime_resource_bindings ( entity_id TEXT NOT NULL REFERENCES entities(id), resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, capabilities TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_channel_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (entity_id, resource_kind, resource_id) )`,
  `CREATE INDEX IF NOT EXISTS idx_runtime_resource_bindings_resource ON runtime_resource_bindings(resource_kind, resource_id)`,
  `CREATE TABLE IF NOT EXISTS slots ( slot_id TEXT PRIMARY KEY, parent_slot_id TEXT REFERENCES slots(slot_id), current_entity_id TEXT REFERENCES entities(id), current_entry_key TEXT, sort_key INTEGER NOT NULL, owner_user_id TEXT, created_at INTEGER NOT NULL, closed_at INTEGER )`,
  `CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_slots_owner ON slots(owner_user_id) WHERE closed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS panel_close_cleanup ( slot_id TEXT PRIMARY KEY, close_id TEXT NOT NULL, owner_user_id TEXT, entity_id TEXT, queued_at INTEGER NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_page ON panel_close_cleanup(close_id, slot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_panel_close_cleanup_owner_page ON panel_close_cleanup(owner_user_id, slot_id)`,
  `CREATE TABLE IF NOT EXISTS slot_history ( slot_id TEXT NOT NULL REFERENCES slots(slot_id), cursor INTEGER NOT NULL, entry_key TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id), source TEXT NOT NULL, context_id TEXT NOT NULL, state_args TEXT, options TEXT, recorded_at INTEGER NOT NULL, PRIMARY KEY (slot_id, cursor) )`,
  `CREATE INDEX IF NOT EXISTS idx_history_entity ON slot_history(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_history_entry ON slot_history(entry_key)`,
  `CREATE TABLE IF NOT EXISTS workspace_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS lifecycle_epochs ( epoch_id TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS lifecycle_leases ( source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL, PRIMARY KEY (source, class_name, object_key) )`,
  `CREATE TABLE IF NOT EXISTS lifecycle_ops ( epoch_id TEXT NOT NULL, source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL, op_kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (epoch_id, source, class_name, object_key, op_kind) )`,
  `CREATE TABLE IF NOT EXISTS do_alarms ( source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL, wake_at INTEGER NOT NULL, dispatch_generation INTEGER NOT NULL DEFAULT 0, dispatch_owner TEXT, PRIMARY KEY (source, class_name, object_key) )`,
  `CREATE TABLE IF NOT EXISTS do_alarm_test_policies ( source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL, test_policy_json TEXT NOT NULL, PRIMARY KEY (source, class_name, object_key) )`,
  `CREATE TABLE IF NOT EXISTS durable_work_owners ( source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL, queues_json TEXT NOT NULL, registered_at INTEGER NOT NULL, PRIMARY KEY (source, class_name, object_key) )`,
  `CREATE TABLE IF NOT EXISTS context_edges ( context_id       TEXT NOT NULL, owner_context_id TEXT NOT NULL, kind             TEXT NOT NULL, owner_entity_id  TEXT, clone_definition TEXT, clone_completion TEXT, created_at       INTEGER NOT NULL, PRIMARY KEY (context_id, owner_context_id, kind) )`,
  `CREATE INDEX IF NOT EXISTS idx_context_edges_owner ON context_edges(owner_context_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_context_edges_child ON context_edges(context_id)`,
];

export function createLegacyStoreSchema(db: Database): void {
  for (const statement of LEGACY_STORE_DDL) db.run(statement);
  db.run(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}
