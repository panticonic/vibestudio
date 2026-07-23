import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type { ResourceScope, SessionMissionFact } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  missionAllowsService,
  missionClosureDigest,
  missionFact,
  missionSubject,
  type MissionCharter,
  type MissionRecord,
  type MissionStandingRestriction,
  type MissionState,
} from "@vibestudio/shared/authority/mission";
import { stateLayout } from "../stateLayout.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MISSION_MIGRATION_PLAN } from "./missionSchema.js";

export interface MissionPermission {
  capability: string;
  resource: ResourceScope;
}

export interface SeededMissionInput {
  productSnapshotState: string;
  missionId: string;
  name: string;
  charter: MissionCharter;
  permissions: readonly MissionPermission[];
  standingRestrictions?: readonly MissionStandingRestriction[];
  now?: number;
}

/** Host-owned mission identity, revisions, session bindings, and closure enforcement. */
export class MissionRegistry {
  private readonly db: DatabaseSync;

  constructor(
    private readonly opts: {
      statePath: string;
      grantStore: CapabilityGrantStore;
      isConduitBlessed: (identity: MissionCharter["harness"]) => boolean;
    }
  ) {
    const databasePath = stateLayout(opts.statePath).governance.missionsDb;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      openCanonicalSqliteDatabase(this.db, MISSION_MIGRATION_PLAN, {
        description: `mission registry in ${databasePath}`,
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

  createDraft(input: {
    name: string;
    charter: MissionCharter;
    owner: { userId: string; deviceId: string };
    missionId?: string;
    seeded?: boolean;
    now?: number;
  }): MissionRecord {
    const now = input.now ?? Date.now();
    const missionId = input.missionId ?? `msn_${randomBytes(18).toString("base64url")}`;
    if (
      !/^msn_[A-Za-z0-9_-]+$/.test(missionId) ||
      !input.name.trim() ||
      !input.owner.userId ||
      !input.owner.deviceId
    ) {
      throw new Error("Mission identity, name, and owner are required");
    }
    const closureDigest = missionClosureDigest(input.charter);
    this.db
      .prepare(
        `INSERT INTO missions
      (mission_id,name,revision,charter_json,owner_user_id,owner_device_id,state,closure_digest,standing_restrictions_json,seeded,created_at,updated_at)
      VALUES (?,?,1,?,?,?,'draft',?,'[]',?,?,?)`
      )
      .run(
        missionId,
        input.name,
        canonicalJson(input.charter),
        input.owner.userId,
        input.owner.deviceId,
        closureDigest,
        input.seeded ? 1 : 0,
        now,
        now
      );
    return this.require(missionId);
  }

  edit(
    missionId: string,
    input: {
      name?: string;
      charter?: MissionCharter;
      now?: number;
      actingUserId: string;
      forkOwner?: { userId: string; deviceId: string };
    }
  ): MissionRecord {
    const current = this.require(missionId);
    if (current.state === "retired") throw coded("Retired missions cannot be edited", "EACCES");
    if (current.seeded) {
      if (!input.forkOwner || input.forkOwner.userId !== input.actingUserId) {
        throw coded("Editing a product mission requires a human-owned fork", "EACCES");
      }
      return this.createDraft({
        name: input.name ?? `${current.name} (custom)`,
        charter: input.charter ?? current.charter,
        owner: input.forkOwner,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    }
    this.assertOwnedBy(current, input.actingUserId);
    const now = input.now ?? Date.now();
    const charter = input.charter ?? current.charter;
    const digest = missionClosureDigest(charter);
    const charterChanged = digest !== current.closureDigest;
    const nextState: MissionState =
      charterChanged && current.state !== "draft" ? "needs-reapproval" : current.state;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO mission_revisions
        (mission_id,revision,charter_json,closure_digest,recorded_at) VALUES (?,?,?,?,?)`
        )
        .run(
          current.missionId,
          current.revision,
          canonicalJson(current.charter),
          current.closureDigest,
          now
        );
      this.db
        .prepare(
          `UPDATE missions SET name=?,revision=?,charter_json=?,state=?,closure_digest=?,updated_at=? WHERE mission_id=?`
        )
        .run(
          input.name ?? current.name,
          current.revision + 1,
          canonicalJson(charter),
          nextState,
          digest,
          now,
          missionId
        );
    });
    return this.require(missionId);
  }

  approve(input: {
    missionId: string;
    permissions: readonly MissionPermission[];
    standingRestrictions?: readonly MissionStandingRestriction[];
    decidedBy: `user:${string}`;
    contextIntegrityReady: boolean;
    now?: number;
  }): MissionRecord {
    if (!input.contextIntegrityReady)
      throw coded("Unattended automations require the trust update", "EAGAIN");
    const current = this.require(input.missionId);
    this.assertOwnedBy(current, userIdFromPrincipal(input.decidedBy));
    if (current.state !== "draft" && current.state !== "needs-reapproval") {
      throw coded(
        `Mission ${current.missionId} cannot be approved from ${current.state}`,
        "EACCES"
      );
    }
    const digest = missionClosureDigest(current.charter);
    if (digest !== current.closureDigest)
      throw new Error("Mission closure cache disagrees with its charter");
    if (!this.opts.isConduitBlessed(current.charter.harness)) {
      throw coded(
        "Mission harness is not a product-blessed conduit at this exact version",
        "EACCES"
      );
    }
    const permissions = normalizePermissions(input.permissions);
    const standingRestrictions = normalizeStandingRestrictions(
      input.standingRestrictions ?? current.standingRestrictions ?? []
    );
    const subject = missionSubject(current);
    for (const permission of permissions) {
      if (!missionAllowsCapability(current.charter, permission.capability)) {
        throw coded(
          `Mission permission ${permission.capability} exceeds tool exposure`,
          "EMISSIONSCOPE"
        );
      }
    }
    const now = input.now ?? Date.now();
    // The registry and grants intentionally live in separate canonical DBs.
    // Mint while the mission is still inert, then expose it with the final
    // state flip: every interruption therefore fails closed.
    for (const grant of this.opts.grantStore.listAuthorityGrants()) {
      if (grant.subject.startsWith(`mission:${current.missionId}@`) && grant.id) {
        this.opts.grantStore.revoke(grant.id, now);
      }
    }
    for (const permission of permissions) {
      this.opts.grantStore.issue({
        effect: "allow",
        capability: permission.capability,
        resource: permission.resource,
        subject,
        constraints: { lineageAtConsent: [] },
        issuedBy: input.decidedBy,
        provenance: current.seeded ? "seed" : "acquisition",
        createdAt: now,
      });
    }
    for (const restriction of standingRestrictions) {
      this.opts.grantStore.issue({
        effect: "deny",
        capability: restriction.capability,
        resource: { kind: "exact", key: restriction.resourceKey },
        subject,
        constraints: { lineageAtConsent: [] },
        issuedBy: input.decidedBy,
        provenance: "acquisition",
        createdAt: now,
      });
    }
    this.db
      .prepare(
        "UPDATE missions SET state='active', standing_restrictions_json=?, updated_at=? WHERE mission_id=?"
      )
      .run(canonicalJson(standingRestrictions), now, current.missionId);
    return this.require(current.missionId);
  }

  /**
   * Reconcile one host-shipped mission against an immutable product snapshot.
   *
   * The mission is made inert in the registry before grants are touched. Since
   * the mission registry and grant store are separate canonical databases,
   * this ordering is the cross-store transaction boundary: interruption can
   * leave an inert mission with partial/unreachable grants, never an active
   * mission with incomplete authority.
   */
  upsertSeeded(input: SeededMissionInput): MissionRecord {
    if (!/^state:[0-9a-f]{64}$/u.test(input.productSnapshotState)) {
      throw new Error("Seeded missions require a canonical product snapshot state");
    }
    if (!/^msn_[A-Za-z0-9_-]+$/u.test(input.missionId) || !input.name.trim()) {
      throw new Error("Seeded missions require a canonical mission id and name");
    }
    if (!this.opts.isConduitBlessed(input.charter.harness)) {
      throw coded("Seeded mission harness is not blessed from this product snapshot", "EACCES");
    }
    const permissions = normalizePermissions(input.permissions);
    for (const permission of permissions) {
      if (!missionAllowsCapability(input.charter, permission.capability)) {
        throw coded(
          `Seeded mission permission ${permission.capability} exceeds tool exposure`,
          "EMISSIONSCOPE"
        );
      }
    }
    const standingRestrictions = normalizeStandingRestrictions(input.standingRestrictions ?? []);
    const closureDigest = missionClosureDigest(input.charter);
    const existing = this.get(input.missionId);
    if (existing && existing.seeded !== true) {
      throw coded(`Mission id ${input.missionId} is already user-owned`, "EACCES");
    }
    const subject = missionSubject({ missionId: input.missionId, closureDigest });
    if (
      existing?.state === "active" &&
      existing.closureDigest === closureDigest &&
      this.seedSnapshotState(input.missionId) === input.productSnapshotState &&
      this.hasExactActiveSeedGrants(subject, permissions, standingRestrictions)
    ) {
      return existing;
    }

    const now = input.now ?? Date.now();
    this.transaction(() => {
      if (existing) {
        if (existing.closureDigest !== closureDigest) {
          this.db
            .prepare(
              `INSERT INTO mission_revisions
               (mission_id,revision,charter_json,closure_digest,recorded_at)
               VALUES (?,?,?,?,?)`
            )
            .run(
              existing.missionId,
              existing.revision,
              canonicalJson(existing.charter),
              existing.closureDigest,
              now
            );
        }
        this.db
          .prepare(
            `UPDATE missions
             SET name=?,revision=?,charter_json=?,owner_user_id='system',
                 owner_device_id='system',state='needs-reapproval',closure_digest=?,
                 standing_restrictions_json=?,seeded=1,seed_snapshot_state=?,updated_at=?
             WHERE mission_id=?`
          )
          .run(
            input.name,
            existing.revision + (existing.closureDigest === closureDigest ? 0 : 1),
            canonicalJson(input.charter),
            closureDigest,
            canonicalJson(standingRestrictions),
            input.productSnapshotState,
            now,
            input.missionId
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO missions
             (mission_id,name,revision,charter_json,owner_user_id,owner_device_id,state,
              closure_digest,standing_restrictions_json,seeded,created_at,updated_at,
              seed_snapshot_state)
             VALUES (?,?,1,?,'system','system','needs-reapproval',?,?,1,?,?,?)`
          )
          .run(
            input.missionId,
            input.name,
            canonicalJson(input.charter),
            closureDigest,
            canonicalJson(standingRestrictions),
            now,
            now,
            input.productSnapshotState
          );
      }
    });

    for (const grant of this.opts.grantStore.listAuthorityGrants()) {
      if (grant.subject.startsWith(`mission:${input.missionId}@`) && grant.id) {
        this.opts.grantStore.revoke(grant.id, now);
      }
    }
    for (const permission of permissions) {
      this.opts.grantStore.issue({
        effect: "allow",
        capability: permission.capability,
        resource: permission.resource,
        subject,
        constraints: { lineageAtConsent: [] },
        issuedBy: "host:product-seed",
        provenance: "seed",
        createdAt: now,
      });
    }
    for (const restriction of standingRestrictions) {
      this.opts.grantStore.issue({
        effect: "deny",
        capability: restriction.capability,
        resource: { kind: "exact", key: restriction.resourceKey },
        subject,
        constraints: { lineageAtConsent: [] },
        issuedBy: "host:product-seed",
        provenance: "seed",
        createdAt: now,
      });
    }
    this.db
      .prepare("UPDATE missions SET state='active',updated_at=? WHERE mission_id=?")
      .run(now, input.missionId);
    return this.require(input.missionId);
  }

  pause(missionId: string, actingUserId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
    this.assertOwnedBy(current, actingUserId, { allowSeeded: true });
    if (current.state !== "active") throw coded("Only active missions can be paused", "EACCES");
    this.db
      .prepare("UPDATE missions SET state='paused',updated_at=? WHERE mission_id=?")
      .run(now, missionId);
    return this.require(missionId);
  }

  resume(missionId: string, actingUserId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
    this.assertOwnedBy(current, actingUserId, { allowSeeded: true });
    if (
      current.state !== "paused" ||
      missionClosureDigest(current.charter) !== current.closureDigest ||
      !this.opts.isConduitBlessed(current.charter.harness)
    ) {
      throw coded("Mission must be re-approved before it can resume", "EACCES");
    }
    this.db
      .prepare("UPDATE missions SET state='active',updated_at=? WHERE mission_id=?")
      .run(now, missionId);
    return this.require(missionId);
  }

  retire(missionId: string, actingUserId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
    this.assertOwnedBy(current, actingUserId);
    if (current.state === "retired") return current;
    const prefix = `mission:${missionId}@`;
    for (const grant of this.opts.grantStore.listAuthorityGrants()) {
      if (grant.effect === "allow" && grant.subject.startsWith(prefix) && grant.id)
        this.opts.grantStore.revoke(grant.id, now);
    }
    this.db
      .prepare("UPDATE missions SET state='retired',updated_at=? WHERE mission_id=?")
      .run(now, missionId);
    return this.require(missionId);
  }

  startSession(input: {
    missionId: string;
    sessionId: string;
    taskRef: string;
    runId: string;
    now?: number;
  }): SessionMissionFact {
    const current = this.require(input.missionId);
    if (
      current.state !== "active" ||
      missionClosureDigest(current.charter) !== current.closureDigest
    ) {
      throw coded(`Mission ${current.missionId} is not active at its approved closure`, "EACCES");
    }
    if (!this.opts.isConduitBlessed(current.charter.harness)) {
      throw coded("Mission harness is no longer a product-blessed conduit", "EACCES");
    }
    const fact = missionFact(current);
    const now = input.now ?? Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO mission_sessions
        (session_id,mission_id,closure_digest,task_ref,started_at,ended_at) VALUES (?,?,?,?,?,NULL)`
        )
        .run(input.sessionId, current.missionId, current.closureDigest, input.taskRef, now);
      this.db
        .prepare(
          `INSERT INTO mission_runs
        (run_id,mission_id,closure_digest,session_id,started_at,finished_at,outcome) VALUES (?,?,?,?,?,NULL,NULL)`
        )
        .run(input.runId, current.missionId, current.closureDigest, input.sessionId, now);
    });
    return fact;
  }

  finishSession(input: { sessionId: string; runId: string; outcome: string; now?: number }): void {
    const now = input.now ?? Date.now();
    this.transaction(() => {
      const session = this.db
        .prepare("UPDATE mission_sessions SET ended_at=? WHERE session_id=? AND ended_at IS NULL")
        .run(now, input.sessionId);
      const run = this.db
        .prepare(
          "UPDATE mission_runs SET finished_at=?,outcome=? WHERE run_id=? AND session_id=? AND finished_at IS NULL"
        )
        .run(now, input.outcome, input.runId, input.sessionId);
      if (Number(session.changes) !== 1 || Number(run.changes) !== 1) {
        throw coded("Mission session or run is not active", "ENOENT");
      }
    });
  }

  factForSession(sessionId: string): SessionMissionFact | null {
    const row = this.db
      .prepare(
        `SELECT m.* FROM mission_sessions s JOIN missions m ON m.mission_id=s.mission_id
      WHERE s.session_id=? AND s.ended_at IS NULL AND s.closure_digest=m.closure_digest AND m.state='active'`
      )
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    const mission = rowToMission(row);
    return this.opts.isConduitBlessed(mission.charter.harness) ? missionFact(mission) : null;
  }

  assertServiceExposure(sessionId: string, qualifiedMethod: string): void {
    const row = this.db
      .prepare(
        `SELECT m.* FROM mission_sessions s JOIN missions m ON m.mission_id=s.mission_id
      WHERE s.session_id=? AND s.ended_at IS NULL`
      )
      .get(sessionId) as Row | undefined;
    if (!row) return;
    const mission = rowToMission(row);
    if (!this.opts.isConduitBlessed(mission.charter.harness)) {
      throw coded(`Mission ${mission.missionId} no longer has a product-blessed conduit`, "EACCES");
    }
    const isUserlandResolutionBoundary =
      (qualifiedMethod === "workers.resolveService" ||
        qualifiedMethod === "workers.resolveDurableObject") &&
      mission.charter.toolExposure.userlandServices.length > 0;
    if (
      mission.state !== "active" ||
      missionClosureDigest(mission.charter) !== mission.closureDigest ||
      (!isUserlandResolutionBoundary && !missionAllowsService(mission.charter, qualifiedMethod))
    ) {
      throw coded(
        `Mission ${mission.missionId} does not expose ${qualifiedMethod}`,
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
    const fact = this.factForSession(input.sessionId);
    if (!fact) return;
    const mission = this.require(fact.missionId);
    const binding = mission.charter.toolExposure.userlandServices.find(
      (entry) => entry.name === input.name && entry.provider === input.provider
    );
    if (
      !binding ||
      (binding.upgradePolicy === "pinned" && binding.providerEv !== input.providerEv)
    ) {
      throw coded(
        `Mission ${mission.missionId} does not expose workspace service ${input.name} from this provider build`,
        "EMISSIONSCOPE"
      );
    }
  }

  /**
   * Enforce the charter's network reach before egress. Returns true when the
   * proxy must disable automatic redirects so every subsequent origin is a
   * fresh, separately mediated request.
   */
  assertNetworkExposure(sessionId: string, origin: string): boolean {
    const row = this.db
      .prepare(
        `SELECT m.* FROM mission_sessions s JOIN missions m ON m.mission_id=s.mission_id
      WHERE s.session_id=? AND s.ended_at IS NULL`
      )
      .get(sessionId) as Row | undefined;
    if (!row) return false;
    const mission = rowToMission(row);
    if (
      mission.state !== "active" ||
      missionClosureDigest(mission.charter) !== mission.closureDigest ||
      !this.opts.isConduitBlessed(mission.charter.harness)
    ) {
      throw coded(`Mission ${mission.missionId} cannot use network egress`, "EMISSIONSCOPE");
    }
    const policy = mission.charter.toolExposure.evalNetwork;
    if (policy === "none") {
      throw coded(`Mission ${mission.missionId} does not expose network egress`, "EMISSIONSCOPE");
    }
    if (
      policy === "declared-origins" &&
      !mission.charter.toolExposure.declaredOrigins.includes(origin)
    ) {
      throw coded(
        `Mission ${mission.missionId} does not expose network origin ${origin}`,
        "EMISSIONSCOPE"
      );
    }
    return policy === "declared-origins";
  }

  get(missionId: string): MissionRecord | null {
    const row = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId) as
      | Row
      | undefined;
    return row ? rowToMission(row) : null;
  }

  list(): MissionRecord[] {
    return (this.db.prepare("SELECT * FROM missions ORDER BY updated_at DESC").all() as Row[]).map(
      rowToMission
    );
  }

  getForUser(missionId: string, userId: string): MissionRecord | null {
    const mission = this.get(missionId);
    return mission && (mission.seeded === true || mission.owner.userId === userId) ? mission : null;
  }

  listForUser(userId: string): MissionRecord[] {
    return this.list().filter(
      (mission) => mission.seeded === true || mission.owner.userId === userId
    );
  }

  private require(missionId: string): MissionRecord {
    const found = this.get(missionId);
    if (!found) throw coded(`Unknown mission ${missionId}`, "ENOENT");
    return found;
  }

  private seedSnapshotState(missionId: string): string | null {
    const row = this.db
      .prepare("SELECT seed_snapshot_state FROM missions WHERE mission_id=?")
      .get(missionId) as { seed_snapshot_state?: SQLOutputValue } | undefined;
    return row?.seed_snapshot_state == null ? null : String(row.seed_snapshot_state);
  }

  private hasExactActiveSeedGrants(
    subject: `mission:${string}`,
    permissions: readonly MissionPermission[],
    restrictions: readonly MissionStandingRestriction[]
  ): boolean {
    const actual = this.opts.grantStore
      .listActiveAuthorityGrants()
      .filter((grant) => grant.subject === subject)
      .map((grant) =>
        canonicalJson({
          effect: grant.effect,
          capability: grant.capability,
          resource: grant.resource,
          provenance: grant.provenance,
        })
      )
      .sort();
    const expected = [
      ...permissions.map((permission) =>
        canonicalJson({
          effect: "allow",
          capability: permission.capability,
          resource: permission.resource,
          provenance: "seed",
        })
      ),
      ...restrictions.map((restriction) =>
        canonicalJson({
          effect: "deny",
          capability: restriction.capability,
          resource: { kind: "exact", key: restriction.resourceKey },
          provenance: "seed",
        })
      ),
    ].sort();
    return canonicalJson(actual) === canonicalJson(expected);
  }

  private assertOwnedBy(
    mission: MissionRecord,
    userId: string,
    opts: { allowSeeded?: boolean } = {}
  ): void {
    if (mission.seeded === true && opts.allowSeeded === true) return;
    if (mission.seeded === true || mission.owner.userId !== userId) {
      throw coded(`Mission ${mission.missionId} is not owned by this user`, "EACCES");
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

type Row = Record<string, SQLOutputValue>;

function rowToMission(row: Row): MissionRecord {
  const charter = JSON.parse(String(row["charter_json"])) as MissionCharter;
  const closureDigest = missionClosureDigest(charter);
  if (closureDigest !== String(row["closure_digest"]))
    throw new Error(`Mission ${String(row["mission_id"])} has an invalid closure cache`);
  return {
    missionId: String(row["mission_id"]),
    name: String(row["name"]),
    revision: Number(row["revision"]),
    charter,
    owner: { userId: String(row["owner_user_id"]), deviceId: String(row["owner_device_id"]) },
    state: String(row["state"]) as MissionState,
    closureDigest,
    standingRestrictions: JSON.parse(
      String(row["standing_restrictions_json"])
    ) as MissionRecord["standingRestrictions"],
    seeded: Number(row["seeded"]) === 1,
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function capabilityMethod(capability: string): string {
  return capability.startsWith("service:") ? capability.slice("service:".length) : capability;
}

function missionAllowsCapability(charter: MissionCharter, capability: string): boolean {
  if (capability.startsWith("workspace-service:")) {
    const name = capability.slice("workspace-service:".length);
    return charter.toolExposure.userlandServices.some((binding) => binding.name === name);
  }
  return missionAllowsService(charter, capabilityMethod(capability));
}

function normalizePermissions(input: readonly MissionPermission[]): MissionPermission[] {
  const normalized = input.map((permission) => {
    const capability = permission.capability.trim();
    if (!capability) throw new Error("Mission permission capability is required");
    validateResourceScope(permission.resource);
    return { capability, resource: permission.resource };
  });
  assertNoDuplicateCanonicalRows(normalized, "mission permission");
  return normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizeStandingRestrictions(
  input: readonly MissionStandingRestriction[]
): MissionStandingRestriction[] {
  const normalized = input.map((restriction) => {
    const capability = restriction.capability.trim();
    if (!capability || !restriction.resourceKey) {
      throw new Error("Mission standing restriction capability and resource are required");
    }
    return { capability, resourceKey: restriction.resourceKey };
  });
  assertNoDuplicateCanonicalRows(normalized, "mission standing restriction");
  return normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function validateResourceScope(resource: ResourceScope): void {
  const key =
    resource.kind === "exact"
      ? resource.key
      : resource.kind === "prefix"
        ? resource.prefix
        : resource.kind === "origin"
          ? resource.origin
          : resource.kind === "domain"
            ? resource.domain
            : resource.value;
  if (!key) throw new Error("Mission permission resource is required");
}

function assertNoDuplicateCanonicalRows(input: readonly unknown[], label: string): void {
  const keys = input.map(canonicalJson);
  if (new Set(keys).size !== keys.length) throw new Error(`Duplicate ${label}`);
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function userIdFromPrincipal(principal: `user:${string}`): string {
  const userId = principal.slice("user:".length);
  if (!userId) throw coded("Mission approval requires a human user", "EACCES");
  return userId;
}
