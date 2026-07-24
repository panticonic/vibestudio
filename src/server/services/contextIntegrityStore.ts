import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type { ContextIntegrityFact } from "@vibestudio/rpc";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  canonicalLineageSet,
  ContextIntegrityLatch,
  isContentAddressedLineageKey,
  isLineageSetKey,
  parseLineageKey,
  type CanonicalLineageSet,
  type ContentClass,
  type ContextIntegrityLatchState,
  type LineageEntry,
} from "@vibestudio/shared/authority/contextIntegrity";
import { stateLayout } from "../stateLayout.js";
import { CONTEXT_INTEGRITY_MIGRATION_PLAN } from "./contextIntegritySchema.js";

export interface ContextIngestionInput {
  key: string;
  via: string;
  classification: "external" | "derived";
  derivedClass?: "internal" | "external";
}

export interface LineageExplanationPage {
  key: string;
  aggregate: boolean;
  memberCount: number;
  digestVerified: true;
  session: {
    class: "external";
    firstSeen: string;
    via: string;
    count: number;
  };
  items: Array<{ key: string; trusted: boolean }>;
  pageInfo: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export type ContextIngestionRecorder = (
  ctx: ServiceContext,
  input: ContextIngestionInput
) => void | Promise<void>;

export type ContextIngestionBatchRecorder = (
  ctx: ServiceContext,
  inputs: readonly ContextIngestionInput[]
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
    return this.ingestMany({
      sessionId: input.sessionId,
      entries: [input],
    });
  }

  ingestMany(input: {
    sessionId: string;
    entries: readonly {
      key: string;
      class: ContentClass;
      via: string;
      at?: Date;
    }[];
  }): ContextIntegrityFact {
    if (!input.sessionId.trim()) throw new Error("Context ingestion requires a session id");
    const current = this.state(input.sessionId) ?? {
      class: "internal" as const,
      latchEpoch: 0,
      sources: [],
    };
    const prepared = this.prepareIngestion(current, input.entries);
    const recordedAt = input.entries.reduce(
      (latest, entry) => Math.max(latest, entry.at?.getTime() ?? 0),
      Date.now()
    );
    this.transaction(() => {
      if (prepared.lineageSet) this.writeLineageSet(prepared.lineageSet, recordedAt);
      this.writeState(input.sessionId, prepared.state, recordedAt);
    });
    return new ContextIntegrityLatch(prepared.state).fact();
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
    const compacted = this.compactExternalKeys([...server.externalKeys, ...attested.externalKeys]);
    const lineageSet = compacted.lineageSet;
    if (lineageSet) {
      this.transaction(() => this.writeLineageSet(lineageSet, Date.now()));
    }
    const externalKeys = compacted.key ? [compacted.key] : [];
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
    if (isLineageSetKey(key)) this.expandLineageKey(key);
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
    if (isLineageSetKey(key)) {
      return this.expandLineageKey(key).every((member) => this.isTrusted(member));
    }
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

  expandLineageKey(keyValue: string): string[] {
    const key = parseLineageKey(keyValue);
    if (!isLineageSetKey(key)) return [key];
    const row = this.db
      .prepare("SELECT members_json,member_count FROM lineage_sets WHERE set_key=?")
      .get(key) as Row | undefined;
    if (!row) {
      throw coded(`Unknown aggregate lineage set ${key}`, "EINTEGRITY");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(row["members_json"]));
    } catch {
      throw coded(`Aggregate lineage set ${key} has invalid member JSON`, "EINTEGRITY");
    }
    if (!Array.isArray(decoded) || !decoded.every((member) => typeof member === "string")) {
      throw coded(`Aggregate lineage set ${key} has invalid members`, "EINTEGRITY");
    }
    const canonical = canonicalLineageSet(decoded);
    if (canonical.key !== key || canonical.members.length !== Number(row["member_count"])) {
      throw coded(`Aggregate lineage set ${key} fails content-address verification`, "EINTEGRITY");
    }
    return [...canonical.members];
  }

  explainLineage(input: {
    sessionId: string;
    key?: string;
    cursor?: string;
    limit?: number;
  }): LineageExplanationPage {
    const state = this.state(input.sessionId);
    const external = state?.sources.filter((source) => source.class === "external") ?? [];
    const requestedKey = input.key ?? external[0]?.key;
    if (!requestedKey) {
      throw coded(`Session ${input.sessionId} has no outside lineage to explain`, "ENOENT");
    }
    const key = parseLineageKey(requestedKey);
    const source = external.find((candidate) => candidate.key === key);
    if (!source) {
      throw coded(`Lineage key ${key} is not present in session ${input.sessionId}`, "EACCES");
    }
    const members = this.expandLineageKey(key);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    const offset = input.cursor ? decodeLineageCursor(input.cursor, key) : 0;
    if (offset > members.length) {
      throw coded(`Lineage cursor is outside aggregate ${key}`, "EINVAL");
    }
    const page = members.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      key,
      aggregate: isLineageSetKey(key),
      memberCount: members.length,
      digestVerified: true,
      session: {
        class: "external",
        firstSeen: source.firstSeen,
        via: source.via,
        count: source.count,
      },
      items: page.map((member) => ({ key: member, trusted: this.isTrusted(member) })),
      pageInfo: {
        offset,
        limit,
        hasMore: nextOffset < members.length,
        nextCursor: nextOffset < members.length ? encodeLineageCursor(key, nextOffset) : null,
      },
    };
  }

  private prepareIngestion(
    current: ContextIntegrityLatchState,
    entries: readonly {
      key: string;
      class: ContentClass;
      via: string;
      at?: Date;
    }[]
  ): { state: ContextIntegrityLatchState; lineageSet: CanonicalLineageSet | null } {
    const parsed = entries.map((entry) => ({
      ...entry,
      key: parseLineageKey(entry.key),
    }));
    for (const entry of parsed) {
      if (isLineageSetKey(entry.key)) this.expandLineageKey(entry.key);
    }
    const internalInputs = parsed.filter((entry) => entry.class === "internal");
    const incomingExternal = parsed.filter((entry) => entry.class === "external");
    const existingExternal = current.sources.filter((entry) => entry.class === "external");
    const externalMembers = new Set<string>();
    for (const entry of existingExternal) {
      for (const member of this.expandLineageKey(entry.key)) externalMembers.add(member);
    }
    for (const entry of incomingExternal) {
      for (const member of this.expandLineageKey(entry.key)) externalMembers.add(member);
    }

    const internalLatch = new ContextIntegrityLatch({
      class: "internal",
      latchEpoch: current.latchEpoch,
      sources: current.sources.filter((entry) => entry.class === "internal"),
    });
    const internalState = internalLatch.ingestMany(internalInputs);
    if (externalMembers.size === 0) {
      return { state: internalState, lineageSet: null };
    }

    const compacted = this.compactExternalKeys([...externalMembers]);
    if (!compacted.key) throw new Error("External lineage compaction produced no key");
    const collidingInternal: LineageEntry[] = [];
    const sources = internalState.sources.filter((entry) => {
      const collides =
        entry.key === compacted.key ||
        (!isLineageSetKey(entry.key) && externalMembers.has(entry.key));
      if (collides) collidingInternal.push(entry);
      return !collides;
    });
    if (sources.length >= ContextIntegrityLatch.MAX_DISTINCT_KEYS) sources.shift();

    const firstSeen = [
      ...existingExternal.map((entry) => entry.firstSeen),
      ...collidingInternal.map((entry) => entry.firstSeen),
      ...incomingExternal.map((entry) => (entry.at ?? new Date()).toISOString()),
    ].sort()[0]!;
    const previousKey = existingExternal.length === 1 ? String(existingExternal[0]!.key) : null;
    const changed = previousKey !== compacted.key;
    const count =
      existingExternal.reduce((total, entry) => total + entry.count, 0) +
      collidingInternal.reduce((total, entry) => total + entry.count, 0) +
      incomingExternal.length;
    sources.push({
      key: parseLineageKey(compacted.key),
      class: "external",
      firstSeen,
      via: incomingExternal.at(-1)?.via ?? existingExternal[0]?.via ?? "lineage-set",
      count,
    });
    return {
      state: {
        class: "external",
        latchEpoch: internalState.latchEpoch + (changed ? 1 : 0),
        sources,
      },
      lineageSet: compacted.lineageSet,
    };
  }

  private compactExternalKeys(keys: readonly string[]): {
    key: string | null;
    lineageSet: CanonicalLineageSet | null;
  } {
    const members = new Set<string>();
    for (const key of keys) {
      for (const member of this.expandLineageKey(key)) members.add(member);
    }
    if (members.size === 0) return { key: null, lineageSet: null };
    if (members.size === 1) return { key: [...members][0]!, lineageSet: null };
    const lineageSet = canonicalLineageSet([...members]);
    return { key: lineageSet.key, lineageSet };
  }

  private writeLineageSet(lineageSet: CanonicalLineageSet, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lineage_sets(set_key,members_json,member_count,created_at)
         VALUES (?,?,?,?)`
      )
      .run(lineageSet.key, JSON.stringify(lineageSet.members), lineageSet.members.length, now);
    const persisted = this.expandLineageKey(lineageSet.key);
    if (
      persisted.length !== lineageSet.members.length ||
      persisted.some((member, index) => member !== lineageSet.members[index])
    ) {
      throw coded(`Aggregate lineage set ${lineageSet.key} has conflicting members`, "EINTEGRITY");
    }
  }

  private state(sessionId: string): ContextIntegrityLatchState | null {
    const latch = this.db
      .prepare("SELECT * FROM session_latches WHERE session_id=?")
      .get(sessionId) as Row | undefined;
    if (!latch) return null;
    const rows = this.db
      .prepare("SELECT * FROM session_lineage WHERE session_id=? ORDER BY ordinal")
      .all(sessionId) as Row[];
    const state: ContextIntegrityLatchState = {
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
    for (const source of state.sources) {
      if (isLineageSetKey(source.key)) this.expandLineageKey(source.key);
    }
    return state;
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

export function recordContextIngestionsForCaller(
  store: ContextIntegrityStore,
  caller: VerifiedCaller,
  inputs: readonly ContextIngestionInput[]
): void {
  const sessionId = caller.agentBinding?.channelId;
  if (!sessionId || inputs.length === 0) return;
  store.ingestMany({
    sessionId,
    entries: inputs.map((input) => {
      if (input.classification === "external") {
        return {
          key: input.key,
          via: input.via,
          class: "external" as const,
        };
      }
      const key = parseLineageKey(input.key);
      return {
        key,
        via: input.via,
        class: store.isTrusted(key)
          ? ("internal" as const)
          : input.derivedClass === "internal"
            ? ("internal" as const)
            : ("external" as const),
      };
    }),
  });
}

export function createContextIngestionRecorder(
  store: ContextIntegrityStore
): ContextIngestionRecorder {
  return (ctx, input) => recordContextIngestionForCaller(store, ctx.caller, input);
}

export function createContextIngestionBatchRecorder(
  store: ContextIntegrityStore
): ContextIngestionBatchRecorder {
  return (ctx, inputs) => recordContextIngestionsForCaller(store, ctx.caller, inputs);
}

type Row = Record<string, SQLOutputValue>;

function policyMatches(kind: string, pattern: string, key: string): boolean {
  if (kind === "pkg-name" && key.startsWith(`${pattern}@`)) return true;
  return kind === "repo-remote" && key.startsWith(`${pattern}@`);
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function encodeLineageCursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ key, offset }), "utf8").toString("base64url");
}

function decodeLineageCursor(cursor: string, expectedKey: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      key?: unknown;
      offset?: unknown;
    };
    if (
      value.key !== expectedKey ||
      typeof value.offset !== "number" ||
      !Number.isInteger(value.offset) ||
      value.offset < 0
    ) {
      throw new Error("mismatch");
    }
    return value.offset;
  } catch {
    throw coded(`Invalid lineage cursor for ${expectedKey}`, "EINVAL");
  }
}
