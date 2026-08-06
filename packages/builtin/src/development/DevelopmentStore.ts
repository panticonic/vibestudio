import { createHash } from "node:crypto";
import {
  developmentRunEventSchema,
  developmentRunSchema,
  developmentSessionSchema,
  type DevelopmentRun,
  type DevelopmentRunEvent,
  type DevelopmentSession,
} from "@vibestudio/service-schemas/development";
import { preparedNativeBuildSchema } from "@vibestudio/service-schemas/developmentNative";
import type { z } from "zod";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import type { SqlStorage } from "@vibestudio/durable";

export type PreparedNativeBuild = z.infer<typeof preparedNativeBuildSchema>;
type Owner = { runtimeId: string; userId: string | null };
type CloseDisposition = "retain-context" | "destroy-context";

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

export class DevelopmentStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(operation: () => T) => T
  ) {}

  createTables(): void {
    this.sql.exec(`CREATE TABLE development_sessions (
      session_id TEXT PRIMARY KEY,
      owner_runtime_id TEXT NOT NULL,
      owner_user_id TEXT,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL,
      session_json TEXT NOT NULL,
      close_idempotency_key TEXT,
      close_disposition TEXT,
      repair_intents_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(
      `CREATE UNIQUE INDEX development_session_open_intent
       ON development_sessions(owner_runtime_id,COALESCE(owner_user_id,''),idempotency_key)`
    );
    this.sql.exec(`CREATE TABLE development_runs (
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
    )`);
    this.sql.exec(
      `CREATE INDEX development_runs_owner
       ON development_runs(owner_user_id,owner_runtime_id,created_at DESC,run_id ASC)`
    );
    this.sql.exec(`CREATE TABLE development_run_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(run_id,sequence)
    )`);
    this.sql.exec(`CREATE TABLE development_mutation_intents (
      run_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      intent_digest TEXT NOT NULL,
      PRIMARY KEY(run_id,operation,idempotency_key)
    )`);
    this.sql.exec(`CREATE TABLE development_test_faults (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      fault_id TEXT NOT NULL,
      armed_at INTEGER NOT NULL
    )`);
  }

  getSession(sessionId: string): DevelopmentSession | null {
    const row = this.sql
      .exec("SELECT session_json FROM development_sessions WHERE session_id=?", sessionId)
      .toArray()[0];
    return row ? developmentSessionSchema.parse(JSON.parse(String(row["session_json"]))) : null;
  }

  findSession(owner: Owner, idempotencyKey: string): DevelopmentSession | null {
    const rows = owner.userId
      ? this.sql
          .exec(
            `SELECT session_json FROM development_sessions
             WHERE owner_user_id=? AND idempotency_key=?`,
            owner.userId,
            idempotencyKey
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT session_json FROM development_sessions
             WHERE owner_user_id IS NULL AND owner_runtime_id=? AND idempotency_key=?`,
            owner.runtimeId,
            idempotencyKey
          )
          .toArray();
    return rows[0]
      ? developmentSessionSchema.parse(JSON.parse(String(rows[0]["session_json"])))
      : null;
  }

  listSessions(owner: Owner): DevelopmentSession[] {
    const rows = owner.userId
      ? this.sql
          .exec(
            `SELECT session_json FROM development_sessions
             WHERE owner_user_id=? ORDER BY created_at DESC,session_id ASC`,
            owner.userId
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT session_json FROM development_sessions
             WHERE owner_user_id IS NULL AND owner_runtime_id=?
             ORDER BY created_at DESC,session_id ASC`,
            owner.runtimeId
          )
          .toArray();
    return rows.map((row) =>
      developmentSessionSchema.parse(JSON.parse(String(row["session_json"])))
    );
  }

  putSession(session: DevelopmentSession): DevelopmentSession {
    const value = developmentSessionSchema.parse(session);
    this.sql.exec(
      `INSERT INTO development_sessions
       (session_id,owner_runtime_id,owner_user_id,idempotency_key,state,session_json,
        created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      value.sessionId,
      value.owner.runtimeId,
      value.owner.userId,
      value.idempotencyKey,
      value.state,
      canonicalJson(value),
      value.createdAt,
      value.updatedAt
    );
    return value;
  }

  updateSession(
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
    at = Date.now()
  ): DevelopmentSession {
    const current = this.requireSession(sessionId);
    const next = developmentSessionSchema.parse({ ...current, ...update, updatedAt: at });
    this.sql.exec(
      `UPDATE development_sessions SET state=?,session_json=?,updated_at=? WHERE session_id=?`,
      next.state,
      canonicalJson(next),
      next.updatedAt,
      sessionId
    );
    return next;
  }

  beginClose(input: {
    sessionId: string;
    idempotencyKey: string;
    disposition: CloseDisposition;
  }): DevelopmentSession {
    const row = this.sql
      .exec(
        `SELECT close_idempotency_key,close_disposition
         FROM development_sessions WHERE session_id=?`,
        input.sessionId
      )
      .toArray()[0];
    if (!row) throw coded("ENOENT", `Unknown development session ${input.sessionId}`);
    if (row["close_idempotency_key"] != null) {
      if (
        String(row["close_idempotency_key"]) !== input.idempotencyKey ||
        String(row["close_disposition"]) !== input.disposition
      ) {
        throw coded("EIDEMPOTENCYDRIFT", "Close key was reused with different intent");
      }
      return this.requireSession(input.sessionId);
    }
    const next = this.updateSession(input.sessionId, { state: "closing" });
    this.sql.exec(
      `UPDATE development_sessions
       SET close_idempotency_key=?,close_disposition=? WHERE session_id=?`,
      input.idempotencyKey,
      input.disposition,
      input.sessionId
    );
    return next;
  }

  recordSessionRepairIntent(input: {
    sessionId: string;
    idempotencyKey: string;
    action: string;
  }): void {
    const row = this.sql
      .exec(
        "SELECT repair_intents_json FROM development_sessions WHERE session_id=?",
        input.sessionId
      )
      .toArray()[0];
    if (!row) throw coded("ENOENT", `Unknown development session ${input.sessionId}`);
    const intents = JSON.parse(String(row["repair_intents_json"])) as Record<string, string>;
    const digest = digestOf({ action: input.action });
    if (intents[input.idempotencyKey] && intents[input.idempotencyKey] !== digest) {
      throw coded("EIDEMPOTENCYDRIFT", "Repair key was reused with different intent");
    }
    if (intents[input.idempotencyKey]) return;
    intents[input.idempotencyKey] = digest;
    this.sql.exec(
      "UPDATE development_sessions SET repair_intents_json=? WHERE session_id=?",
      canonicalJson(intents),
      input.sessionId
    );
  }

  activeRunCount(sessionId: string): number {
    return this.listRuns({ sessionId }).filter((run) => ACTIVE_RUN_STATES.has(run.state)).length;
  }

  getRun(runId: string): DevelopmentRun | null {
    const row = this.sql
      .exec("SELECT run_json FROM development_runs WHERE run_id=?", runId)
      .toArray()[0];
    return row ? developmentRunSchema.parse(JSON.parse(String(row["run_json"]))) : null;
  }

  getPlan(runId: string): PreparedNativeBuild {
    const row = this.sql
      .exec("SELECT plan_json FROM development_runs WHERE run_id=?", runId)
      .toArray()[0];
    if (!row) throw coded("ENOENT", `Unknown development run ${runId}`);
    return preparedNativeBuildSchema.parse(JSON.parse(String(row["plan_json"])));
  }

  putRun(
    run: DevelopmentRun,
    plan: PreparedNativeBuild,
    startIntentDigest: string
  ): DevelopmentRun {
    const value = developmentRunSchema.parse(run);
    const prepared = preparedNativeBuildSchema.parse(plan);
    return this.transaction(() => {
      const existing = this.getRun(value.runId);
      if (existing) {
        const row = this.sql
          .exec("SELECT start_intent_digest FROM development_runs WHERE run_id=?", value.runId)
          .toArray()[0]!;
        if (String(row["start_intent_digest"]) !== startIntentDigest) {
          throw coded("EIDEMPOTENCYDRIFT", "Run id was reused with different intent");
        }
        return existing;
      }
      this.sql.exec(
        `INSERT INTO development_runs
         (run_id,owner_runtime_id,owner_user_id,session_id,state,run_json,plan_json,
          start_intent_digest,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        value.runId,
        value.ownerRuntimeId,
        value.ownerUserId,
        value.sessionId,
        value.state,
        canonicalJson(value),
        canonicalJson(prepared),
        startIntentDigest,
        value.createdAt,
        value.updatedAt
      );
      this.insertEvent(value.runId, value.createdAt, "state", {
        state: value.state,
        message: "Exact build accepted",
      });
      return value;
    });
  }

  listRuns(input: {
    owner?: Owner;
    sessionId?: string;
    state?: DevelopmentRun["state"];
  }): DevelopmentRun[] {
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (input.owner?.userId) {
      clauses.push("owner_user_id=?");
      bindings.push(input.owner.userId);
    } else if (input.owner) {
      clauses.push("owner_user_id IS NULL AND owner_runtime_id=?");
      bindings.push(input.owner.runtimeId);
    }
    if (input.sessionId) {
      clauses.push("session_id=?");
      bindings.push(input.sessionId);
    }
    if (input.state) {
      clauses.push("state=?");
      bindings.push(input.state);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec(
        `SELECT run_json FROM development_runs${where}
         ORDER BY created_at DESC,run_id ASC`,
        ...bindings
      )
      .toArray()
      .map((row) => developmentRunSchema.parse(JSON.parse(String(row["run_json"]))));
  }

  transitionRun(input: {
    runId: string;
    expected: readonly DevelopmentRun["state"][];
    state: DevelopmentRun["state"];
    message: string;
    commitPoint?: DevelopmentRun["commitPoint"];
    artifact?: DevelopmentRun["artifact"];
    instance?: DevelopmentRun["instance"];
    hostReadiness?: DevelopmentRun["hostReadiness"];
    client?: DevelopmentRun["client"];
    attachedHost?: DevelopmentRun["attachedHost"];
    repair?: DevelopmentRun["repair"];
    terminal?: boolean;
    at?: number;
  }): DevelopmentRun {
    return this.transaction(() => {
      const current = this.requireRun(input.runId);
      if (!input.expected.includes(current.state)) {
        throw coded("ESTATE", `Run ${input.runId} is ${current.state}`);
      }
      const at = input.at ?? Date.now();
      const next = developmentRunSchema.parse({
        ...current,
        state: input.state,
        updatedAt: at,
        ...(input.commitPoint !== undefined ? { commitPoint: input.commitPoint } : {}),
        ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
        ...(input.instance !== undefined ? { instance: input.instance } : {}),
        ...(input.hostReadiness !== undefined ? { hostReadiness: input.hostReadiness } : {}),
        ...(input.client !== undefined ? { client: input.client } : {}),
        ...(input.attachedHost !== undefined ? { attachedHost: input.attachedHost } : {}),
        ...(input.repair !== undefined ? { repair: input.repair } : {}),
        ...(input.terminal ? { terminalAt: at } : {}),
      });
      this.sql.exec(
        `UPDATE development_runs SET state=?,run_json=?,updated_at=? WHERE run_id=?`,
        next.state,
        canonicalJson(next),
        at,
        next.runId
      );
      this.insertEvent(next.runId, at, "state", {
        state: next.state,
        message: input.message,
        commitPoint: next.commitPoint,
      });
      return next;
    });
  }

  appendEvent(
    runId: string,
    kind: DevelopmentRunEvent["kind"],
    payload: unknown,
    at = Date.now()
  ): DevelopmentRunEvent {
    this.requireRun(runId);
    return this.transaction(() => this.insertEvent(runId, at, kind, payload));
  }

  listEvents(
    runId: string,
    after = 0,
    limit = 100
  ): {
    events: DevelopmentRunEvent[];
    nextAfter: number | null;
  } {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = this.sql
      .exec(
        `SELECT sequence,at,kind,payload_json FROM development_run_events
         WHERE run_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?`,
        runId,
        after,
        bounded + 1
      )
      .toArray();
    const events = rows.slice(0, bounded).map((row) =>
      developmentRunEventSchema.parse({
        sequence: Number(row["sequence"]),
        at: Number(row["at"]),
        kind: String(row["kind"]),
        payload: JSON.parse(String(row["payload_json"])),
      })
    );
    return {
      events,
      nextAfter: rows.length > bounded ? (events.at(-1)?.sequence ?? null) : null,
    };
  }

  recordRunIntent(input: {
    runId: string;
    operation: "stop" | "repair";
    idempotencyKey: string;
    intent: unknown;
  }): void {
    const digest = digestOf(input.intent);
    const row = this.sql
      .exec(
        `SELECT intent_digest FROM development_mutation_intents
         WHERE run_id=? AND operation=? AND idempotency_key=?`,
        input.runId,
        input.operation,
        input.idempotencyKey
      )
      .toArray()[0];
    if (row) {
      if (String(row["intent_digest"]) !== digest) {
        throw coded("EIDEMPOTENCYDRIFT", "Mutation key was reused with different intent");
      }
      return;
    }
    this.sql.exec(
      `INSERT INTO development_mutation_intents
       (run_id,operation,idempotency_key,intent_digest) VALUES (?,?,?,?)`,
      input.runId,
      input.operation,
      input.idempotencyKey,
      digest
    );
  }

  armSnapshotFault(input: { runId: string; sessionId: string }): {
    faultId: string;
    runId: string;
    phase: "after-snapshot-retained";
    armedAt: number;
  } {
    const existing = this.sql
      .exec(
        "SELECT fault_id,armed_at,session_id FROM development_test_faults WHERE run_id=?",
        input.runId
      )
      .toArray()[0];
    if (existing) {
      if (String(existing["session_id"]) !== input.sessionId) {
        throw coded("EIDEMPOTENCYDRIFT", "Fault run id belongs to another session");
      }
      return {
        faultId: String(existing["fault_id"]),
        runId: input.runId,
        phase: "after-snapshot-retained",
        armedAt: Number(existing["armed_at"]),
      };
    }
    const armedAt = Date.now();
    const faultId = `development-fault-${createHash("sha256")
      .update(`${input.runId}\0${input.sessionId}`)
      .digest("hex")
      .slice(0, 24)}`;
    this.sql.exec(
      `INSERT INTO development_test_faults(run_id,session_id,fault_id,armed_at)
       VALUES (?,?,?,?)`,
      input.runId,
      input.sessionId,
      faultId,
      armedAt
    );
    return { faultId, runId: input.runId, phase: "after-snapshot-retained", armedAt };
  }

  consumeSnapshotFault(runId: string): string | null {
    const row = this.sql
      .exec("SELECT fault_id FROM development_test_faults WHERE run_id=?", runId)
      .toArray()[0];
    if (!row) return null;
    this.sql.exec("DELETE FROM development_test_faults WHERE run_id=?", runId);
    return String(row["fault_id"]);
  }

  private requireSession(sessionId: string): DevelopmentSession {
    const session = this.getSession(sessionId);
    if (!session) throw coded("ENOENT", `Unknown development session ${sessionId}`);
    return session;
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
    const nextRow = this.sql
      .exec(
        `SELECT COALESCE(MAX(sequence),0)+1 AS next
         FROM development_run_events WHERE run_id=?`,
        runId
      )
      .one();
    const event = developmentRunEventSchema.parse({
      sequence: Number(nextRow["next"]),
      at,
      kind,
      payload,
    });
    this.sql.exec(
      `INSERT INTO development_run_events(run_id,sequence,at,kind,payload_json)
       VALUES (?,?,?,?,?)`,
      runId,
      event.sequence,
      event.at,
      event.kind,
      canonicalJson(event.payload)
    );
    return event;
  }
}

export function developmentSessionId(ownerKey: string, idempotencyKey: string): string {
  return `development-${createHash("sha256")
    .update(`development-session:v1\0${ownerKey}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
