import type { CanonicalSqliteObject } from "@vibestudio/sqlite";

/** Derived lookup over the acquisition's one immutable target binding. */
export const AUTHORITY_TARGET_JOIN_INDEX: CanonicalSqliteObject = {
  type: "index",
  name: "aa_target_request",
  sql: `CREATE INDEX aa_target_request ON authority_acquisitions(
    json_extract(binding_json, '$.facts.targetRequestId'), created_at, acquisition_id
  ) WHERE json_extract(binding_json, '$.facts.kind') = 'target-join' AND state = 'pending'`,
};

/** Installed by the grant owner; these records never open a second database. */
export const AUTHORITY_ACQUISITION_OBJECTS: readonly CanonicalSqliteObject[] = [
  {
    type: "table",
    name: "authority_acquisition_owners",
    sql: `CREATE TABLE authority_acquisition_owners (
      owner_runtime_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      retired_at INTEGER,
      PRIMARY KEY (owner_runtime_id, session_id)
    )`,
  },
  {
    type: "table",
    name: "authority_acquisitions",
    sql: `CREATE TABLE authority_acquisitions (
      acquisition_id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL,
      owner_runtime_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      delivery_owner TEXT NOT NULL CHECK (delivery_owner IN ('in-band','owner-redrive')),
      state TEXT NOT NULL CHECK (state IN ('pending','decided','closed','failed')),
      decision_json TEXT,
      decision_digest TEXT,
      resolution_json TEXT,
      resolution_digest TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      acknowledged_at INTEGER,
      superseded_at INTEGER,
      FOREIGN KEY (owner_runtime_id, session_id)
        REFERENCES authority_acquisition_owners(owner_runtime_id, session_id),
      CHECK (
        (state = 'pending' AND decision_json IS NULL AND decision_digest IS NULL
          AND resolution_json IS NULL AND resolution_digest IS NULL AND settled_at IS NULL
          AND acknowledged_at IS NULL AND superseded_at IS NULL) OR
        (state <> 'pending' AND decision_json IS NOT NULL AND decision_digest IS NOT NULL
          AND resolution_json IS NOT NULL AND resolution_digest IS NOT NULL AND settled_at IS NOT NULL)
      )
    )`,
  },
  {
    type: "index",
    name: "aa_current_request",
    sql: "CREATE UNIQUE INDEX aa_current_request ON authority_acquisitions(request_key) WHERE superseded_at IS NULL",
  },
  {
    type: "index",
    name: "aa_owner_delivery",
    sql: "CREATE INDEX aa_owner_delivery ON authority_acquisitions(owner_runtime_id, session_id, created_at, acquisition_id) WHERE acknowledged_at IS NULL",
  },
  {
    type: "index",
    name: "aa_owner_redrive",
    sql: "CREATE INDEX aa_owner_redrive ON authority_acquisitions(owner_runtime_id, session_id, created_at, acquisition_id) WHERE acknowledged_at IS NULL AND delivery_owner = 'owner-redrive' AND state <> 'pending'",
  },
];
