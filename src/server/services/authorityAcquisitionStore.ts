import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { JsonValue } from "@vibestudio/shared/wireValues";
import { JsonValueSchema } from "@vibestudio/shared/wireValues";

export interface AcquisitionOwner {
  ownerRuntimeId: string;
  sessionId: string;
}

export type AcquisitionContinuation = "in-band" | "owner-redrive";

export interface AcquisitionDeliveryCursor extends AcquisitionOwner {
  createdAt: number;
  acquisitionId: string;
}

/** Host-sealed admission facts. Live signals and transport handles are not facts. */
export interface AuthorityAcquisitionAdmission extends AcquisitionOwner {
  requestKey: string;
  facts: JsonValue;
}

export interface AuthorityAcquisitionResolution {
  state: "decided" | "closed" | "failed";
  value: JsonValue;
}

export interface AuthorityAcquisitionRecord {
  acquisitionId: string;
  admission: AuthorityAcquisitionAdmission;
  bindingDigest: string;
  deliveryOwner: AcquisitionContinuation;
  createdAt: number;
  state: "pending" | AuthorityAcquisitionResolution["state"];
  decision?: JsonValue;
  resolution?: AuthorityAcquisitionResolution;
  resolutionDigest?: string;
  settledAt?: number;
  acknowledgedAt?: number;
  supersededAt?: number;
}

type Row = Record<string, SQLOutputValue>;
type Transaction = <T>(work: () => T) => T;

/** Acquisition and grant writes share the grant owner's connection and transaction. */
export class AuthorityAcquisitionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction
  ) {}

  admit(
    input: AuthorityAcquisitionAdmission,
    now = Date.now(),
    deliveryOwner: AcquisitionContinuation = "owner-redrive"
  ): AuthorityAcquisitionRecord {
    requireOwner(input);
    if (!input.requestKey.trim() || input.requestKey.includes("\0"))
      throw new Error("Acquisition requires a non-NUL request key");
    JsonValueSchema.parse(input.facts);
    const binding = canonicalJson(input);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO authority_acquisition_owners(owner_runtime_id, session_id)
        VALUES (?, ?) ON CONFLICT DO NOTHING`
        )
        .run(input.ownerRuntimeId, input.sessionId);
      this.requireActiveOwner(input);
      const existing = this.current(input.requestKey, input);
      if (existing) {
        if (canonicalJson(existing.admission) !== binding)
          throw new Error("Acquisition replay changed its immutable admission facts");
        return existing;
      }
      const acquisitionId = `acq:${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO authority_acquisitions
        (acquisition_id, request_key, owner_runtime_id, session_id, binding_json, binding_digest, delivery_owner, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          acquisitionId,
          input.requestKey,
          input.ownerRuntimeId,
          input.sessionId,
          JSON.stringify(input),
          digest("binding", { acquisitionId, createdAt: now, admission: input }),
          deliveryOwner,
          now
        );
      return this.require(acquisitionId, input);
    });
  }

  current(requestKey: string, owner: AcquisitionOwner): AuthorityAcquisitionRecord | null {
    const value = this.db
      .prepare(
        `SELECT * FROM authority_acquisitions
      WHERE request_key = ? AND superseded_at IS NULL`
      )
      .get(requestKey);
    return value ? this.owned(value, owner) : null;
  }

  get(acquisitionId: string, owner: AcquisitionOwner): AuthorityAcquisitionRecord | null {
    const value = this.db
      .prepare("SELECT * FROM authority_acquisitions WHERE acquisition_id = ?")
      .get(acquisitionId);
    return value ? this.owned(value, owner) : null;
  }

  /** Host startup/lifecycle traversal; never exposed as a caller-selected owner read. */
  scan(
    page: {
      pendingOnly?: boolean;
      after?: { createdAt: number; acquisitionId: string };
    } = {}
  ): AuthorityAcquisitionRecord[] {
    return this.db
      .prepare(
        `SELECT acquisitions.* FROM authority_acquisitions AS acquisitions
        JOIN authority_acquisition_owners AS owners USING (owner_runtime_id, session_id)
        WHERE owners.retired_at IS NULL
          AND (? = 0 OR acquisitions.state = 'pending')
          AND (? IS NULL OR acquisitions.created_at > ? OR
            (acquisitions.created_at = ? AND acquisitions.acquisition_id > ?))
        ORDER BY acquisitions.created_at, acquisitions.acquisition_id LIMIT 64`
      )
      .all(
        page.pendingOnly ? 1 : 0,
        page.after?.createdAt ?? null,
        page.after?.createdAt ?? null,
        page.after?.createdAt ?? null,
        page.after?.acquisitionId ?? null
      )
      .map((value) =>
        this.owned(value, {
          ownerRuntimeId: String(value["owner_runtime_id"]),
          sessionId: String(value["session_id"]),
        })
      );
  }

  /** A repeated decision reads its receipt; it cannot mint a second grant. */
  resolve(
    acquisitionId: string,
    owner: AcquisitionOwner,
    bindingDigest: string,
    decision: JsonValue,
    write: () => AuthorityAcquisitionResolution,
    now = Date.now()
  ): AuthorityAcquisitionRecord {
    return this.transaction(() => {
      this.requireActiveOwner(owner);
      const record = this.require(acquisitionId, owner);
      if (record.bindingDigest !== bindingDigest) throw new Error("Acquisition binding mismatch");
      const decisionJson = canonicalJson(decision);
      if (record.state !== "pending") {
        if (canonicalJson(record.decision) !== decisionJson)
          throw new Error("Acquisition already has a different decision");
        return record;
      }
      const resolution = write();
      requireResolution(resolution);
      this.storeResolution(record, decision, resolution, now);
      return this.require(acquisitionId, owner);
    });
  }

  /** An owning operation can close its exact pending ask without retiring sibling work. */
  withdraw(
    acquisitionId: string,
    owner: AcquisitionOwner,
    bindingDigest: string,
    now = Date.now()
  ): AuthorityAcquisitionRecord {
    return this.transaction(() => {
      const record = this.require(acquisitionId, owner);
      if (record.bindingDigest !== bindingDigest) throw new Error("Acquisition binding mismatch");
      if (record.state !== "pending") return record;
      this.requireActiveOwner(owner);
      this.storeResolution(
        record,
        { kind: "owner-withdrawal" },
        {
          state: "closed",
          value: { state: "closed", reason: "operation-ended" },
        },
        now
      );
      return this.require(acquisitionId, owner);
    });
  }

  acknowledge(
    acquisitionId: string,
    owner: AcquisitionOwner,
    resolutionDigest: string,
    now = Date.now()
  ): void {
    this.transaction(() => {
      const record = this.require(acquisitionId, owner);
      if (record.state === "pending" || record.resolutionDigest !== resolutionDigest)
        throw new Error("Acquisition acknowledgement does not match its terminal receipt");
      this.db
        .prepare(
          `UPDATE authority_acquisitions SET acknowledged_at = ?
        WHERE acquisition_id = ? AND acknowledged_at IS NULL`
        )
        .run(now, acquisitionId);
    });
  }

  /** Response handoff changes delivery ownership, never receipt acknowledgement. */
  setDeliveryOwner(
    acquisitionId: string,
    owner: AcquisitionOwner,
    deliveryOwner: AcquisitionContinuation
  ): void {
    this.transaction(() => {
      this.require(acquisitionId, owner);
      this.db
        .prepare("UPDATE authority_acquisitions SET delivery_owner = ? WHERE acquisition_id = ?")
        .run(deliveryOwner, acquisitionId);
    });
  }

  /** Begin a genuinely new ask, retaining the previous cycle for late readers. */
  supersede(requestKey: string, owner: AcquisitionOwner, now = Date.now()): boolean {
    return this.transaction(() => {
      this.requireActiveOwner(owner);
      const record = this.current(requestKey, owner);
      if (!record || record.state === "pending") return false;
      this.db
        .prepare("UPDATE authority_acquisitions SET superseded_at = ? WHERE acquisition_id = ?")
        .run(now, record.acquisitionId);
      return true;
    });
  }

  /** Canonical target decisions and linked acquisition receipts share the owner commit. */
  resolveTarget(
    requestId: string,
    decision: JsonValue,
    resolution: AuthorityAcquisitionResolution,
    now = Date.now()
  ): void {
    requireResolution(resolution);
    JsonValueSchema.parse(decision);
    this.transaction(() => {
      for (;;) {
        const records = this.db
          .prepare(
            `SELECT * FROM authority_acquisitions
          WHERE json_extract(binding_json, '$.facts.targetRequestId') = ?
            AND json_extract(binding_json, '$.facts.kind') = 'target-join' AND state = 'pending'
          ORDER BY created_at, acquisition_id LIMIT 64`
          )
          .all(requestId);
        if (records.length === 0) return;
        for (const row of records) {
          const record = this.owned(row, {
            ownerRuntimeId: String(row["owner_runtime_id"]),
            sessionId: String(row["session_id"]),
          });
          this.requireActiveOwner(record.admission);
          this.storeResolution(record, decision, resolution, now);
        }
      }
    });
  }

  /** Delivery remains due until exact acknowledgement or authoritative owner retirement. */
  outstanding(
    owner: AcquisitionOwner,
    page: { limit?: number; after?: { createdAt: number; acquisitionId: string } } = {}
  ): AuthorityAcquisitionRecord[] {
    requireOwner(owner);
    const limit = page.limit ?? 64;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new Error("Invalid acquisition page limit");
    if (page.after && (!Number.isSafeInteger(page.after.createdAt) || !page.after.acquisitionId))
      throw new Error("Invalid acquisition page cursor");
    return this.db
      .prepare(
        `SELECT acquisitions.* FROM authority_acquisitions AS acquisitions
      JOIN authority_acquisition_owners AS owners USING (owner_runtime_id, session_id)
      WHERE acquisitions.owner_runtime_id = ? AND acquisitions.session_id = ?
        AND acquisitions.acknowledged_at IS NULL AND owners.retired_at IS NULL
        AND (? IS NULL OR acquisitions.created_at > ? OR
          (acquisitions.created_at = ? AND acquisitions.acquisition_id > ?))
      ORDER BY acquisitions.created_at, acquisitions.acquisition_id LIMIT ?`
      )
      .all(
        owner.ownerRuntimeId,
        owner.sessionId,
        page.after?.createdAt ?? null,
        page.after?.createdAt ?? null,
        page.after?.createdAt ?? null,
        page.after?.acquisitionId ?? null,
        limit
      )
      .map((value) => this.owned(value, owner));
  }

  /** Host recovery visits only unacknowledged terminal debt, in the delivery index's order. */
  scanOutstandingTerminal(after?: AcquisitionDeliveryCursor): AuthorityAcquisitionRecord[] {
    if (after) {
      requireOwner(after);
      if (!Number.isSafeInteger(after.createdAt) || !after.acquisitionId.trim())
        throw new Error("Invalid acquisition delivery cursor");
    }
    return this.db
      .prepare(
        `SELECT acquisitions.* FROM authority_acquisitions AS acquisitions INDEXED BY aa_owner_redrive
      JOIN authority_acquisition_owners AS owners USING (owner_runtime_id, session_id)
      WHERE acquisitions.acknowledged_at IS NULL AND acquisitions.state <> 'pending'
        AND acquisitions.delivery_owner = 'owner-redrive'
        AND owners.retired_at IS NULL
        ${
          after
            ? "AND (acquisitions.owner_runtime_id, acquisitions.session_id, acquisitions.created_at, acquisitions.acquisition_id) > (?, ?, ?, ?)"
            : ""
        }
      ORDER BY acquisitions.owner_runtime_id, acquisitions.session_id, acquisitions.created_at, acquisitions.acquisition_id
      LIMIT 64`
      )
      .all(
        ...(after
          ? [after.ownerRuntimeId, after.sessionId, after.createdAt, after.acquisitionId]
          : [])
      )
      .map((value) =>
        this.owned(value, {
          ownerRuntimeId: String(value["owner_runtime_id"]),
          sessionId: String(value["session_id"]),
        })
      );
  }

  /** Retiring a finite owner closes pending asks and fences every subsequent admission. */
  retire(owner: AcquisitionOwner, now = Date.now()): void {
    requireOwner(owner);
    this.transaction(() => this.retireOwner(owner, now));
  }

  /** One terminal session boundary retires each owner once, without traversing receipt history. */
  retireSession(sessionId: string, now = Date.now()): void {
    if (!sessionId.trim() || sessionId.includes("\0"))
      throw new Error("Invalid acquisition session");
    this.transaction(() => {
      const owners = this.db
        .prepare(
          "SELECT owner_runtime_id FROM authority_acquisition_owners WHERE session_id = ? AND retired_at IS NULL"
        )
        .all(sessionId);
      for (const owner of owners)
        this.retireOwner({ ownerRuntimeId: String(owner["owner_runtime_id"]), sessionId }, now);
    });
  }

  /** Entity retirement visits its indexed owner sessions, rather than receipt history. */
  retireRuntime(ownerRuntimeId: string, now = Date.now()): void {
    if (!ownerRuntimeId.trim() || ownerRuntimeId.includes("\0"))
      throw new Error("Invalid acquisition owner runtime");
    this.transaction(() => {
      let after: string | null = null;
      for (;;) {
        const owners: Row[] = this.db
          .prepare(
            `SELECT session_id FROM authority_acquisition_owners
          WHERE owner_runtime_id = ? AND retired_at IS NULL AND (? IS NULL OR session_id > ?)
          ORDER BY session_id LIMIT 64`
          )
          .all(ownerRuntimeId, after, after);
        if (owners.length === 0) return;
        for (const owner of owners)
          this.retireOwner({ ownerRuntimeId, sessionId: String(owner["session_id"]) }, now);
        after = String(owners.at(-1)!["session_id"]);
      }
    });
  }

  private retireOwner(owner: AcquisitionOwner, now: number): void {
    this.db
      .prepare(
        `INSERT INTO authority_acquisition_owners(owner_runtime_id, session_id, retired_at)
        VALUES (?, ?, ?) ON CONFLICT(owner_runtime_id, session_id)
        DO UPDATE SET retired_at = COALESCE(retired_at, excluded.retired_at)`
      )
      .run(owner.ownerRuntimeId, owner.sessionId, now);
    for (;;) {
      const records = this.db
        .prepare(
          `SELECT * FROM authority_acquisitions
        WHERE owner_runtime_id = ? AND session_id = ? AND state = 'pending'
        ORDER BY created_at, acquisition_id LIMIT 64`
        )
        .all(owner.ownerRuntimeId, owner.sessionId)
        .map((value) => this.owned(value, owner));
      if (records.length === 0) return;
      for (const record of records)
        this.storeResolution(
          record,
          { kind: "owner-retired" },
          { state: "closed", value: { reason: "owner-retired" } },
          now
        );
    }
  }

  private storeResolution(
    record: AuthorityAcquisitionRecord,
    decision: JsonValue,
    resolution: AuthorityAcquisitionResolution,
    now: number
  ): void {
    const decisionDigest = digest("decision", {
      acquisitionId: record.acquisitionId,
      bindingDigest: record.bindingDigest,
      decision,
    });
    const resolutionDigest = digest("resolution", {
      acquisitionId: record.acquisitionId,
      bindingDigest: record.bindingDigest,
      decisionDigest,
      resolution,
    });
    this.db
      .prepare(
        `UPDATE authority_acquisitions SET state = ?, decision_json = ?, decision_digest = ?,
      resolution_json = ?, resolution_digest = ?, settled_at = ? WHERE acquisition_id = ? AND state = 'pending'`
      )
      .run(
        resolution.state,
        canonicalJson(decision),
        decisionDigest,
        canonicalJson(resolution),
        resolutionDigest,
        now,
        record.acquisitionId
      );
  }

  private requireActiveOwner(owner: AcquisitionOwner): void {
    requireOwner(owner);
    const value = this.db
      .prepare(
        `SELECT retired_at FROM authority_acquisition_owners
      WHERE owner_runtime_id = ? AND session_id = ?`
      )
      .get(owner.ownerRuntimeId, owner.sessionId);
    if (!value || value["retired_at"] !== null)
      throw new Error("Acquisition owner is absent or retired");
  }

  private require(acquisitionId: string, owner: AcquisitionOwner): AuthorityAcquisitionRecord {
    const value = this.get(acquisitionId, owner);
    if (!value) throw new Error("Unknown acquisition");
    return value;
  }

  private owned(value: Row, owner: AcquisitionOwner): AuthorityAcquisitionRecord {
    requireOwner(owner);
    if (
      value["owner_runtime_id"] !== owner.ownerRuntimeId ||
      value["session_id"] !== owner.sessionId
    )
      throw Object.assign(new Error("Acquisition is not owned by this task"), {
        code: "EACCES",
      });
    const admission = JSON.parse(String(value["binding_json"])) as AuthorityAcquisitionAdmission;
    const bindingDigest = String(value["binding_digest"]);
    if (
      digest("binding", {
        acquisitionId: String(value["acquisition_id"]),
        createdAt: Number(value["created_at"]),
        admission,
      }) !== bindingDigest ||
      admission.requestKey !== value["request_key"] ||
      admission.ownerRuntimeId !== owner.ownerRuntimeId ||
      admission.sessionId !== owner.sessionId
    )
      throw new Error("Acquisition admission failed content verification");
    const record: AuthorityAcquisitionRecord = {
      acquisitionId: String(value["acquisition_id"]),
      admission,
      bindingDigest,
      deliveryOwner: String(value["delivery_owner"]) as AcquisitionContinuation,
      createdAt: Number(value["created_at"]),
      state: String(value["state"]) as AuthorityAcquisitionRecord["state"],
    };
    if (record.state !== "pending") {
      const decision = JSON.parse(String(value["decision_json"])) as JsonValue;
      const resolution = JSON.parse(
        String(value["resolution_json"])
      ) as AuthorityAcquisitionResolution;
      requireResolution(resolution);
      const decisionDigest = digest("decision", {
        acquisitionId: record.acquisitionId,
        bindingDigest,
        decision,
      });
      const resolutionDigest = digest("resolution", {
        acquisitionId: record.acquisitionId,
        bindingDigest,
        decisionDigest,
        resolution,
      });
      if (
        decisionDigest !== value["decision_digest"] ||
        resolutionDigest !== value["resolution_digest"] ||
        resolution.state !== record.state
      )
        throw new Error("Acquisition receipt failed content verification");
      Object.assign(record, {
        decision,
        resolution,
        resolutionDigest,
        settledAt: Number(value["settled_at"]),
      });
    }
    if (value["acknowledged_at"] !== null) record.acknowledgedAt = Number(value["acknowledged_at"]);
    if (value["superseded_at"] !== null) record.supersededAt = Number(value["superseded_at"]);
    return record;
  }
}

function requireOwner(owner: AcquisitionOwner): void {
  if (
    !owner.ownerRuntimeId?.trim() ||
    !owner.sessionId?.trim() ||
    owner.ownerRuntimeId.includes("\0") ||
    owner.sessionId.includes("\0")
  )
    throw new Error("Acquisition requires an exact owner and execution session");
}

function requireResolution(value: AuthorityAcquisitionResolution): void {
  if (
    !value ||
    !["decided", "closed", "failed"].includes(value["state"]) ||
    value["value"] === undefined
  )
    throw new Error("Acquisition resolution must be a synchronous terminal record");
  JsonValueSchema.parse(value["value"]);
  canonicalJson(value);
}

function digest(kind: string, value: unknown): string {
  return createHash("sha256")
    .update(`authority-acquisition-${kind}-v1\0`)
    .update(canonicalJson(value))
    .digest("hex");
}
