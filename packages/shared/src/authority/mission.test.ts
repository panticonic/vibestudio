import { describe, expect, it } from "vitest";
import { missionAllowsService, missionClosureDigest, missionSubject, type MissionCharter } from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  taskSpec: "Back up the project",
  harness: { unit: "workspace/workers/system-agent", ev: hex },
  skills: [{ path: "workspace/skills/backup", contentHash: "b".repeat(64) }],
  toolExposure: { services: ["logs.query", "notification.*"], userlandServices: [], evalNetwork: "none", declaredOrigins: [] },
  model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: { reasoningEffort: "medium" } },
  trigger: { kind: "cron", cron: "0 2 * * *" },
});

describe("mission closure", () => {
  it("changes for behavioral edits but not registry identity", () => {
    const first = missionClosureDigest(charter());
    expect(missionClosureDigest({ ...charter(), trigger: { kind: "cron", cron: "0 3 * * *" } })).not.toBe(first);
    expect(missionSubject({ missionId: "msn_one", closureDigest: first })).not.toBe(
      missionSubject({ missionId: "msn_two", closureDigest: first })
    );
  });

  it("enforces structural method exposure and rejects global wildcards", () => {
    expect(missionAllowsService(charter(), "notification.post")).toBe(true);
    expect(missionAllowsService(charter(), "credential.delete")).toBe(false);
    expect(() => missionClosureDigest({ ...charter(), toolExposure: { ...charter().toolExposure, services: ["*"] } })).toThrow(/Invalid/);
  });
});
