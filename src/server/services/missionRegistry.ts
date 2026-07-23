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
  type MissionState,
} from "@vibestudio/shared/authority/mission";
import { stateLayout } from "../stateLayout.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MISSION_MIGRATION_PLAN } from "./missionSchema.js";

export interface MissionPermission {
  capability: string;
  resource: ResourceScope;
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
      forkOwner?: { userId: string; deviceId: string };
    }
  ): MissionRecord {
    const current = this.require(missionId);
    if (current.state === "retired") throw coded("Retired missions cannot be edited", "EACCES");
    if (current.seeded) {
      if (!input.forkOwner) {
        throw coded("Editing a product mission requires a human-owned fork", "EACCES");
      }
      return this.createDraft({
        name: input.name ?? `${current.name} (custom)`,
        charter: input.charter ?? current.charter,
        owner: input.forkOwner,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    }
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
    decidedBy: `user:${string}`;
    contextIntegrityReady: boolean;
    now?: number;
  }): MissionRecord {
    if (!input.contextIntegrityReady)
      throw coded("Unattended automations require the trust update", "EAGAIN");
    const current = this.require(input.missionId);
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
    const subject = missionSubject(current);
    for (const permission of input.permissions) {
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
      if (
        grant.effect === "allow" &&
        grant.subject.startsWith(`mission:${current.missionId}@`) &&
        grant.id
      ) {
        this.opts.grantStore.revoke(grant.id, now);
      }
    }
    for (const permission of input.permissions) {
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
    this.db
      .prepare("UPDATE missions SET state='active', updated_at=? WHERE mission_id=?")
      .run(now, current.missionId);
    return this.require(current.missionId);
  }

  pause(missionId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
    if (current.state !== "active") throw coded("Only active missions can be paused", "EACCES");
    this.db
      .prepare("UPDATE missions SET state='paused',updated_at=? WHERE mission_id=?")
      .run(now, missionId);
    return this.require(missionId);
  }

  resume(missionId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
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

  retire(missionId: string, now = Date.now()): MissionRecord {
    const current = this.require(missionId);
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

  private require(missionId: string): MissionRecord {
    const found = this.get(missionId);
    if (!found) throw coded(`Unknown mission ${missionId}`, "ENOENT");
    return found;
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

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
