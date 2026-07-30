import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionPermission,
  MissionRecord,
  MissionRunRecord,
  MissionStandingRestriction,
  MissionState,
} from "@vibestudio/shared/authority/mission";
import {
  missionClosureDigest,
} from "@vibestudio/shared/authority/mission";
import {
  compileMissionExposure,
  reviewedExecutionClosureDigest,
  type ReviewedExecutionClosureBody,
} from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { HOST_AUTHORITY_METHODS } from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { receiverAuthorityPolicy } from "@vibestudio/shared/authority/receiverAuthorityPolicy";

interface MissionRow {
  mission_id: string;
  name: string;
  revision: number;
  charter_json: string;
  permissions_json: string;
  standing_restrictions_json: string;
  owner_user_id: string;
  owner_device_id: string;
  state: MissionState;
  revision_digest: string;
  active_closure_digest: string | null;
  seeded: number;
  created_at: number;
  updated_at: number;
}

export class MissionsDO extends DurableObjectBase {
  static override rpcMethods = missionsMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE missions (
      mission_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      charter_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      standing_restrictions_json TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      owner_device_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft','active','needs-reapproval','paused','retired')),
      revision_digest TEXT NOT NULL,
      active_closure_digest TEXT,
      seeded INTEGER NOT NULL CHECK (seeded IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, revision)
    )`);
    this.sql.exec(`CREATE TABLE mission_runs (
      run_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      closure_digest TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT
    )`);
    this.sql.exec(
      `CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)`
    );
  }

  protected override requiredTables(): readonly string[] {
    return ["missions", "mission_revisions", "mission_runs"];
  }

  @schemaRpc()
  list(): MissionRecord[] {
    const userId = this.requireUser();
    return this.sql
      .exec(
        `SELECT * FROM missions
         WHERE seeded=1 OR owner_user_id=?
         ORDER BY updated_at DESC`,
        userId
      )
      .toArray()
      .map((row) => this.rowToMission(row as unknown as MissionRow));
  }

  @schemaRpc()
  get(missionId: string): MissionRecord | null {
    const row = this.getRow(missionId);
    if (!row) return null;
    this.requireVisible(row);
    return this.rowToMission(row);
  }

  @schemaRpc()
  listRuns(missionId: string): MissionRunRecord[] {
    this.requireMission(missionId);
    return this.sql
      .exec(
        `SELECT * FROM mission_runs WHERE mission_id=?
         ORDER BY started_at DESC,run_id DESC`,
        missionId
      )
      .toArray()
      .map((row) => ({
        runId: String(row["run_id"]),
        missionId: String(row["mission_id"]),
        closureDigest: String(row["closure_digest"]),
        sessionId: String(row["session_id"]),
        startedAt: Number(row["started_at"]),
        ...(row["finished_at"] == null ? {} : { finishedAt: Number(row["finished_at"]) }),
        ...(row["outcome"] == null ? {} : { outcome: String(row["outcome"]) }),
      }));
  }

  @schemaRpc()
  createDraft(input: {
    name: string;
    charter: MissionCharter;
    permissions: MissionPermission[];
    standingRestrictions?: MissionStandingRestriction[];
  }): MissionRecord {
    const caller = this.requireHumanCaller();
    const now = Date.now();
    const missionId = `msn_${crypto.randomUUID().replaceAll("-", "")}`;
    const standingRestrictions = input.standingRestrictions ?? [];
    const revisionDigest = missionClosureDigest(
      input.charter,
      input.permissions,
      standingRestrictions
    );
    this.sql.exec(
      `INSERT INTO missions
       (mission_id,name,revision,charter_json,permissions_json,standing_restrictions_json,
        owner_user_id,owner_device_id,state,revision_digest,active_closure_digest,seeded,
        created_at,updated_at)
       VALUES (?,?,1,?,?,?,?,?,'draft',?,NULL,0,?,?)`,
      missionId,
      input.name,
      canonicalJson(input.charter),
      canonicalJson(input.permissions),
      canonicalJson(standingRestrictions),
      caller.userId,
      caller.callerId,
      revisionDigest,
      now,
      now
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async edit(
    missionId: string,
    input: {
      name?: string;
      charter?: MissionCharter;
      permissions?: MissionPermission[];
      standingRestrictions?: MissionStandingRestriction[];
    }
  ): Promise<MissionRecord> {
    const current = this.requireMission(missionId);
    const caller = this.requireHumanCaller();
    if (current.seeded) {
      return this.createDraft({
        name: input.name ?? `${current.name} (custom)`,
        charter: input.charter ?? current.charter,
        permissions: input.permissions ?? [...current.permissions],
        standingRestrictions:
          input.standingRestrictions ?? [...current.standingRestrictions],
      });
    }
    if (current.owner.userId !== caller.userId) throw denied("Mission belongs to another user");
    if (current.state === "retired") throw denied("Retired missions cannot be edited");
    if (current.state === "active" && this.activeSubject(current)) {
      await this.rpc.call("main", "reviewedClosure.suspend", [this.activeSubject(current)]);
    }
    const next: MissionRecord = {
      ...current,
      name: input.name ?? current.name,
      revision: current.revision + 1,
      charter: input.charter ?? current.charter,
      permissions: input.permissions ?? current.permissions,
      standingRestrictions: input.standingRestrictions ?? current.standingRestrictions,
      state: current.state === "draft" ? "draft" : "needs-reapproval",
      updatedAt: Date.now(),
    };
    next.revisionDigest = missionClosureDigest(
      next.charter,
      next.permissions,
      next.standingRestrictions
    );
    this.sql.exec(
      `INSERT INTO mission_revisions (mission_id,revision,record_json,recorded_at)
       VALUES (?,?,?,?)`,
      current.missionId,
      current.revision,
      canonicalJson(current),
      next.updatedAt
    );
    this.sql.exec(
      `UPDATE missions SET name=?,revision=?,charter_json=?,permissions_json=?,
       standing_restrictions_json=?,state=?,revision_digest=?,active_closure_digest=NULL,
       updated_at=? WHERE mission_id=?`,
      next.name,
      next.revision,
      canonicalJson(next.charter),
      canonicalJson(next.permissions),
      canonicalJson(next.standingRestrictions),
      next.state,
      next.revisionDigest,
      next.updatedAt,
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async requestReview(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    if (mission.state !== "draft" && mission.state !== "needs-reapproval") {
      throw denied("Only an inert mission revision can be reviewed");
    }
    const { body, closureDigest } = this.compileClosure(mission);
    await this.rpc.call("main", "reviewedClosure.activate", [
      {
        body,
        closureDigest,
        presentation: {
          title: `Activate ${mission.name}`,
          description:
            "Review the exact harness, service access, workspace-service bindings, network reach, and standing authority for this automation.",
          summary: `${mission.name} will run with the reviewed authority below.`,
          facts: [
            { label: "Harness", value: `${body.harness.unit}@${body.harness.ev}` },
            {
              label: "Service methods",
              value: String(body.exposure.serviceMethods.length),
            },
            { label: "Standing rules", value: String(body.grants.length) },
          ],
        },
      },
    ]);
    const now = Date.now();
    this.sql.exec(
      `UPDATE missions SET state='active',active_closure_digest=?,updated_at=?
       WHERE mission_id=?`,
      closureDigest,
      now,
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async pause(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    const subject = this.requireActiveSubject(mission);
    await this.rpc.call("main", "reviewedClosure.suspend", [subject]);
    this.sql.exec(
      "UPDATE missions SET state='paused',updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async resume(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    if (mission.state !== "paused") throw denied("Only paused missions can resume");
    const { body, closureDigest } = this.compileClosure(mission);
    if (closureDigest !== this.getRow(missionId)?.active_closure_digest) {
      throw denied("Mission must be reviewed again before it can resume");
    }
    await this.rpc.call("main", "reviewedClosure.activate", [
      {
        body,
        closureDigest,
        presentation: {
          title: `Resume ${mission.name}`,
          description: "Resume this unchanged reviewed automation closure.",
          summary: `${mission.name} will resume at its previously reviewed closure.`,
        },
      },
    ]);
    this.sql.exec(
      "UPDATE missions SET state='active',updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async retire(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    const subject = this.activeSubject(mission);
    if (subject) await this.rpc.call("main", "reviewedClosure.retire", [subject]);
    this.sql.exec(
      "UPDATE missions SET state='retired',updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async startSession(input: {
    missionId: string;
    sessionId: string;
    taskRef: string;
    runId: string;
  }): Promise<{ missionId: string; closureDigest: string; harness: { unit: string; ev: string } }> {
    this.requireHost();
    const mission = this.requireMission(input.missionId, true);
    const subject = this.requireActiveSubject(mission);
    const closureDigest = this.getRow(mission.missionId)?.active_closure_digest;
    if (!closureDigest) throw denied("Mission has no active reviewed closure");
    const fact = (await this.rpc.call("main", "reviewedClosure.bindSession", [
      { subject, closureDigest, sessionId: input.sessionId, taskRef: input.taskRef },
    ])) as { closureDigest: string; harness: { unit: string; ev: string } };
    this.sql.exec(
      `INSERT INTO mission_runs
       (run_id,mission_id,closure_digest,session_id,started_at,finished_at,outcome)
       VALUES (?,?,?,?,?,NULL,NULL)`,
      input.runId,
      mission.missionId,
      fact.closureDigest,
      input.sessionId,
      Date.now()
    );
    return { missionId: mission.missionId, ...fact };
  }

  @schemaRpc()
  async finishSession(input: { sessionId: string; runId: string; outcome: string }): Promise<void> {
    this.requireHost();
    await this.rpc.call("main", "reviewedClosure.finishSession", [
      { sessionId: input.sessionId },
    ]);
    this.sql.exec(
      `UPDATE mission_runs SET finished_at=?,outcome=?
       WHERE run_id=? AND session_id=? AND finished_at IS NULL`,
      Date.now(),
      input.outcome,
      input.runId,
      input.sessionId
    );
    if (Number(this.sql.exec(`SELECT changes() AS count`).one()["count"]) !== 1) {
      throw new Error("Mission run is not active");
    }
  }

  @schemaRpc()
  async proposeAuthorityRevision(input: {
    missionId: string;
    capability: string;
    resource: MissionPermission["resource"];
    tier: "gated" | "critical";
  }): Promise<MissionRecord> {
    this.requireHost();
    const current = this.requireMission(input.missionId, true);
    if (current.state === "retired") throw denied("Retired missions cannot be revised");
    const duplicate = current.permissions.some(
      (permission) =>
        permission.capability === input.capability &&
        canonicalJson(permission.resource) === canonicalJson(input.resource)
    );
    if (duplicate) return current;
    const subject = this.activeSubject(current);
    if (subject) await this.rpc.call("main", "reviewedClosure.suspend", [subject]);
    const nextPermissions = [
      ...current.permissions,
      { capability: input.capability, resource: input.resource, tier: input.tier },
    ];
    const revision = current.revision + 1;
    const revisionDigest = missionClosureDigest(
      current.charter,
      nextPermissions,
      current.standingRestrictions
    );
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO mission_revisions (mission_id,revision,record_json,recorded_at)
       VALUES (?,?,?,?)`,
      current.missionId,
      current.revision,
      canonicalJson(current),
      now
    );
    this.sql.exec(
      `UPDATE missions SET revision=?,permissions_json=?,state='needs-reapproval',
       revision_digest=?,active_closure_digest=NULL,updated_at=? WHERE mission_id=?`,
      revision,
      canonicalJson(nextPermissions),
      revisionDigest,
      now,
      current.missionId
    );
    return this.requireMission(current.missionId, true);
  }

  private compileClosure(mission: MissionRecord): {
    body: ReviewedExecutionClosureBody;
    closureDigest: string;
  } {
    const body: ReviewedExecutionClosureBody = {
      subjectPrefix: `mission:${mission.missionId}`,
      exposure: compileMissionExposure(mission.charter, Object.keys(HOST_AUTHORITY_METHODS)),
      harness: { ...mission.charter.harness },
      grants: [
        ...mission.permissions.filter(isStandingPermission).map((permission) => ({
          effect: "allow" as const,
          capability: permission.capability,
          resource: permission.resource,
          tier: permission.tier,
        })),
        ...mission.standingRestrictions.map((restriction) => ({
          effect: "deny" as const,
          capability: restriction.capability,
          resource: { kind: "exact" as const, key: restriction.resourceKey },
          tier: "gated" as const,
        })),
      ],
      grantDependencies: mission.permissions.filter(isStandingPermission).map((permission) => ({
        subject: `agent:${mission.charter.agentBindingId}`,
        capability: permission.capability,
        resource: permission.resource,
      })),
      lineageClasses: [...mission.charter.declaredLineageClasses],
      owner: `user:${mission.owner.userId}`,
      issuer: this.rpcSelfId,
      sourceDocument: {
        kind: "mission",
        id: mission.missionId,
        revision: mission.revision,
        digest: mission.revisionDigest,
      },
    };
    return { body, closureDigest: reviewedExecutionClosureDigest(body) };
  }

  private getRow(missionId: string): MissionRow | null {
    const rows = this.sql.exec("SELECT * FROM missions WHERE mission_id=?", missionId).toArray();
    return rows[0] ? (rows[0] as unknown as MissionRow) : null;
  }

  private requireMission(missionId: string, host = false): MissionRecord {
    const row = this.getRow(missionId);
    if (!row) throw Object.assign(new Error(`Unknown mission ${missionId}`), { code: "ENOENT" });
    if (!host) this.requireVisible(row);
    return this.rowToMission(row);
  }

  private requireVisible(row: MissionRow): void {
    const userId = this.requireUser();
    if (row.seeded !== 1 && row.owner_user_id !== userId) {
      throw Object.assign(new Error("Unknown mission"), { code: "ENOENT" });
    }
  }

  private requireUser(): string {
    const userId = this.caller?.userId;
    if (!userId || userId === "system") throw denied("Missions require an authenticated user");
    return userId;
  }

  private requireHumanCaller(): { userId: string; callerId: string } {
    const caller = this.caller;
    const userId = this.requireUser();
    if (!caller) throw denied("Mission changes require an authenticated caller");
    return { userId, callerId: caller.callerId };
  }

  private requireHost(): void {
    if (this.caller?.callerKind !== "server") throw denied("Mission session lifecycle is host-only");
  }

  private rowToMission(row: MissionRow): MissionRecord {
    const charter = JSON.parse(row.charter_json) as MissionCharter;
    const permissions = JSON.parse(row.permissions_json) as MissionPermission[];
    const standingRestrictions = JSON.parse(
      row.standing_restrictions_json
    ) as MissionStandingRestriction[];
    const revisionDigest = missionClosureDigest(charter, permissions, standingRestrictions);
    if (revisionDigest !== row.revision_digest) {
      throw new Error(`Mission ${row.mission_id} has an invalid revision digest`);
    }
    return {
      missionId: row.mission_id,
      name: row.name,
      revision: Number(row.revision),
      charter,
      owner: { userId: row.owner_user_id, deviceId: row.owner_device_id },
      state: row.state,
      revisionDigest,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(row.seeded === 1 ? { seeded: true } : {}),
      permissions,
      standingRestrictions,
    };
  }

  private activeSubject(mission: MissionRecord): string | null {
    const digest = this.getRow(mission.missionId)?.active_closure_digest;
    return digest ? `mission:${mission.missionId}@${digest}` : null;
  }

  private requireActiveSubject(mission: MissionRecord): string {
    const subject = this.activeSubject(mission);
    if (!subject || mission.state !== "active") throw denied("Mission is not active");
    return subject;
  }
}

function isStandingPermission(permission: MissionPermission): boolean {
  return (
    permission.tier === "gated" &&
    receiverAuthorityPolicy(permission.capability).missionGrant
  );
}

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: "EACCES" });
}
