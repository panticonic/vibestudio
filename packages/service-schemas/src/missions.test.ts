import { describe, expect, it, vi } from "vitest";
import { createMissionsClient, type MissionRpc } from "./clients/missionsClient.js";
import {
  missionCharterSchema,
  missionRecordSchema,
  missionRunRecordSchema,
  missionsMethods,
  missionsRpcMethods,
} from "./missions.js";

const hex = "a".repeat(64);
const image = {
  source: "workers/rollout",
  ref: `state:${"b".repeat(64)}`,
  effectiveVersion: hex,
  className: "RolloutDO",
  objectKey: "primary",
};

describe("missions v3 contract", () => {
  it("requires a digest and reversible action for the revision-guarded method", () => {
    const { args } = missionsMethods.transitionAtRevision;
    expect(args.parse(["mission", "pause", hex])).toEqual(["mission", "pause", hex]);
    expect(args.safeParse(["mission", "resume"]).success).toBe(false);
    expect(args.safeParse(["mission", "retire", hex]).success).toBe(false);
    expect(args.safeParse(["mission", "resume", "unknown-revision"]).success).toBe(false);
    expect(missionsMethods.pause.args.parse(["mission"])).toEqual(["mission"]);
    expect(missionsMethods.resume.args.parse(["mission"])).toEqual(["mission"]);
  });

  it("sends the guarded transition through the revision-aware receiver", async () => {
    const result = { state: "paused", missionId: "mission", revisionDigest: hex };
    const call = vi
      .fn()
      .mockResolvedValueOnce({ kind: "durable-object", targetId: "controller" })
      .mockResolvedValueOnce(result);
    const client = createMissionsClient({ call } as unknown as MissionRpc);
    await expect(client.transitionAtRevision("mission", "pause", hex)).resolves.toEqual(result);
    expect(call.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "controller",
      missionsRpcMethods.transitionAtRevision,
      ["mission", "pause", hex],
    ]);
    expect(call).toHaveBeenCalledTimes(2);
  });
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
    const authorityPlan = {
      schemaVersion: 2,
      digest: hex,
      artifactRef: `authority-plan:${hex}`,
      compilerVersion: "1",
      catalogDigest: hex,
    };
    expect(
      missionRecordSchema.parse({
        schemaVersion: 3,
        missionId: "rollout",
        name: "Rollout watcher",
        revision: 1,
        charter,
        authorityPlan,
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
    expect(missionsMethods.pause.tier.tier).toBe("open");
    expect(missionsMethods.resume.tier.tier).toBe("open");
    expect(missionsMethods.pause.tier.rationale).toContain("without changing standing authority");
  });
});
