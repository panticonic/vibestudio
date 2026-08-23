import { describe, expect, it } from "vitest";
import {
  missionCharterSchema,
  missionRecordSchema,
  missionRunRecordSchema,
  missionsMethods,
} from "./missions.js";

describe("missions service agent ergonomics", () => {
  it("exposes immediate launch and lifecycle control to sessions", () => {
    for (const method of ["edit", "runNow", "pause", "resume", "retire"] as const) {
      expect(missionsMethods[method].agentFacing).toBe(true);
      expect(missionsMethods[method].tier.session).toBe("family");
      expect(missionsMethods[method].authority?.principals).toContain("session");
    }
    expect(missionsMethods.launch.agentFacing).toBe(false);
    expect(missionsMethods.launch.tier.tier).toBe("open");
    expect(missionsMethods).not.toHaveProperty("requestReview");
  });

  it("provides one addressed read for a transcript tick inspector", () => {
    expect(missionsMethods.getRun.agentFacing).not.toBe(false);
    expect(missionsMethods.getRun.tier.session).toBe("family");
    expect(missionsMethods.getRun.description).toContain("exact automation run");
  });

  it("carries calendar, finite-run, and completion state through the wire contract", () => {
    const charter = missionCharterSchema.parse({
      summary: "Watch the rollout",
      harness: { unit: "workers/rollout", ev: "a".repeat(64) },
      execution: {
        kind: "method",
        target: { source: "workers/rollout", className: "RolloutDO", objectKey: "primary" },
        method: "check",
        args: [],
      },
      trigger: {
        kind: "cron",
        expression: "5 5 * * THU",
        timezone: "America/New_York",
        untilAt: 1_800_000_000_000,
        maxRuns: 12,
      },
    });
    expect(charter.trigger).toMatchObject({ kind: "cron", maxRuns: 12 });
    expect(
      missionRecordSchema.parse({
        missionId: "mission-rollout",
        name: "Rollout watcher",
        revision: 1,
        charter,
        owner: { userId: "alice", deviceId: "panel:alice" },
        state: "completed",
        revisionDigest: "b".repeat(64),
        createdAt: 1,
        updatedAt: 2,
        runCount: 3,
        completedAt: 3,
        completionReason: "response",
        completionResponse: "The rollout is complete.",
        permissions: [],
        standingRestrictions: [],
      })
    ).toMatchObject({ state: "completed", runCount: 3, completionReason: "response" });
    expect(
      missionRunRecordSchema.parse({
        runId: "run-3",
        missionId: "mission-rollout",
        closureDigest: "c".repeat(64),
        revision: 1,
        trigger: "scheduled",
        status: "succeeded",
        startedAt: 2,
        runNumber: 3,
        completionResponse: "The rollout is complete.",
      })
    ).toMatchObject({ revision: 1, runNumber: 3, completionResponse: "The rollout is complete." });
  });
});
