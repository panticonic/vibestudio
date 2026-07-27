import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  developmentRunEventSchema,
  developmentRunSchema,
  developmentSessionSchema,
  type DevelopmentRun,
  type DevelopmentRunEvent,
  type DevelopmentSession,
} from "@vibestudio/service-schemas/development";
import {
  publishExecutionOwner,
  verifyExecutionArtifactRef,
  type ExecutionPublicationPort,
  type ExecutionRoot,
  type ExecutionRootProvider,
} from "@vibestudio/shared/execution/retention";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";
import type { PreparedDevelopmentBuild } from "./developmentExecutor.js";

type CloseContext = "retain-context" | "destroy-context";
interface StoredSession extends DevelopmentSession {
  close?: { idempotencyKey: string; disposition: CloseContext };
  repairIntents?: Record<string, string>;
}
interface PersistedSessions {
  schemaVersion: 1;
  sessions: StoredSession[];
}

const ACTIVE_RUN_STATES = new Set<DevelopmentRun["state"]>([
  "accepted",
  "materializing",
  "installing",
  "building",
  "starting",
  "awaiting-readiness",
  "ready",
  "stopping",
]);

export class DevelopmentSessionStore {
  private readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly eventListeners = new Set<
    (run: DevelopmentRun, event: DevelopmentRunEvent) => void
  >();

  constructor(opts: { statePath: string; publicationPort?: ExecutionPublicationPort }) {
    const layout = stateLayout(opts.statePath);
    this.filePath = layout.development.sessionsFile;
    fs.mkdirSync(layout.development.root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(layout.development.runsDb);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS development_runs (
        run_id TEXT PRIMARY KEY,
        owner_runtime_id TEXT NOT NULL,
        owner_user_id TEXT,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        run_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        start_intent_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS development_runs_owner
        ON development_runs(owner_user_id, owner_runtime_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS development_runs_session
        ON development_runs(session_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS development_run_events (
        run_id TEXT NOT NULL REFERENCES development_runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS development_mutation_intents (
        run_id TEXT NOT NULL REFERENCES development_runs(run_id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        intent_digest TEXT NOT NULL,
        PRIMARY KEY (run_id, operation, idempotency_key)
      );
    `);
    this.publicationPort = opts.publicationPort;
    this.loadSessions();
    this.validateColdRuns();
  }

  private readonly publicationPort?: ExecutionPublicationPort;

  close(): void {
    this.db.close();
  }

  onRunEvent(listener: (run: DevelopmentRun, event: DevelopmentRunEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get(sessionId: string): DevelopmentSession | null {
    const value = this.sessions.get(sessionId);
    return value ? publicSession(value) : null;
  }

  findOpen(
    owner: { runtimeId: string; userId: string | null },
    idempotencyKey: string
  ): DevelopmentSession | null {
    for (const value of this.sessions.values()) {
      if (sessionOwnedBy(value, owner) && value.idempotencyKey === idempotencyKey) {
        return publicSession(value);
      }
    }
    return null;
  }

  list(owner: { runtimeId: string; userId: string | null }): DevelopmentSession[] {
    return [...this.sessions.values()]
      .filter((value) => sessionOwnedBy(value, owner))
      .map(publicSession)
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId)
      );
  }

  /** Internal recovery census; callers must not expose this without owner filtering. */
  listAllSessions(): DevelopmentSession[] {
    return [...this.sessions.values()].map(publicSession);
  }

  activeRunCount(sessionId: string): number {
    return this.listRuns({ sessionId }).filter((run) => ACTIVE_RUN_STATES.has(run.state)).length;
  }

  getRun(runId: string): DevelopmentRun | null {
    const row = this.db
      .prepare("SELECT run_json FROM development_runs WHERE run_id = ?")
      .get(runId) as { run_json?: unknown } | undefined;
    return row ? parseRun(row.run_json) : null;
  }

  getRunPlan(runId: string): PreparedDevelopmentBuild {
    const row = this.db
      .prepare("SELECT plan_json FROM development_runs WHERE run_id = ?")
      .get(runId) as { plan_json?: unknown } | undefined;
    if (!row) throw coded("ENOENT", `Unknown development run ${runId}`);
    return parsePlan(row.plan_json, runId);
  }

  listRuns(
    input: {
      ownerRuntimeId?: string;
      ownerUserId?: string | null;
      sessionId?: string;
      state?: DevelopmentRun["state"];
    } = {}
  ): DevelopmentRun[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.ownerRuntimeId && input.ownerUserId) {
      clauses.push("(owner_user_id = ? OR (owner_user_id IS NULL AND owner_runtime_id = ?))");
      values.push(input.ownerUserId, input.ownerRuntimeId);
    } else if (input.ownerRuntimeId) {
      clauses.push("owner_user_id IS NULL AND owner_runtime_id = ?");
      values.push(input.ownerRuntimeId);
    }
    if (input.sessionId) {
      clauses.push("session_id = ?");
      values.push(input.sessionId);
    }
    if (input.state) {
      clauses.push("state = ?");
      values.push(input.state);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT run_json FROM development_runs${where} ORDER BY created_at DESC, run_id ASC`)
      .all(...values) as Array<{ run_json: unknown }>;
    return rows.map((row) => parseRun(row.run_json));
  }

  pageRuns(input: {
    ownerRuntimeId: string;
    ownerUserId: string | null;
    sessionId?: string;
    state?: DevelopmentRun["state"];
    cursor?: { createdAt: number; runId: string };
    limit?: number;
  }): {
    runs: DevelopmentRun[];
    nextCursor: { createdAt: number; runId: string } | null;
  } {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.ownerUserId) {
      clauses.push("(owner_user_id = ? OR (owner_user_id IS NULL AND owner_runtime_id = ?))");
      values.push(input.ownerUserId, input.ownerRuntimeId);
    } else {
      clauses.push("owner_user_id IS NULL AND owner_runtime_id = ?");
      values.push(input.ownerRuntimeId);
    }
    if (input.sessionId) {
      clauses.push("session_id = ?");
      values.push(input.sessionId);
    }
    if (input.state) {
      clauses.push("state = ?");
      values.push(input.state);
    }
    if (input.cursor) {
      clauses.push("(created_at < ? OR (created_at = ? AND run_id > ?))");
      values.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.runId);
    }
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT run_json FROM development_runs
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, run_id ASC
          LIMIT ?`
      )
      .all(...values, limit + 1) as Array<{ run_json: unknown }>;
    const runs = rows.slice(0, limit).map((row) => parseRun(row.run_json));
    const last = runs.at(-1);
    return {
      runs,
      nextCursor:
        rows.length > limit && last ? { createdAt: last.createdAt, runId: last.runId } : null,
    };
  }

  putRun(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild,
    startIntentDigest: string
  ): { run: DevelopmentRun; event: DevelopmentRunEvent } {
    const validatedRun = developmentRunSchema.parse(run);
    validatePlanForRun(plan, validatedRun);
    const result = this.transaction(() => {
      const existing = this.getRun(run.runId);
      if (existing) {
        const row = this.db
          .prepare("SELECT start_intent_digest FROM development_runs WHERE run_id = ?")
          .get(run.runId) as { start_intent_digest: string };
        if (row.start_intent_digest !== startIntentDigest) {
          throw coded("EIDEMPOTENCYDRIFT", "Run id was reused with different start intent");
        }
        return {
          created: false as const,
          run: existing,
          event:
            this.listRunEvents(existing.runId, 0, 1).events[0] ??
            developmentRunEventSchema.parse({
              sequence: 1,
              at: existing.createdAt,
              kind: "state",
              payload: { state: existing.state, message: "Build accepted" },
            }),
        };
      }
      this.db
        .prepare(
          `INSERT INTO development_runs (
            run_id, owner_runtime_id, owner_user_id, session_id, state, run_json, plan_json,
            start_intent_digest, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.runId,
          run.ownerRuntimeId,
          run.ownerUserId,
          run.sessionId,
          run.state,
          canonicalJson(run),
          canonicalJson(plan),
          startIntentDigest,
          run.createdAt,
          run.updatedAt
        );
      const event = this.insertEvent(run.runId, run.createdAt, "state", {
        state: run.state,
        message: "Exact build accepted",
      });
      return { created: true as const, run, event };
    });
    if (result.created) this.emit(result.run, result.event);
    return { run: result.run, event: result.event };
  }

  transitionRun(input: {
    runId: string;
    expected: readonly DevelopmentRun["state"][];
    state: DevelopmentRun["state"];
    at?: number;
    message: string;
    commitPoint?: DevelopmentRun["commitPoint"];
    artifact?: DevelopmentRun["artifact"];
    instance?: DevelopmentRun["instance"];
    hostReadiness?: DevelopmentRun["hostReadiness"];
    client?: DevelopmentRun["client"];
    attachedHost?: DevelopmentRun["attachedHost"];
    repair?: DevelopmentRun["repair"];
    terminal?: boolean;
  }): { run: DevelopmentRun; event: DevelopmentRunEvent } {
    const apply = () =>
      this.transaction(() => {
        const current = this.requireRun(input.runId);
        if (!input.expected.includes(current.state)) {
          throw coded(
            "ESTATE",
            `Development run ${input.runId} is ${current.state}, expected ${input.expected.join("|")}`
          );
        }
        const at = input.at ?? Date.now();
        const next = developmentRunSchema.parse({
          ...current,
          state: input.state,
          updatedAt: at,
          ...(input.commitPoint ? { commitPoint: input.commitPoint } : {}),
          ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
          ...(input.instance !== undefined ? { instance: input.instance } : {}),
          ...(input.hostReadiness !== undefined ? { hostReadiness: input.hostReadiness } : {}),
          ...(input.client !== undefined ? { client: input.client } : {}),
          ...(input.attachedHost !== undefined ? { attachedHost: input.attachedHost } : {}),
          ...(input.repair !== undefined ? { repair: input.repair } : {}),
          ...(input.terminal ? { terminalAt: at } : {}),
        });
        this.db
          .prepare(
            `UPDATE development_runs
                SET state = ?, run_json = ?, updated_at = ?
              WHERE run_id = ? AND state = ?`
          )
          .run(next.state, canonicalJson(next), at, next.runId, current.state);
        const event = this.insertEvent(next.runId, at, "state", {
          state: next.state,
          message: input.message,
          commitPoint: next.commitPoint,
        });
        return { run: next, event };
      });
    const artifact = input.artifact;
    const result =
      artifact && input.commitPoint === "artifacts-verified"
        ? publishExecutionOwner(
            this.publicationPort,
            {
              owner: "development-run",
              ownerId: input.runId,
              artifacts: [
                { buildKey: artifact.buildKey, executionDigest: artifact.executionDigest },
              ],
            },
            apply
          )
        : apply();
    this.emit(result.run, result.event);
    return result;
  }

  appendRunEvent(
    runId: string,
    kind: DevelopmentRunEvent["kind"],
    payload: unknown,
    at = Date.now()
  ): DevelopmentRunEvent {
    const result = this.transaction(() => {
      const run = this.requireRun(runId);
      return { run, event: this.insertEvent(runId, at, kind, payload) };
    });
    this.emit(result.run, result.event);
    return result.event;
  }

  listRunEvents(
    runId: string,
    after = 0,
    limit = 100
  ): { events: DevelopmentRunEvent[]; nextAfter: number | null } {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare(
        `SELECT sequence, at, kind, payload_json
           FROM development_run_events
          WHERE run_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?`
      )
      .all(runId, after, bounded + 1) as Array<{
      sequence: number;
      at: number;
      kind: string;
      payload_json: string;
    }>;
    const hasMore = rows.length > bounded;
    const events = rows.slice(0, bounded).map((row) =>
      developmentRunEventSchema.parse({
        sequence: Number(row.sequence),
        at: Number(row.at),
        kind: row.kind,
        payload: JSON.parse(row.payload_json),
      })
    );
    return {
      events,
      nextAfter: hasMore ? (events.at(-1)?.sequence ?? null) : null,
    };
  }

  recordMutationIntent(input: {
    runId: string;
    operation: "stop" | "repair";
    idempotencyKey: string;
    intent: unknown;
  }): void {
    const digest = createHash("sha256").update(canonicalJson(input.intent)).digest("hex");
    const existing = this.db
      .prepare(
        `SELECT intent_digest FROM development_mutation_intents
          WHERE run_id = ? AND operation = ? AND idempotency_key = ?`
      )
      .get(input.runId, input.operation, input.idempotencyKey) as
      | { intent_digest: string }
      | undefined;
    if (existing) {
      if (existing.intent_digest !== digest)
        throw coded(
          "EIDEMPOTENCYDRIFT",
          `${input.operation} idempotency key was reused with different intent`
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO development_mutation_intents (
          run_id, operation, idempotency_key, intent_digest
        ) VALUES (?, ?, ?, ?)`
      )
      .run(input.runId, input.operation, input.idempotencyKey, digest);
  }

  putOpening(session: DevelopmentSession): DevelopmentSession {
    if (this.sessions.has(session.sessionId)) return this.get(session.sessionId)!;
    this.sessions.set(session.sessionId, { ...developmentSessionSchema.parse(session) });
    this.saveSessions();
    return session;
  }

  update(
    sessionId: string,
    update: Partial<
      Pick<
        DevelopmentSession,
        | "state"
        | "primaryDiagnostic"
        | "cleanupDiagnostics"
        | "repairAttention"
        | "contextEffect"
        | "native"
      >
    >,
    now = Date.now()
  ): DevelopmentSession {
    const current = this.requireSession(sessionId);
    const next: StoredSession = developmentSessionSchema.parse({
      ...publicSession(current),
      ...update,
      updatedAt: now,
    });
    this.sessions.set(sessionId, next);
    this.saveSessions();
    return publicSession(next);
  }

  beginClose(
    input: { sessionId: string; idempotencyKey: string; disposition: CloseContext },
    now = Date.now()
  ): DevelopmentSession {
    const current = this.requireSession(input.sessionId);
    if (current.close) {
      if (
        current.close.idempotencyKey !== input.idempotencyKey ||
        current.close.disposition !== input.disposition
      ) {
        throw coded(
          "EIDEMPOTENCYDRIFT",
          "Close idempotency key was reused with different session intent"
        );
      }
      return publicSession(current);
    }
    const next: StoredSession = {
      ...current,
      state: "closing",
      updatedAt: now,
      close: { idempotencyKey: input.idempotencyKey, disposition: input.disposition },
    };
    this.sessions.set(input.sessionId, next);
    this.saveSessions();
    return publicSession(next);
  }

  recordSessionRepairIntent(input: {
    sessionId: string;
    idempotencyKey: string;
    action: string;
  }): void {
    const current = this.requireSession(input.sessionId);
    const digest = createHash("sha256")
      .update(canonicalJson({ action: input.action }))
      .digest("hex");
    const existing = current.repairIntents?.[input.idempotencyKey];
    if (existing && existing !== digest)
      throw coded(
        "EIDEMPOTENCYDRIFT",
        "Session repair idempotency key was reused with different intent"
      );
    if (existing) return;
    this.sessions.set(input.sessionId, {
      ...current,
      repairIntents: { ...current.repairIntents, [input.idempotencyKey]: digest },
    });
    this.saveSessions();
  }

  executionRootProvider(): ExecutionRootProvider {
    return {
      id: "development-run",
      mandatory: true,
      snapshotRoots: (epoch) => this.snapshotExecutionRoots(epoch),
    };
  }

  async snapshotExecutionRoots(_epoch: number): Promise<readonly ExecutionRoot[]> {
    return this.listRuns()
      .filter((run) => run.artifact !== null)
      .map((run) => ({
        owner: "development-run" as const,
        ownerId: run.runId,
        reason: "retained-result" as const,
        artifact: verifyExecutionArtifactRef(
          run.artifact! as unknown as import("@vibestudio/shared/execution/retention").ExecutionArtifactRefV1
        ),
      }));
  }

  private requireSession(sessionId: string): StoredSession {
    const current = this.sessions.get(sessionId);
    if (!current) throw coded("ENOENT", `Unknown development session ${sessionId}`);
    return current;
  }

  private requireRun(runId: string): DevelopmentRun {
    const run = this.getRun(runId);
    if (!run) throw coded("ENOENT", `Unknown development run ${runId}`);
    return run;
  }

  private insertEvent(
    runId: string,
    at: number,
    kind: DevelopmentRunEvent["kind"],
    payload: unknown
  ): DevelopmentRunEvent {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM development_run_events WHERE run_id = ?"
      )
      .get(runId) as { next: number };
    const event = developmentRunEventSchema.parse({
      sequence: Number(row.next),
      at,
      kind,
      payload,
    });
    this.db
      .prepare(
        `INSERT INTO development_run_events (run_id, sequence, at, kind, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, event.sequence, event.at, event.kind, canonicalJson(event.payload));
    return event;
  }

  private emit(run: DevelopmentRun, event: DevelopmentRunEvent): void {
    for (const listener of this.eventListeners) listener(run, event);
  }

  private loadSessions(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<PersistedSessions>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error(`Unknown development session schema in ${this.filePath}`);
    }
    for (const session of parsed.sessions) {
      if (!isStoredSession(session))
        throw new Error(`Invalid development session in ${this.filePath}`);
      this.sessions.set(session.sessionId, session);
    }
  }

  private saveSessions(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: PersistedSessions = {
      schemaVersion: 1,
      sessions: [...this.sessions.values()].sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId)
      ),
    };
    writeFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  private validateColdRuns(): void {
    const rows = this.db
      .prepare("SELECT run_id, run_json, plan_json FROM development_runs ORDER BY run_id")
      .all() as Array<{ run_id: string; run_json: unknown; plan_json: unknown }>;
    for (const row of rows) {
      const run = parseRun(row.run_json);
      const plan = parsePlan(row.plan_json, row.run_id);
      validatePlanForRun(plan, run);
      if (run.artifact)
        verifyExecutionArtifactRef(
          run.artifact as unknown as import("@vibestudio/shared/execution/retention").ExecutionArtifactRefV1
        );
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function developmentSessionId(ownerKey: string, idempotencyKey: string): string {
  return `development-${createHash("sha256")
    .update(`development-session:v1\0${ownerKey}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function sessionOwnedBy(
  session: StoredSession,
  owner: { runtimeId: string; userId: string | null }
): boolean {
  return session.owner.userId
    ? session.owner.userId === owner.userId
    : session.owner.runtimeId === owner.runtimeId;
}

function parseRun(value: unknown): DevelopmentRun {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return developmentRunSchema.parse(raw);
}

function parsePlan(value: unknown, runId: string): PreparedDevelopmentBuild {
  const raw = (
    typeof value === "string" ? JSON.parse(value) : value
  ) as Partial<PreparedDevelopmentBuild> | null;
  if (
    !raw ||
    raw.version !== 1 ||
    raw.runId !== runId ||
    !raw.sourcePlan ||
    !raw.snapshot ||
    !raw.recipe ||
    !raw.executables
  ) {
    throw new Error(`Invalid development execution plan for ${runId}`);
  }
  return raw as PreparedDevelopmentBuild;
}

function validatePlanForRun(plan: PreparedDevelopmentBuild, run: DevelopmentRun): void {
  if (
    plan.runId !== run.runId ||
    plan.snapshot.snapshotDigest !== run.snapshot.snapshotDigest ||
    canonicalJson(plan.snapshot) !== canonicalJson(run.snapshot) ||
    canonicalJson(plan.recipe) !== canonicalJson(run.recipe)
  ) {
    throw new Error(`Development run ${run.runId} does not match its exact execution plan`);
  }
}

function publicSession(value: StoredSession): DevelopmentSession {
  const { close: _close, repairIntents: _repairIntents, ...session } = value;
  return developmentSessionSchema.parse(session);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const { close, repairIntents, ...session } = item;
  if (!developmentSessionSchema.safeParse(session).success) return false;
  const closeValid =
    close === undefined ||
    (close !== null &&
      typeof close === "object" &&
      !Array.isArray(close) &&
      typeof (close as Record<string, unknown>)["idempotencyKey"] === "string" &&
      ["retain-context", "destroy-context"].includes(
        String((close as Record<string, unknown>)["disposition"])
      ));
  const repairsValid =
    repairIntents === undefined ||
    (repairIntents !== null &&
      typeof repairIntents === "object" &&
      !Array.isArray(repairIntents) &&
      Object.values(repairIntents).every((entry) => typeof entry === "string"));
  return closeValid && repairsValid;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
