import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type { ContextIntegrityFact } from "@vibestudio/rpc";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  ContextIntegrityLatch,
  isContentAddressedLineageKey,
  parseLineageKey,
  type ContentClass,
  type ContextIntegrityLatchState,
} from "@vibestudio/shared/authority/contextIntegrity";
import { stateLayout } from "../stateLayout.js";
import { CONTEXT_INTEGRITY_MIGRATION_PLAN } from "./contextIntegritySchema.js";

export interface ContextIngestionInput {
  key: string;
  via: string;
  classification: "external" | "derived";
  derivedClass?: "internal" | "external";
}

export type ContextIngestionRecorder = (
  ctx: ServiceContext,
  input: ContextIngestionInput
) => void | Promise<void>;

/** Durable server-side half of the session latch plus exact content trust. */
export class ContextIntegrityStore {
  private readonly db: DatabaseSync;

  constructor(opts: { statePath: string }) {
    const databasePath = stateLayout(opts.statePath).governance.contentTrustDb;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      openCanonicalSqliteDatabase(this.db, CONTEXT_INTEGRITY_MIGRATION_PLAN, {
        description: `content trust store in ${databasePath}`,
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

  ingest(input: {
    sessionId: string;
    key: string;
    class: ContentClass;
    via: string;
    at?: Date;
  }): ContextIntegrityFact {
    if (!input.sessionId.trim()) throw new Error("Context ingestion requires a session id");
    const current = this.state(input.sessionId);
    const latch = new ContextIntegrityLatch(current ?? undefined);
    const next = latch.ingest(input);
    this.transaction(() =>
      this.writeState(input.sessionId, next, input.at?.getTime() ?? Date.now())
    );
    return latch.fact();
  }

  fact(sessionId: string): ContextIntegrityFact {
    const state = this.state(sessionId);
    return state
      ? new ContextIntegrityLatch(state).fact()
      : { class: "internal", latchEpoch: 0, externalKeys: [] };
  }

  factIfKnown(sessionId: string): ContextIntegrityFact | null {
    const state = this.state(sessionId);
    return state ? new ContextIntegrityLatch(state).fact() : null;
  }

  effectiveFact(input: {
    sessionId: string;
    attested?: ContextIntegrityFact | null;
    conduitBlessed: boolean;
  }): ContextIntegrityFact {
    const server = this.fact(input.sessionId);
    const attested = input.conduitBlessed
      ? input.attested
      : {
          class: "external" as const,
          latchEpoch: input.attested?.latchEpoch ?? 0,
          externalKeys: [`session:${input.sessionId}`],
        };
    if (!attested || attested.class === "not-applicable") return server;
    const externalKeys = [...new Set([...server.externalKeys, ...attested.externalKeys])];
    return {
      class:
        server.class === "external" || attested.class === "external" || externalKeys.length > 0
          ? "external"
          : "internal",
      latchEpoch: Math.max(server.latchEpoch, attested.latchEpoch),
      externalKeys,
    };
  }

  ingestResolved(input: {
    sessionId: string;
    key: string;
    via: string;
    derivedClass?: ContentClass | "unknown";
    at?: Date;
  }): ContextIntegrityFact {
    const key = parseLineageKey(input.key);
    const contentClass = this.isTrusted(key)
      ? "internal"
      : input.derivedClass === "internal"
        ? "internal"
        : "external";
    return this.ingest({ ...input, key, class: contentClass });
  }

  ensureCutover(stateRoot: string, now = Date.now()): void {
    if (!/^state:[0-9a-f]{64}$/u.test(stateRoot)) {
      throw new Error("Context-integrity cutover requires a canonical semantic state root");
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO content_trust_meta(key,value,recorded_at) VALUES ('grandfather-root',?,?)"
      )
      .run(stateRoot, now);
  }

  isCutoverComplete(): boolean {
    const root = this.cutoverRoot();
    return root !== null && /^state:[0-9a-f]{64}$/u.test(root);
  }

  cutoverRoot(): string | null {
    const row = this.db
      .prepare("SELECT value FROM content_trust_meta WHERE key='grandfather-root'")
      .get() as Row | undefined;
    return row ? String(row["value"]) : null;
  }

  vouch(input: { key: string; decidedBy: string; viaPrompt?: string; now?: Date }): string {
    const key = parseLineageKey(input.key);
    if (!isContentAddressedLineageKey(key))
      throw coded(`Lineage ${key} is not content-addressed`, "EACCES");
    if (!input.decidedBy.trim()) throw new Error("A human decision is required to vouch content");
    const id = `vch_${randomBytes(18).toString("base64url")}`;
    this.db
      .prepare(
        `INSERT INTO vouches
      (id,subject_kind,subject_key,decided_by,decided_at,via_prompt,revoked_at) VALUES (?,?,?,?,?,?,NULL)`
      )
      .run(
        id,
        key.slice(0, key.indexOf(":")),
        key,
        input.decidedBy,
        (input.now ?? new Date()).toISOString(),
        input.viaPrompt ?? null
      );
    return id;
  }

  addTrustPolicy(input: {
    patternKind: "pkg-name" | "repo-remote";
    patternKey: string;
    decidedBy: string;
    ceremony: Record<string, unknown>;
    now?: Date;
  }): string {
    if (
      !input.patternKey.trim() ||
      !input.decidedBy.trim() ||
      Object.keys(input.ceremony).length === 0
    ) {
      throw new Error("Trust policy requires a bounded pattern and confirmation ceremony");
    }
    const prefix = input.patternKind === "pkg-name" ? "pkg:" : "repo:";
    if (
      !input.patternKey.startsWith(prefix) ||
      input.patternKey.includes("@") ||
      input.patternKey.includes("#")
    ) {
      throw new Error(`Trust policy pattern is not canonical: ${input.patternKey}`);
    }
    const id = `tpol_${randomBytes(18).toString("base64url")}`;
    this.db
      .prepare(
        `INSERT INTO trust_policies
      (id,pattern_kind,pattern_key,decided_by,decided_at,ceremony,revoked_at) VALUES (?,?,?,?,?,?,NULL)`
      )
      .run(
        id,
        input.patternKind,
        input.patternKey,
        input.decidedBy,
        (input.now ?? new Date()).toISOString(),
        JSON.stringify(input.ceremony)
      );
    return id;
  }

  isTrusted(keyValue: string): boolean {
    const key = parseLineageKey(keyValue);
    const exact = this.db
      .prepare("SELECT 1 FROM vouches WHERE subject_key=? AND revoked_at IS NULL")
      .get(key);
    if (exact) return true;
    const rows = this.db
      .prepare("SELECT pattern_kind,pattern_key FROM trust_policies WHERE revoked_at IS NULL")
      .all() as Row[];
    return rows.some((row) =>
      policyMatches(String(row["pattern_kind"]), String(row["pattern_key"]), key)
    );
  }

  revoke(id: string, now = new Date()): boolean {
    const stamp = now.toISOString();
    const vouch = this.db
      .prepare("UPDATE vouches SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(stamp, id);
    const policy = this.db
      .prepare("UPDATE trust_policies SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(stamp, id);
    return Number(vouch.changes) + Number(policy.changes) === 1;
  }

  listTrust(): Array<{
    id: string;
    kind: "vouch" | "policy";
    subject: string;
    decidedBy: string;
    decidedAt: string;
    revokedAt: string | null;
  }> {
    const vouches = this.db
      .prepare("SELECT id,subject_key,decided_by,decided_at,revoked_at FROM vouches")
      .all() as Row[];
    const policies = this.db
      .prepare("SELECT id,pattern_key,decided_by,decided_at,revoked_at FROM trust_policies")
      .all() as Row[];
    return [
      ...vouches.map((row) => ({
        id: String(row["id"]),
        kind: "vouch" as const,
        subject: String(row["subject_key"]),
        decidedBy: String(row["decided_by"]),
        decidedAt: String(row["decided_at"]),
        revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
      })),
      ...policies.map((row) => ({
        id: String(row["id"]),
        kind: "policy" as const,
        subject: String(row["pattern_key"]),
        decidedBy: String(row["decided_by"]),
        decidedAt: String(row["decided_at"]),
        revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
      })),
    ].sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
  }

  private state(sessionId: string): ContextIntegrityLatchState | null {
    const latch = this.db
      .prepare("SELECT * FROM session_latches WHERE session_id=?")
      .get(sessionId) as Row | undefined;
    if (!latch) return null;
    const rows = this.db
      .prepare("SELECT * FROM session_lineage WHERE session_id=? ORDER BY ordinal")
      .all(sessionId) as Row[];
    return {
      class: String(latch["class"]) as ContentClass,
      latchEpoch: Number(latch["latch_epoch"]),
      sources: rows.map((row) => ({
        key: parseLineageKey(String(row["lineage_key"])),
        class: String(row["class"]) as ContentClass,
        firstSeen: String(row["first_seen"]),
        via: String(row["via"]),
        count: Number(row["count"]),
      })),
    };
  }

  private writeState(sessionId: string, state: ContextIntegrityLatchState, now: number): void {
    this.db
      .prepare(
        `INSERT INTO session_latches(session_id,class,latch_epoch,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET class=excluded.class,latch_epoch=excluded.latch_epoch,updated_at=excluded.updated_at`
      )
      .run(sessionId, state.class, state.latchEpoch, now);
    this.db.prepare("DELETE FROM session_lineage WHERE session_id=?").run(sessionId);
    const insert = this.db.prepare(`INSERT INTO session_lineage
      (session_id,lineage_key,class,first_seen,via,count,ordinal) VALUES (?,?,?,?,?,?,?)`);
    state.sources.forEach((entry, ordinal) =>
      insert.run(
        sessionId,
        entry.key,
        entry.class,
        entry.firstSeen,
        entry.via,
        entry.count,
        ordinal
      )
    );
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Advance the server-owned latch for the agent session represented by a
 * verified caller. Non-agent UI and host calls intentionally have no model
 * context to taint.
 */
export function recordContextIngestionForCaller(
  store: ContextIntegrityStore,
  caller: VerifiedCaller,
  input: ContextIngestionInput
): void {
  const sessionId = caller.agentBinding?.channelId;
  if (!sessionId) return;
  if (input.classification === "external") {
    store.ingest({
      sessionId,
      key: input.key,
      class: "external",
      via: input.via,
    });
    return;
  }
  store.ingestResolved({
    sessionId,
    key: input.key,
    via: input.via,
    derivedClass: input.derivedClass ?? "unknown",
  });
}

export function createContextIngestionRecorder(
  store: ContextIntegrityStore
): ContextIngestionRecorder {
  return (ctx, input) => recordContextIngestionForCaller(store, ctx.caller, input);
}

type Row = Record<string, SQLOutputValue>;

function policyMatches(kind: string, pattern: string, key: string): boolean {
  if (kind === "pkg-name" && key.startsWith(`${pattern}@`)) return true;
  return kind === "repo-remote" && key.startsWith(`${pattern}@`);
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
