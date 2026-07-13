/**
 * The eval owner bindings (`chat` + `agent`): present + forwarding for agent-owned
 * eval, ABSENT for non-agent (CLI/panel) eval.
 */
import { describe, expect, it, vi } from "vitest";
import { buildOwnerBindings } from "./evalOwnerBindings.js";

describe("buildOwnerBindings", () => {
  it("injects NO chat/agent for a non-agent eval (no channelId/agentRef → CLI/panel)", () => {
    const call = vi.fn();
    expect(buildOwnerBindings({}, call)).toEqual({});
    expect(buildOwnerBindings({ channelId: "c" }, call)).toEqual({}); // agentRef missing
    expect(buildOwnerBindings({ agentRef: "a" }, call)).toEqual({}); // channelId missing
    expect(call).not.toHaveBeenCalled();
  });

  it("agent self-config + chat forward to the owning runtime's gated chatOp on this channel", async () => {
    const call = vi.fn(async () => undefined);
    const b = buildOwnerBindings(
      { channelId: "chan-1", agentRef: "do:a:Agent:k", contextId: "ctx-1" },
      call
    ) as {
      agent: {
        setModel: (m: string) => Promise<unknown>;
        describe: () => Promise<unknown>;
        setApprovalLevel: (n: number) => Promise<unknown>;
      };
      chat: {
        send: (c: string) => Promise<unknown>;
        replayEnvelope: (id: string) => Promise<unknown>;
        contextId: string;
        channelId: string;
      };
    };

    await b.agent.setModel("openai:gpt-5.3");
    expect(call).toHaveBeenCalledWith("do:a:Agent:k", "chatOp", [
      "chan-1",
      "configureAgent",
      [{ model: "openai:gpt-5.3" }],
    ]);

    await b.agent.setApprovalLevel(0);
    expect(call).toHaveBeenCalledWith("do:a:Agent:k", "chatOp", [
      "chan-1",
      "configureAgent",
      [{ approvalLevel: 0 }],
    ]);

    await b.agent.describe();
    expect(call).toHaveBeenCalledWith("do:a:Agent:k", "chatOp", ["chan-1", "describeSelf", []]);

    await b.chat.send("hi");
    expect(call).toHaveBeenCalledWith("do:a:Agent:k", "chatOp", ["chan-1", "send", ["hi"]]);
    await b.chat.replayEnvelope("event-1");
    expect(call).toHaveBeenCalledWith("do:a:Agent:k", "chatOp", [
      "chan-1",
      "replayEnvelope",
      ["event-1"],
    ]);
    expect(b.chat.contextId).toBe("ctx-1");
    expect(b.chat.channelId).toBe("chan-1");
  });
});
