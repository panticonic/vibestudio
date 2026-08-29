import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceConnectionStateController,
  workspaceConnectionPresentation,
  type WorkspaceConnectionState,
} from "./workspaceConnection.js";

describe("WorkspaceConnectionStateController", () => {
  it("keeps startup quiet, then presents one reconnecting transition and recovery", () => {
    let now = 10;
    const publish = vi.fn<(state: WorkspaceConnectionState) => void>();
    const controller = new WorkspaceConnectionStateController("remote", publish, () => now++);

    controller.transport("connecting");
    expect(publish).not.toHaveBeenCalled();

    controller.transport("connected");
    controller.transport("connecting");
    controller.reconnect({ attempt: 3, nextRetryInMs: 2_100 });
    controller.transport("connected");

    expect(publish.mock.calls.map(([state]) => state.phase)).toEqual([
      "online",
      "reconnecting",
      "reconnecting",
      "online",
    ]);
    expect(publish.mock.calls[2]?.[0]).toMatchObject({
      attempt: 3,
      nextRetryInMs: 2_100,
    });
  });

  it("makes a terminal session end sticky across later transport noise", () => {
    const publish = vi.fn<(state: WorkspaceConnectionState) => void>();
    const controller = new WorkspaceConnectionStateController("remote", publish, () => 1);
    controller.transport("connected");
    controller.end();
    controller.transport("connecting");
    controller.transport("connected");

    expect(controller.snapshot().phase).toBe("ended");
    expect(publish.mock.calls.map(([state]) => state.phase)).toEqual(["online", "ended"]);
  });
});

describe("workspaceConnectionPresentation", () => {
  const state = (phase: WorkspaceConnectionState["phase"]): WorkspaceConnectionState => ({
    version: 1,
    phase,
    mode: "remote",
    since: 1,
  });

  it("does not cover a starting or online workspace", () => {
    expect(workspaceConnectionPresentation(state("starting"))).toBeNull();
    expect(workspaceConnectionPresentation(state("online"))).toBeNull();
  });

  it("presents reconnect progress without leaking transport details", () => {
    expect(
      workspaceConnectionPresentation({
        ...state("reconnecting"),
        attempt: 4,
        nextRetryInMs: 1_500,
      })
    ).toMatchObject({ showSpinner: true, retryDetail: "Reconnect attempt 4 in 2s" });
  });
});
