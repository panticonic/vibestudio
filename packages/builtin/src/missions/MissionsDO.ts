import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
  type DurableObjectSchemaMigration,
} from "@vibestudio/durable";
import { createHash } from "node:crypto";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionCompletionReason,
  MissionExecution,
  MissionPermission,
  MissionRecord,
  MissionRunRecord,
  MissionStandingRestriction,
  MissionState,
} from "@vibestudio/shared/authority/mission";
import { missionClosureDigest, missionNextRunAt } from "@vibestudio/shared/authority/mission";
import { missionCompletionResponse } from "@vibestudio/shared/authority/mission";
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
const RUN_STARTED_NOTIFICATION_TTL_MS = 6_000;

type OverviewFilter = "all" | "attention" | "active" | "paused" | "completed" | "drafts";
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
  activated_at: number | null;
  run_count: number;
  completed_at: number | null;
  completion_reason: MissionCompletionReason | null;
  completion_response: string | null;
}

interface RunRow {
  run_id: string;
  mission_id: string;
  closure_digest: string;
  mission_revision: number;
  trigger_kind: "manual" | "scheduled";
  status: MissionRunRecord["status"];
  started_at: number;
  run_number: number | null;
  finished_at: number | null;
  session_id: string | null;
  channel_id: string | null;
  context_id: string | null;
  executor_id: string | null;
  final_message: string | null;
  completion_response: string | null;
  error: string | null;
}

export class MissionsDO extends DurableObjectBase {
  static override schemaVersion = 5;
  protected override schemaProductionBaseline() {
    return { version: 2, name: "automations-v2" } as const;
  }
  protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    return [
      {
        version: 3,
        name: "automation-actions-and-activation",
        validateSource: (sql) => {
          const columns = sql
            .exec(`PRAGMA table_info(missions)`)
            .toArray()
            .map((column) => String(column["name"]));
          const expected = [
            "mission_id",
            "name",
            "revision",
            "charter_json",
            "permissions_json",
            "standing_restrictions_json",
            "owner_user_id",
            "owner_device_id",
            "state",
            "revision_digest",
            "active_closure_digest",
            "seeded",
            "schedule_origin_at",
            "next_run_at",
            "last_run_at",
            "created_at",
            "updated_at",
          ];
          if (JSON.stringify(columns) !== JSON.stringify(expected)) {
            throw new Error(`MissionsDO v2 source schema is unknown: ${JSON.stringify(columns)}`);
          }
        },
        migrate: (sql) => {
          sql.exec(`ALTER TABLE missions ADD COLUMN activated_at INTEGER`);
          const rows = sql
            .exec(
              `SELECT mission_id,name,revision,charter_json,permissions_json,
                      standing_restrictions_json,owner_user_id,owner_device_id,state,
                      revision_digest,seeded,schedule_origin_at,next_run_at,last_run_at,
                      created_at,updated_at
                 FROM missions`
            )
            .toArray();
          for (const row of rows) {
            const charter = JSON.parse(String(row["charter_json"])) as Record<string, unknown>;
            const execution = charter["execution"] as Record<string, unknown> | undefined;
            if (execution?.["kind"] !== "agent" || "action" in execution) continue;
            const prompt = execution["prompt"];
            if (typeof prompt !== "string" || !prompt.trim()) {
              throw new Error(`Automation ${String(row["mission_id"])} has an unknown v2 action`);
            }
            const permissions = JSON.parse(String(row["permissions_json"])) as MissionPermission[];
            const restrictions = JSON.parse(
              String(row["standing_restrictions_json"])
            ) as MissionStandingRestriction[];
            const oldDigest = legacyPromptClosureDigest(charter, permissions, restrictions);
            if (oldDigest !== String(row["revision_digest"])) {
              throw new Error(
                `Automation ${String(row["mission_id"])} has an invalid v2 revision digest`
              );
            }
            const { prompt: _prompt, ...executionWithoutPrompt } = execution;
            const nextCharter = {
              ...charter,
              execution: {
                ...executionWithoutPrompt,
                action: { kind: "prompt", text: prompt },
              },
            } as MissionCharter;
            const revision = Number(row["revision"]);
            const state = String(row["state"]) as MissionState;
            const previousRecord = {
              missionId: String(row["mission_id"]),
              name: String(row["name"]),
              revision,
              charter,
              owner: {
                userId: String(row["owner_user_id"]),
                deviceId: String(row["owner_device_id"]),
              },
              state,
              revisionDigest: oldDigest,
              createdAt: Number(row["created_at"]),
              updatedAt: Number(row["updated_at"]),
              ...(Number(row["seeded"]) === 1 ? { seeded: true } : {}),
              permissions,
              standingRestrictions: restrictions,
              ...(row["next_run_at"] == null ? {} : { nextRunAt: Number(row["next_run_at"]) }),
              ...(row["last_run_at"] == null ? {} : { lastRunAt: Number(row["last_run_at"]) }),
            };
            sql.exec(
              `INSERT INTO mission_revisions (mission_id,revision,record_json,recorded_at)
               VALUES (?,?,?,?)`,
              previousRecord.missionId,
              revision,
              canonicalJson(previousRecord),
              previousRecord.updatedAt
            );
            sql.exec(
              `UPDATE missions
                  SET revision=?,charter_json=?,state=?,revision_digest=?,
                      schedule_origin_at=NULL,next_run_at=NULL
                WHERE mission_id=?`,
              revision + 1,
              canonicalJson(nextCharter),
              state === "draft" || state === "retired" ? state : "needs-reapproval",
              missionClosureDigest(nextCharter, permissions, restrictions),
              previousRecord.missionId
            );
          }
        },
      },
      {
        version: 4,
        name: "automation-termination-and-calendar-schedules",
        validateSource: (sql) => {
          assertColumns(sql, "missions", [
            "mission_id",
            "name",
            "revision",
            "charter_json",
            "permissions_json",
            "standing_restrictions_json",
            "owner_user_id",
            "owner_device_id",
            "state",
            "revision_digest",
            "active_closure_digest",
            "seeded",
            "schedule_origin_at",
            "next_run_at",
            "last_run_at",
            "created_at",
            "updated_at",
            "activated_at",
          ]);
          assertColumns(sql, "mission_runs", [
            "run_id",
            "mission_id",
            "closure_digest",
            "trigger_kind",
            "status",
            "started_at",
            "finished_at",
            "session_id",
            "channel_id",
            "context_id",
            "executor_id",
            "final_message",
            "error",
          ]);
        },
        migrate: (sql) => {
          sql.exec(missionRunsTableSql("mission_runs_v4"));
          sql.exec(`WITH numbered AS (
              SELECT r.*,
                ROW_NUMBER() OVER (
                  PARTITION BY r.mission_id ORDER BY r.started_at,r.run_id
                ) AS ordinal
              FROM mission_runs r WHERE r.status!='skipped'
            )
            INSERT INTO mission_runs_v4 (
              run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,
              started_at,run_number,finished_at,session_id,channel_id,context_id,
              executor_id,final_message,completion_response,error
            )
            SELECT r.run_id,r.mission_id,r.closure_digest,
              COALESCE(
                (SELECT CAST(json_extract(mr.record_json,'$.revision') AS INTEGER)
                   FROM mission_revisions mr
                  WHERE mr.mission_id=r.mission_id
                    AND json_extract(mr.record_json,'$.revisionDigest')=r.closure_digest
                  ORDER BY mr.revision DESC LIMIT 1),
                (SELECT m.revision FROM missions m WHERE m.mission_id=r.mission_id)
              ),
              r.trigger_kind,r.status,r.started_at,n.ordinal,r.finished_at,r.session_id,
              r.channel_id,r.context_id,r.executor_id,r.final_message,NULL,r.error
            FROM mission_runs r
            LEFT JOIN numbered n ON n.run_id=r.run_id`);
          sql.exec(`DROP TABLE mission_runs`);
          sql.exec(`ALTER TABLE mission_runs_v4 RENAME TO mission_runs`);
          sql.exec(
            `CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)`
          );
          sql.exec(missionsTableSql("missions_v4"));
          sql.exec(`INSERT INTO missions_v4 (
              mission_id,name,revision,charter_json,permissions_json,
              standing_restrictions_json,owner_user_id,owner_device_id,state,
              revision_digest,active_closure_digest,seeded,schedule_origin_at,
              next_run_at,last_run_at,created_at,updated_at,activated_at,run_count,
              completed_at,completion_reason,completion_response
            )
            SELECT m.mission_id,m.name,m.revision,m.charter_json,m.permissions_json,
              m.standing_restrictions_json,m.owner_user_id,m.owner_device_id,m.state,
              m.revision_digest,m.active_closure_digest,m.seeded,m.schedule_origin_at,
              m.next_run_at,m.last_run_at,m.created_at,m.updated_at,m.activated_at,
              (SELECT COUNT(*) FROM mission_runs r
                WHERE r.mission_id=m.mission_id AND r.status!='skipped'),
              NULL,NULL,NULL
            FROM missions m`);
          sql.exec(`DROP TABLE missions`);
          sql.exec(`ALTER TABLE missions_v4 RENAME TO missions`);
        },
      },
      {
        version: 5,
        name: "idempotent-agent-automation-proposals",
        validateSource: (sql) => {
          assertColumns(sql, "missions", [
            "mission_id",
            "name",
            "revision",
            "charter_json",
            "permissions_json",
            "standing_restrictions_json",
            "owner_user_id",
            "owner_device_id",
            "state",
            "revision_digest",
            "active_closure_digest",
            "seeded",
            "schedule_origin_at",
            "next_run_at",
            "last_run_at",
            "created_at",
            "updated_at",
            "activated_at",
            "run_count",
            "completed_at",
            "completion_reason",
            "completion_response",
          ]);
        },
        migrate: (sql) => sql.exec(missionProposalsTableSql()),
      },
    ];
  }
  static override rpcMethods = missionsMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {
    this.sql.exec(missionsTableSql("missions"));
    this.sql.exec(`CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, revision)
    )`);
    this.sql.exec(missionRunsTableSql("mission_runs"));
    this.sql.exec(missionProposalsTableSql());
    this.sql.exec(
      `CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)`
    );
  }

  protected override requiredTables(): readonly string[] {
    return ["missions", "mission_revisions", "mission_runs", "mission_proposals"];
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
         WHERE state='active' AND (
           (next_run_at IS NOT NULL AND next_run_at<=?) OR
           (json_extract(charter_json,'$.trigger.untilAt') IS NOT NULL AND
            CAST(json_extract(charter_json,'$.trigger.untilAt') AS INTEGER)<=?)
         )
         ORDER BY COALESCE(next_run_at,
           CAST(json_extract(charter_json,'$.trigger.untilAt') AS INTEGER)),mission_id`,
        now,
        now
      )
      .toArray();
    for (const row of due) {
      const mission = this.requireMission(String(row["mission_id"]), true);
      const completion = this.completionBeforeRun(mission, now);
      if (completion) {
        if (this.hasActiveRun(mission.missionId)) {
          this.sql.exec(
            "UPDATE missions SET next_run_at=NULL,updated_at=? WHERE mission_id=?",
            now,
            mission.missionId
          );
        } else {
          await this.suspendForCompletion(mission);
          this.markCompleted(mission.missionId, completion, now);
        }
        continue;
      }
      if (mission.nextRunAt !== undefined && mission.nextRunAt <= now) {
        await this.startExecution(mission, "scheduled");
      }
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
    missionId?: string;
  }): {
    generatedAt: number;
    stats: {
      total: number;
      active: number;
      running: number;
      failedLast24Hours: number;
      awaitingReview: number;
      completed: number;
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
    if (options.missionId) {
      conditions.push("mission_id=?");
      bindings.push(options.missionId);
    }
    if (query) {
      conditions.push(
        "(instr(lower(name),?)>0 OR instr(lower(json_extract(charter_json,'$.summary')),?)>0)"
      );
      bindings.push(query, query);
    }
    if (filter === "active") conditions.push("state='active'");
    if (filter === "paused") conditions.push("state='paused'");
    if (filter === "completed") conditions.push("state='completed'");
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
           SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed,
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
        completed: Number(definitionStats?.["completed"] ?? 0),
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
  getRun(runId: string): MissionRunRecord | null {
    const row = this.getRunRow(runId);
    if (!row) return null;
    this.requireMission(row.mission_id);
    return this.rowToRun(row);
  }

  @schemaRpc()
  proposeDraft(input: {
    name: string;
    charter: MissionCharter;
    permissions: MissionPermission[];
    standingRestrictions?: MissionStandingRestriction[];
  }): MissionRecord {
    return this.insertDraft(input, this.rpcIdempotencyKey ?? undefined);
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

  private insertDraft(
    input: {
      name: string;
      charter: MissionCharter;
      permissions: MissionPermission[];
      standingRestrictions?: MissionStandingRestriction[];
    },
    proposalKey?: string
  ): MissionRecord {
    const caller = this.requireOwnerCaller();
    if (proposalKey) {
      const existing = this.sql
        .exec(
          `SELECT mission_id FROM mission_proposals
            WHERE owner_user_id=? AND proposal_key=?`,
          caller.userId,
          proposalKey
        )
        .toArray()[0];
      if (existing) return this.requireMission(String(existing["mission_id"]));
    }
    assertExecutionPermissions(input.charter, input.permissions);
    const now = Date.now();
    const missionId = `msn_${crypto.randomUUID().replaceAll("-", "")}`;
    const standingRestrictions = input.standingRestrictions ?? [];
    const revisionDigest = missionClosureDigest(
      input.charter,
      input.permissions,
      standingRestrictions
    );
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO missions
         (mission_id,name,revision,charter_json,permissions_json,standing_restrictions_json,
          owner_user_id,owner_device_id,state,revision_digest,active_closure_digest,seeded,
          schedule_origin_at,next_run_at,last_run_at,created_at,updated_at,activated_at,
          run_count,completed_at,completion_reason,completion_response)
         VALUES (?,?,1,?,?,?,?,?,'draft',?,NULL,0,NULL,NULL,NULL,?,?,NULL,0,NULL,NULL,NULL)`,
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
      if (proposalKey) {
        this.sql.exec(
          `INSERT INTO mission_proposals
           (owner_user_id,proposal_key,mission_id,created_at) VALUES (?,?,?,?)`,
          caller.userId,
          proposalKey,
          missionId,
          now
        );
      }
    });
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
       schedule_origin_at=NULL,next_run_at=NULL,updated_at=?,completed_at=NULL,
       completion_reason=NULL,completion_response=NULL WHERE mission_id=?`,
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
    const now = Date.now();
    this.assertCanActivate(mission, now);
    const { body, closureDigest } = this.compileClosure(mission);
    const staleSubject = this.activeSubject(mission);
    if (staleSubject) await this.rpc.call("main", "reviewedClosure.suspend", [staleSubject]);
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
    const scheduleOriginAt = scheduleOrigin(mission.charter, now);
    const nextRunAt = initialNextRunAt(mission.charter, now, scheduleOriginAt);
    this.sql.exec(
      `UPDATE missions SET state='active',active_closure_digest=?,schedule_origin_at=?,next_run_at=?,updated_at=?,activated_at=COALESCE(activated_at,?),completed_at=NULL,completion_reason=NULL,completion_response=NULL
       WHERE mission_id=?`,
      closureDigest,
      scheduleOriginAt,
      nextRunAt,
      now,
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
    const now = Date.now();
    const completion = this.completionBeforeRun(mission, now);
    if (completion) {
      this.markCompleted(missionId, completion, now);
      return this.requireMission(missionId);
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
    completionResponse?: string;
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
    await this.terminalizeRun(row, input.outcome, {
      finalMessage: input.finalMessage,
      completionResponse: input.completionResponse,
      error: input.error,
    });
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
       revision_digest=?,active_closure_digest=NULL,next_run_at=NULL,updated_at=?,
       completed_at=NULL,completion_reason=NULL,completion_response=NULL
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
    const now = Date.now();
    const completion = this.completionBeforeRun(mission, now);
    if (completion) {
      await this.suspendForCompletion(mission);
      this.markCompleted(mission.missionId, completion, now);
      throw denied(`Automation has completed (${completion.reason})`);
    }
    const subject = this.requireActiveSubject(mission);
    const closureDigest = this.getRow(mission.missionId)?.active_closure_digest;
    if (!closureDigest) throw denied("Automation has no active reviewed closure");
    const active = this.activeRunRow(mission.missionId);
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    if (active) {
      this.sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,started_at,finished_at,error)
         VALUES (?,?,?,?,?, 'skipped',?,?,?)`,
        runId,
        mission.missionId,
        closureDigest,
        mission.revision,
        trigger,
        now,
        now,
        `Previous run ${String(active["run_id"])} is still active`
      );
      if (trigger === "scheduled") this.advanceSchedule(mission, now, mission.runCount);
      return this.requireRun(runId);
    }
    const runNumber = mission.runCount + 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,started_at,run_number)
         VALUES (?,?,?,?,?, 'starting',?,?)`,
        runId,
        mission.missionId,
        closureDigest,
        mission.revision,
        trigger,
        now,
        runNumber
      );
      this.sql.exec(
        "UPDATE missions SET last_run_at=?,updated_at=?,run_count=? WHERE mission_id=?",
        now,
        now,
        runNumber,
        mission.missionId
      );
      if (trigger === "scheduled") this.advanceSchedule(mission, now, runNumber);
    });
    this.scheduleRunStartedNotification(mission, trigger, runNumber);
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

  private scheduleRunStartedNotification(
    mission: MissionRecord,
    trigger: "manual" | "scheduled",
    runNumber: number
  ): void {
    const pending = (async () => {
      try {
        await this.rpc.call("main", "notification.showToUser", [
          mission.owner.userId,
          {
            type: "info",
            title: `Running ${mission.name}`,
            message:
              trigger === "scheduled"
                ? `Scheduled wake-up #${runNumber} is being processed.`
                : `Run #${runNumber} is being processed.`,
            ttl: RUN_STARTED_NOTIFICATION_TTL_MS,
            actions: [
              {
                id: "view-automation",
                label: "View automation",
                variant: "soft",
                command: {
                  type: "panel.open",
                  source: "about/automations",
                  stateArgs: { missionId: mission.missionId },
                },
              },
            ],
          },
        ]);
      } catch (error) {
        console.warn(
          `[MissionsDO] Could not show the transient run notice for ${mission.missionId}:`,
          error
        );
      }
    })();
    this.ctx.waitUntil?.(pending);
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
      const completion = missionCompletionResponse(result);
      await this.finishOwnedRun(
        runId,
        sessionId,
        "succeeded",
        completion?.response ?? resultSummary(result),
        undefined,
        completion?.response
      );
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
    const activity = automationActivity(mission, this.requireRun(runId));
    if (execution.action.kind === "prompt") {
      await this.rpc.call(targetId, "runAutomationTurn", [
        { channelId, prompt: execution.action.text, automation: activity },
      ]);
    } else {
      await this.rpc.call(targetId, "runAutomationEval", [
        {
          channelId,
          automation: activity,
          eval: {
            code: execution.action.code,
            ...(execution.action.syntax ? { syntax: execution.action.syntax } : {}),
            ...(execution.action.timeoutMs ? { timeoutMs: execution.action.timeoutMs } : {}),
            ...(execution.action.reset === true ? { reset: true } : {}),
          },
        },
      ]);
    }
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
    error?: string,
    completionResponse?: string
  ): Promise<void> {
    await this.rpc.call("main", "reviewedClosure.finishSession", [{ sessionId }]);
    const row = this.getRunRow(runId);
    if (!row) throw notFound(`Unknown automation run ${runId}`);
    await this.terminalizeRun(row, status, { finalMessage, completionResponse, error });
  }

  private async failStartingRun(runId: string, error: unknown): Promise<void> {
    const row = this.getRunRow(runId);
    if (!row || row.status === "succeeded" || row.status === "failed" || row.status === "skipped") {
      return;
    }
    if (row.session_id) {
      await this.rpc.call("main", "reviewedClosure.finishSession", [{ sessionId: row.session_id }]);
    }
    await this.terminalizeRun(row, "failed", { error: describeError(error) });
  }

  private async terminalizeRun(
    row: RunRow,
    status: "succeeded" | "failed",
    input: { finalMessage?: string; completionResponse?: string; error?: string }
  ): Promise<void> {
    const now = Date.now();
    const mission = this.requireMission(row.mission_id, true);
    const completion =
      row.mission_revision === mission.revision &&
      (mission.state === "active" || mission.state === "paused")
        ? this.completionAfterRun(mission, now, input.completionResponse)
        : null;
    if (completion) await this.suspendForCompletion(mission);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE mission_runs SET status=?,finished_at=?,final_message=?,completion_response=?,error=?
         WHERE run_id=? AND status IN ('starting','running')`,
        status,
        now,
        bounded(input.finalMessage) ?? null,
        bounded(input.completionResponse) ?? null,
        bounded(input.error) ?? null,
        row.run_id
      );
      if (completion) this.markCompleted(mission.missionId, completion, now);
    });
  }

  private advanceSchedule(mission: MissionRecord, now: number, runCount: number): void {
    const trigger = mission.charter.trigger;
    if (trigger.kind === "manual") return;
    const origin = this.getRow(mission.missionId)?.schedule_origin_at;
    if (trigger.kind === "schedule" && origin == null) {
      throw new Error(`Automation ${mission.missionId} has no schedule origin`);
    }
    const candidate =
      trigger.kind === "schedule"
        ? withJitter(missionNextRunAt(trigger, now, Number(origin)), trigger.jitterMs)
        : missionNextRunAt(trigger, now);
    const next =
      (trigger.maxRuns !== undefined && runCount >= trigger.maxRuns) ||
      (trigger.untilAt !== undefined && candidate >= trigger.untilAt)
        ? null
        : candidate;
    this.sql.exec(
      "UPDATE missions SET next_run_at=?,updated_at=? WHERE mission_id=?",
      next,
      now,
      mission.missionId
    );
  }

  private nextWakeAt(): number | null {
    const value = this.sql
      .exec(
        `SELECT MIN(wake_at) AS wake FROM (
           SELECT next_run_at AS wake_at FROM missions
            WHERE state='active' AND next_run_at IS NOT NULL
           UNION ALL
           SELECT CAST(json_extract(charter_json,'$.trigger.untilAt') AS INTEGER) AS wake_at
             FROM missions
            WHERE state='active' AND json_extract(charter_json,'$.trigger.untilAt') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM mission_runs r
                 WHERE r.mission_id=missions.mission_id
                   AND r.status IN ('starting','running')
              )
         )`
      )
      .one()["wake"];
    return value == null ? null : Number(value);
  }

  private activeRunRow(missionId: string): RunRow | null {
    const row = this.sql
      .exec(
        `SELECT * FROM mission_runs
         WHERE mission_id=? AND status IN ('starting','running') LIMIT 1`,
        missionId
      )
      .toArray()[0];
    return row ? (row as unknown as RunRow) : null;
  }

  private hasActiveRun(missionId: string): boolean {
    return this.activeRunRow(missionId) !== null;
  }

  private completionBeforeRun(
    mission: MissionRecord,
    now: number
  ): { reason: Exclude<MissionCompletionReason, "response"> } | null {
    const trigger = mission.charter.trigger;
    if (trigger.kind === "manual") return null;
    if (trigger.maxRuns !== undefined && mission.runCount >= trigger.maxRuns) {
      return { reason: "max-runs" };
    }
    if (trigger.untilAt !== undefined && now >= trigger.untilAt) {
      return { reason: "until" };
    }
    return null;
  }

  private completionAfterRun(
    mission: MissionRecord,
    now: number,
    response?: string
  ): { reason: MissionCompletionReason; response?: string } | null {
    const normalized = response?.trim();
    if (normalized) return { reason: "response", response: normalized };
    return this.completionBeforeRun(mission, now);
  }

  private markCompleted(
    missionId: string,
    completion: { reason: MissionCompletionReason; response?: string },
    now: number
  ): void {
    this.sql.exec(
      `UPDATE missions
          SET state='completed',next_run_at=NULL,updated_at=?,completed_at=?,
              completion_reason=?,completion_response=?
        WHERE mission_id=? AND state IN ('active','paused')`,
      now,
      now,
      completion.reason,
      bounded(completion.response) ?? null,
      missionId
    );
  }

  private async suspendForCompletion(mission: MissionRecord): Promise<void> {
    const subject = this.activeSubject(mission);
    if (subject) await this.rpc.call("main", "reviewedClosure.suspend", [subject]);
  }

  private assertCanActivate(mission: MissionRecord, now: number): void {
    const completion = this.completionBeforeRun(mission, now);
    if (completion) {
      throw denied(
        completion.reason === "until"
          ? "Automation end time has already passed"
          : "Automation has already reached its maximum run count"
      );
    }
    const trigger = mission.charter.trigger;
    if (trigger.kind === "manual" || trigger.untilAt === undefined) return;
    const origin = scheduleOrigin(mission.charter, now);
    const next = initialNextRunAt(mission.charter, now, origin);
    if (next === null || next >= trigger.untilAt) {
      throw denied("Automation has no scheduled occurrence before its end time");
    }
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
      ...(row.activated_at == null ? {} : { activatedAt: Number(row.activated_at) }),
      runCount: Number(row.run_count),
      ...(row.completed_at == null ? {} : { completedAt: Number(row.completed_at) }),
      ...(row.completion_reason == null ? {} : { completionReason: row.completion_reason }),
      ...(row.completion_response == null ? {} : { completionResponse: row.completion_response }),
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
      revision: Number(row.mission_revision),
      trigger: row.trigger_kind,
      status: row.status,
      startedAt: Number(row.started_at),
      ...(row.run_number == null ? {} : { runNumber: Number(row.run_number) }),
      ...(row.finished_at == null ? {} : { finishedAt: Number(row.finished_at) }),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.channel_id ? { channelId: row.channel_id } : {}),
      ...(row.context_id ? { contextId: row.context_id } : {}),
      ...(row.executor_id ? { executorId: row.executor_id } : {}),
      ...(row.final_message ? { finalMessage: row.final_message } : {}),
      ...(row.completion_response ? { completionResponse: row.completion_response } : {}),
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

function missionsTableSql(name: "missions" | "missions_v4"): string {
  return `CREATE TABLE ${name} (
    mission_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    charter_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    standing_restrictions_json TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    owner_device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'draft','active','needs-reapproval','paused','completed','retired'
    )),
    revision_digest TEXT NOT NULL,
    active_closure_digest TEXT,
    seeded INTEGER NOT NULL CHECK (seeded IN (0,1)),
    schedule_origin_at INTEGER,
    next_run_at INTEGER,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    activated_at INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
    completed_at INTEGER,
    completion_reason TEXT CHECK (
      completion_reason IS NULL OR completion_reason IN ('until','max-runs','response')
    ),
    completion_response TEXT
  )`;
}

function missionRunsTableSql(name: "mission_runs" | "mission_runs_v4"): string {
  return `CREATE TABLE ${name} (
    run_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    closure_digest TEXT NOT NULL,
    mission_revision INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
    status TEXT NOT NULL CHECK (status IN ('starting','running','succeeded','failed','skipped')),
    started_at INTEGER NOT NULL,
    run_number INTEGER,
    finished_at INTEGER,
    session_id TEXT,
    channel_id TEXT,
    context_id TEXT,
    executor_id TEXT,
    final_message TEXT,
    completion_response TEXT,
    error TEXT
  )`;
}

function missionProposalsTableSql(): string {
  return `CREATE TABLE mission_proposals (
    owner_user_id TEXT NOT NULL,
    proposal_key TEXT NOT NULL,
    mission_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, proposal_key)
  )`;
}

function assertColumns(
  sql: { exec(query: string): { toArray(): Array<Record<string, unknown>> } },
  table: string,
  expected: readonly string[]
): void {
  const columns = sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .map((column) => String(column["name"]));
  if (JSON.stringify(columns) !== JSON.stringify(expected)) {
    throw new Error(`MissionsDO source table ${table} is unknown: ${JSON.stringify(columns)}`);
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
  if (charter.trigger.kind === "manual") return null;
  if (charter.trigger.kind === "cron") return missionNextRunAt(charter.trigger, now);
  if (origin == null) throw new Error("Interval automation requires a cadence origin");
  return withJitter(missionNextRunAt(charter.trigger, now, origin), charter.trigger.jitterMs);
}

function withJitter(value: number, jitterMs = 0): number {
  return value + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
}

function legacyPromptClosureDigest(
  charter: Record<string, unknown>,
  permissions: readonly MissionPermission[],
  standingRestrictions: readonly MissionStandingRestriction[]
): string {
  return createHash("sha256")
    .update("automation-closure-v3\0", "utf8")
    .update(canonicalJson({ charter, permissions, standingRestrictions }), "utf8")
    .digest("hex");
}

function executionLabel(execution: MissionExecution): string {
  if (execution.kind === "method") return `${execution.target.className}.${execution.method}`;
  return `${execution.action.kind === "eval" ? "Eval in" : "Prompt"} ${execution.target.className}`;
}

function automationActivity(mission: MissionRecord, run: MissionRunRecord) {
  const trigger = mission.charter.trigger;
  const action =
    mission.charter.execution.kind === "agent" ? mission.charter.execution.action.kind : "method";
  return {
    missionId: mission.missionId,
    runId: run.runId,
    name: mission.name,
    revision: mission.revision,
    action,
    trigger: run.trigger,
    startedAt: run.startedAt,
    createdAt: mission.createdAt,
    ...(mission.activatedAt === undefined ? {} : { activatedAt: mission.activatedAt }),
    ...(run.runNumber === undefined ? {} : { runNumber: run.runNumber }),
    schedule:
      trigger.kind === "schedule"
        ? {
            kind: "interval" as const,
            everyMs: trigger.everyMs,
            ...(trigger.anchorAt === undefined ? {} : { anchorAt: trigger.anchorAt }),
            ...(trigger.jitterMs === undefined ? {} : { jitterMs: trigger.jitterMs }),
            ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
            ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
          }
        : trigger.kind === "cron"
          ? {
              kind: "cron" as const,
              expression: trigger.expression,
              timezone: trigger.timezone,
              ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
              ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
            }
          : null,
  };
}

function triggerLabel(charter: MissionCharter): string {
  const trigger = charter.trigger;
  if (trigger.kind === "manual") return "Manual";
  if (trigger.kind === "cron") return `${trigger.expression} in ${trigger.timezone}`;
  return `Every ${trigger.everyMs} ms${
    trigger.anchorAt === undefined ? "" : ` from ${trigger.anchorAt}`
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
