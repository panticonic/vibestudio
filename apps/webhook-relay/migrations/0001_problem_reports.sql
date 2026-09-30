CREATE TABLE submissions (
 submission_id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt_secret_digest TEXT NOT NULL,
 receipt_id TEXT NOT NULL, machine_key_id TEXT NOT NULL, signing_public_key TEXT NOT NULL, signature TEXT NOT NULL, received_at TEXT NOT NULL,
 created_at TEXT NOT NULL, observed_at TEXT, failure_kind TEXT, operation TEXT, fingerprint_version INTEGER, build_version TEXT, template_version TEXT, installation_pseudonym TEXT, intent TEXT, component TEXT, product_version TEXT, code TEXT,
 fingerprint TEXT, declared_fingerprint TEXT, occurrence_count INTEGER,
 r2_key TEXT NOT NULL, bytes INTEGER NOT NULL, content_state TEXT NOT NULL DEFAULT 'available',
 pinned INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deletion_completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reports_machine ON submissions(signing_public_key,received_at);
CREATE INDEX reports_received ON submissions(received_at,submission_id);
CREATE INDEX reports_group ON submissions(fingerprint,received_at,submission_id);
CREATE INDEX reports_component ON submissions(component,received_at,submission_id);
CREATE INDEX reports_version ON submissions(product_version,received_at,submission_id);
CREATE TABLE triage_groups (fingerprint TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'new', severity TEXT NOT NULL DEFAULT 'unclassified',
 assigned_to TEXT, fixed_version TEXT, muted_until TEXT, updated_at TEXT NOT NULL);
CREATE TABLE group_reports (fingerprint TEXT NOT NULL, submission_id TEXT NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE, PRIMARY KEY(fingerprint,submission_id));
CREATE TABLE investigations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL, agent_panel_id TEXT, development_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE investigation_events (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 kind TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), report_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(report_ids_json) AND json_type(report_ids_json)='array'), created_at TEXT NOT NULL);
CREATE TABLE admin_audit (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, operation TEXT NOT NULL, query_digest TEXT, created_at TEXT NOT NULL);
CREATE VIEW report_groups AS SELECT fingerprint, component, product_version, code, count(*) AS reports,
 sum(occurrence_count) AS reported_occurrences, min(received_at) AS first_received, max(received_at) AS last_received
 FROM submissions WHERE content_state='available' GROUP BY fingerprint, component, product_version, code;

CREATE UNIQUE INDEX investigation_active_group ON investigations(fingerprint) WHERE status IN ('queued','investigating','blocked');
CREATE VIEW group_overview AS SELECT g.*,count(s.submission_id) AS reports,min(s.received_at) AS first_received,max(s.received_at) AS last_received FROM triage_groups g LEFT JOIN submissions s ON s.fingerprint=g.fingerprint AND s.content_state='available' GROUP BY g.fingerprint;
CREATE VIEW regression_candidates AS SELECT s.submission_id,s.fingerprint,s.product_version,g.fixed_version,s.received_at FROM submissions s JOIN triage_groups g ON g.fingerprint=s.fingerprint WHERE g.fixed_version IS NOT NULL AND s.content_state='available' AND s.received_at>g.updated_at AND (s.product_version IS NULL OR s.product_version!=g.fixed_version);

CREATE VIEW machine_overview AS SELECT signing_public_key,machine_key_id,count(*) AS reports,
 count(DISTINCT fingerprint) AS error_groups,count(DISTINCT product_version) AS product_versions,
 min(received_at) AS first_received,max(received_at) AS last_received
 FROM submissions WHERE content_state='available' GROUP BY signing_public_key,machine_key_id;
