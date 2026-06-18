import { describe, expect, it } from "vitest";
import type { HostTargetLaunchSessionSnapshot } from "./hostTargets.js";
import {
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
  HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS,
  isLaunchSessionEventFor,
  isLaunchSessionEventForTarget,
  normalizeLaunchEventName,
} from "./hostTargetLaunchGate.js";

const session: HostTargetLaunchSessionSnapshot = {
  sessionId: "launch_123",
  target: "react-native",
  status: "preparing",
  currentPhase: "build-app",
  message: "Mobile app is preparing.",
  timeline: [],
  approvals: [],
  approvalViews: [],
  approvalsResolved: 0,
  startedAt: 1,
  updatedAt: 2,
  settled: false,
};

describe("hostTargetLaunchGate", () => {
  it("normalizes only the launch-session event name", () => {
    expect(HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS).toEqual([
      HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
    ]);
    expect(normalizeLaunchEventName("event:host-target-launch:session-changed")).toBe(
      "host-target-launch:session-changed"
    );
    expect(normalizeLaunchEventName("host-targets:changed")).toBeNull();
    expect(normalizeLaunchEventName("apps:status")).toBeNull();
  });

  it("matches launch session events by session id", () => {
    expect(
      isLaunchSessionEventFor("launch_123", "host-target-launch:session-changed", session)
    ).toBe(true);
    expect(
      isLaunchSessionEventFor("launch_other", "host-target-launch:session-changed", session)
    ).toBe(false);
  });

  it("matches launch session events by target", () => {
    expect(
      isLaunchSessionEventForTarget("react-native", "event:host-target-launch:session-changed", session)
    ).toBe(true);
    expect(
      isLaunchSessionEventForTarget("terminal", "event:host-target-launch:session-changed", session)
    ).toBe(false);
  });
});
