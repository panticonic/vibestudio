import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  canonicalEntityId,
  IdentityCollisionError,
  type EntityRecord,
} from "@vibestudio/shared/runtime/entitySpec";
import type { DORef } from "@vibestudio/shared/doDispatcher";

interface ReceiptRow {
  identity: string;
  phase: "cloning" | "complete";
}

/**
 * The host's record of one storage clone: which reservation owns the target
 * object and whether the runtime finished copying into it. The copy itself is
 * the runtime's object fork, which publishes the target atomically; this
 * receipt is what lets the receiver's admission stay closed until the fork
 * returned, and lets a retry after a host crash recognize its own work.
 */
export class DurableObjectCloneReceipts {
  constructor(private readonly db: DatabaseSync) {
    // The workerd runtime staged file copies under three phases; its receipts
    // describe files that no longer exist and are not reinterpreted.
    const legacy = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'do_storage_clones'`)
      .get() as { sql?: string } | undefined;
    if (legacy?.sql?.includes("'staged'")) db.exec("DROP TABLE do_storage_clones");
    db.exec(`CREATE TABLE IF NOT EXISTS do_storage_clones (
      target_id TEXT PRIMARY KEY, identity TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('cloning', 'complete'))
    )`);
  }

  /** Validate that `reservation` is the exact reserved owner of a copy of `source`. */
  static expectedTargetId(source: DORef, reservation: EntityRecord): string {
    const expected = canonicalEntityId({
      kind: "do",
      source: source.source,
      className: source.className,
      key: reservation.key,
    });
    if (
      reservation.id !== expected ||
      reservation.kind !== "do" ||
      reservation.status !== "preparing" ||
      !reservation.authoritySessionId ||
      !reservation.cloneProvenance ||
      reservation.cloneProvenance.storage !== "snapshot" ||
      reservation.source.repoPath !== source.source ||
      reservation.className !== source.className ||
      reservation.cloneProvenance.sourceEntityId !==
        canonicalEntityId({
          kind: "do",
          source: source.source,
          className: source.className,
          key: source.objectKey,
        }) ||
      reservation.key === source.objectKey
    ) {
      throw new Error(`Storage clone has no exact reserved owner for ${expected}`);
    }
    return expected;
  }

  /**
   * Claim the clone for this reservation. Returns "complete" when an earlier
   * attempt already finished, "retry" when one began and did not record its
   * end (its fork may or may not have completed), "new" otherwise.
   */
  begin(source: DORef, reservation: EntityRecord): "new" | "retry" | "complete" {
    const targetId = DurableObjectCloneReceipts.expectedTargetId(source, reservation);
    const identity = canonicalJson({
      source,
      targetId,
      authoritySessionId: reservation.authoritySessionId,
      contextId: reservation.contextId,
      cloneProvenance: reservation.cloneProvenance,
    });
    const row = this.read(targetId);
    if (row && row.identity !== identity) {
      throw new IdentityCollisionError(targetId, {
        field: "storageCloneOwner",
        existing: JSON.parse(row.identity),
        attempted: JSON.parse(identity),
      });
    }
    if (row?.phase === "complete") return "complete";
    if (row) return "retry";
    this.db
      .prepare(`INSERT INTO do_storage_clones (target_id, identity, phase) VALUES (?, ?, 'cloning')`)
      .run(targetId, identity);
    return "new";
  }

  complete(targetId: string): void {
    this.db
      .prepare(`UPDATE do_storage_clones SET phase = 'complete' WHERE target_id = ?`)
      .run(targetId);
  }

  /** Throws unless the reservation's storage is fresh or its clone completed. */
  requireComplete(reservation: EntityRecord): void {
    if (reservation.cloneProvenance?.storage === "fresh") return;
    const row = this.read(reservation.id);
    const identity = row
      ? (JSON.parse(row.identity) as {
          authoritySessionId: string;
          contextId: string;
          cloneProvenance: EntityRecord["cloneProvenance"];
        })
      : null;
    if (
      !row ||
      row.phase !== "complete" ||
      !identity ||
      identity.authoritySessionId !== reservation.authoritySessionId ||
      identity.contextId !== reservation.contextId ||
      canonicalJson(identity.cloneProvenance) !== canonicalJson(reservation.cloneProvenance)
    ) {
      throw new Error(
        `Storage copy completion does not match reserved incarnation ${reservation.id} (${reservation.authoritySessionId})`
      );
    }
  }

  /** Retirement of the target forgets its receipt. */
  retire(targetId: string): void {
    this.db.prepare(`DELETE FROM do_storage_clones WHERE target_id = ?`).run(targetId);
  }

  private read(id: string): ReceiptRow | null {
    return (
      (this.db
        .prepare(`SELECT identity, phase FROM do_storage_clones WHERE target_id = ?`)
        .get(id) as unknown as ReceiptRow | null) ?? null
    );
  }
}
