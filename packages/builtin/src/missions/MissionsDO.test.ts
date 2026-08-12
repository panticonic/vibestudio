import { describe, expect, it } from "vitest";
import { DURABLE_OBJECT_FRAMEWORK_RPC_METHODS } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type { MissionCharter, MissionRecord } from "@vibestudio/shared/authority/mission";
import type { ReviewedExecutionClosureBody } from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { MissionsDO } from "./MissionsDO.js";

const charter = (): MissionCharter => ({
  summary: "Prepare a daily summary",
  harness: { unit: "workers/summary", ev: "a".repeat(64) },
  execution: {
    kind: "agent",
    target: { source: "workers/summary", className: "SummaryAgent", objectKey: "daily" },
    prompt: "Prepare a daily summary",
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

async function missions() {
  return createTestDO(MissionsDO, {
    WORKER_SOURCE: "vibestudio/internal",
    WORKER_CLASS_NAME: "MissionsDO",
    __objectKey: "workspace",
  });
}

describe("MissionsDO", () => {
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
         (run_id,mission_id,closure_digest,trigger_kind,status,started_at,finished_at,final_message,error)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        `run-${index}`,
        created.missionId,
        "b".repeat(64),
        index % 2 === 0 ? "scheduled" : "manual",
        status,
        now - index * 1_000,
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
});
