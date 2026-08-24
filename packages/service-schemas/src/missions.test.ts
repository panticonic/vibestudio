import { describe, expect, it } from "vitest";
import {
  missionCharterSchema,
  missionRecordSchema,
  missionRunRecordSchema,
  missionsMethods,
} from "./missions.js";

const hex = "a".repeat(64);
const image = {
  source: "workers/rollout",
  ref: `state:${"b".repeat(64)}`,
  effectiveVersion: hex,
  className: "RolloutDO",
  objectKey: "primary",
};

describe("missions v2 contract", () => {
  it("launches immediately and has no review endpoint", () => {
    expect(missionsMethods.launch.tier.tier).toBe("open");
    expect(missionsMethods).not.toHaveProperty("requestReview");
    expect(missionsMethods).not.toHaveProperty("pauseForAuthorityDenial");
  });

  it("requires an immutable image and semantic operations", () => {
    const charter = missionCharterSchema.parse({
      summary: "Watch the rollout",
      execution: {
        kind: "method",
        image,
        method: "check",
        args: [],
        operations: [{ service: "workers/rollout", method: "check", args: [], use: "action" }],
      },
      trigger: {
        kind: "cron",
        expression: "5 5 * * THU",
        timezone: "America/New_York",
        maxRuns: 12,
      },
    });
    const operationPolicy = {
      schemaVersion: 1,
      digest: hex,
      artifactRef: `policy:${hex}`,
      compilerVersion: "1",
      catalogDigest: hex,
    };
    expect(
      missionRecordSchema.parse({
        schemaVersion: 2,
        missionId: "rollout",
        name: "Rollout watcher",
        revision: 1,
        charter,
        operationPolicy,
        owner: { userId: "alice" },
        state: "active",
        revisionDigest: hex,
        authority: { requestIds: [], grantIds: [], denialIds: [] },
        createdAt: 1,
        updatedAt: 1,
        activatedAt: 1,
        runCount: 0,
      }).state
    ).toBe("active");
    expect(
      missionRunRecordSchema.parse({
        runId: "run-1",
        missionId: "rollout",
        missionSubject: `mission:rollout@${hex}`,
        revision: 1,
        trigger: "scheduled",
        phase: "terminal",
        outcome: "succeeded",
        startedAt: 1,
      }).outcome
    ).toBe("succeeded");
  });

  it("pause changes scheduling state without changing authority", () => {
    expect(missionsMethods.pause.tier.rationale).toContain("without changing standing authority");
  });
});
