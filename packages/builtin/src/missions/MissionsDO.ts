import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionExecution,
  MissionPermission,
  MissionRecord,
  MissionRunRecord,
  MissionStandingRestriction,
  MissionState,
} from "@vibestudio/shared/authority/mission";
import { missionClosureDigest, missionNextRunAt } from "@vibestudio/shared/authority/mission";
import {
  compileMissionExposure,
  reviewedExecutionClosureDigest,
  type ReviewedExecutionClosureBody,
} from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { HOST_AUTHORITY_METHODS } from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { receiverAuthorityPolicy } from "@vibestudio/shared/authority/receiverAuthorityPolicy";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";
const MAX_RUN_TEXT = 24_000;
const OVERVIEW_RUN_LIMIT = 5;
const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ATTENTION_LIMIT = 8;
const DEFAULT_OVERVIEW_LIMIT = 30;

type OverviewFilter = "all" | "attention" | "active" | "paused" | "drafts";
interface OverviewCursor {
  updatedAt: number;
  missionId: string;
}

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
  schedule_origin_at: number | null;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  run_id: string;
  mission_id: string;
  closure_digest: string;
  trigger_kind: "manual" | "scheduled";
  status: MissionRunRecord["status"];
  started_at: number;
  finished_at: number | null;
  session_id: string | null;
  channel_id: string | null;
  context_id: string | null;
  executor_id: string | null;
  final_message: string | null;
  error: string | null;
}

export class MissionsDO extends DurableObjectBase {
  static override schemaVersion = 2;
  protected override schemaProductionBaseline() {
    return { version: 2, name: "automations-v2" } as const;
  }
  static override rpcMethods = missionsMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
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
      schedule_origin_at INTEGER,
      next_run_at INTEGER,
      last_run_at INTEGER,
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
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
      status TEXT NOT NULL CHECK (status IN ('starting','running','succeeded','failed','skipped')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      session_id TEXT,
      channel_id TEXT,
      context_id TEXT,
      executor_id TEXT,
      final_message TEXT,
      error TEXT
    )`);
    this.sql.exec(
      `CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)`
    );
  }

  protected override requiredTables(): readonly string[] {
    return ["missions", "mission_revisions", "mission_runs"];
  }

  protected override schemaIndexDefinitions(): readonly string[] {
    return [`CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)`];
  }

  protected override nextAlarmAfterRequest(): { wakeAt: number } | undefined {
    const next = this.nextWakeAt();
    return next === null ? undefined : { wakeAt: next };
  }

  override async alarm(): Promise<{ wakeAt: number } | null> {
    await super.alarm();
    const now = Date.now();
    const due = this.sql
      .exec(
        `SELECT mission_id FROM missions
         WHERE state='active' AND next_run_at IS NOT NULL AND next_run_at<=?
         ORDER BY next_run_at,mission_id`,
        now
      )
      .toArray();
    for (const row of due) {
      const mission = this.requireMission(String(row["mission_id"]), true);
      this.advanceSchedule(mission, now);
      await this.startExecution(mission, "scheduled");
    }
    const next = this.nextWakeAt();
    return next === null ? null : { wakeAt: next };
  }

  @schemaRpc()
  overview(options: {
    limit?: number;
    cursor?: OverviewCursor;
    filter?: OverviewFilter;
    query?: string;
  }): {
    generatedAt: number;
    stats: {
      total: number;
      active: number;
      running: number;
      failedLast24Hours: number;
      awaitingReview: number;
    };
    items: Array<{
      automation: MissionRecord;
      recentRuns: MissionRunRecord[];
      totalRuns: number;
      activeRuns: number;
      failedRunsSince: number;
    }>;
    nextCursor?: OverviewCursor;
    attention: Array<{ missionId: string; missionName: string; run: MissionRunRecord }>;
  } {
    const userId = this.requireUser();
    const generatedAt = Date.now();
    const limit = options.limit ?? DEFAULT_OVERVIEW_LIMIT;
    const filter = options.filter ?? "all";
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const cutoff = generatedAt - ATTENTION_WINDOW_MS;
    const conditions = ["(seeded=1 OR owner_user_id=?)"];
    const bindings: unknown[] = [userId];
    if (query) {
      conditions.push(
        "(instr(lower(name),?)>0 OR instr(lower(json_extract(charter_json,'$.summary')),?)>0)"
      );
      bindings.push(query, query);
    }
    if (filter === "active") conditions.push("state='active'");
    if (filter === "paused") conditions.push("state='paused'");
    if (filter === "drafts") conditions.push("state IN ('draft','needs-reapproval')");
    if (filter === "attention") {
      conditions.push(
        "(state='needs-reapproval' OR EXISTS (SELECT 1 FROM mission_runs r WHERE r.mission_id=missions.mission_id AND r.status='failed' AND r.started_at>=?))"
      );
      bindings.push(cutoff);
    }
    if (options.cursor) {
      conditions.push("(updated_at<? OR (updated_at=? AND mission_id<?))");
      bindings.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.missionId);
    }
    const pageRows = this.sql
      .exec(
        `SELECT * FROM missions
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC,mission_id DESC LIMIT ?`,
        ...bindings,
        limit + 1
      )
      .toArray() as unknown as MissionRow[];
    const hasNextPage = pageRows.length > limit;
    const missionRows = pageRows.slice(0, limit);
    const missionIds = missionRows.map((row) => row.mission_id);
    const placeholders = missionIds.map(() => "?").join(",");
    const runRows =
      missionIds.length === 0
        ? []
        : (this.sql
            .exec(
              `WITH page_runs AS (
                 SELECT r.*,
                   ROW_NUMBER() OVER (
                     PARTITION BY r.mission_id ORDER BY r.started_at DESC,r.run_id DESC
                   ) AS rank
                 FROM mission_runs r
                 WHERE r.mission_id IN (${placeholders})
               )
               SELECT * FROM page_runs WHERE rank<=?
               ORDER BY started_at DESC,run_id DESC`,
              ...missionIds,
              OVERVIEW_RUN_LIMIT
            )
            .toArray() as unknown as Array<RunRow & { rank: number }>);
    const statsRows =
      missionIds.length === 0
        ? []
        : this.sql
            .exec(
              `SELECT r.mission_id,
                 COUNT(*) AS total_runs,
                 SUM(CASE WHEN r.status IN ('starting','running') THEN 1 ELSE 0 END) AS active_runs,
                 SUM(CASE WHEN r.status='failed' AND r.started_at>=? THEN 1 ELSE 0 END) AS failed_runs_since
               FROM mission_runs r
               WHERE r.mission_id IN (${placeholders})
               GROUP BY r.mission_id`,
              cutoff,
              ...missionIds
            )
            .toArray();
    const definitionStats = this.sql
      .exec(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN state IN ('draft','needs-reapproval') THEN 1 ELSE 0 END) AS awaiting_review
         FROM missions WHERE seeded=1 OR owner_user_id=?`,
        userId
      )
      .toArray()[0];
    const runStats = this.sql
      .exec(
        `SELECT
           SUM(CASE WHEN r.status IN ('starting','running') THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN r.status='failed' AND r.started_at>=? THEN 1 ELSE 0 END) AS failed
         FROM mission_runs r
         JOIN missions m ON m.mission_id=r.mission_id
         WHERE m.seeded=1 OR m.owner_user_id=?`,
        cutoff,
        userId
      )
      .toArray()[0];
    const runsByMission = new Map<string, MissionRunRecord[]>();
    for (const row of runRows) {
      const values = runsByMission.get(row.mission_id) ?? [];
      values.push(this.rowToRun(row));
      runsByMission.set(row.mission_id, values);
    }
    const stats = new Map(
      statsRows.map((row) => [
        String(row["mission_id"]),
        {
          totalRuns: Number(row["total_runs"]),
          activeRuns: Number(row["active_runs"]),
          failedRunsSince: Number(row["failed_runs_since"]),
        },
      ])
    );
    const attention = this.sql
      .exec(
        `SELECT r.*,m.name AS mission_name FROM mission_runs r
         JOIN missions m ON m.mission_id=r.mission_id
         WHERE r.status='failed' AND r.started_at>=?
           AND (m.seeded=1 OR m.owner_user_id=?)
         ORDER BY r.started_at DESC,r.run_id DESC LIMIT ?`,
        cutoff,
        userId,
        ATTENTION_LIMIT
      )
      .toArray()
      .map((row) => ({
        missionId: String(row["mission_id"]),
        missionName: String(row["mission_name"]),
        run: this.rowToRun(row as unknown as RunRow),
      }));
    return {
      generatedAt,
      stats: {
        total: Number(definitionStats?.["total"] ?? 0),
        active: Number(definitionStats?.["active"] ?? 0),
        running: Number(runStats?.["running"] ?? 0),
        failedLast24Hours: Number(runStats?.["failed"] ?? 0),
        awaitingReview: Number(definitionStats?.["awaiting_review"] ?? 0),
      },
      items: missionRows.map((row) => ({
        automation: this.rowToMission(row),
        recentRuns: runsByMission.get(row.mission_id) ?? [],
        ...(stats.get(row.mission_id) ?? {
          totalRuns: 0,
          activeRuns: 0,
          failedRunsSince: 0,
        }),
      })),
      ...(hasNextPage
        ? {
            nextCursor: {
              updatedAt: missionRows.at(-1)!.updated_at,
              missionId: missionRows.at(-1)!.mission_id,
            },
          }
        : {}),
      attention,
    };
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
  listRuns(
    missionId: string,
    options: { limit?: number; cursor?: { startedAt: number; runId: string } }
  ): { items: MissionRunRecord[]; nextCursor?: { startedAt: number; runId: string } } {
    this.requireMission(missionId);
    const limit = options.limit ?? 20;
    const rows = (options.cursor
      ? this.sql.exec(
          `SELECT * FROM mission_runs WHERE mission_id=?
           AND (started_at<? OR (started_at=? AND run_id<?))
           ORDER BY started_at DESC,run_id DESC LIMIT ?`,
          missionId,
          options.cursor.startedAt,
          options.cursor.startedAt,
          options.cursor.runId,
          limit + 1
        )
      : this.sql.exec(
          `SELECT * FROM mission_runs WHERE mission_id=?
           ORDER BY started_at DESC,run_id DESC LIMIT ?`,
          missionId,
          limit + 1
        )
    ).toArray() as unknown as RunRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.rowToRun(row)),
      ...(hasMore && last
        ? { nextCursor: { startedAt: Number(last.started_at), runId: last.run_id } }
        : {}),
    };
  }

  @schemaRpc()
  proposeDraft(input: {
    name: string;
    charter: MissionCharter;
    permissions: MissionPermission[];
    standingRestrictions?: MissionStandingRestriction[];
  }): MissionRecord {
    return this.insertDraft(input);
  }

  @schemaRpc()
  createDraft(input: {
    name: string;
    charter: MissionCharter;
    permissions: MissionPermission[];
    standingRestrictions?: MissionStandingRestriction[];
  }): MissionRecord {
    return this.insertDraft(input);
  }

  private insertDraft(input: {
    name: string;
    charter: MissionCharter;
    permissions: MissionPermission[];
    standingRestrictions?: MissionStandingRestriction[];
  }): MissionRecord {
    const caller = this.requireOwnerCaller();
    assertExecutionPermissions(input.charter, input.permissions);
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
        schedule_origin_at,next_run_at,last_run_at,created_at,updated_at)
       VALUES (?,?,1,?,?,?,?,?,'draft',?,NULL,0,NULL,NULL,NULL,?,?)`,
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
    const caller = this.requireOwnerCaller();
    if (current.seeded) {
      return this.insertDraft({
        name: input.name ?? `${current.name} (custom)`,
        charter: input.charter ?? current.charter,
        permissions: input.permissions ?? [...current.permissions],
        standingRestrictions: input.standingRestrictions ?? [...current.standingRestrictions],
      });
    }
    if (current.owner.userId !== caller.userId) throw denied("Automation belongs to another user");
    if (current.state === "retired") throw denied("Retired automations cannot be edited");
    const nextCharter = input.charter ?? current.charter;
    const nextPermissions = input.permissions ?? current.permissions;
    assertExecutionPermissions(nextCharter, nextPermissions);
    const subject = this.activeSubject(current);
    if (subject) await this.rpc.call("main", "reviewedClosure.suspend", [subject]);
    const next: MissionRecord = {
      ...current,
      name: input.name ?? current.name,
      revision: current.revision + 1,
      charter: nextCharter,
      permissions: nextPermissions,
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
       schedule_origin_at=NULL,next_run_at=NULL,updated_at=? WHERE mission_id=?`,
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
      throw denied("Only an inert automation revision can be reviewed");
    }
    const { body, closureDigest } = this.compileClosure(mission);
    await this.rpc.call("main", "reviewedClosure.activate", [
      {
        body,
        closureDigest,
        presentation: {
          title: `Activate ${mission.name}`,
          description:
            "Review the exact code, action, schedule, network reach, and standing authority for this automation.",
          summary: mission.charter.summary,
          facts: [
            { label: "Execution", value: executionLabel(mission.charter.execution) },
            { label: "Schedule", value: triggerLabel(mission.charter) },
            { label: "Standing rules", value: String(body.grants.length) },
          ],
        },
      },
    ]);
    const now = Date.now();
    const scheduleOriginAt = scheduleOrigin(mission.charter, now);
    const nextRunAt = initialNextRunAt(mission.charter, now, scheduleOriginAt);
    this.sql.exec(
      `UPDATE missions SET state='active',active_closure_digest=?,schedule_origin_at=?,next_run_at=?,updated_at=?
       WHERE mission_id=?`,
      closureDigest,
      scheduleOriginAt,
      nextRunAt,
      now,
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async runNow(missionId: string): Promise<MissionRunRecord> {
    const mission = this.requireMission(missionId);
    this.requireActiveSubject(mission);
    return this.startExecution(mission, "manual");
  }

  @schemaRpc()
  async pause(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    const subject = this.requireActiveSubject(mission);
    await this.rpc.call("main", "reviewedClosure.suspend", [subject]);
    this.sql.exec(
      "UPDATE missions SET state='paused',next_run_at=NULL,updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async resume(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    if (mission.state !== "paused") throw denied("Only paused automations can resume");
    const { body, closureDigest } = this.compileClosure(mission);
    if (closureDigest !== this.getRow(missionId)?.active_closure_digest) {
      throw denied("Automation must be reviewed again before it can resume");
    }
    await this.rpc.call("main", "reviewedClosure.activate", [
      {
        body,
        closureDigest,
        presentation: {
          title: `Resume ${mission.name}`,
          description: "Resume this unchanged reviewed automation closure.",
          summary: mission.charter.summary,
        },
      },
    ]);
    const now = Date.now();
    const row = this.getRow(missionId);
    const scheduleOriginAt = row?.schedule_origin_at ?? scheduleOrigin(mission.charter, now);
    this.sql.exec(
      "UPDATE missions SET state='active',schedule_origin_at=?,next_run_at=?,updated_at=? WHERE mission_id=?",
      scheduleOriginAt,
      initialNextRunAt(mission.charter, now, scheduleOriginAt),
      now,
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
      "UPDATE missions SET state='retired',next_run_at=NULL,updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async finishRun(input: {
    runId: string;
    outcome: "succeeded" | "failed";
    finalMessage?: string;
    error?: string;
  }): Promise<void> {
    const row = this.getRunRow(input.runId);
    if (!row) throw notFound(`Unknown automation run ${input.runId}`);
    if (row.status === "succeeded" || row.status === "failed" || row.status === "skipped") return;
    if (!row.executor_id || this.rpcCallerId !== row.executor_id) {
      throw denied("Only the recorded automation executor can finish this run");
    }
    if (row.session_id) {
      await this.rpc.call("main", "reviewedClosure.finishSession", [{ sessionId: row.session_id }]);
    }
    this.sql.exec(
      `UPDATE mission_runs SET status=?,finished_at=?,final_message=?,error=?
       WHERE run_id=? AND status IN ('starting','running')`,
      input.outcome,
      Date.now(),
      bounded(input.finalMessage),
      bounded(input.error),
      input.runId
    );
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
    if (current.charter.execution.kind !== "agent") {
      throw denied("Method automations inherit their installed code authority");
    }
    if (current.state === "retired") throw denied("Retired automations cannot be revised");
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
       revision_digest=?,active_closure_digest=NULL,next_run_at=NULL,updated_at=?
       WHERE mission_id=?`,
      revision,
      canonicalJson(nextPermissions),
      revisionDigest,
      now,
      current.missionId
    );
    return this.requireMission(current.missionId, true);
  }

  private async startExecution(
    mission: MissionRecord,
    trigger: "manual" | "scheduled"
  ): Promise<MissionRunRecord> {
    const subject = this.requireActiveSubject(mission);
    const closureDigest = this.getRow(mission.missionId)?.active_closure_digest;
    if (!closureDigest) throw denied("Automation has no active reviewed closure");
    const now = Date.now();
    const active = this.sql
      .exec(
        `SELECT run_id FROM mission_runs
         WHERE mission_id=? AND status IN ('starting','running') LIMIT 1`,
        mission.missionId
      )
      .toArray()[0];
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    if (active) {
      this.sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,trigger_kind,status,started_at,finished_at,error)
         VALUES (?,?,?,?, 'skipped',?,?,?)`,
        runId,
        mission.missionId,
        closureDigest,
        trigger,
        now,
        now,
        `Previous run ${String(active["run_id"])} is still active`
      );
      return this.requireRun(runId);
    }
    this.sql.exec(
      `INSERT INTO mission_runs
       (run_id,mission_id,closure_digest,trigger_kind,status,started_at)
       VALUES (?,?,?,?, 'starting',?)`,
      runId,
      mission.missionId,
      closureDigest,
      trigger,
      now
    );
    this.sql.exec(
      "UPDATE missions SET last_run_at=?,updated_at=? WHERE mission_id=?",
      now,
      now,
      mission.missionId
    );
    try {
      if (mission.charter.execution.kind === "method") {
        await this.executeMethod(mission, runId, subject, closureDigest);
      } else {
        await this.executeAgent(mission, runId, subject, closureDigest);
      }
    } catch (error) {
      await this.failStartingRun(runId, error);
    }
    return this.requireRun(runId);
  }

  private async executeMethod(
    mission: MissionRecord,
    runId: string,
    subject: string,
    closureDigest: string
  ): Promise<void> {
    const execution = mission.charter.execution;
    if (execution.kind !== "method") throw new Error("Expected method automation");
    const handle = await this.activateTarget(execution, mission.charter.harness.ev);
    const sessionId = runId;
    await this.bindRun(subject, closureDigest, sessionId, runId);
    this.markRunning(runId, {
      sessionId,
      executorId: handle.targetId,
    });
    try {
      const result = await this.rpc.call(handle.targetId, execution.method, [...execution.args]);
      await this.finishOwnedRun(runId, sessionId, "succeeded", resultSummary(result));
    } catch (error) {
      await this.finishOwnedRun(runId, sessionId, "failed", undefined, describeError(error));
    }
  }

  private async executeAgent(
    mission: MissionRecord,
    runId: string,
    subject: string,
    closureDigest: string
  ): Promise<void> {
    const execution = mission.charter.execution;
    if (execution.kind !== "agent") throw new Error("Expected agent automation");
    let channelId: string;
    let contextId: string;
    let targetId: string;
    if (execution.conversation.mode === "continue") {
      channelId = execution.conversation.channelId;
      contextId = execution.conversation.contextId;
      const handle = await this.activateTarget(
        execution,
        mission.charter.harness.ev,
        contextId,
        channelId
      );
      targetId = handle.targetId;
    } else {
      channelId = `automation-${mission.missionId}-${runId}`;
      contextId = await this.createContext();
      await this.activateChannel(channelId, contextId);
      const freshExecution: Extract<MissionExecution, { kind: "agent" }> = {
        ...execution,
        target: { ...execution.target, objectKey: `${execution.target.objectKey}-${runId}` },
      };
      const handle = await this.activateTarget(
        freshExecution,
        mission.charter.harness.ev,
        contextId,
        channelId
      );
      targetId = handle.targetId;
      await this.rpc.call(targetId, "subscribeChannel", [
        { channelId, contextId, replay: false, delivery: "all" },
      ]);
    }
    await this.bindRun(subject, closureDigest, channelId, runId);
    this.markRunning(runId, {
      sessionId: channelId,
      channelId,
      contextId,
      executorId: targetId,
    });
    await this.rpc.call(targetId, "runAutomationTurn", [
      { channelId, runId, prompt: execution.prompt },
    ]);
  }

  private async activateTarget(
    execution: MissionExecution,
    ref: string,
    contextId?: string,
    agentChannelId?: string
  ): Promise<{ id: string; targetId: string; contextId?: string }> {
    const value = await this.rpc.call("main", "runtime.createEntity", [
      {
        kind: "do",
        execution: { surface: "code", source: execution.target.source, ref },
        className: execution.target.className,
        key: execution.target.objectKey,
        ...(contextId ? { contextId } : {}),
        ...(agentChannelId ? { agentChannelId } : {}),
      },
    ]);
    const handle = value as { id?: unknown; targetId?: unknown; contextId?: unknown } | null;
    if (!handle || typeof handle.id !== "string" || typeof handle.targetId !== "string") {
      throw new Error("Automation target could not be activated");
    }
    if (contextId && handle.contextId !== contextId) {
      throw new Error("Automation target belongs to a different context");
    }
    return {
      id: handle.id,
      targetId: handle.targetId,
      ...(typeof handle.contextId === "string" ? { contextId: handle.contextId } : {}),
    };
  }

  private async createContext(): Promise<string> {
    const value = (await this.rpc.call("main", "runtime.createContext", [{}])) as {
      contextId?: unknown;
    } | null;
    if (!value || typeof value.contextId !== "string" || !value.contextId) {
      throw new Error("Automation context could not be created");
    }
    return value.contextId;
  }

  private async activateChannel(channelId: string, contextId: string): Promise<void> {
    await this.rpc.call("main", "runtime.createEntity", [
      {
        kind: "do",
        execution: { surface: "code", source: CHANNEL_SOURCE },
        className: CHANNEL_CLASS,
        key: channelId,
        contextId,
      },
    ]);
  }

  private async bindRun(
    subject: string,
    closureDigest: string,
    sessionId: string,
    runId: string
  ): Promise<void> {
    await this.rpc.call("main", "reviewedClosure.bindSession", [
      { subject, closureDigest, sessionId, taskRef: runId },
    ]);
  }

  private markRunning(
    runId: string,
    input: {
      sessionId: string;
      executorId: string;
      channelId?: string;
      contextId?: string;
    }
  ): void {
    this.sql.exec(
      `UPDATE mission_runs SET status='running',session_id=?,channel_id=?,context_id=?,executor_id=?
       WHERE run_id=? AND status='starting'`,
      input.sessionId,
      input.channelId ?? null,
      input.contextId ?? null,
      input.executorId,
      runId
    );
  }

  private async finishOwnedRun(
    runId: string,
    sessionId: string,
    status: "succeeded" | "failed",
    finalMessage?: string,
    error?: string
  ): Promise<void> {
    await this.rpc.call("main", "reviewedClosure.finishSession", [{ sessionId }]);
    this.sql.exec(
      `UPDATE mission_runs SET status=?,finished_at=?,final_message=?,error=? WHERE run_id=?`,
      status,
      Date.now(),
      bounded(finalMessage),
      bounded(error),
      runId
    );
  }

  private async failStartingRun(runId: string, error: unknown): Promise<void> {
    const row = this.getRunRow(runId);
    if (!row || row.status === "succeeded" || row.status === "failed" || row.status === "skipped") {
      return;
    }
    if (row.session_id) {
      await this.rpc.call("main", "reviewedClosure.finishSession", [{ sessionId: row.session_id }]);
    }
    this.sql.exec(
      `UPDATE mission_runs SET status='failed',finished_at=?,error=? WHERE run_id=?`,
      Date.now(),
      bounded(describeError(error)),
      runId
    );
  }

  private advanceSchedule(mission: MissionRecord, now: number): void {
    if (mission.charter.trigger.kind !== "schedule") return;
    const origin = this.getRow(mission.missionId)?.schedule_origin_at;
    if (origin == null) throw new Error(`Automation ${mission.missionId} has no schedule origin`);
    const next = withJitter(
      missionNextRunAt(mission.charter.trigger, now, Number(origin)),
      mission.charter.trigger.jitterMs
    );
    this.sql.exec(
      "UPDATE missions SET next_run_at=?,last_run_at=?,updated_at=? WHERE mission_id=?",
      next,
      now,
      now,
      mission.missionId
    );
  }

  private nextWakeAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT MIN(next_run_at) AS wake FROM missions
         WHERE state='active' AND next_run_at IS NOT NULL`
      )
      .one()["wake"];
    return value == null ? null : Number(value);
  }

  private compileClosure(mission: MissionRecord): {
    body: ReviewedExecutionClosureBody;
    closureDigest: string;
  } {
    const execution = mission.charter.execution;
    const standingPermissions = mission.permissions.filter(isStandingPermission);
    const body: ReviewedExecutionClosureBody = {
      subjectPrefix: `mission:${mission.missionId}`,
      exposure: compileMissionExposure(mission.charter, Object.keys(HOST_AUTHORITY_METHODS)),
      harness: { ...mission.charter.harness },
      grants: [
        ...standingPermissions.map((permission) => ({
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
      grantDependencies: [],
      lineageClasses: execution.kind === "agent" ? [...execution.declaredLineageClasses] : ["none"],
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

  private getRunRow(runId: string): RunRow | null {
    const rows = this.sql.exec("SELECT * FROM mission_runs WHERE run_id=?", runId).toArray();
    return rows[0] ? (rows[0] as unknown as RunRow) : null;
  }

  private requireRun(runId: string): MissionRunRecord {
    const row = this.getRunRow(runId);
    if (!row) throw notFound(`Unknown automation run ${runId}`);
    return this.rowToRun(row);
  }

  private requireMission(missionId: string, host = false): MissionRecord {
    const row = this.getRow(missionId);
    if (!row) throw notFound(`Unknown automation ${missionId}`);
    if (!host) this.requireVisible(row);
    return this.rowToMission(row);
  }

  private requireVisible(row: MissionRow): void {
    const userId = this.requireUser();
    if (row.seeded !== 1 && row.owner_user_id !== userId) throw notFound("Unknown automation");
  }

  private requireUser(): string {
    const userId = this.caller?.userId;
    if (!userId || userId === "system") throw denied("Automations require an authenticated user");
    return userId;
  }

  private requireOwnerCaller(): { userId: string; callerId: string } {
    const caller = this.caller;
    const userId = this.requireUser();
    if (!caller) throw denied("Automation drafts require an authenticated caller");
    return { userId, callerId: caller.callerId };
  }

  private requireHost(): void {
    if (this.caller?.callerKind !== "server") throw denied("Automation revision is host-only");
  }

  private rowToMission(row: MissionRow): MissionRecord {
    const charter = JSON.parse(row.charter_json) as MissionCharter;
    const permissions = JSON.parse(row.permissions_json) as MissionPermission[];
    const standingRestrictions = JSON.parse(
      row.standing_restrictions_json
    ) as MissionStandingRestriction[];
    const revisionDigest = missionClosureDigest(charter, permissions, standingRestrictions);
    if (revisionDigest !== row.revision_digest) {
      throw new Error(`Automation ${row.mission_id} has an invalid revision digest`);
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
      ...(row.next_run_at == null ? {} : { nextRunAt: Number(row.next_run_at) }),
      ...(row.last_run_at == null ? {} : { lastRunAt: Number(row.last_run_at) }),
    };
  }

  private rowToRun(row: RunRow): MissionRunRecord {
    return {
      runId: row.run_id,
      missionId: row.mission_id,
      closureDigest: row.closure_digest,
      trigger: row.trigger_kind,
      status: row.status,
      startedAt: Number(row.started_at),
      ...(row.finished_at == null ? {} : { finishedAt: Number(row.finished_at) }),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.channel_id ? { channelId: row.channel_id } : {}),
      ...(row.context_id ? { contextId: row.context_id } : {}),
      ...(row.executor_id ? { executorId: row.executor_id } : {}),
      ...(row.final_message ? { finalMessage: row.final_message } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private activeSubject(mission: MissionRecord): string | null {
    const digest = this.getRow(mission.missionId)?.active_closure_digest;
    return digest ? `mission:${mission.missionId}@${digest}` : null;
  }

  private requireActiveSubject(mission: MissionRecord): string {
    const subject = this.activeSubject(mission);
    if (!subject || mission.state !== "active") throw denied("Automation is not active");
    return subject;
  }
}

function scheduleOrigin(charter: MissionCharter, now: number): number | null {
  return charter.trigger.kind === "schedule" ? (charter.trigger.anchorAt ?? now) : null;
}

function initialNextRunAt(
  charter: MissionCharter,
  now: number,
  origin: number | null
): number | null {
  if (charter.trigger.kind !== "schedule") return null;
  if (origin == null) throw new Error("Scheduled automation requires a cadence origin");
  return withJitter(missionNextRunAt(charter.trigger, now, origin), charter.trigger.jitterMs);
}

function withJitter(value: number, jitterMs = 0): number {
  return value + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
}

function executionLabel(execution: MissionExecution): string {
  return execution.kind === "agent"
    ? `Prompt ${execution.target.className}`
    : `${execution.target.className}.${execution.method}`;
}

function triggerLabel(charter: MissionCharter): string {
  return charter.trigger.kind === "manual"
    ? "Manual"
    : `Every ${charter.trigger.everyMs} ms${
        charter.trigger.anchorAt === undefined ? "" : ` from ${charter.trigger.anchorAt}`
      }`;
}

function assertExecutionPermissions(
  charter: MissionCharter,
  permissions: readonly MissionPermission[]
): void {
  if (charter.execution.kind === "method" && permissions.length > 0) {
    throw new Error(
      "Method automations use the target code's reviewed installation authority and cannot declare agent grants"
    );
  }
}

function isStandingPermission(permission: MissionPermission): boolean {
  return permission.tier === "gated" && receiverAuthorityPolicy(permission.capability).missionGrant;
}

function resultSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return bounded(value);
  try {
    return bounded(canonicalJson(value));
  } catch {
    return bounded(String(value));
  }
}

function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_RUN_TEXT ? value : `${value.slice(0, MAX_RUN_TEXT)}\n…`;
}

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: "EACCES" });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "ENOENT" });
}
