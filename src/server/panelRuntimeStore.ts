import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCanonicalSqliteDatabase, type CanonicalSqliteSchema } from "@vibestudio/sqlite";

/**
 * Host-owned panel runtime facts for tendrils (docs/tendrils-plan.md 4.4, 4.5).
 *
 * Build proof: whether an exact panel build (its build key) has ever
 * started successfully. The server's attempt coordinator observes boots, so
 * the proof lives with the host, keyed by the immutable build rather than by a
 * history entry: the same build reused in another entry is equally proven.
 * Proven is final. A build that failed by its own code before ever starting is
 * "failed"; no row means unproven.
 *
 * Presentation requests: a durable request to show a panel slot on one paired
 * device. The device's client lists its pending requests whenever it connects;
 * taking the slot's runtime lease on that device clears the request.
 */
const PANEL_RUNTIME_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "build_proof",
      sql: `CREATE TABLE build_proof (
        build_key TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('proven', 'failed')),
        failure TEXT,
        recorded_at INTEGER NOT NULL
      )`,
    },
    {
      type: "table",
      name: "presentation_requests",
      sql: `CREATE TABLE presentation_requests (
        slot_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        focus INTEGER NOT NULL,
        alert TEXT NOT NULL CHECK (alert IN ('none', 'inbox', 'interrupt')),
        requested_at INTEGER NOT NULL,
        PRIMARY KEY (slot_id, device_id)
      )`,
    },
    {
      type: "index",
      name: "presentation_requests_by_device",
      sql: "CREATE INDEX presentation_requests_by_device ON presentation_requests(device_id)",
    },
  ],
};

export type BuildProofState = "unproven" | "proven" | "failed";
export type PresentationAlert = "none" | "inbox" | "interrupt";

export interface PresentationRequestRecord {
  slotId: string;
  deviceId: string;
  focus: boolean;
  alert: PresentationAlert;
  requestedAt: number;
}

export class PanelRuntimeStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(opts: { databasePath: string; now?: () => number }) {
    fs.mkdirSync(path.dirname(opts.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(opts.databasePath);
    this.now = opts.now ?? Date.now;
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      openCanonicalSqliteDatabase(this.db, PANEL_RUNTIME_SCHEMA, {
        description: `panel runtime schema in ${opts.databasePath}`,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  proofOf(buildKey: string): BuildProofState {
    const row = this.db
      .prepare("SELECT state FROM build_proof WHERE build_key = ?")
      .get(buildKey) as { state: "proven" | "failed" } | undefined;
    return row?.state ?? "unproven";
  }

  failureOf(buildKey: string): unknown {
    const row = this.db
      .prepare("SELECT failure FROM build_proof WHERE build_key = ? AND state = 'failed'")
      .get(buildKey) as { failure: string | null } | undefined;
    return row?.failure ? (JSON.parse(row.failure) as unknown) : null;
  }

  /**
   * Record a boot outcome. Returns the resulting state and whether it changed.
   * Proven is final; a failure only marks an unproven build (a proven build
   * failing later is a runtime fault, not evidence the update was broken); a
   * successful start proves a build that had failed before.
   */
  recordProof(
    buildKey: string,
    outcome: { state: "proven" } | { state: "failed"; failure: unknown }
  ): { state: BuildProofState; changed: boolean } {
    const current = this.proofOf(buildKey);
    if (current === "proven") return { state: "proven", changed: false };
    if (current === "failed" && outcome.state === "failed")
      return { state: "failed", changed: false };
    this.db
      .prepare(
        `INSERT INTO build_proof (build_key, state, failure, recorded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(build_key) DO UPDATE SET
           state = excluded.state, failure = excluded.failure, recorded_at = excluded.recorded_at`
      )
      .run(
        buildKey,
        outcome.state,
        outcome.state === "failed" ? JSON.stringify(outcome.failure ?? null) : null,
        this.now()
      );
    return { state: outcome.state, changed: true };
  }

  request(request: Omit<PresentationRequestRecord, "requestedAt">): PresentationRequestRecord {
    const requestedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO presentation_requests (slot_id, device_id, focus, alert, requested_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slot_id, device_id) DO UPDATE SET
           focus = excluded.focus, alert = excluded.alert, requested_at = excluded.requested_at`
      )
      .run(request.slotId, request.deviceId, request.focus ? 1 : 0, request.alert, requestedAt);
    return { ...request, requestedAt };
  }

  pending(deviceId?: string): PresentationRequestRecord[] {
    const rows = (
      deviceId === undefined
        ? this.db.prepare("SELECT * FROM presentation_requests ORDER BY requested_at").all()
        : this.db
            .prepare(
              "SELECT * FROM presentation_requests WHERE device_id = ? ORDER BY requested_at"
            )
            .all(deviceId)
    ) as Array<{
      slot_id: string;
      device_id: string;
      focus: number;
      alert: PresentationAlert;
      requested_at: number;
    }>;
    return rows.map((row) => ({
      slotId: row.slot_id,
      deviceId: row.device_id,
      focus: row.focus === 1,
      alert: row.alert,
      requestedAt: row.requested_at,
    }));
  }

  /** Clear one slot's request on one device. Returns whether one existed. */
  clear(slotId: string, deviceId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM presentation_requests WHERE slot_id = ? AND device_id = ?")
        .run(slotId, deviceId).changes > 0
    );
  }

  /** Clear every request for a slot (the slot closed). */
  clearSlot(slotId: string): number {
    return Number(
      this.db.prepare("DELETE FROM presentation_requests WHERE slot_id = ?").run(slotId).changes
    );
  }
}
