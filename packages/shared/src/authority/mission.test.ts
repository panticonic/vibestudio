import { describe, expect, it } from "vitest";
import {
  missionAllowsService,
  missionClosureDigest,
  missionCompletionResponse,
  missionNextRunAt,
  validateMissionCharter,
  type MissionCharter,
} from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  summary: "Back up the project",
  harness: { unit: "workers/system-agent", ev: hex, ref: `state:${"b".repeat(64)}` },
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
  it("requires an immutable source ref for every new or revised charter", () => {
    const historical = charter();
    delete historical.harness.ref;
    expect(() => validateMissionCharter(historical)).toThrow("immutable source ref");
  });

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

  it("computes five-field calendar schedules in their reviewed IANA timezone", () => {
    const thursdayMorning = {
      kind: "cron",
      expression: "5 5 * * THU",
      timezone: "America/New_York",
    } as const;

    expect(missionNextRunAt(thursdayMorning, Date.UTC(2026, 2, 5, 10, 4, 59))).toBe(
      Date.UTC(2026, 2, 5, 10, 5)
    );
    // New York changes to daylight time before the following Thursday.
    expect(missionNextRunAt(thursdayMorning, Date.UTC(2026, 2, 5, 10, 5))).toBe(
      Date.UTC(2026, 2, 12, 9, 5)
    );
  });

  it("rejects ambiguous calendar contracts and invalid termination policies", () => {
    expect(() =>
      closure({
        ...charter(),
        trigger: { kind: "cron", expression: "0 5 * * * *", timezone: "America/New_York" },
      })
    ).toThrow(/five-field/);
    expect(() =>
      closure({
        ...charter(),
        trigger: { kind: "cron", expression: "5 5 * * THU", timezone: "US/Eastern" },
      })
    ).toThrow(/canonical IANA timezone/);
    expect(() =>
      closure({
        ...charter(),
        trigger: { kind: "cron", expression: " 5 5 * * Thu ", timezone: "America/New_York" },
      })
    ).toThrow(/must be canonical: 5 5 \* \* THU/);
    expect(() =>
      closure({
        ...charter(),
        trigger: { kind: "schedule", everyMs: 60_000, maxRuns: 0 },
      })
    ).toThrow(/positive integer/);
  });

  it("recognizes only an explicit, non-empty natural completion response", () => {
    expect(
      missionCompletionResponse({
        protocol: "automation-completion.v1",
        response: "  The migration is complete.  ",
      })
    ).toEqual({
      protocol: "automation-completion.v1",
      response: "The migration is complete.",
    });
    expect(missionCompletionResponse({ response: "done" })).toBeNull();
    expect(
      missionCompletionResponse({ protocol: "automation-completion.v1", response: "   " })
    ).toBeNull();
  });
});
