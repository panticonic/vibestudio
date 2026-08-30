import { describe, expect, it, vi } from "vitest";
import { resolveExactCausalInvocation, trajectoryTurnTaskRef } from "./workspaceSourceProvider.js";

describe("resolveExactCausalInvocation", () => {
  it("returns the recorded turn that owns an exact trajectory invocation", async () => {
    const inspectInvocationState = vi.fn(async () => ({
      rows: [
        {
          log_id: "branch:channel:chat-1",
          head: "branch:channel:chat-1",
          invocation_id: "call-1",
          turn_id: "turn-1",
          initiating_user_id: "user-1",
          status: "started",
          terminal_outcome: null,
          started_events: 1,
          terminal_events: 0,
        },
      ],
    }));

    await expect(
      resolveExactCausalInvocation(
        { inspectInvocationState },
        {
          kind: "trajectory-invocation",
          logId: "branch:channel:chat-1",
          head: "branch:channel:chat-1",
          invocationId: "call-1",
        }
      )
    ).resolves.toEqual({
      active: true,
      initiatingUserId: "user-1",
      taskRef: '["branch:channel:chat-1","branch:channel:chat-1","turn-1"]',
    });
  });

  it("does not treat replayed coordinates from a terminal invocation as a live task", async () => {
    const inspectInvocationState = vi.fn(async () => ({
      rows: [
        {
          log_id: "branch:channel:chat-1",
          head: "branch:channel:chat-1",
          invocation_id: "call-1",
          turn_id: "turn-1",
          initiating_user_id: "user-1",
          status: "completed",
          terminal_outcome: "success",
          started_events: 1,
          terminal_events: 1,
        },
      ],
    }));

    await expect(
      resolveExactCausalInvocation(
        { inspectInvocationState },
        {
          kind: "trajectory-invocation",
          logId: "branch:channel:chat-1",
          head: "branch:channel:chat-1",
          invocationId: "call-1",
        }
      )
    ).resolves.toEqual({
      active: false,
      initiatingUserId: "user-1",
      taskRef: '["branch:channel:chat-1","branch:channel:chat-1","turn-1"]',
    });
  });

  it("keeps equal turn ids on different trajectory branches in different tasks", () => {
    const parent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:chat-1",
      head: "main",
      invocationId: "call-1",
    };
    expect(trajectoryTurnTaskRef(parent, "turn-1")).not.toBe(
      trajectoryTurnTaskRef({ ...parent, head: "fork-1" }, "turn-1")
    );
  });
});
