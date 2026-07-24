import { describe, expect, it } from "vitest";
import {
  FRESH_REMOTE_STARTUP_CONNECTION_PHASES,
  LOCAL_STARTUP_CONNECTION_PHASES,
  startupConnectionProgress,
} from "../startupConnectionProgress.js";
import {
  connectionTimeline,
  launchTimelineWithConnection,
  startupTimeline,
} from "./startupTimeline.js";

describe("startup timeline", () => {
  it("keeps completed local connection stages as the next stage becomes active", () => {
    const progress = startupConnectionProgress(
      LOCAL_STARTUP_CONNECTION_PHASES,
      "connect-workspace"
    );

    expect(connectionTimeline(progress)).toEqual([
      {
        id: "start-local-server",
        label: "Start local workspace server",
        state: "complete",
      },
      { id: "connect-workspace", label: "Connect to workspace", state: "active" },
      {
        id: "prepare-workspace-session",
        label: "Prepare workspace session",
        state: "pending",
      },
    ]);
  });

  it("marks the exact active connection stage as failed", () => {
    const progress = startupConnectionProgress(
      FRESH_REMOTE_STARTUP_CONNECTION_PHASES,
      "resolve-workspace"
    );

    expect(connectionTimeline(progress, "failed").map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "redeem-pairing-link", state: "complete" },
      { id: "resolve-workspace", state: "failed" },
      { id: "connect-workspace", state: "pending" },
      { id: "prepare-workspace-session", state: "pending" },
    ]);
  });

  it("preserves connection stages when the host launch timeline takes over", () => {
    const progress = startupConnectionProgress(
      LOCAL_STARTUP_CONNECTION_PHASES,
      "prepare-workspace-session"
    );

    const timeline = launchTimelineWithConnection(progress, [
      { id: "pair", label: "Connect", state: "complete" },
      { id: "review-trust", label: "Review trust", state: "active" },
      { id: "start-units", label: "Start privileged units", state: "pending" },
      { id: "build-app", label: "Build desktop app", state: "pending" },
      { id: "activate-target", label: "Activate desktop", state: "pending" },
      { id: "connected", label: "Connected", state: "pending" },
    ]);

    expect(timeline.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "start-local-server", state: "complete" },
      { id: "connect-workspace", state: "complete" },
      { id: "prepare-workspace-session", state: "complete" },
      { id: "review-trust", state: "active" },
      { id: "start-units", state: "pending" },
      { id: "build-app", state: "pending" },
      { id: "activate-target", state: "pending" },
      { id: "connected", state: "pending" },
    ]);
  });

  it("uses a stable generic connection row before the host reports a plan", () => {
    expect(startupTimeline(null)[0]).toEqual({
      id: "connect-workspace",
      label: "Connect to workspace",
      state: "active",
    });
  });
});
