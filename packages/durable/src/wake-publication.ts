import type { SchemaSqlStorage } from "./schema.js";

export interface WakeOwnerKey {
  source: string;
  className: string;
  objectKey: string;
}
export interface WakePublication {
  incarnation: string;
  revision: number;
  wakeAt: number | null;
}
/** Canonical host maintenance-journal identity; never restored with application storage. */
export interface StorageIncarnation {
  incarnation: string;
  generation: number;
}
interface RegisteredWake extends WakePublication {
  key: WakeOwnerKey;
  generation: number;
}
export interface WakeRequest {
  incarnation: string;
  generation: number;
}
interface RetainedWakeRequest extends WakeRequest {
  acknowledgedGeneration: number;
  claim?: { generation: number; dispatchGeneration: number };
}

/** Host scheduling metadata. Task state and eligibility remain at the source owner. */
export class WakePublicationStore {
  constructor(
    private readonly storage: {
      sql: SchemaSqlStorage;
      transactionSync<T>(callback: () => T): T;
    },
    private readonly assertActive: (key: WakeOwnerKey) => void
  ) {}

  /** Register the host's canonical incarnation before source admission. */
  register(key: WakeOwnerKey, identity: StorageIncarnation): string {
    this.assertActive(key);
    if (
      !identity.incarnation ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1
    )
      throw new Error("Invalid storage incarnation");
    return this.storage.transactionSync(() => {
      const current = this.read(key);
      if (current) {
        if (identity.generation < current.generation)
          throw new Error("Retired storage incarnation");
        if (identity.generation === current.generation) {
          if (identity.incarnation !== current.incarnation)
            throw new Error("Storage generation identity conflicts");
          return current.incarnation;
        }
      }
      this.write({ key, ...identity, revision: -1, wakeAt: null });
      this.forgetRequest(key);
      this.clearAlarm(key);
      return identity.incarnation;
    });
  }

  /** A clear retains its revision. Equal replays repair a lost derived row without releasing a live claim. */
  publish(key: WakeOwnerKey, publication: WakePublication): "accepted" | "duplicate" | "stale" {
    this.assertActive(key);
    if (
      !publication.incarnation ||
      !Number.isSafeInteger(publication.revision) ||
      publication.revision < 0 ||
      (publication.wakeAt !== null &&
        (!Number.isSafeInteger(publication.wakeAt) || publication.wakeAt < 0))
    ) {
      throw new Error("Invalid wake publication");
    }
    return this.storage.transactionSync(() => {
      const current = this.read(key);
      if (
        !current ||
        current.incarnation !== publication.incarnation ||
        publication.revision < current.revision
      )
        return "stale";
      const duplicate = publication.revision === current.revision;
      if (duplicate && publication.wakeAt !== current.wakeAt)
        throw new Error("Wake revision conflicts with its retained schedule");
      if (!duplicate) this.write({ key, ...publication, generation: current.generation });
      if (this.hasPendingRequest(key)) this.ensureRequestedAlarm(key);
      else if (publication.wakeAt === null) this.clearAlarm(key);
      else if (duplicate) {
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO do_alarms (source, class_name, object_key, wake_at, dispatch_generation, dispatch_owner)
           VALUES (?, ?, ?, ?, 0, NULL)`,
          key.source,
          key.className,
          key.objectKey,
          publication.wakeAt
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO do_alarms (source, class_name, object_key, wake_at, dispatch_generation, dispatch_owner)
           VALUES (?, ?, ?, ?, 0, NULL)
           ON CONFLICT(source, class_name, object_key) DO UPDATE SET wake_at = excluded.wake_at, dispatch_owner = NULL`,
          key.source,
          key.className,
          key.objectKey,
          publication.wakeAt
        );
      }
      return duplicate ? "duplicate" : "accepted";
    });
  }

  /** An authenticated host event asks this incarnation to reconcile its own state. */
  request(key: WakeOwnerKey, incarnation: string): "accepted" | "stale" {
    this.assertActive(key);
    return this.storage.transactionSync(() => {
      if (this.read(key)?.incarnation !== incarnation) return "stale";
      const current = this.readRequest(key);
      const generation = (current?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("Wake request generation exhausted");
      this.writeRequest(key, {
        ...current,
        incarnation,
        generation,
        acknowledgedGeneration: current?.acknowledgedGeneration ?? 0,
      });
      this.ensureRequestedAlarm(key);
      return "accepted";
    });
  }

  hasPendingRequest(key: WakeOwnerKey): boolean {
    const request = this.readRequest(key);
    return !!request && request.generation > request.acknowledgedGeneration;
  }

  /** Capture only events preceding this dispatch; later events require another pass. */
  claimRequest(key: WakeOwnerKey, dispatchGeneration: number): WakeRequest | undefined {
    const request = this.readRequest(key);
    if (!request || request.generation === request.acknowledgedGeneration) return undefined;
    this.writeRequest(key, {
      ...request,
      claim: { generation: request.generation, dispatchGeneration },
    });
    return { incarnation: request.incarnation, generation: request.generation };
  }

  /** Caller must first validate its exact durable alarm claim in the same transaction. */
  acknowledgeRequest(key: WakeOwnerKey, token: WakeRequest, dispatchGeneration: number): void {
    const request = this.readRequest(key);
    if (
      !request ||
      token.incarnation !== request.incarnation ||
      token.generation !== request.claim?.generation ||
      dispatchGeneration !== request.claim.dispatchGeneration
    )
      throw new Error("Wake request acknowledgement does not match its dispatch claim");
    this.writeRequest(key, {
      incarnation: request.incarnation,
      generation: request.generation,
      acknowledgedGeneration: token.generation,
    });
  }

  /** Derived scheduling preserves a live claim; only its owner may acknowledge it. */
  ensureRequestedAlarm(key: WakeOwnerKey): void {
    if (!this.hasPendingRequest(key)) return;
    this.storage.sql.exec(
      `INSERT INTO do_alarms (source, class_name, object_key, wake_at, dispatch_generation, dispatch_owner)
       VALUES (?, ?, ?, 0, 0, NULL)
       ON CONFLICT(source, class_name, object_key) DO UPDATE SET wake_at = 0`,
      key.source,
      key.className,
      key.objectKey
    );
  }

  /** Authoritative incarnation replacement or entity retirement, never elapsed time. */
  forgetRequest(key: WakeOwnerKey): void {
    this.storage.sql.exec("DELETE FROM state WHERE key = ?", this.requestAddress(key));
  }

  private requestAddress(key: WakeOwnerKey): string {
    return `alarm-wake-request:${JSON.stringify([key.source, key.className, key.objectKey])}`;
  }
  private readRequest(key: WakeOwnerKey): RetainedWakeRequest | undefined {
    const row = this.storage.sql
      .exec("SELECT value FROM state WHERE key = ?", this.requestAddress(key))
      .toArray()[0];
    return row ? (JSON.parse(String(row["value"])) as RetainedWakeRequest) : undefined;
  }
  private writeRequest(key: WakeOwnerKey, request: RetainedWakeRequest): void {
    this.storage.sql.exec(
      "INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      this.requestAddress(key),
      JSON.stringify(request)
    );
  }

  /** Recovery enumerates registered sources, including ones whose first publication was lost. */
  owners(): WakeOwnerKey[] {
    return this.storage.sql
      .exec(`SELECT value FROM state WHERE key LIKE 'alarm-source:%' ORDER BY key`)
      .toArray()
      .map((row) => (JSON.parse(String(row["value"])) as RegisteredWake).key);
  }

  /** Called on the host's claim transaction; survives clear/reinsert and storage-incarnation rotation. */
  nextClaimGeneration(key: WakeOwnerKey): number {
    const counterKey = `alarm-claim:${JSON.stringify([key.source, key.className, key.objectKey])}`;
    const counter = this.storage.sql
      .exec(`SELECT value FROM state WHERE key = ?`, counterKey)
      .toArray()[0];
    const row = this.storage.sql
      .exec(
        `SELECT dispatch_generation FROM do_alarms WHERE source = ? AND class_name = ? AND object_key = ?`,
        key.source,
        key.className,
        key.objectKey
      )
      .toArray()[0];
    const next =
      Math.max(Number(counter?.["value"] ?? 0), Number(row?.["dispatch_generation"] ?? 0)) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Alarm claim generation exhausted");
    this.storage.sql.exec(
      `INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      counterKey,
      String(next)
    );
    return next;
  }

  private read(key: WakeOwnerKey): RegisteredWake | undefined {
    const row = this.storage.sql
      .exec(`SELECT value FROM state WHERE key = ?`, this.address(key))
      .toArray()[0];
    return row ? (JSON.parse(String(row["value"])) as RegisteredWake) : undefined;
  }
  private write(value: RegisteredWake): void {
    this.storage.sql.exec(
      `INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      this.address(value.key),
      JSON.stringify(value)
    );
  }
  private address(key: WakeOwnerKey): string {
    return `alarm-source:${JSON.stringify([key.source, key.className, key.objectKey])}`;
  }
  private clearAlarm(key: WakeOwnerKey): void {
    this.storage.sql.exec(
      `DELETE FROM do_alarms WHERE source = ? AND class_name = ? AND object_key = ?`,
      key.source,
      key.className,
      key.objectKey
    );
    this.storage.sql.exec(
      `DELETE FROM do_alarm_test_policies WHERE source = ? AND class_name = ? AND object_key = ?`,
      key.source,
      key.className,
      key.objectKey
    );
  }
}
