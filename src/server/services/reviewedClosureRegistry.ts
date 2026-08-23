import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type { AuthorityGrantSubject, SessionReviewedClosureFact } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  compiledExposureAllowsService,
  compiledExposureAllowsUserlandService,
  compiledExposureNetworkRedirectPolicy,
  reviewedExecutionClosureDigest,
  type ReviewedExecutionClosureBody,
} from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { stateLayout } from "../stateLayout.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { REVIEWED_CLOSURE_SCHEMA } from "./reviewedClosureSchema.js";

export interface ReviewedClosureRecord extends ReviewedExecutionClosureBody {
  subject: AuthorityGrantSubject;
  closureDigest: string;
  state: "active" | "suspended" | "retired";
  activatedAt: number;
  updatedAt: number;
}

type Row = Record<string, SQLOutputValue>;

export class ReviewedClosureRegistry {
  private readonly db: DatabaseSync;
  private readonly stopGrantWithdrawalListener: () => void;

  constructor(
    private readonly opts: {
      statePath: string;
      grantStore: CapabilityGrantStore;
      isHarnessBlessed: (harness: ReviewedExecutionClosureBody["harness"]) => boolean;
    }
  ) {
    const databasePath = stateLayout(opts.statePath).authority.reviewedClosuresDb;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    openCanonicalSqliteDatabase(this.db, REVIEWED_CLOSURE_SCHEMA, {
      description: `reviewed execution closures in ${databasePath}`,
    });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.stopGrantWithdrawalListener = opts.grantStore.onAgentGrantWithdrawal((grant, at) => {
      this.suspendForDependencyWithdrawal(grant, at);
    });
  }

  close(): void {
    this.stopGrantWithdrawalListener();
    this.db.close();
  }

  activate(input: {
    body: ReviewedExecutionClosureBody;
    closureDigest: string;
    publisher: string;
    decidedBy: `user:${string}`;
    now?: number;
  }): ReviewedClosureRecord {
    const actualDigest = reviewedExecutionClosureDigest(input.body);
    if (input.closureDigest !== actualDigest) {
      throw coded("Reviewed closure digest does not match its compiled body", "EACCES");
    }
    if (!this.opts.isHarnessBlessed(input.body.harness)) {
      throw coded("Reviewed closure harness is not blessed at this exact version", "EACCES");
    }
    if (input.body.issuer !== input.publisher) {
      throw coded("Reviewed closure issuer does not match its authenticated publisher", "EACCES");
    }
    for (const grant of input.body.grants) {
      if (grant.effect === "allow" && grant.tier !== "gated") {
        throw coded("Critical authority cannot become a standing closure grant", "EACCES");
      }
    }
    for (const dependency of input.body.grantDependencies) {
      const active = this.opts.grantStore
        .grantsForSubjects([authoritySubject(dependency.subject)], dependency.capability, input.now)
        .some(
          (grant) =>
            grant.effect === "allow" &&
            grant.capability === dependency.capability &&
            canonicalJson(grant.resource) === canonicalJson(dependency.resource)
        );
      if (!active) {
        throw coded(
          `Reviewed closure dependency is not active: ${dependency.subject} ${dependency.capability}`,
          "EACCES"
        );
      }
    }
    const subject = authoritySubject(`${input.body.subjectPrefix}@${actualDigest}`);
    const existing = this.get(subject);
    if (existing?.state === "retired") {
      throw coded("A retired reviewed closure subject cannot be reactivated", "EACCES");
    }
    const now = input.now ?? Date.now();
    this.revokeSubjectGrants(subject, now);
    try {
      for (const grant of input.body.grants) {
        this.opts.grantStore.issue({
          effect: grant.effect,
          capability: grant.capability,
          resource: grant.resource,
          subject,
          constraints: {
            lineageAtConsent: [...input.body.lineageClasses],
            ...(subject.startsWith("mission:")
              ? { reviewedClosureSubject: subject as `mission:${string}` }
              : {}),
          },
          issuedBy: input.body.issuer,
          provenance: "acquisition",
          createdAt: now,
          decidedBy: input.decidedBy,
        });
      }
    } catch (error) {
      this.revokeSubjectGrants(subject, now);
      throw error;
    }
    this.db
      .prepare(
        `INSERT INTO reviewed_closures
         (subject,closure_digest,body_json,state,activated_at,updated_at)
         VALUES (?,?,?,'active',?,?)
         ON CONFLICT(subject) DO UPDATE SET
           closure_digest=excluded.closure_digest,
           body_json=excluded.body_json,
           state='active',
           activated_at=excluded.activated_at,
           updated_at=excluded.updated_at`
      )
      .run(subject, actualDigest, canonicalJson(input.body), now, now);
    return this.require(subject);
  }

  suspend(subjectInput: string, issuer: string, now = Date.now()): ReviewedClosureRecord {
    const subject = authoritySubject(subjectInput);
    const current = this.require(subject);
    if (current.issuer !== issuer) {
      throw coded("Only the reviewed closure issuer may suspend it", "EACCES");
    }
    return this.suspendRecord(current, now);
  }

  private suspendRecord(current: ReviewedClosureRecord, now: number): ReviewedClosureRecord {
    const subject = current.subject;
    if (current.state === "retired") throw coded("Reviewed closure is retired", "EACCES");
    this.revokeSubjectGrants(subject, now);
    this.db
      .prepare("UPDATE reviewed_closures SET state='suspended',updated_at=? WHERE subject=?")
      .run(now, subject);
    this.finishSubjectSessions(subject, now);
    return this.require(subject);
  }

  retire(subjectInput: string, issuer: string, now = Date.now()): ReviewedClosureRecord {
    const subject = authoritySubject(subjectInput);
    const current = this.require(subject);
    if (current.issuer !== issuer) {
      throw coded("Only the reviewed closure issuer may retire it", "EACCES");
    }
    this.revokeSubjectGrants(subject, now);
    this.db
      .prepare("UPDATE reviewed_closures SET state='retired',updated_at=? WHERE subject=?")
      .run(now, subject);
    this.finishSubjectSessions(subject, now);
    return this.require(subject);
  }

  bindSession(input: {
    subject: string;
    closureDigest: string;
    sessionId: string;
    taskRef: string;
    binderId: string;
    now?: number;
  }): SessionReviewedClosureFact {
    const closure = this.require(authoritySubject(input.subject));
    if (
      closure.state !== "active" ||
      closure.closureDigest !== input.closureDigest ||
      !this.opts.isHarnessBlessed(closure.harness)
    ) {
      throw coded("Reviewed closure is not active at the requested digest", "EACCES");
    }
    if (input.binderId !== closure.issuer) {
      throw coded("Only the reviewed closure issuer may bind its sessions", "EACCES");
    }
    const now = input.now ?? Date.now();
    const existing = this.db
      .prepare("SELECT * FROM reviewed_closure_sessions WHERE session_id=?")
      .get(input.sessionId) as Row | undefined;
    if (existing) {
      if (
        String(existing["subject"]) === closure.subject &&
        String(existing["closure_digest"]) === closure.closureDigest &&
        String(existing["task_ref"]) === input.taskRef &&
        String(existing["binder_id"]) === input.binderId &&
        existing["finished_at"] === null
      ) {
        return sessionFact(closure);
      }
      throw coded("Session is already bound to another reviewed closure", "EACCES");
    }
    this.db
      .prepare(
        `INSERT INTO reviewed_closure_sessions
         (session_id,subject,closure_digest,task_ref,binder_id,started_at,finished_at)
         VALUES (?,?,?,?,?,?,NULL)`
      )
      .run(
        input.sessionId,
        closure.subject,
        closure.closureDigest,
        input.taskRef,
        input.binderId,
        now
      );
    return sessionFact(closure);
  }

  finishSession(sessionId: string, binderId: string, now = Date.now()): void {
    const existing = this.db
      .prepare(`SELECT binder_id,finished_at FROM reviewed_closure_sessions WHERE session_id=?`)
      .get(sessionId) as { binder_id: string; finished_at: number | null } | undefined;
    if (!existing) throw coded("Unknown reviewed closure session", "ENOENT");
    if (existing.binder_id !== binderId) {
      throw coded("Only the session binder may finish a reviewed closure session", "EACCES");
    }
    if (existing.finished_at !== null) return;
    this.db
      .prepare(`UPDATE reviewed_closure_sessions SET finished_at=? WHERE session_id=?`)
      .run(now, sessionId);
  }

  factForSession(sessionId: string): SessionReviewedClosureFact | null {
    const closure = this.closureForSession(sessionId);
    return closure && this.opts.isHarnessBlessed(closure.harness) ? sessionFact(closure) : null;
  }

  sourceForSession(sessionId: string): {
    issuer: string;
    sourceDocument: ReviewedExecutionClosureBody["sourceDocument"];
  } | null {
    const closure = this.closureForSession(sessionId);
    return closure
      ? { issuer: closure.issuer, sourceDocument: { ...closure.sourceDocument } }
      : null;
  }

  assertServiceExposure(sessionId: string, qualifiedMethod: string): void {
    const closure = this.closureForSession(sessionId);
    if (!closure) return;
    this.assertBlessed(closure);
    if (!compiledExposureAllowsService(closure.exposure, qualifiedMethod)) {
      throw coded(
        `Reviewed closure ${closure.subject} does not expose ${qualifiedMethod}`,
        "EMISSIONSCOPE"
      );
    }
  }

  assertUserlandServiceExposure(input: {
    sessionId: string;
    name: string;
    provider: string;
    providerEv: string;
  }): void {
    const closure = this.closureForSession(input.sessionId);
    if (!closure) return;
    this.assertBlessed(closure);
    if (!compiledExposureAllowsUserlandService(closure.exposure, input)) {
      throw coded(
        `Reviewed closure ${closure.subject} does not expose workspace service ${input.name} from this provider build`,
        "EMISSIONSCOPE"
      );
    }
  }

  assertNetworkExposure(sessionId: string, origin: string): boolean {
    const closure = this.closureForSession(sessionId);
    if (!closure) return false;
    this.assertBlessed(closure);
    const policy = compiledExposureNetworkRedirectPolicy(closure.exposure, origin);
    if (policy === "deny") {
      throw coded(
        `Reviewed closure ${closure.subject} ${
          closure.exposure.network.mode === "none"
            ? "does not expose network egress"
            : `does not expose network origin ${origin}`
        }`,
        "EMISSIONSCOPE"
      );
    }
    return policy === "allow-without-redirects";
  }

  get(subjectInput: string): ReviewedClosureRecord | null {
    const row = this.db
      .prepare("SELECT * FROM reviewed_closures WHERE subject=?")
      .get(subjectInput) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  private require(subject: string): ReviewedClosureRecord {
    const closure = this.get(subject);
    if (!closure) throw coded(`Unknown reviewed closure ${subject}`, "ENOENT");
    return closure;
  }

  private closureForSession(sessionId: string): ReviewedClosureRecord | null {
    const row = this.db
      .prepare(
        `SELECT c.* FROM reviewed_closure_sessions s
         JOIN reviewed_closures c ON c.subject=s.subject
         WHERE s.session_id=? AND s.finished_at IS NULL AND c.state='active'
           AND c.closure_digest=s.closure_digest`
      )
      .get(sessionId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  private assertBlessed(closure: ReviewedClosureRecord): void {
    if (!this.opts.isHarnessBlessed(closure.harness)) {
      throw coded(`Reviewed closure ${closure.subject} is no longer blessed`, "EACCES");
    }
  }

  private revokeSubjectGrants(subject: AuthorityGrantSubject, now: number): void {
    for (const grant of this.opts.grantStore.listAuthorityGrants()) {
      if (grant.subject === subject && grant.id && grant.revokedAt === undefined) {
        this.opts.grantStore.revoke(grant.id, now);
      }
    }
  }

  private finishSubjectSessions(subject: AuthorityGrantSubject, now: number): void {
    this.db
      .prepare(
        "UPDATE reviewed_closure_sessions SET finished_at=? WHERE subject=? AND finished_at IS NULL"
      )
      .run(now, subject);
  }

  private suspendForDependencyWithdrawal(
    withdrawn: import("@vibestudio/rpc").AuthorityGrant,
    now: number
  ): void {
    const rows = this.db
      .prepare("SELECT * FROM reviewed_closures WHERE state='active'")
      .all() as Row[];
    for (const row of rows) {
      const closure = rowToRecord(row);
      if (
        closure.grantDependencies.some(
          (dependency) =>
            dependency.subject === withdrawn.subject &&
            dependency.capability === withdrawn.capability &&
            canonicalJson(dependency.resource) === canonicalJson(withdrawn.resource)
        )
      ) {
        this.suspendRecord(closure, now);
      }
    }
  }
}

function rowToRecord(row: Row): ReviewedClosureRecord {
  const body = JSON.parse(String(row["body_json"])) as ReviewedExecutionClosureBody;
  const closureDigest = reviewedExecutionClosureDigest(body);
  if (closureDigest !== String(row["closure_digest"])) {
    throw new Error(`Reviewed closure ${String(row["subject"])} has an invalid digest cache`);
  }
  return {
    ...body,
    subject: authoritySubject(String(row["subject"])),
    closureDigest,
    state: String(row["state"]) as ReviewedClosureRecord["state"],
    activatedAt: Number(row["activated_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function authoritySubject(value: string): AuthorityGrantSubject {
  if (!/^(?:mission|agent|user|code|session|host):\S+$/u.test(value)) {
    throw new Error("Reviewed closure subject is not a canonical authority principal");
  }
  return value as AuthorityGrantSubject;
}

function sessionFact(closure: ReviewedClosureRecord): SessionReviewedClosureFact {
  return {
    subject: closure.subject,
    closureDigest: closure.closureDigest,
    harness: { ...closure.harness },
  };
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
