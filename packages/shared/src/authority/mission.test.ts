import { describe, expect, it } from "vitest";
import {
  missionCompletionResponse,
  missionNextRunAt,
  missionPrincipal,
  missionRevisionDigest,
  validateMissionCharter,
  type MissionCharter,
} from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  summary: "Back up the project",
  execution: {
    kind: "agent",
    image: {
      source: "workers/system-agent",
      ref: `state:${"b".repeat(64)}`,
      effectiveVersion: hex,
      className: "SystemAgent",
      objectKey: "backup",
    },
    action: { kind: "prompt", text: "Back up the project" },
    conversation: { mode: "fresh" },
    operations: [
      { service: "notification", method: "post", use: "action" },
      { service: "logs", method: "query", use: "conditional" },
    ],
  },
  trigger: { kind: "schedule", everyMs: 86_400_000, anchorAt: 1_000 },
});

describe("automation revision", () => {
  it("requires one immutable execution image", () => {
    const value = charter();
    value.execution.image.ref = "state:bad";
    expect(() => validateMissionCharter(value)).toThrow("exact immutable execution image");
  });

  it("closes over executable behavior and compiled operation policy", () => {
    const first = missionRevisionDigest(charter(), hex);
    expect(
      missionRevisionDigest(
        { ...charter(), trigger: { kind: "schedule", everyMs: 3_600_000 } },
        hex
      )
    ).not.toBe(first);
    expect(missionRevisionDigest(charter(), "b".repeat(64))).not.toBe(first);
    expect(missionPrincipal("backup", first)).toBe(`mission:backup@${first}`);
  });

  it("requires exact operations and rejects duplicates", () => {
    const duplicate = charter();
    duplicate.execution.operations = [
      { service: "notification", method: "post", use: "action" },
      { service: "notification", method: "post", use: "conditional" },
    ];
    expect(() => validateMissionCharter(duplicate)).toThrow("Duplicate automation operation");
    const inexact = charter();
    inexact.execution.operations = [{ service: "*", method: "request", use: "action" }];
    expect(() => validateMissionCharter(inexact)).toThrow("exact service and method names");
  });

  it("computes aligned and calendar occurrences", () => {
    expect(missionNextRunAt({ kind: "schedule", everyMs: 60_000, anchorAt: 500 }, 500)).toBe(
      60_500
    );
    const cron = { kind: "cron", expression: "5 5 * * THU", timezone: "America/New_York" } as const;
    expect(missionNextRunAt(cron, Date.UTC(2026, 2, 5, 10, 4, 59))).toBe(
      Date.UTC(2026, 2, 5, 10, 5)
    );
  });

  it("recognizes only explicit natural completion", () => {
    expect(
      missionCompletionResponse({ protocol: "automation-completion.v1", response: "  Complete.  " })
    ).toEqual({ protocol: "automation-completion.v1", response: "Complete." });
    expect(missionCompletionResponse({ response: "done" })).toBeNull();
  });
});
