import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DURABLE_OBJECT_FRAMEWORK_RPC_METHODS,
  DurableObjectBase,
  type DurableObjectContext,
} from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/shared/authority/mission";
import type { ReviewedExecutionClosureBody } from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { MissionsDO } from "./MissionsDO.js";

class LegacyMissionsV2DO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected override schemaProductionBaseline() {
    return { version: 2, name: "automations-v2" } as const;
  }

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
}

class IdempotentProposalMissionsDO extends MissionsDO {
  protected override get rpcIdempotencyKey(): string | null {
    return "agent-proposal-request";
  }
}

const charter = (): MissionCharter => ({
  summary: "Prepare a daily summary",
  harness: { unit: "workers/summary", ev: "a".repeat(64) },
  execution: {
    kind: "agent",
    target: { source: "workers/summary", className: "SummaryAgent", objectKey: "daily" },
    action: { kind: "prompt", text: "Prepare a daily summary" },
    conversation: { mode: "fresh" },
    toolExposure: {
      services: ["docs.read"],
      userlandServices: [],
      workspaceServiceDiscovery: "bound",
      evalNetwork: "none",
      declaredOrigins: [],
    },
    declaredLineageClasses: ["none"],
  },
  trigger: { kind: "manual" },
});

const methodCharter = (resultLimit?: number): MissionCharter => ({
  summary: "Check whether the rollout is complete",
  harness: { unit: "workers/rollout", ev: "d".repeat(64) },
  execution: {
    kind: "method",
    target: { source: "workers/rollout", className: "RolloutWorker", objectKey: "primary" },
    method: "check",
    args: [],
  },
  trigger: {
    kind: "cron",
    expression: "5 5 * * THU",
    timezone: "America/New_York",
    ...(resultLimit === undefined ? {} : { maxRuns: resultLimit }),
  },
});

async function missions() {
  return createTestDO(MissionsDO, {
    WORKER_SOURCE: "vibestudio/internal",
    WORKER_CLASS_NAME: "MissionsDO",
    __objectKey: "workspace",
  });
}

describe("MissionsDO", () => {
  it("migrates v2 automation history forward without resetting it", async () => {
    const legacy = await createTestDO(LegacyMissionsV2DO);
    const currentCharter = charter();
    if (
      currentCharter.execution.kind !== "agent" ||
      currentCharter.execution.action.kind !== "prompt"
    ) {
      throw new Error("Expected prompt charter fixture");
    }
    const legacyCharter = {
      ...currentCharter,
      execution: {
        kind: "agent",
        target: currentCharter.execution.target,
        prompt: currentCharter.execution.action.text,
        conversation: currentCharter.execution.conversation,
        toolExposure: currentCharter.execution.toolExposure,
        declaredLineageClasses: currentCharter.execution.declaredLineageClasses,
      },
    };
    const legacyDigest = createHash("sha256")
      .update("automation-closure-v3\0", "utf8")
      .update(
        canonicalJson({ charter: legacyCharter, permissions: [], standingRestrictions: [] }),
        "utf8"
      )
      .digest("hex");
    legacy.sql.exec(
      `INSERT INTO missions
       (mission_id,name,revision,charter_json,permissions_json,standing_restrictions_json,
        owner_user_id,owner_device_id,state,revision_digest,active_closure_digest,seeded,
        schedule_origin_at,next_run_at,last_run_at,created_at,updated_at)
       VALUES ('kept','Existing automation',1,?,'[]','[]','alice','panel:alice','active',?,?,0,1,2,NULL,1,1)`,
      canonicalJson(legacyCharter),
      legacyDigest,
      legacyDigest
    );
    legacy.sql.exec(
      `INSERT INTO mission_runs
       (run_id,mission_id,closure_digest,trigger_kind,status,started_at,finished_at,final_message)
       VALUES ('legacy-run','kept',?,'scheduled','succeeded',1,2,'done')`,
      legacyDigest
    );

    const migrated = await createTestDO(
      MissionsDO,
      {
        WORKER_SOURCE: "vibestudio/internal",
        WORKER_CLASS_NAME: "MissionsDO",
        __objectKey: "workspace",
      },
      { db: legacy.db }
    );

    expect(
      migrated.sql
        .exec(`PRAGMA table_info(missions)`)
        .toArray()
        .map((column) => column["name"])
    ).toEqual(
      expect.arrayContaining([
        "activated_at",
        "run_count",
        "completed_at",
        "completion_reason",
        "completion_response",
      ])
    );
    await expect(
      migrated.callAs<MissionRecord>(
        { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
        "get",
        "kept"
      )
    ).resolves.toMatchObject({
      name: "Existing automation",
      revision: 2,
      state: "needs-reapproval",
      runCount: 1,
      charter: { execution: { action: { kind: "prompt", text: "Prepare a daily summary" } } },
    });
    expect(
      migrated.sql.exec(`SELECT next_run_at FROM missions WHERE mission_id='kept'`).one()
    ).toEqual({
      next_run_at: null,
    });
    expect(
      migrated.sql.exec(`SELECT active_closure_digest FROM missions WHERE mission_id='kept'`).one()
    ).toEqual({ active_closure_digest: legacyDigest });
    expect(
      migrated.sql
        .exec(`SELECT revision,record_json FROM mission_revisions WHERE mission_id='kept'`)
        .one()
    ).toMatchObject({
      revision: 1,
      record_json: expect.stringContaining('"prompt":"Prepare a daily summary"'),
    });
    expect(
      migrated.sql.exec(`SELECT version, name FROM _vibestudio_schema_migrations`).toArray()
    ).toEqual([
      { version: 3, name: "automation-actions-and-activation" },
      { version: 4, name: "automation-termination-and-calendar-schedules" },
      { version: 5, name: "idempotent-agent-automation-proposals" },
    ]);
    expect(
      migrated.sql
        .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='mission_proposals'`)
        .one()
    ).toEqual({ name: "mission_proposals" });
    await expect(
      migrated.callAs(
        { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
        "getRun",
        "legacy-run"
      )
    ).resolves.toMatchObject({ revision: 1, runNumber: 1, finalMessage: "done" });
  });

  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await missions();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(missionsMethods).sort());
  });

  it("owns drafts per authenticated user and records a revision digest", async () => {
    const { callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const bob = { callerId: "panel:bob", callerKind: "panel" as const, userId: "bob" };
    const created = await callAs<MissionRecord>(alice, "createDraft", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });

    expect(created).toMatchObject({
      name: "Daily summary",
      state: "draft",
      revision: 1,
      owner: { userId: "alice", deviceId: "panel:alice" },
    });
    expect(created.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(callAs(bob, "get", created.missionId)).rejects.toThrow(/Unknown automation/);
    await expect(callAs<MissionRecord[]>(alice, "list")).resolves.toEqual([
      expect.objectContaining({ missionId: created.missionId }),
    ]);
  });

  it("returns the same draft when an agent proposal transport is retried", async () => {
    const { callAs, sql } = await createTestDO(IdempotentProposalMissionsDO, {
      WORKER_SOURCE: "vibestudio/internal",
      WORKER_CLASS_NAME: "MissionsDO",
      __objectKey: "workspace",
    });
    const caller = { callerId: "do:agent", callerKind: "do" as const, userId: "alice" };
    const input = { name: "Daily summary", charter: charter(), permissions: [] };

    const first = await callAs<MissionRecord>(caller, "proposeDraft", input);
    const retried = await callAs<MissionRecord>(caller, "proposeDraft", input);

    expect(retried.missionId).toBe(first.missionId);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM missions`).one()).toEqual({ count: 1 });
    expect(sql.exec(`SELECT mission_id FROM mission_proposals`).one()).toEqual({
      mission_id: first.missionId,
    });
  });

  it("compiles only eligible gated permissions into standing grants", async () => {
    const { instance, callAs } = await missions();
    const created = await callAs<MissionRecord>(
      { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
      "createDraft",
      {
        name: "Daily summary",
        charter: charter(),
        permissions: [
          {
            capability: "docs.read",
            resource: { kind: "prefix", prefix: "docs/" },
            tier: "gated",
          },
          {
            capability: "workspace.storage.delete",
            resource: { kind: "exact", key: "workspace" },
            tier: "critical",
          },
        ],
      }
    );
    const compiled = (
      instance as unknown as {
        compileClosure(record: MissionRecord): { body: ReviewedExecutionClosureBody };
      }
    ).compileClosure(created);

    expect(compiled.body.grants).toEqual([
      expect.objectContaining({ capability: "docs.read", tier: "gated" }),
    ]);
    expect(compiled.body.grantDependencies).toEqual([]);
  });

  it("returns one bounded supervision overview and cursor-pages older runs", async () => {
    const { instance, callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const created = await callAs<MissionRecord>(alice, "createDraft", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });
    const sql = (
      instance as unknown as {
        sql: { exec(query: string, ...bindings: unknown[]): unknown };
      }
    ).sql;
    const now = Date.now();
    for (let index = 0; index < 8; index += 1) {
      const status = index === 0 ? "running" : index === 1 ? "failed" : "succeeded";
      sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,started_at,run_number,finished_at,final_message,error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        `run-${index}`,
        created.missionId,
        "b".repeat(64),
        created.revision,
        index % 2 === 0 ? "scheduled" : "manual",
        status,
        now - index * 1_000,
        index + 1,
        status === "running" ? null : now - index * 1_000 + 250,
        status === "succeeded" ? `result ${index}` : null,
        status === "failed" ? "provider unavailable" : null
      );
    }

    const overview = await callAs<{
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
        recentRuns: Array<{ runId: string }>;
        totalRuns: number;
        activeRuns: number;
        failedRunsSince: number;
      }>;
      attention: Array<{ missionId: string; run: { runId: string; error?: string } }>;
    }>(alice, "overview", {});
    expect(overview.stats).toEqual({
      total: 1,
      active: 0,
      running: 1,
      failedLast24Hours: 1,
      awaitingReview: 1,
      completed: 0,
    });
    expect(overview.items).toEqual([
      expect.objectContaining({
        automation: expect.objectContaining({ missionId: created.missionId }),
        totalRuns: 8,
        activeRuns: 1,
        failedRunsSince: 1,
        recentRuns: expect.arrayContaining([expect.objectContaining({ runId: "run-0" })]),
      }),
    ]);
    expect(overview.items[0]?.recentRuns).toHaveLength(5);
    expect(overview.attention).toEqual([
      expect.objectContaining({
        missionId: created.missionId,
        run: expect.objectContaining({ runId: "run-1", error: "provider unavailable" }),
      }),
    ]);
    await expect(callAs(alice, "getRun", "run-1")).resolves.toMatchObject({
      runId: "run-1",
      missionId: created.missionId,
      status: "failed",
      error: "provider unavailable",
    });
    await expect(callAs(alice, "getRun", "missing-run")).resolves.toBeNull();

    const first = await callAs<{
      items: Array<{ runId: string; startedAt: number }>;
      nextCursor?: { startedAt: number; runId: string };
    }>(alice, "listRuns", created.missionId, { limit: 3 });
    expect(first.items.map((run) => run.runId)).toEqual(["run-0", "run-1", "run-2"]);
    expect(first.nextCursor).toEqual({
      startedAt: first.items[2]?.startedAt,
      runId: "run-2",
    });
    const second = await callAs<{ items: Array<{ runId: string }> }>(
      alice,
      "listRuns",
      created.missionId,
      { limit: 3, cursor: first.nextCursor }
    );
    expect(second.items.map((run) => run.runId)).toEqual(["run-3", "run-4", "run-5"]);
  });

  it("pages and filters definitions on the server while keeping global counts", async () => {
    const { instance, callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const records = await Promise.all(
      ["Archive cleanup", "Billing digest", "Customer briefing", "Dependency review"].map((name) =>
        callAs<MissionRecord>(alice, "createDraft", {
          name,
          charter: { ...charter(), summary: `${name} summary` },
          permissions: [],
        })
      )
    );
    const sql = (
      instance as unknown as { sql: { exec(query: string, ...bindings: unknown[]): unknown } }
    ).sql;
    records.forEach((record, index) => {
      sql.exec(
        "UPDATE missions SET updated_at=?,state=? WHERE mission_id=?",
        10_000 + index,
        index === 2 ? "paused" : "draft",
        record.missionId
      );
    });

    const first = await callAs<{
      stats: { total: number; awaitingReview: number };
      items: Array<{ automation: MissionRecord }>;
      nextCursor?: { updatedAt: number; missionId: string };
    }>(alice, "overview", { limit: 2 });
    expect(first.stats).toMatchObject({ total: 4, awaitingReview: 3 });
    expect(first.items.map((item) => item.automation.name)).toEqual([
      "Dependency review",
      "Customer briefing",
    ]);
    expect(first.nextCursor).toEqual({
      updatedAt: 10_002,
      missionId: records[2]!.missionId,
    });

    const second = await callAs<{
      items: Array<{ automation: MissionRecord }>;
      nextCursor?: unknown;
    }>(alice, "overview", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.automation.name)).toEqual([
      "Billing digest",
      "Archive cleanup",
    ]);
    expect(second.nextCursor).toBeUndefined();

    const drafts = await callAs<{ items: Array<{ automation: MissionRecord }> }>(
      alice,
      "overview",
      { filter: "drafts" }
    );
    expect(drafts.items.map((item) => item.automation.name)).not.toContain("Customer briefing");

    const search = await callAs<{ items: Array<{ automation: MissionRecord }> }>(
      alice,
      "overview",
      { query: "BILLING" }
    );
    expect(search.items.map((item) => item.automation.name)).toEqual(["Billing digest"]);
  });

  it("runs calendar automations to natural completion and preserves editable history", async () => {
    const { instance, callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method === "reviewedClosure.activate") return undefined;
      if (target === "main" && method === "reviewedClosure.suspend") return undefined;
      if (target === "main" && method === "reviewedClosure.bindSession") return undefined;
      if (target === "main" && method === "reviewedClosure.finishSession") return undefined;
      if (target === "main" && method === "runtime.createEntity") {
        return { id: "rollout-worker", targetId: "do:rollout", contextId: undefined };
      }
      if (target === "do:rollout" && method === "check") {
        return {
          protocol: "automation-completion.v1",
          response: "The rollout reached 100% and passed its health checks.",
        };
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const draft = await callAs<MissionRecord>(alice, "createDraft", {
      name: "Rollout watcher",
      charter: methodCharter(10),
      permissions: [],
    });
    const active = await callAs<MissionRecord>(alice, "requestReview", draft.missionId);

    expect(active).toMatchObject({
      state: "active",
      runCount: 0,
      charter: {
        trigger: {
          kind: "cron",
          expression: "5 5 * * THU",
          timezone: "America/New_York",
          maxRuns: 10,
        },
      },
    });
    expect(active.nextRunAt).toBeGreaterThan(Date.now());

    const run = await callAs<MissionRunRecord>(alice, "runNow", draft.missionId);
    expect(run).toMatchObject({
      revision: 1,
      runNumber: 1,
      status: "succeeded",
      completionResponse: "The rollout reached 100% and passed its health checks.",
    });
    const completed = await callAs<MissionRecord>(alice, "get", draft.missionId);
    expect(completed).toMatchObject({
      state: "completed",
      runCount: 1,
      completionReason: "response",
      completionResponse: "The rollout reached 100% and passed its health checks.",
    });
    expect(completed.nextRunAt).toBeUndefined();

    const revised = await callAs<MissionRecord>(alice, "edit", draft.missionId, {
      charter: methodCharter(3),
    });
    expect(revised).toMatchObject({
      state: "needs-reapproval",
      revision: 2,
      runCount: 1,
    });
    expect(revised.completedAt).toBeUndefined();
    expect(revised.completionReason).toBeUndefined();
    expect(revised.completionResponse).toBeUndefined();
  });

  it("completes after the configured maximum even when the terminal run fails", async () => {
    const { instance, callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method.startsWith("reviewedClosure.")) return undefined;
      if (target === "main" && method === "runtime.createEntity") {
        return { id: "rollout-worker", targetId: "do:rollout" };
      }
      if (target === "do:rollout" && method === "check") throw new Error("health check failed");
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const draft = await callAs<MissionRecord>(alice, "createDraft", {
      name: "Bounded rollout watcher",
      charter: methodCharter(1),
      permissions: [],
    });
    await callAs(alice, "requestReview", draft.missionId);
    const run = await callAs<MissionRunRecord>(alice, "runNow", draft.missionId);

    expect(run).toMatchObject({ status: "failed", runNumber: 1, error: "health check failed" });
    await expect(callAs<MissionRecord>(alice, "get", draft.missionId)).resolves.toMatchObject({
      state: "completed",
      runCount: 1,
      completionReason: "max-runs",
    });
  });

  it("ends at the reviewed until boundary without starting another run", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 12, 12);
      vi.setSystemTime(now);
      const { instance, callAs } = await missions();
      const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
      const rpcCall = vi.fn(async (target: string, method: string) => {
        if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
        if (
          target === "main" &&
          (method === "reviewedClosure.activate" || method === "reviewedClosure.suspend")
        )
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      });
      Object.defineProperty(instance, "rpc", {
        value: { call: rpcCall },
        configurable: true,
      });
      const scheduled = charter();
      scheduled.trigger = {
        kind: "schedule",
        everyMs: 60_000,
        untilAt: now + 90_000,
      };
      const draft = await callAs<MissionRecord>(alice, "createDraft", {
        name: "Short-lived watcher",
        charter: scheduled,
        permissions: [],
      });
      await callAs(alice, "requestReview", draft.missionId);

      vi.setSystemTime(now + 90_000);
      await instance.alarm();

      await expect(callAs<MissionRecord>(alice, "get", draft.missionId)).resolves.toMatchObject({
        state: "completed",
        runCount: 0,
        completedAt: now + 90_000,
        completionReason: "until",
      });
      expect(rpcCall).not.toHaveBeenCalledWith(
        expect.anything(),
        "runtime.createEntity",
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
