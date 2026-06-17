import type { SqlStorage } from "@workspace/runtime/worker";

/**
 * Gmail tables split into two migration regimes:
 *
 * - REBUILDABLE: caches reconstructed from Gmail + channel replay (thread
 *   cache, triage queues, hits, wake bookkeeping). Versioned by
 *   drop-and-recreate — bump the worker schemaVersion when a shape changes.
 * - DURABLE: user data a schema bump must NOT wipe. `gmail_channel_state`
 *   holds the credential pin and setup status (dropping it would re-trigger
 *   first-run onboarding for configured users); prefs/replied-senders/people
 *   hold accumulated user signal. Shape changes here need additive
 *   per-version ALTERs in the worker's migrate(), never a drop.
 */
const REBUILDABLE_GMAIL_TABLES = [
  "gmail_threads",
  "gmail_attention_hits",
  "gmail_attention_turns",
  "gmail_attention_queue",
  "gmail_wake_turns",
  "gmail_triage_queue",
  "gmail_triage_runs",
  // Legacy tables from earlier schema generations.
  "gmail_categories",
  "gmail_attention_rules",
];

export const DURABLE_GMAIL_TABLES = [
  "gmail_channel_state",
  "gmail_attention_prefs",
  "gmail_replied_senders",
  "gmail_people",
  "gmail_reminders",
  "gmail_push_targets",
];

export function dropRebuildableGmailTables(sql: SqlStorage): void {
  for (const table of REBUILDABLE_GMAIL_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Full reset (tests / explicit wipe only — never the migration path). */
export function dropGmailTables(sql: SqlStorage): void {
  dropRebuildableGmailTables(sql);
  for (const table of DURABLE_GMAIL_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

export function createGmailTables(sql: SqlStorage): void {
  // Durable: pre-existing rows survive schema bumps. Objects migrated from
  // older generations may carry extra legacy columns (last_overview_json,
  // last_search_*) — harmless, all nullable; reads/writes use named columns.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_channel_state (
      channel_id TEXT PRIMARY KEY,
      history_id TEXT,
      email_address TEXT,
      credential_id TEXT,
      poll_interval_ms INTEGER NOT NULL,
      last_sync_at INTEGER,
      last_error TEXT,
      setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences',
      setup_prompted_at INTEGER,
      configured_at INTEGER,
      setup_summary TEXT,
      sync_state TEXT NOT NULL DEFAULT 'ok',
      rate_limited_until INTEGER,
      backoff_ms INTEGER,
      last_setup_json TEXT,
      people_api_status TEXT,
      watch_expiration INTEGER
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_threads (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      snippet TEXT NOT NULL,
      unread INTEGER NOT NULL,
      in_inbox INTEGER NOT NULL,
      actionable INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id)
    )
  `);
  // Natural-language attention preferences (replaces the old rule store).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_prefs (
      channel_id TEXT PRIMARY KEY,
      preferences_text TEXT NOT NULL,
      known_sender_shortcut INTEGER NOT NULL DEFAULT 1,
      triage_model TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_hits (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      directive_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      matched_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_replied_senders (
      channel_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display TEXT,
      first_replied_at INTEGER NOT NULL,
      last_replied_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(channel_id, email)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_turns (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_queue (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_wake_turns (
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);
  // Candidates awaiting the batched LLM triage pass (metadata only).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_triage_queue (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      category TEXT,
      prior_reply INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, thread_id, message_id)
    )
  `);
  // Cost-control bookkeeping for triage LLM runs.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_triage_runs (
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      candidates INTEGER NOT NULL,
      outcome TEXT NOT NULL
    )
  `);
  // Snoozed-thread reminders (durable user data; fire via the worker alarm).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_reminders (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      note TEXT,
      subject TEXT,
      from_addr TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_people (
      channel_id TEXT,
      email TEXT,
      display_name TEXT,
      sent_to_count INTEGER DEFAULT 0,
      received_from_count INTEGER DEFAULT 0,
      last_interaction_at INTEGER,
      you_replied INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, email)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_push_targets (
      email_address TEXT NOT NULL,
      source TEXT NOT NULL,
      class_name TEXT NOT NULL,
      object_key TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY(email_address, source, class_name, object_key)
    )
  `);
}

/**
 * Best-effort migration of old rule-engine state into natural-language
 * preference text. Called BEFORE dropGmailTables when upgrading.
 */
export function extractLegacyAttentionPrefs(
  sql: SqlStorage
): Array<{ channelId: string; preferencesText: string }> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = sql.exec(`SELECT channel_id, rules_json FROM gmail_attention_rules`).toArray();
  } catch {
    return [];
  }
  const prefs: Array<{ channelId: string; preferencesText: string }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row["rules_json"])) as {
        directives?: Array<{ name?: string; description?: string; enabled?: boolean }>;
      };
      const lines = (parsed.directives ?? [])
        .filter((directive) => directive.enabled !== false)
        .map((directive) => `- ${directive.description ?? directive.name ?? "watch rule"}`);
      if (lines.length > 0) {
        prefs.push({ channelId: String(row["channel_id"]), preferencesText: lines.join("\n") });
      }
    } catch {
      // Unparseable legacy rules: fall back to the default preference seed.
    }
  }
  return prefs;
}

/** Additive column migration for durable tables (no-op when present). */
export function ensureColumn(sql: SqlStorage, table: string, column: string, ddl: string): void {
  const existing = sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .some((row) => String(row["name"]) === column);
  if (!existing) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export const DEFAULT_ATTENTION_PREFERENCES =
  "Surface unread inbox mail from people I have replied to before. " +
  "Ignore promotions, social updates, and newsletters unless they look urgent or time-sensitive.";
