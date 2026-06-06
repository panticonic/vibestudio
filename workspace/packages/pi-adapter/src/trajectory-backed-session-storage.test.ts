import { describe, expect, it, vi } from "vitest";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { createInitialTrajectoryState, type TrajectoryState } from "@workspace/agentic-protocol";
import { TrajectoryBackedSessionStorage } from "./trajectory-backed-session-storage.js";
import { materializeSessionTree } from "./materialize-session-tree.js";

const timestamp = "2026-05-20T12:00:00.000Z";

describe("TrajectoryBackedSessionStorage", () => {
  it("materializes path entries and keeps writes in memory", async () => {
    const first: SessionTreeEntry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "hello", timestamp: 1 } as never,
    };
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [first],
    });
    expect(await storage.getLeafId()).toBe("entry-1");
    expect(await storage.getEntries()).toEqual([first]);
  });

  it("persists exact Pi session tree entries into private trajectory events", async () => {
    const appendEvent = vi.fn();
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [],
      appendEvent,
    });
    await storage.appendEntry({
      type: "model_change",
      id: "entry-1",
      parentId: null,
      timestamp,
      provider: "anthropic",
      modelId: "claude",
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system.event",
        payload: expect.objectContaining({
          details: expect.objectContaining({
            kind: "pi.session_entry",
            entry: expect.objectContaining({ type: "model_change", modelId: "claude" }),
          }),
        }),
      }),
      expect.objectContaining({ type: "model_change", modelId: "claude" })
    );
  });

  it("persists message entries exactly for LLM cache/session restore", async () => {
    const appendEvent = vi.fn();
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [],
      appendEvent,
    });
    await storage.appendEntry({
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: { role: "assistant", content: "hi", timestamp: 1 } as never,
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system.event",
        payload: expect.objectContaining({
          details: expect.objectContaining({
            kind: "pi.session_entry",
            entry: expect.objectContaining({
              type: "message",
              message: expect.objectContaining({ role: "assistant", content: "hi" }),
            }),
          }),
        }),
      }),
      expect.objectContaining({ type: "message" })
    );
  });

  it("materializes exact Pi entries ahead of lossy message projection", () => {
    const first: SessionTreeEntry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "cached" },
          { type: "toolCall", id: "call-1", name: "read", input: { path: "a.ts" } },
        ],
        timestamp: 1,
        stopReason: "tool_calls",
      } as never,
    };
    const leaf: SessionTreeEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: "entry-1",
      timestamp,
      targetId: "entry-1",
    };

    const state = {
      systemEvents: [first, leaf].map((entry, seq) => ({
        kind: "system.event",
        actor: { kind: "agent", id: "agent-1" },
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: entry.type,
          details: { kind: "pi.session_entry", entry },
        },
        createdAt: entry.timestamp,
        eventId: `event-${seq}`,
        trajectoryId: "traj-1",
        branchId: "main",
        seq,
        prevEventHash: "0",
        eventHash: `${seq}`,
      })),
      messages: {
        "entry-1": {
          messageId: "entry-1",
          actor: { kind: "agent", id: "agent-1" },
          role: "assistant",
          content: "lossy",
          status: "completed",
        },
      },
    } as never;

    expect(materializeSessionTree(state)).toEqual([first]);
  });
});

describe("materializeSessionTree blocks reconstruction", () => {
  const agent = { kind: "agent" as const, id: "pi" };

  function stateWith(
    blocks: unknown[],
    invocations: Record<string, unknown> = {}
  ): TrajectoryState {
    return {
      ...createInitialTrajectoryState(),
      messages: {
        m1: {
          messageId: "m1",
          actor: agent,
          role: "assistant",
          status: "completed",
          completedAt: timestamp,
          outcome: "completed",
          blocks,
        },
      },
      invocations,
    } as unknown as TrajectoryState;
  }

  it("reconstructs structured Pi content (text/thinking/toolCall) from blocks and invocations", () => {
    const state = stateWith(
      [
        { blockId: "m1:block:0", type: "thinking", content: "reasoning" },
        { blockId: "m1:block:1", type: "text", content: "the answer" },
        { blockId: "m1:block:2", type: "invocation", invocationId: "inv-1" },
      ],
      {
        "inv-1": {
          invocationId: "inv-1",
          actor: agent,
          name: "read",
          request: { path: "a.ts" },
          status: "completed",
          outputs: [],
          progress: [],
        },
      }
    );

    const [entry] = materializeSessionTree(state);
    expect((entry as unknown as { message: { content: unknown } }).message.content).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "the answer" },
      { type: "toolCall", id: "inv-1", name: "read", input: { path: "a.ts" } },
    ]);
  });

  it("degrades to a text placeholder instead of emitting a toolCall with missing request metadata", () => {
    // Invocation request is unavailable (e.g. partial/resumed trajectory). We must
    // never feed a toolCall with undefined input to the model.
    const state = stateWith([
      { blockId: "m1:block:0", type: "text", content: "before tool" },
      { blockId: "m1:block:1", type: "invocation", invocationId: "inv-missing" },
    ]);

    const [entry] = materializeSessionTree(state);
    expect((entry as unknown as { message: { content: unknown } }).message.content).toEqual([
      { type: "text", text: "before tool" },
      { type: "text", text: "[Tool call inv-missing omitted: metadata unavailable]" },
    ]);
  });
});
