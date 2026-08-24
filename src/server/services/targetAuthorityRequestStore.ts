import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AuthorityGrantSubject, ResourceScope, TargetAuthorityRequest } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import { stateLayout } from "../stateLayout.js";
import { TARGET_AUTHORITY_REQUEST_SCHEMA } from "./targetAuthorityRequestSchema.js";

export interface DurableTargetAuthorityRequest extends TargetAuthorityRequest {
  capabilityDefinitionDigest: string;
  review: import("@vibestudio/rpc").CompiledAuthorityPlanLeaf["review"];
}

export class TargetAuthorityRequestStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(opts: { statePath: string }) {
    this.databasePath = stateLayout(opts.statePath).authority.targetRequestsDb;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    openCanonicalSqliteDatabase(this.db, TARGET_AUTHORITY_REQUEST_SCHEMA, {
      description: `target authority request store in ${this.databasePath}`,
    });
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  ensure(
    input: Omit<DurableTargetAuthorityRequest, "v" | "requestId" | "state" | "createdAt">,
    now = Date.now()
  ): DurableTargetAuthorityRequest {
    const requestId = createHash("sha256")
      .update("target-authority-request-v2\0")
      .update(
        canonicalJson({
          targetSubject: input.targetSubject,
          operationKey: input.operationKey,
        })
      )
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO target_authority_requests
      (request_id,target_subject,operation_key,capability,resource_json,tier,state,source_user,capability_definition_digest,review_json,created_at)
      VALUES (?,?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT(target_subject,operation_key) DO NOTHING`
      )
      .run(
        requestId,
        input.targetSubject,
        input.operationKey,
        input.capability,
        canonicalJson(input.resource),
        input.tier,
        input.sourceUser,
        input.capabilityDefinitionDigest,
        canonicalJson(input.review),
        now
      );
    this.db
      .prepare(
        `INSERT INTO target_authority_request_plans
         (request_id,authority_plan_digest,created_at) VALUES (?,?,?)
         ON CONFLICT(request_id,authority_plan_digest) DO NOTHING`
      )
      .run(requestId, input.authorityPlanDigest, now);
    const request = this.require(requestId);
    if (
      request.targetSubject !== input.targetSubject ||
      request.operationKey !== input.operationKey ||
      request.capability !== input.capability ||
      request.capabilityDefinitionDigest !== input.capabilityDefinitionDigest ||
      canonicalJson(request.resource) !== canonicalJson(input.resource) ||
      request.tier !== input.tier ||
      request.sourceUser !== input.sourceUser ||
      canonicalJson(request.review) !== canonicalJson(input.review)
    ) {
      throw new Error(`Target authority request ${requestId} was replayed with different facts`);
    }
    return request;
  }

  registerSubject(
    subject: AuthorityGrantSubject,
    authorityPlanDigest: string,
    ownerUser: `user:${string}`,
    controllerRuntimeId: string,
    now = Date.now()
  ): void {
    this.db
      .prepare(
        `INSERT INTO authority_subjects
      (target_subject,authority_plan_digest,owner_user,controller_runtime_id,state,created_at)
      VALUES (?,?,?,?,'active',?)
      ON CONFLICT(target_subject) DO NOTHING`
      )
      .run(subject, authorityPlanDigest, ownerUser, controllerRuntimeId, now);
    const registered = this.subject(subject);
    if (
      !registered ||
      registered.authorityPlanDigest !== authorityPlanDigest ||
      registered.ownerUser !== ownerUser ||
      registered.controllerRuntimeId !== controllerRuntimeId ||
      registered.state !== "active"
    ) {
      throw new Error(
        `Authority subject ${subject} was replayed with different ownership, controller, or policy`
      );
    }
  }

  subject(subject: AuthorityGrantSubject): {
    authorityPlanDigest: string;
    ownerUser: `user:${string}`;
    controllerRuntimeId: string;
    state: "active" | "retired";
  } | null {
    const row = this.db
      .prepare(
        "SELECT authority_plan_digest,owner_user,controller_runtime_id,state FROM authority_subjects WHERE target_subject=?"
      )
      .get(subject) as Record<string, unknown> | undefined;
    return row
      ? {
          authorityPlanDigest: String(row["authority_plan_digest"]),
          ownerUser: String(row["owner_user"]) as `user:${string}`,
          controllerRuntimeId: String(row["controller_runtime_id"]),
          state: String(row["state"]) as "active" | "retired",
        }
      : null;
  }

  retireSubject(subject: AuthorityGrantSubject, now = Date.now()): { cancelledRequests: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE authority_subjects SET state='retired',retired_at=? WHERE target_subject=? AND state='active'"
        )
        .run(now, subject);
      if (Number(changed.changes) === 0) {
        const existing = this.subject(subject);
        if (!existing) throw new Error(`Unknown authority subject ${subject}`);
        if (existing.state !== "retired")
          throw new Error(`Authority subject ${subject} could not be retired`);
      }
      const cancelled = this.db
        .prepare(
          "UPDATE target_authority_requests SET state='cancelled',settled_at=? WHERE target_subject=? AND state='pending'"
        )
        .run(now, subject);
      this.db.exec("COMMIT");
      return { cancelledRequests: Number(cancelled.changes) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  settle(
    requestId: string,
    state: "granted" | "denied" | "cancelled",
    grantId?: string,
    now = Date.now()
  ): void {
    this.db
      .prepare(
        "UPDATE target_authority_requests SET state=?, settled_at=?, grant_id=? WHERE request_id=? AND state='pending'"
      )
      .run(state, now, grantId ?? null, requestId);
  }

  pending(): DurableTargetAuthorityRequest[] {
    return (
      this.db
        .prepare(
          `SELECT requests.*, MIN(links.authority_plan_digest) AS authority_plan_digest
           FROM target_authority_requests AS requests
           JOIN target_authority_request_plans AS links USING (request_id)
           WHERE requests.state='pending'
           GROUP BY requests.request_id
           ORDER BY requests.created_at, requests.request_id`
        )
        .all() as Record<string, unknown>[]
    ).map(row);
  }

  forPlan(
    subject: AuthorityGrantSubject,
    authorityPlanDigest: string
  ): DurableTargetAuthorityRequest[] {
    return (
      this.db
        .prepare(
          `SELECT requests.*, links.authority_plan_digest
           FROM target_authority_requests AS requests
           JOIN target_authority_request_plans AS links USING (request_id)
           WHERE requests.target_subject=? AND links.authority_plan_digest=?
           ORDER BY requests.created_at, requests.request_id`
        )
        .all(subject, authorityPlanDigest) as Record<string, unknown>[]
    ).map(row);
  }

  pendingForInvocation(input: {
    targetSubject: AuthorityGrantSubject;
    capability: string;
    capabilityDefinitionDigest: string;
    resource: ResourceScope;
  }): DurableTargetAuthorityRequest | null {
    const value = this.db
      .prepare(
        `SELECT requests.*, links.authority_plan_digest
         FROM target_authority_requests AS requests
         JOIN target_authority_request_plans AS links USING (request_id)
         WHERE requests.target_subject=? AND requests.capability=?
           AND requests.capability_definition_digest=? AND requests.resource_json=?
           AND requests.state='pending'
         ORDER BY requests.created_at, requests.request_id, links.authority_plan_digest
         LIMIT 1`
      )
      .get(
        input.targetSubject,
        input.capability,
        input.capabilityDefinitionDigest,
        canonicalJson(input.resource)
      ) as Record<string, unknown> | undefined;
    return value ? row(value) : null;
  }

  get(requestId: string): DurableTargetAuthorityRequest | null {
    const value = this.db
      .prepare(
        `SELECT requests.*, links.authority_plan_digest
         FROM target_authority_requests AS requests
         JOIN target_authority_request_plans AS links USING (request_id)
         WHERE requests.request_id=?
         ORDER BY links.authority_plan_digest LIMIT 1`
      )
      .get(requestId) as Record<string, unknown> | undefined;
    return value ? row(value) : null;
  }

  private require(requestId: string): DurableTargetAuthorityRequest {
    const value = this.get(requestId);
    if (!value) throw new Error(`Target authority request ${requestId} was not persisted`);
    return value;
  }
  close(): void {
    this.db.close();
  }
}

function row(value: Record<string, unknown>): DurableTargetAuthorityRequest {
  return {
    v: 1,
    requestId: String(value["request_id"]),
    targetSubject: String(value["target_subject"]) as AuthorityGrantSubject,
    authorityPlanDigest: String(value["authority_plan_digest"]),
    operationKey: String(value["operation_key"]),
    capability: String(value["capability"]),
    resource: JSON.parse(String(value["resource_json"])) as ResourceScope,
    tier: String(value["tier"]) as "gated" | "critical",
    state: String(value["state"]) as DurableTargetAuthorityRequest["state"],
    sourceUser: String(value["source_user"]) as `user:${string}`,
    capabilityDefinitionDigest: String(value["capability_definition_digest"]),
    review: JSON.parse(String(value["review_json"])) as DurableTargetAuthorityRequest["review"],
    createdAt: Number(value["created_at"]),
    ...(value["settled_at"] == null ? {} : { settledAt: Number(value["settled_at"]) }),
    ...(value["grant_id"] == null ? {} : { grantId: String(value["grant_id"]) }),
  };
}
