import { describe, expect, it } from "vitest";
import {
  missionAllowsService,
  missionClosureDigest,
  missionNextRunAt,
  type MissionCharter,
} from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  summary: "Back up the project",
  harness: { unit: "workers/system-agent", ev: hex },
  execution: {
    kind: "agent",
    target: {
      source: "workers/system-agent",
      className: "SystemAgent",
      objectKey: "backup",
    },
    action: { kind: "prompt", text: "Back up the project" },
    conversation: { mode: "fresh" },
    toolExposure: {
      services: ["logs.query", "notification.*"],
      userlandServices: [],
      workspaceServiceDiscovery: "bound",
      evalNetwork: "none",
      declaredOrigins: [],
    },
    declaredLineageClasses: ["none"],
  },
  trigger: { kind: "schedule", everyMs: 86_400_000, anchorAt: 1_000 },
});
const closure = (value: MissionCharter): string => missionClosureDigest(value, [], []);

describe("automation closure", () => {
  it("changes for execution and schedule edits", () => {
    const first = closure(charter());
    expect(closure({ ...charter(), trigger: { kind: "schedule", everyMs: 3_600_000 } })).not.toBe(
      first
    );
    const current = charter();
    if (current.execution.kind !== "agent") throw new Error("fixture");
    const execution = current.execution;
    expect(
      closure({
        ...current,
        execution: {
          ...execution,
          action: { kind: "prompt", text: "Back up and verify the project" },
        },
      })
    ).not.toBe(first);
  });

  it("changes when approved allows or standing denies change", () => {
    const empty = missionClosureDigest(charter(), [], []);
    expect(
      missionClosureDigest(
        charter(),
        [
          {
            capability: "service:notification.post",
            resource: { kind: "exact", key: "service:notification.post" },
            tier: "gated",
          },
        ],
        []
      )
    ).not.toBe(empty);
    expect(
      missionClosureDigest(
        charter(),
        [],
        [{ capability: "credential.use", resourceKey: "credentials:all" }]
      )
    ).not.toBe(empty);
  });

  it("enforces structural method exposure and rejects global wildcards", () => {
    expect(missionAllowsService(charter(), "notification.post")).toBe(true);
    expect(missionAllowsService(charter(), "credential.delete")).toBe(false);
    const current = charter();
    if (current.execution.kind !== "agent") throw new Error("fixture");
    const execution = current.execution;
    expect(() =>
      closure({
        ...current,
        execution: {
          ...execution,
          toolExposure: { ...execution.toolExposure, services: ["*"] },
        },
      })
    ).toThrow(/Invalid/);
  });

  it("pins the execution source to the reviewed harness", () => {
    const current = charter();
    expect(() =>
      closure({
        ...current,
        harness: { ...current.harness, unit: "workers/other" },
      })
    ).toThrow(/must equal/);
  });

  it("computes one aligned occurrence without catch-up bursts", () => {
    const trigger = { kind: "schedule", everyMs: 1_000, anchorAt: 500 } as const;
    expect(missionNextRunAt(trigger, 499)).toBe(500);
    expect(missionNextRunAt(trigger, 500)).toBe(1_500);
    expect(missionNextRunAt(trigger, 4_999)).toBe(5_500);
  });
});
