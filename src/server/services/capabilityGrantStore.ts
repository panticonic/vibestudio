import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type {
  AuthorityGrant,
  AuthorityGrantSubject,
  AuthorityLock,
  Principal,
  ResourceScope,
} from "@vibestudio/rpc";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { scopeCovers } from "@vibestudio/shared/authorization";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { capabilityDomain } from "@vibestudio/shared/authority/capabilityDomains";
import type { ApprovalResourceScope } from "@vibestudio/shared/approvals";
import type {
  ApprovalPrincipal,
  UserlandApprovalGrant,
  UserlandApprovalGrantScope,
  UserlandApprovalIssuer,
  UserlandApprovalSubject,
} from "@vibestudio/shared/approvals";
import { stateLayout } from "../stateLayout.js";
import { AUTHORITY_GRANTS_MIGRATION_PLAN } from "./authorityGrantSchema.js";

export interface IssueAuthorityGrantInput {
  id?: string;
  effect: "allow" | "deny";
  capability: string;
  resource: ResourceScope;
  subject: AuthorityGrantSubject;
  constraints?: AuthorityGrant["constraints"];
  issuedBy: string;
  provenance: "acquisition" | "critical-confirmation" | "preauthorization" | "install" | "seed";
  createdAt?: number;
  expiresAt?: number;
  scope?: AuthorityGrant["scope"];
  suspendedAt?: number;
  lastUsedAt?: number;
  decidedBy?: string;
  decisionSurface?: string;
}

export interface PreauthorizationEnvelopeInput {
  envelopeId?: string;
  sessionId: string;
  taskRef: string;
  missionSubject?: `mission:${string}`;
  createdBy: `user:${string}`;
  createdAt?: number;
  rules: readonly {
    capability: string;
    resource: ResourceScope;
    worstCaseSeverity: "routine" | "sensitive";
  }[];
}

export class CapabilityGrantStore {
  private readonly db: DatabaseSync;
  private readonly agentGrantWithdrawalListeners = new Set<
    (grant: AuthorityGrant, at: number) => void
  >();
  readonly databasePath: string;

  constructor(opts: { statePath: string }) {
    const layout = stateLayout(opts.statePath);
    this.databasePath = layout.authority.grantsDb;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      openCanonicalSqliteDatabase(this.db, AUTHORITY_GRANTS_MIGRATION_PLAN, {
        description: `authority grant store in ${this.databasePath}`,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close();
      throw new Error(
        `Authority grant store ${this.databasePath} cannot be loaded without risking data loss: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  close(): void {
    this.db.close();
  }

  issue(input: IssueAuthorityGrantInput): AuthorityGrant {
    validateGrantInput(input);
    const id = input.id ?? ulid(input.createdAt);
    const createdAt = input.createdAt ?? Date.now();
    const constraints = input.constraints ?? {};
    this.db
      .prepare(
        `INSERT INTO authority_grants (
          id, effect, capability, resource_key, resource_scope, subject,
          session_id, invocation_digest, mission_subject, envelope_id,
          agent_binding_id, lineage_at_consent, issued_by, provenance, created_at, expires_at,
          revoked_at, consumed_at, scope, suspended_at, last_used_at,
          decided_by, decision_surface, task_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.effect,
        input.capability,
        resourceKeyOf(input.resource),
        input.resource.kind,
        input.subject,
        constraints.sessionId ?? null,
        constraints.invocationDigest ?? null,
        constraints.missionSubject ?? null,
        constraints.envelopeId ?? null,
        constraints.agentBindingId ?? null,
        canonicalJson([...(constraints.lineageAtConsent ?? [])].sort()),
        input.issuedBy,
        input.provenance,
        createdAt,
        input.expiresAt ?? null,
        input.scope ?? inferGrantScope(input),
        input.suspendedAt ?? null,
        input.lastUsedAt ?? null,
        input.decidedBy ?? null,
        input.decisionSurface ?? null,
        constraints.taskRef ?? null
      );
    return {
      id,
      effect: input.effect,
      capability: input.capability,
      resource: input.resource,
      subject: input.subject,
      constraints: { ...constraints },
      issuedBy: input.issuedBy,
      provenance: input.provenance,
      createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      scope: input.scope ?? inferGrantScope(input),
      ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
      ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
    };
  }

  grantsForSubjects(
    subjects: readonly AuthorityGrantSubject[],
    capability: string,
    now = Date.now()
  ): AuthorityGrant[] {
    if (subjects.length === 0) return [];
    this.suspendIdleAgentGrants(now);
    const found: AuthorityGrant[] = [];
    for (const chunk of chunks([...new Set(subjects)], 300)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT * FROM authority_grants
           WHERE subject IN (${placeholders})
             AND revoked_at IS NULL
             AND suspended_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`
        )
        .all(...chunk, now) as GrantRow[];
      for (const row of rows) {
        if (capabilityPatternCovers(String(row["capability"]), capability))
          found.push(rowToGrant(row));
      }
    }
    return found;
  }

  consume(grantId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE authority_grants SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL
           AND invocation_digest IS NOT NULL`
      )
      .run(now, grantId);
    return Number(result.changes) === 1;
  }

  revoke(grantId: string, now = Date.now()): boolean {
    const grant = this.listAuthorityGrants().find((candidate) => candidate.id === grantId);
    const result = this.db
      .prepare("UPDATE authority_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, grantId);
    const changed = Number(result.changes) === 1;
    if (changed && grant?.scope === "agent") this.emitAgentGrantWithdrawal(grant, now);
    return changed;
  }

  touch(grantId: string, now = Date.now()): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE authority_grants SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND suspended_at IS NULL"
          )
          .run(now, grantId).changes
      ) === 1
    );
  }

  suspendIdleAgentGrants(now = Date.now(), idleMs = 90 * 24 * 60 * 60 * 1_000): number {
    const cutoff = now - idleMs;
    const candidates = this.listAgentAuthorityGrants().filter(
      (grant) => grant.suspendedAt === undefined && (grant.lastUsedAt ?? grant.createdAt) <= cutoff
    );
    const changed = Number(
      this.db
        .prepare(
          `UPDATE authority_grants SET suspended_at = ?
           WHERE scope = 'agent' AND revoked_at IS NULL AND suspended_at IS NULL
             AND COALESCE(last_used_at, created_at) <= ?`
        )
        .run(now, cutoff).changes
    );
    for (const grant of candidates) this.emitAgentGrantWithdrawal(grant, now);
    return changed;
  }

  restore(grantId: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE authority_grants SET suspended_at = NULL WHERE id = ? AND revoked_at IS NULL AND suspended_at IS NOT NULL"
          )
          .run(grantId).changes
      ) === 1
    );
  }

  createLock(input: {
    id?: string;
    agentBindingId: string;
    level: AuthorityLock["level"];
    capability?: string;
    resource?: ResourceScope;
    domain?: string;
    verb?: string;
    decidedBy: string;
    surface: AuthorityLock["surface"];
    createdAt?: number;
  }): AuthorityLock {
    const id = input.id ?? ulid(input.createdAt);
    const createdAt = input.createdAt ?? Date.now();
    if (!input.agentBindingId.trim()) throw new Error("Lock agent binding is required");
    if (
      (input.level === "resource" && (!input.capability || !input.resource)) ||
      (input.level === "capability" && (!input.capability || input.resource)) ||
      (input.level === "cell" && (!input.domain || !input.verb))
    ) {
      throw new Error(`Invalid ${input.level} authority lock`);
    }
    this.db
      .prepare(
        `INSERT INTO authority_locks (
          id, agent_binding_id, level, capability, resource_key, resource_scope,
          domain, verb, decided_by, decision_surface, created_at, revoked_at,
          attempt_count, last_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`
      )
      .run(
        id,
        input.agentBindingId,
        input.level,
        input.capability ?? null,
        input.resource ? resourceKeyOf(input.resource) : null,
        input.resource?.kind ?? null,
        input.domain ?? null,
        input.verb ?? null,
        input.decidedBy,
        input.surface,
        createdAt
      );
    return {
      id,
      agentBindingId: input.agentBindingId,
      level: input.level,
      ...(input.capability ? { capability: input.capability } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.verb ? { verb: input.verb } : {}),
      decidedBy: input.decidedBy,
      surface: input.surface,
      createdAt,
      attemptCount: 0,
    };
  }

  matchingLocks(
    agentBindingId: string,
    capability: string,
    resourceKey: string,
    now = Date.now()
  ): AuthorityLock[] {
    const category = capabilityDomain(capability);
    const rows = this.db
      .prepare(
        `SELECT * FROM authority_locks
         WHERE agent_binding_id = ? AND revoked_at IS NULL
           AND (
             (level = 'resource' AND capability = ?) OR
             (level = 'capability' AND capability = ?) OR
             (level = 'cell' AND domain = ? AND verb = ?)
           )
         ORDER BY created_at ASC, id ASC`
      )
      .all(
        agentBindingId,
        capability,
        capability,
        category?.domain ?? "-",
        category?.verb ?? "-"
      ) as GrantRow[];
    const locks = rows.map(rowToLock).filter((lock) => {
      return (
        lock.level !== "resource" || (lock.resource && scopeCovers(lock.resource, resourceKey))
      );
    });
    const firstLock = locks[0];
    if (firstLock) {
      this.db
        .prepare(
          `UPDATE authority_locks SET attempt_count = attempt_count + 1, last_attempt_at = ?
           WHERE id = ?`
        )
        .run(now, firstLock.id);
      locks[0] = {
        ...firstLock,
        attemptCount: firstLock.attemptCount + 1,
        lastAttemptAt: now,
      };
    }
    return locks;
  }

  listLocks(agentBindingId?: string): AuthorityLock[] {
    const rows = agentBindingId
      ? this.db
          .prepare(
            "SELECT * FROM authority_locks WHERE agent_binding_id = ? ORDER BY created_at DESC"
          )
          .all(agentBindingId)
      : this.db.prepare("SELECT * FROM authority_locks ORDER BY created_at DESC").all();
    return (rows as GrantRow[]).map(rowToLock);
  }

  revokeLock(lockId: string, now = Date.now()): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE authority_locks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, lockId).changes
      ) === 1
    );
  }

  pruneSession(sessionId: string, now = Date.now()): number {
    const result = this.db
      .prepare(
        "UPDATE authority_grants SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL"
      )
      .run(now, sessionId);
    return Number(result.changes);
  }

  listAuthorityGrants(): AuthorityGrant[] {
    return (
      this.db
        .prepare("SELECT * FROM authority_grants ORDER BY created_at DESC, id DESC")
        .all() as GrantRow[]
    ).map(rowToGrant);
  }

  priorInteractiveApprovalCount(input: {
    agentBindingId: string;
    capability: string;
    resource: ResourceScope;
  }): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM authority_grants
         WHERE effect='allow' AND provenance='acquisition'
           AND agent_binding_id=? AND capability=?
           AND resource_key=? AND resource_scope=?
           AND scope IN ('once','task')`
      )
      .get(
        input.agentBindingId,
        input.capability,
        resourceKeyOf(input.resource),
        input.resource.kind
      ) as { count: SQLOutputValue };
    return Number(row.count);
  }

  listActiveAuthorityGrants(now = Date.now()): AuthorityGrant[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM authority_grants
           WHERE revoked_at IS NULL AND consumed_at IS NULL
             AND suspended_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at DESC, id DESC`
        )
        .all(now) as GrantRow[]
    ).map(rowToGrant);
  }

  listAgentAuthorityGrants(agentBindingId?: string): AuthorityGrant[] {
    const subject = agentBindingId ? `agent:${agentBindingId}` : null;
    const rows = subject
      ? this.db
          .prepare(
            `SELECT * FROM authority_grants
             WHERE scope = 'agent' AND subject = ? AND revoked_at IS NULL
               AND consumed_at IS NULL
             ORDER BY created_at DESC, id DESC`
          )
          .all(subject)
      : this.db
          .prepare(
            `SELECT * FROM authority_grants
             WHERE scope = 'agent' AND revoked_at IS NULL AND consumed_at IS NULL
             ORDER BY created_at DESC, id DESC`
          )
          .all();
    return (rows as GrantRow[]).map(rowToGrant);
  }

  onAgentGrantWithdrawal(listener: (grant: AuthorityGrant, at: number) => void): () => void {
    this.agentGrantWithdrawalListeners.add(listener);
    return () => this.agentGrantWithdrawalListeners.delete(listener);
  }

  resetAgentAuthority(
    agentBindingId: string,
    options: { keepLocks: boolean },
    now = Date.now()
  ): { grants: number; locks: number } {
    let grants = 0;
    let locks = 0;
    const withdrawn = this.listAgentAuthorityGrants(agentBindingId);
    this.transaction(() => {
      grants = Number(
        this.db
          .prepare(
            `UPDATE authority_grants SET revoked_at = ?
             WHERE subject = ? AND scope = 'agent' AND revoked_at IS NULL`
          )
          .run(now, `agent:${agentBindingId}`).changes
      );
      if (!options.keepLocks) {
        locks = Number(
          this.db
            .prepare(
              `UPDATE authority_locks SET revoked_at = ?
               WHERE agent_binding_id = ? AND revoked_at IS NULL`
            )
            .run(now, agentBindingId).changes
        );
      }
    });
    for (const grant of withdrawn) this.emitAgentGrantWithdrawal(grant, now);
    return { grants, locks };
  }

  private emitAgentGrantWithdrawal(grant: AuthorityGrant, at: number): void {
    for (const listener of this.agentGrantWithdrawalListeners) listener(grant, at);
  }

  createEnvelope(input: PreauthorizationEnvelopeInput): string {
    if (input.rules.some((rule) => rule.worstCaseSeverity === ("critical" as string))) {
      throw new Error("Critical worst-case rules cannot enter a preauthorization envelope");
    }
    const envelopeId = input.envelopeId ?? ulid(input.createdAt);
    const createdAt = input.createdAt ?? Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO preauth_envelopes
           (envelope_id, session_id, task_ref, mission_subject, state, created_by, created_at, closed_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`
        )
        .run(
          envelopeId,
          input.sessionId,
          input.taskRef,
          input.missionSubject ?? null,
          input.createdBy,
          createdAt
        );
      const insert = this.db.prepare(
        `INSERT INTO envelope_rules
         (envelope_id, capability, resource_key, resource_scope, worst_case_severity)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const rule of input.rules) {
        insert.run(
          envelopeId,
          rule.capability,
          resourceKeyOf(rule.resource),
          rule.resource.kind,
          rule.worstCaseSeverity
        );
      }
    });
    return envelopeId;
  }

  envelopeAllows(input: {
    envelopeId: string;
    sessionId: string;
    taskRef: string;
    missionSubject?: `mission:${string}`;
    capability: string;
    resourceKey: string;
  }): boolean {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM envelope_rules r
         JOIN preauth_envelopes e ON e.envelope_id = r.envelope_id
         WHERE e.envelope_id = ? AND e.state = 'active' AND e.session_id = ? AND e.task_ref = ?
           AND ((e.mission_subject IS NULL AND ? IS NULL) OR e.mission_subject = ?)`
      )
      .all(
        input.envelopeId,
        input.sessionId,
        input.taskRef,
        input.missionSubject ?? null,
        input.missionSubject ?? null
      ) as EnvelopeRuleRow[];
    return rows.some(
      (row) =>
        capabilityPatternCovers(String(row["capability"]), input.capability) &&
        scopeCovers(
          scopeFromRow(String(row["resource_scope"]), String(row["resource_key"])),
          input.resourceKey
        )
    );
  }

  closeEnvelope(envelopeId: string, now = Date.now()): boolean {
    let changed = false;
    this.transaction(() => {
      changed =
        Number(
          this.db
            .prepare(
              "UPDATE preauth_envelopes SET state = 'closed', closed_at = ? WHERE envelope_id = ? AND state = 'active'"
            )
            .run(now, envelopeId).changes
        ) === 1;
      if (changed) {
        this.db
          .prepare(
            "UPDATE authority_grants SET revoked_at = ? WHERE envelope_id = ? AND revoked_at IS NULL"
          )
          .run(now, envelopeId);
      }
    });
    return changed;
  }

  lookupUserland(
    principal: ApprovalPrincipal,
    subjectId: string,
    issuer?: UserlandApprovalIssuer
  ): UserlandApprovalGrant | null {
    return (
      this.userlandRows(principal, subjectId, issuer).find(
        (entry) => entry.grant.scope === "session"
      )?.grant ??
      this.userlandRows(principal, subjectId, issuer).find(
        (entry) => entry.grant.scope === "caller"
      )?.grant ??
      this.userlandRows(principal, subjectId, issuer).find(
        (entry) => entry.grant.scope === "version"
      )?.grant ??
      null
    );
  }

  async recordUserland(
    principal: ApprovalPrincipal,
    subject: UserlandApprovalSubject,
    choice: string,
    now = Date.now(),
    issuer?: UserlandApprovalIssuer,
    scope: UserlandApprovalGrantScope = "caller",
    decision?: {
      provenance: IssueAuthorityGrantInput["provenance"];
      decidedBy: string;
    }
  ): Promise<void> {
    const effectiveIssuer = issuer ?? {
      kind: principal.callerKind,
      id: scope === "version" ? principal.repoPath : principal.callerId,
    };
    const subjectPrincipal = userlandSubject(principal, scope);
    this.transaction(() => {
      this.revokeUserlandRows(principal, subject.id, effectiveIssuer, scope, now);
      this.issue({
        effect: choice === "deny" ? "deny" : "allow",
        capability: userlandCapability(effectiveIssuer, choice),
        resource: { kind: "exact", key: subject.id },
        subject: subjectPrincipal,
        constraints:
          scope === "session"
            ? { sessionId: principal.callerId, lineageAtConsent: [] }
            : { lineageAtConsent: [] },
        issuedBy: userlandIssuedBy(principal),
        provenance: decision?.provenance ?? "acquisition",
        createdAt: now,
        ...(decision?.decidedBy ? { decidedBy: decision.decidedBy } : {}),
      });
    });
  }

  async revokeUserland(
    principal: ApprovalPrincipal,
    subjectId: string,
    issuer?: UserlandApprovalIssuer,
    now = Date.now()
  ): Promise<boolean> {
    const rows = this.userlandRows(principal, subjectId, issuer);
    let changed = false;
    this.transaction(() => {
      for (const row of rows) changed = this.revoke(row.id, now) || changed;
    });
    return changed;
  }

  listUserland(
    principal: ApprovalPrincipal,
    issuer?: UserlandApprovalIssuer
  ): UserlandApprovalGrant[] {
    return this.userlandRows(principal, undefined, issuer).map((entry) => entry.grant);
  }

  listPersistentUserland(): Array<{ id: string; grant: UserlandApprovalGrant }> {
    return this.allUserlandRows()
      .filter((entry) => entry.grant.scope !== "session")
      .map(({ id, grant }) => ({ id, grant }));
  }

  revokePersistentUserland(id: string, now = Date.now()): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM authority_grants
         WHERE id = ? AND capability LIKE 'userland.choice/%' AND session_id IS NULL`
      )
      .get(id);
    return row ? this.revoke(id, now) : false;
  }

  private userlandRows(
    principal: ApprovalPrincipal,
    subjectId?: string,
    issuer?: UserlandApprovalIssuer
  ): Array<{ id: string; grant: UserlandApprovalGrant }> {
    const candidates = this.allUserlandRows().filter(({ grant }) => {
      if (subjectId !== undefined && grant.subject.id !== subjectId) return false;
      if (!userlandGrantApplies(grant, principal)) return false;
      const effectiveIssuer = userlandEffectiveIssuer(grant);
      const expectedIssuer =
        issuer ??
        (grant.scope === "version"
          ? { kind: principal.callerKind, id: principal.repoPath }
          : { kind: principal.callerKind, id: principal.callerId });
      return (
        effectiveIssuer.kind === expectedIssuer.kind && effectiveIssuer.id === expectedIssuer.id
      );
    });
    return candidates.sort((left, right) => right.grant.grantedAt - left.grant.grantedAt);
  }

  private allUserlandRows(): Array<{ id: string; grant: UserlandApprovalGrant }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM authority_grants
         WHERE capability LIKE 'userland.choice/%'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id DESC`
      )
      .all(Date.now()) as GrantRow[];
    return rows.map((row) => ({
      id: String(row["id"]),
      grant: userlandGrantFromRow(row),
    }));
  }

  private revokeUserlandRows(
    principal: ApprovalPrincipal,
    subjectId: string,
    issuer: UserlandApprovalIssuer,
    scope: UserlandApprovalGrantScope,
    now: number
  ): void {
    for (const row of this.userlandRows(principal, subjectId, issuer)) {
      if (row.grant.scope === scope) this.revoke(row.id, now);
    }
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

type GrantRow = Record<string, SQLOutputValue>;
type EnvelopeRuleRow = Record<string, SQLOutputValue>;

const USERLAND_CAPABILITY_PREFIX = "userland.choice/";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decoded(value: string, label: string): string {
  try {
    const result = Buffer.from(value, "base64url").toString("utf8");
    if (encoded(result) !== value) throw new Error("non-canonical encoding");
    return result;
  } catch (error) {
    throw new Error(`Invalid ${label} encoding`, { cause: error });
  }
}

function userlandCapability(issuer: UserlandApprovalIssuer, choice: string): string {
  return `${USERLAND_CAPABILITY_PREFIX}${issuer.kind}/${encoded(issuer.id)}/${encoded(choice)}`;
}

function parseUserlandCapability(capability: string): {
  issuer: UserlandApprovalIssuer;
  choice: string;
} {
  const parts = capability.split("/");
  const [prefix, kind, issuerId, choice] = parts;
  if (
    parts.length !== 4 ||
    prefix !== "userland.choice" ||
    !kind ||
    !issuerId ||
    !choice ||
    !["panel", "app", "worker", "do", "extension"].includes(kind)
  ) {
    throw new Error(`Invalid userland approval capability ${capability}`);
  }
  return {
    issuer: {
      kind: kind as UserlandApprovalIssuer["kind"],
      id: decoded(issuerId, "userland issuer"),
    },
    choice: decoded(choice, "userland choice"),
  };
}

function userlandIssuedBy(principal: ApprovalPrincipal): string {
  return [
    "userland",
    principal.callerKind,
    encoded(principal.callerId),
    encoded(principal.repoPath),
    encoded(principal.effectiveVersion),
  ].join(":");
}

function parseUserlandIssuedBy(value: string): ApprovalPrincipal {
  const parts = value.split(":");
  const [prefix, callerKind, callerId, repoPath, effectiveVersion] = parts;
  if (
    parts.length !== 5 ||
    prefix !== "userland" ||
    !callerKind ||
    !callerId ||
    !repoPath ||
    !effectiveVersion ||
    !["panel", "app", "worker", "do", "extension"].includes(callerKind)
  ) {
    throw new Error(`Invalid userland approval issuer principal ${value}`);
  }
  return {
    callerKind: callerKind as ApprovalPrincipal["callerKind"],
    callerId: decoded(callerId, "userland caller"),
    repoPath: decoded(repoPath, "userland repository"),
    effectiveVersion: decoded(effectiveVersion, "userland effective version"),
  };
}

function userlandSubject(
  principal: ApprovalPrincipal,
  scope: UserlandApprovalGrantScope
): Principal {
  if (scope === "version") {
    const caller = userlandVersionGrantRequiresCaller(principal)
      ? encoded(principal.callerId)
      : "-";
    return `code:userland/${encoded(principal.repoPath)}/${caller}@${encoded(principal.effectiveVersion)}`;
  }
  return `session:userland/${encoded(principal.callerId)}`;
}

function userlandGrantFromRow(row: GrantRow): UserlandApprovalGrant {
  const { issuer, choice } = parseUserlandCapability(String(row["capability"]));
  const principal = parseUserlandIssuedBy(String(row["issued_by"]));
  const subject = String(row["subject"]);
  const scope: UserlandApprovalGrantScope = subject.startsWith("code:userland/")
    ? "version"
    : row["session_id"] === null
      ? "caller"
      : "session";
  if (scope === "version") {
    const match = /^code:userland\/([^/]+)\/([^@]+)@(.+)$/.exec(subject);
    if (!match) throw new Error(`Invalid version-scoped userland subject ${subject}`);
    const [, repository, , effectiveVersion] = match;
    if (!repository || !effectiveVersion) {
      throw new Error(`Invalid version-scoped userland subject ${subject}`);
    }
    principal.repoPath = decoded(repository, "userland subject repository");
    principal.effectiveVersion = decoded(effectiveVersion, "userland subject effective version");
  } else if (!subject.startsWith("session:userland/")) {
    throw new Error(`Invalid caller-scoped userland subject ${subject}`);
  }
  return {
    principal: {
      callerId: principal.callerId,
      callerKind: principal.callerKind,
      repoPath: principal.repoPath,
      effectiveVersion: principal.effectiveVersion,
    },
    issuer,
    subject: { id: String(row["resource_key"]) },
    choice,
    grantedAt: Number(row["created_at"]),
    scope,
  };
}

function userlandEffectiveIssuer(grant: UserlandApprovalGrant): UserlandApprovalIssuer {
  if (grant.issuer) return grant.issuer;
  if ((grant.scope ?? "caller") === "version" && grant.principal.repoPath) {
    return { kind: grant.principal.callerKind, id: grant.principal.repoPath };
  }
  return { kind: grant.principal.callerKind, id: grant.principal.callerId };
}

function userlandGrantApplies(grant: UserlandApprovalGrant, principal: ApprovalPrincipal): boolean {
  if ((grant.scope ?? "caller") !== "version") {
    return grant.principal.callerId === principal.callerId;
  }
  return (
    grant.principal.callerKind === principal.callerKind &&
    (!userlandVersionGrantRequiresCaller(grant.principal) ||
      grant.principal.callerId === principal.callerId) &&
    grant.principal.repoPath === principal.repoPath &&
    grant.principal.effectiveVersion === principal.effectiveVersion
  );
}

function userlandVersionGrantRequiresCaller(
  principal: Pick<UserlandApprovalGrant["principal"], "repoPath" | "effectiveVersion">
): boolean {
  return principal.effectiveVersion === "internal" || principal.repoPath === "vibestudio/internal";
}

function rowToGrant(row: GrantRow): AuthorityGrant {
  const subject = String(row["subject"]) as AuthorityGrantSubject;
  if (!/^(host|user|code|session|mission|agent):/.test(subject))
    throw new Error(`Invalid grant subject ${subject}`);
  const lineage = JSON.parse(String(row["lineage_at_consent"])) as unknown;
  if (!Array.isArray(lineage) || !lineage.every((value) => typeof value === "string")) {
    throw new Error(`Grant ${String(row["id"])} has invalid lineage_at_consent`);
  }
  const constraints = {
    ...(row["session_id"] === null ? {} : { sessionId: String(row["session_id"]) }),
    ...(row["invocation_digest"] === null
      ? {}
      : { invocationDigest: String(row["invocation_digest"]) }),
    ...(row["mission_subject"] === null
      ? {}
      : { missionSubject: String(row["mission_subject"]) as `mission:${string}` }),
    ...(row["agent_binding_id"] === null
      ? {}
      : { agentBindingId: String(row["agent_binding_id"]) }),
    ...(row["envelope_id"] === null ? {} : { envelopeId: String(row["envelope_id"]) }),
    ...(row["task_ref"] === null ? {} : { taskRef: String(row["task_ref"]) }),
    lineageAtConsent: lineage,
  };
  return {
    id: String(row["id"]),
    effect: String(row["effect"]) as "allow" | "deny",
    capability: String(row["capability"]),
    resource: scopeFromRow(String(row["resource_scope"]), String(row["resource_key"])),
    subject,
    constraints,
    issuedBy: String(row["issued_by"]),
    provenance: String(row["provenance"]),
    createdAt: Number(row["created_at"]),
    ...(row["expires_at"] === null ? {} : { expiresAt: Number(row["expires_at"]) }),
    ...(row["revoked_at"] === null ? {} : { revokedAt: Number(row["revoked_at"]) }),
    ...(row["consumed_at"] === null ? {} : { consumedAt: Number(row["consumed_at"]) }),
    ...(row["suspended_at"] === null ? {} : { suspendedAt: Number(row["suspended_at"]) }),
    ...(row["last_used_at"] === null ? {} : { lastUsedAt: Number(row["last_used_at"]) }),
    scope: String(row["scope"]) as NonNullable<AuthorityGrant["scope"]>,
  };
}

function rowToLock(row: GrantRow): AuthorityLock {
  return {
    id: String(row["id"]),
    agentBindingId: String(row["agent_binding_id"]),
    level: String(row["level"]) as AuthorityLock["level"],
    ...(row["capability"] === null ? {} : { capability: String(row["capability"]) }),
    ...(row["resource_key"] === null || row["resource_scope"] === null
      ? {}
      : {
          resource: scopeFromRow(String(row["resource_scope"]), String(row["resource_key"])),
        }),
    ...(row["domain"] === null ? {} : { domain: String(row["domain"]) }),
    ...(row["verb"] === null ? {} : { verb: String(row["verb"]) }),
    decidedBy: String(row["decided_by"]),
    surface: String(row["decision_surface"]) as AuthorityLock["surface"],
    createdAt: Number(row["created_at"]),
    ...(row["revoked_at"] === null ? {} : { revokedAt: Number(row["revoked_at"]) }),
    attemptCount: Number(row["attempt_count"]),
    ...(row["last_attempt_at"] === null ? {} : { lastAttemptAt: Number(row["last_attempt_at"]) }),
  };
}

function validateGrantInput(input: IssueAuthorityGrantInput): void {
  if (!input.capability.trim()) throw new Error("Grant capability is required");
  if (!/^(host|user|code|session|mission|agent):.+/.test(input.subject))
    throw new Error("Grant subject is not canonical");
  if (input.provenance === "critical-confirmation") {
    if (
      input.effect !== "allow" ||
      !input.subject.startsWith("session:") ||
      !input.constraints?.invocationDigest
    ) {
      throw new Error(
        "Critical confirmation must be a session allow bound to an invocation digest"
      );
    }
  }
  if (input.effect === "allow" && input.constraints?.lineageAtConsent === undefined) {
    throw new Error("Every allow grant must record lineageAtConsent");
  }
}

function inferGrantScope(input: IssueAuthorityGrantInput): NonNullable<AuthorityGrant["scope"]> {
  if (input.subject.startsWith("agent:")) return "agent";
  if (input.subject.startsWith("mission:")) return "mission";
  if (input.constraints?.invocationDigest) return "once";
  if (input.constraints?.taskRef) return "task";
  if (input.constraints?.sessionId) return "session";
  if (input.subject.startsWith("code:")) return "version";
  return "system";
}

function scopeFromRow(kind: string, key: string): ResourceScope {
  switch (kind) {
    case "exact":
      return { kind, key };
    case "prefix":
      return { kind, prefix: key };
    case "origin":
      return { kind, origin: key };
    case "domain":
      return { kind, domain: key };
    case "network":
      return { kind, value: "*" };
    default:
      throw new Error(`Unknown authority resource scope ${kind}`);
  }
}

function resourceKeyOf(scope: ResourceScope): string {
  switch (scope.kind) {
    case "exact":
      return scope.key;
    case "prefix":
      return scope.prefix;
    case "origin":
      return scope.origin;
    case "domain":
      return scope.domain;
    case "network":
      return "*";
  }
}

export function authorityResourceForApprovalScope(scope: ApprovalResourceScope): ResourceScope {
  switch (scope.kind) {
    case "exact":
      return { kind: "exact", key: scope.key };
    case "origin":
      return { kind: "origin", origin: scope.origin };
    case "domain":
      return { kind: "domain", domain: scope.domain };
    case "network":
      return { kind: "network", value: "*" };
  }
}

export function approvalScopeForAuthorityResource(scope: ResourceScope): ApprovalResourceScope {
  switch (scope.kind) {
    case "exact":
      return { kind: "exact", key: scope.key };
    case "origin":
      return { kind: "origin", origin: scope.origin };
    case "domain":
      return { kind: "domain", domain: scope.domain };
    case "network":
      return { kind: "network", value: "*" };
    case "prefix":
      return { kind: "exact", key: scope.prefix };
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(at = Date.now()): string {
  if (!Number.isSafeInteger(at) || at < 0 || at > 0xffffffffffff)
    throw new Error("ULID timestamp is out of range");
  let time = BigInt(at);
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD.charAt(Number(time & 31n)) + head;
    time >>= 5n;
  }
  const bytes = randomBytes(10);
  let random = 0n;
  for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  let tail = "";
  for (let index = 0; index < 16; index += 1) {
    tail = CROCKFORD.charAt(Number(random & 31n)) + tail;
    random >>= 5n;
  }
  return head + tail;
}
