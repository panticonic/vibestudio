import { describe, expect, it, vi } from "vitest";
import { localToolExecutor } from "./index.js";

describe("localToolExecutor", () => {
  it("preserves a local tool termination request as durable turn control", async () => {
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-1",
        channelId: "channel-1",
        invocationId: "invocation-1",
        tool: "complete",
        args: { report: "done" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        localTools: {
          alreadyApplied: async () => null,
          run: async () => ({
            result: { protocolContent: [], details: { outcome: "success" } },
            isError: false,
            terminate: true,
          }),
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      turnControl: { kind: "terminate" },
    });
  });

  it("does not execute a mutation whose semantic command is already complete", async () => {
    const run = vi.fn();
    const outcome = await localToolExecutor.execute({
      descriptor: {
        kind: "local_tool",
        effectId: "effect-replayed",
        channelId: "channel-1",
        invocationId: "invocation-replayed",
        tool: "write",
        args: { path: "file.txt", content: "value" },
      } as never,
      state: {} as never,
      signal: new AbortController().signal,
      deps: {
        localTools: {
          alreadyApplied: async () => ({
            commandId: "command-replayed",
            command: { kind: "command", value: { status: "complete" } },
          }),
          run,
        },
      } as never,
      onEphemeral: () => undefined,
    });

    expect(run).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      result: {
        protocolContent: [
          {
            type: "text",
            text: expect.stringContaining("command-replayed"),
          },
        ],
        details: {
          replayed: true,
          evidence: { commandId: "command-replayed" },
        },
      },
    });
  });
});
