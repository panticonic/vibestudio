/**
 * Canonical browser-environment schema. Browser profiles are provider-local
 * discovery details and secrets are encrypted before they reach SQLite.
 */
export const BROWSER_DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_favicons (
  page_url TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  source_url TEXT,
  png16 BLOB,
  png32 BLOB,
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_favicons_origin ON page_favicons(origin);

CREATE TABLE IF NOT EXISTS site_preferences (
  origin TEXT PRIMARY KEY,
  zoom_factor REAL NOT NULL DEFAULT 1.0 CHECK (zoom_factor >= 0.25 AND zoom_factor <= 5.0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  folder_path TEXT NOT NULL DEFAULT '/',
  date_added INTEGER NOT NULL,
  date_modified INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  import_key TEXT UNIQUE,
  tags TEXT,
  keyword TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_path);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  typed_count INTEGER NOT NULL DEFAULT 0,
  first_visit INTEGER,
  last_visit INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_last_visit ON history(last_visit);

CREATE TABLE IF NOT EXISTS history_visits (
  id INTEGER PRIMARY KEY,
  history_id INTEGER NOT NULL REFERENCES history(id) ON DELETE CASCADE,
  visit_time INTEGER NOT NULL,
  transition TEXT DEFAULT 'link',
  source TEXT NOT NULL DEFAULT 'vibestudio',
  import_source_id TEXT NOT NULL DEFAULT '',
  panel_id TEXT NOT NULL DEFAULT '',
  title TEXT,
  typed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(history_id, visit_time, source, import_source_id, panel_id, transition)
);
CREATE INDEX IF NOT EXISTS idx_history_visits_history_id ON history_visits(history_id);
CREATE INDEX IF NOT EXISTS idx_history_visits_source ON history_visits(source, import_source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts
USING fts5(url, title, content=history, content_rowid=id);
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
  INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
  INSERT INTO history_fts(history_fts, rowid, url, title)
  VALUES('delete', old.id, old.url, old.title);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON history BEGIN
  INSERT INTO history_fts(history_fts, rowid, url, title)
  VALUES('delete', old.id, old.url, old.title);
  INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
END;

CREATE TABLE IF NOT EXISTS passwords (
  id INTEGER PRIMARY KEY,
  origin_url TEXT NOT NULL,
  username_hash BLOB NOT NULL,
  username_encrypted BLOB NOT NULL,
  password_encrypted BLOB NOT NULL,
  action_url TEXT NOT NULL DEFAULT '',
  realm TEXT NOT NULL DEFAULT '',
  date_created INTEGER,
  date_last_used INTEGER,
  date_password_changed INTEGER,
  times_used INTEGER DEFAULT 0,
  source_id TEXT,
  UNIQUE(origin_url, username_hash, action_url, realm)
);

CREATE TABLE IF NOT EXISTS password_never_save (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL UNIQUE,
  date_added INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cookie_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO cookie_state(singleton, revision) VALUES(1, 0);

CREATE TABLE IF NOT EXISTS cookies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  partition_key TEXT NOT NULL DEFAULT '',
  encrypted_value BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  host_only INTEGER NOT NULL DEFAULT 0,
  secure INTEGER NOT NULL DEFAULT 0,
  http_only INTEGER NOT NULL DEFAULT 0,
  same_site TEXT NOT NULL DEFAULT 'unspecified',
  expiration_date REAL,
  source_scheme TEXT,
  source_port INTEGER,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER,
  revision INTEGER NOT NULL,
  UNIQUE(name, domain, path, partition_key)
);
CREATE INDEX IF NOT EXISTS idx_cookies_domain ON cookies(domain);
CREATE INDEX IF NOT EXISTS idx_cookies_revision ON cookies(revision);

CREATE TABLE IF NOT EXISTS cookie_mutations (
  mutation_id TEXT PRIMARY KEY,
  applied_revision INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS form_fill_values (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  value_hash BLOB NOT NULL,
  value_encrypted BLOB NOT NULL,
  display_label TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  UNIQUE(type, value_hash)
);
CREATE INDEX IF NOT EXISTS idx_form_fill_values_type ON form_fill_values(type);

CREATE TABLE IF NOT EXISTS search_engines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  keyword TEXT,
  search_url TEXT NOT NULL,
  suggest_url TEXT,
  favicon_url TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  import_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS import_jobs (
  job_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  host_label TEXT NOT NULL,
  source_id TEXT NOT NULL,
  browser TEXT NOT NULL,
  phase TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  data_types TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  resumable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_updated ON import_jobs(updated_at);

CREATE TABLE IF NOT EXISTS import_batches (
  job_id TEXT NOT NULL REFERENCES import_jobs(job_id) ON DELETE CASCADE,
  data_type TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  item_count INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, data_type, batch_index)
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  environment_key TEXT NOT NULL,
  host_id TEXT NOT NULL,
  panel_id TEXT,
  origin TEXT,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  save_path TEXT NOT NULL,
  received_bytes INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_host_updated
  ON downloads(host_id, updated_at DESC);
`;
