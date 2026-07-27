import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type {
  AttachedHostChallengeRecord,
  AttachedHostDecision,
  AttachedHostApprovalAuditRecord,
  AttachedHostProtocolStore,
  AttachedHostSessionRecord,
} from "./attachedHostProtocol.js";

/**
 * Durable public session metadata and replay/approval state.
 *
 * This database intentionally has no columns for private keys, bearer tokens,
 * device credentials, admin credentials, environment paths, or raw routed
 * invocation envelopes.
 */
export class AttachedHostSessionStore implements AttachedHostProtocolStore {
  private static readonly MAX_CONSUMED_MESSAGES_PER_SESSION = 4_096;
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attached_host_sessions (
        session_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'closed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attached_host_consumed_messages (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id),
        FOREIGN KEY (session_id) REFERENCES attached_host_sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS attached_host_consumed_message_expiry
        ON attached_host_consumed_messages(session_id, expires_at);
      CREATE TABLE IF NOT EXISTS attached_host_challenges (
        session_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        challenge_json TEXT NOT NULL,
        shown_presentation_digest TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending', 'consumed', 'route-lost')),
        decision TEXT CHECK(decision IN ('once', 'deny')),
        challenged_at INTEGER,
        decided_at INTEGER,
        PRIMARY KEY (session_id, nonce),
        FOREIGN KEY (session_id) REFERENCES attached_host_sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS attached_host_challenge_state
        ON attached_host_challenges(session_id, state);
    `);
    this.ensureChallengeAuditColumns();
  }

  close(): void {
    this.db.close();
  }

  putSession(record: AttachedHostSessionRecord): void {
    assertPersistableSession(record);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attached_host_sessions(
           session_id, record_json, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           record_json = excluded.record_json,
           state = excluded.state,
           updated_at = excluded.updated_at`
      )
      .run(
        record.transcript.sessionId,
        canonicalJson(record),
        record.state,
        record.transcript.issuedAt,
        now
      );
  }

  getSession(sessionId: string): AttachedHostSessionRecord | null {
    const row = this.db
      .prepare("SELECT record_json FROM attached_host_sessions WHERE session_id = ?")
      .get(sessionId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as AttachedHostSessionRecord) : null;
  }

  closeSession(sessionId: string, reason: string, at: number): void {
    const existing = this.getSession(sessionId);
    if (!existing) return;
    const record: AttachedHostSessionRecord = {
      ...existing,
      state: "closed",
      closedReason: reason,
      closedAt: at,
    };
    this.db
      .prepare(
        `UPDATE attached_host_sessions
         SET record_json = ?, state = 'closed', updated_at = ?
         WHERE session_id = ?`
      )
      .run(canonicalJson(record), at, sessionId);
  }

  consumeMessage(sessionId: string, messageId: string, expiresAt: number, at: number): boolean {
    return this.immediate(() => {
      const row = this.db
        .prepare("SELECT state FROM attached_host_sessions WHERE session_id = ?")
        .get(sessionId) as { state: string } | undefined;
      if (!row || row.state !== "active") return false;
      this.db
        .prepare(
          "DELETE FROM attached_host_consumed_messages WHERE session_id = ? AND expires_at <= ?"
        )
        .run(sessionId, at);
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO attached_host_consumed_messages(
             session_id, message_id, expires_at, consumed_at
           ) VALUES (?, ?, ?, ?)`
        )
        .run(sessionId, messageId, expiresAt, at);
      if (Number(inserted.changes) !== 1) return false;
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM attached_host_consumed_messages WHERE session_id = ?"
        )
        .get(sessionId) as { count: number };
      const excess =
        Number(count.count) - AttachedHostSessionStore.MAX_CONSUMED_MESSAGES_PER_SESSION;
      if (excess > 0) {
        this.db
          .prepare(
            `DELETE FROM attached_host_consumed_messages
             WHERE rowid IN (
               SELECT rowid FROM attached_host_consumed_messages
               WHERE session_id = ?
               ORDER BY expires_at ASC, consumed_at ASC, message_id ASC
               LIMIT ?
             )`
          )
          .run(sessionId, excess);
      }
      this.db
        .prepare("UPDATE attached_host_sessions SET updated_at = ? WHERE session_id = ?")
        .run(at, sessionId);
      return true;
    });
  }

  putChallenge(record: AttachedHostChallengeRecord): void {
    const session = this.getSession(record.challenge.sessionId);
    if (!session || session.state !== "active") {
      throw storeError("EATTACHED_SESSION", "Cannot persist a challenge for an inactive session");
    }
    this.db
      .prepare(
        `INSERT INTO attached_host_challenges(
           session_id, nonce, challenge_json, shown_presentation_digest, state, decision,
           challenged_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, nonce) DO UPDATE SET
           challenge_json = CASE
             WHEN attached_host_challenges.state = 'pending'
               AND attached_host_challenges.decision IS NULL THEN excluded.challenge_json
             ELSE attached_host_challenges.challenge_json
           END,
           shown_presentation_digest = CASE
             WHEN attached_host_challenges.state = 'pending'
               AND attached_host_challenges.decision IS NULL
               THEN COALESCE(excluded.shown_presentation_digest,
                             attached_host_challenges.shown_presentation_digest)
             ELSE attached_host_challenges.shown_presentation_digest
           END,
           challenged_at = CASE
             WHEN attached_host_challenges.state = 'pending'
               AND attached_host_challenges.decision IS NULL THEN excluded.challenged_at
             ELSE attached_host_challenges.challenged_at
           END`
      )
      .run(
        record.challenge.sessionId,
        record.challenge.nonce,
        canonicalJson(record.challenge),
        record.shownPresentationDigest,
        record.state,
        record.decision,
        record.challengedAt,
        record.decidedAt
      );
  }

  getChallenge(sessionId: string, nonce: string): AttachedHostChallengeRecord | null {
    const row = this.db
      .prepare(
        `SELECT challenge_json, shown_presentation_digest, state, decision, challenged_at, decided_at
         FROM attached_host_challenges
         WHERE session_id = ? AND nonce = ?`
      )
      .get(sessionId, nonce) as
      | {
          challenge_json: string;
          shown_presentation_digest: string | null;
          state: AttachedHostChallengeRecord["state"];
          decision: AttachedHostDecision | null;
          challenged_at: number;
          decided_at: number | null;
        }
      | undefined;
    return row
      ? {
          challenge: JSON.parse(row.challenge_json) as AttachedHostChallengeRecord["challenge"],
          shownPresentationDigest: row.shown_presentation_digest,
          state: row.state,
          decision: row.decision,
          challengedAt: row.challenged_at,
          decidedAt: row.decided_at,
        }
      : null;
  }

  markChallengeShown(sessionId: string, nonce: string, presentationDigest: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE attached_host_challenges
         SET shown_presentation_digest = ?
         WHERE session_id = ? AND nonce = ? AND state = 'pending'
           AND (shown_presentation_digest IS NULL OR shown_presentation_digest = ?)`
      )
      .run(presentationDigest, sessionId, nonce, presentationDigest);
    return Number(result.changes) === 1;
  }

  consumeChallenge(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision
  ): boolean {
    return this.immediate(() => {
      const row = this.db
        .prepare(
          `SELECT challenge_json, state
           FROM attached_host_challenges
           WHERE session_id = ? AND nonce = ?`
        )
        .get(sessionId, nonce) as { challenge_json: string; state: string } | undefined;
      if (!row || row.state !== "pending") return false;
      const challenge = JSON.parse(row.challenge_json) as AttachedHostChallengeRecord["challenge"];
      if (challenge.invocationSnapshotDigest !== snapshotDigest) return false;
      const result = this.db
        .prepare(
          `UPDATE attached_host_challenges
           SET state = 'consumed', decision = ?
           WHERE session_id = ? AND nonce = ? AND state = 'pending'`
        )
        .run(decision, sessionId, nonce);
      return Number(result.changes) === 1;
    });
  }

  recordChallengeDecision(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision,
    decidedAt: number
  ): boolean {
    return this.immediate(() => {
      const result = this.db
        .prepare(
          `UPDATE attached_host_challenges
           SET decision = ?, decided_at = ?
           WHERE session_id = ? AND nonce = ? AND state = 'pending'
             AND decision IS NULL
             AND json_extract(challenge_json, '$.invocationSnapshotDigest') = ?`
        )
        .run(decision, decidedAt, sessionId, nonce, snapshotDigest);
      return Number(result.changes) === 1;
    });
  }

  listApprovalAudit(input: {
    sessionId: string;
    after: string | null;
    limit: number;
  }): AttachedHostApprovalAuditRecord[] {
    const after = parseAuditCursor(input.after);
    const limit = checkedLimit(input.limit);
    const rows = this.db
      .prepare(
        `SELECT rowid AS audit_sequence, challenge_json, shown_presentation_digest,
                decision, challenged_at, decided_at
         FROM attached_host_challenges
         WHERE session_id = ? AND rowid > ?
           AND decision IS NOT NULL
           AND shown_presentation_digest IS NOT NULL
           AND challenged_at IS NOT NULL
           AND decided_at IS NOT NULL
         ORDER BY rowid ASC
         LIMIT ?`
      )
      .all(input.sessionId, after, limit) as Array<{
      audit_sequence: number;
      challenge_json: string;
      shown_presentation_digest: string;
      decision: AttachedHostDecision;
      challenged_at: number;
      decided_at: number;
    }>;
    return rows.map((row) => ({
      cursor: String(row.audit_sequence),
      challenge: JSON.parse(row.challenge_json) as AttachedHostChallengeRecord["challenge"],
      shownPresentationDigest: row.shown_presentation_digest,
      decision: row.decision,
      challengedAt: row.challenged_at,
      decidedAt: row.decided_at,
    }));
  }

  closePendingChallenges(sessionId: string): number {
    const result = this.db
      .prepare(
        `UPDATE attached_host_challenges
         SET state = 'route-lost', decision = NULL
         WHERE session_id = ? AND state = 'pending' AND decision IS NULL`
      )
      .run(sessionId);
    return Number(result.changes);
  }

  private immediate<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureChallengeAuditColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(attached_host_challenges)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("challenged_at")) {
      this.db.exec("ALTER TABLE attached_host_challenges ADD COLUMN challenged_at INTEGER");
    }
    if (!names.has("decided_at")) {
      this.db.exec("ALTER TABLE attached_host_challenges ADD COLUMN decided_at INTEGER");
    }
  }
}

/** Small deterministic store for protocol unit tests and in-process peers. */
export class MemoryAttachedHostProtocolStore implements AttachedHostProtocolStore {
  private readonly sessions = new Map<
    string,
    { record: AttachedHostSessionRecord; consumedMessages: Map<string, number> }
  >();
  private readonly challenges = new Map<string, AttachedHostChallengeRecord>();
  private readonly challengeSequences = new Map<string, number>();
  private nextChallengeSequence = 1;

  putSession(record: AttachedHostSessionRecord): void {
    assertPersistableSession(record);
    const existing = this.sessions.get(record.transcript.sessionId);
    this.sessions.set(record.transcript.sessionId, {
      record: structuredClone(record),
      consumedMessages: existing?.consumedMessages ?? new Map(),
    });
  }

  getSession(sessionId: string): AttachedHostSessionRecord | null {
    const record = this.sessions.get(sessionId)?.record;
    return record ? structuredClone(record) : null;
  }

  closeSession(sessionId: string, reason: string, at: number): void {
    const stored = this.sessions.get(sessionId);
    if (!stored) return;
    stored.record = {
      ...stored.record,
      state: "closed",
      closedReason: reason,
      closedAt: at,
    };
  }

  consumeMessage(sessionId: string, messageId: string, expiresAt: number, at: number): boolean {
    const stored = this.sessions.get(sessionId);
    if (!stored || stored.record.state !== "active") return false;
    for (const [id, expiry] of stored.consumedMessages) {
      if (expiry <= at) stored.consumedMessages.delete(id);
    }
    if (stored.consumedMessages.has(messageId)) return false;
    stored.consumedMessages.set(messageId, expiresAt);
    while (stored.consumedMessages.size > 4_096) {
      const oldest = stored.consumedMessages.keys().next().value as string | undefined;
      if (!oldest) break;
      stored.consumedMessages.delete(oldest);
    }
    return true;
  }

  putChallenge(record: AttachedHostChallengeRecord): void {
    const key = challengeKey(record.challenge.sessionId, record.challenge.nonce);
    const existing = this.challenges.get(key);
    if (existing && (existing.state !== "pending" || existing.decision !== null)) return;
    if (!this.challengeSequences.has(key)) {
      this.challengeSequences.set(key, this.nextChallengeSequence++);
    }
    this.challenges.set(
      key,
      structuredClone({
        ...record,
        shownPresentationDigest:
          record.shownPresentationDigest ?? existing?.shownPresentationDigest ?? null,
        challengedAt: existing?.challengedAt ?? record.challengedAt,
        decidedAt: existing?.decidedAt ?? record.decidedAt,
      })
    );
  }

  getChallenge(sessionId: string, nonce: string): AttachedHostChallengeRecord | null {
    const record = this.challenges.get(challengeKey(sessionId, nonce));
    return record ? structuredClone(record) : null;
  }

  markChallengeShown(sessionId: string, nonce: string, presentationDigest: string): boolean {
    const record = this.challenges.get(challengeKey(sessionId, nonce));
    if (
      !record ||
      record.state !== "pending" ||
      (record.shownPresentationDigest !== null &&
        record.shownPresentationDigest !== presentationDigest)
    ) {
      return false;
    }
    record.shownPresentationDigest = presentationDigest;
    return true;
  }

  consumeChallenge(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision
  ): boolean {
    const record = this.challenges.get(challengeKey(sessionId, nonce));
    if (
      !record ||
      record.state !== "pending" ||
      record.challenge.invocationSnapshotDigest !== snapshotDigest
    ) {
      return false;
    }
    record.state = "consumed";
    record.decision = decision;
    return true;
  }

  recordChallengeDecision(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision,
    decidedAt: number
  ): boolean {
    const record = this.challenges.get(challengeKey(sessionId, nonce));
    if (
      !record ||
      record.state !== "pending" ||
      record.decision !== null ||
      record.challenge.invocationSnapshotDigest !== snapshotDigest
    ) {
      return false;
    }
    record.decision = decision;
    record.decidedAt = decidedAt;
    return true;
  }

  listApprovalAudit(input: {
    sessionId: string;
    after: string | null;
    limit: number;
  }): AttachedHostApprovalAuditRecord[] {
    const after = BigInt(parseAuditCursor(input.after));
    const limit = checkedLimit(input.limit);
    return [...this.challenges.values()]
      .filter(
        (record) =>
          record.challenge.sessionId === input.sessionId &&
          record.decision !== null &&
          record.shownPresentationDigest !== null &&
          record.decidedAt !== null
      )
      .map((record) => ({
        record,
        cursor: String(
          this.challengeSequences.get(
            challengeKey(record.challenge.sessionId, record.challenge.nonce)
          )!
        ),
      }))
      .filter(({ cursor }) => BigInt(cursor) > after)
      .sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1))
      .slice(0, limit)
      .map(({ record, cursor }) => ({
        cursor,
        challenge: structuredClone(record.challenge),
        shownPresentationDigest: record.shownPresentationDigest!,
        decision: record.decision!,
        challengedAt: record.challengedAt,
        decidedAt: record.decidedAt!,
      }));
  }

  closePendingChallenges(sessionId: string): number {
    let closed = 0;
    for (const record of this.challenges.values()) {
      if (
        record.challenge.sessionId === sessionId &&
        record.state === "pending" &&
        record.decision === null
      ) {
        record.state = "route-lost";
        record.decision = null;
        closed += 1;
      }
    }
    return closed;
  }
}

function assertPersistableSession(record: AttachedHostSessionRecord): void {
  const serialized = canonicalJson(record);
  if (
    /(?:privateKey|adminToken|refreshToken|deviceSecret|encryptionKey|databasePath)/iu.test(
      serialized
    )
  ) {
    throw storeError(
      "EATTACHED_SECRET",
      "Attached-host durable session record contains prohibited credential material"
    );
  }
}

function challengeKey(sessionId: string, nonce: string): string {
  return `${sessionId}\0${nonce}`;
}

function parseAuditCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^[1-9][0-9]*$/u.test(cursor)) {
    throw storeError("EATTACHED_CURSOR", "Attached-host audit cursor is malformed");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed)) {
    throw storeError("EATTACHED_CURSOR", "Attached-host audit cursor is out of range");
  }
  return parsed;
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
    throw storeError("EATTACHED_CURSOR", "Attached-host audit page size is invalid");
  }
  return limit;
}

function storeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
