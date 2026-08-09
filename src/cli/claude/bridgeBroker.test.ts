import { describe, expect, it, vi } from "vitest";
import { createCliClaudeBridgeAuthority } from "./bridgeBroker.js";
import type { RpcClient } from "../rpcClient.js";

describe("CLI Claude bridge authority", () => {
  it("seals the vessel target and maps only exact broker operations", async () => {
    const callTargetPush = vi.fn(async (_target: string, method: string) =>
      method === "say" ? { messageId: "m1", channelId: "chan-1" } : { ok: true }
    );
    const call = vi.fn(async (method: string) =>
      method === "workspace.listSkills" ? [] : "# skill"
    );
    const close = vi.fn(async () => undefined);
    const onRecovery = vi.fn(async () => () => undefined);
    const client = { callTargetPush, call, close, onRecovery } as unknown as RpcClient;
    const makeClient = vi.fn(() => client);
    const authority = createCliClaudeBridgeAuthority({
      serverUrl: "http://127.0.0.1:4123",
      agentToken: "agent:one:secret",
      vesselRef: "do:linked:one",
      makeClient,
    });

    await expect(authority.say({ text: "hello", idempotencyKey: "mcp:1" })).resolves.toEqual({
      messageId: "m1",
      channelId: "chan-1",
    });
    await authority.acceptDelivery({
      bridgeSessionId: "bridge-session-1",
      attachmentGeneration: "attachment-1",
      deliveryId: "delivery-4",
      batchId: "batch-1",
    });
    await expect(
      authority.requestPermission({
        requestId: "abcde",
        toolName: "Bash",
        description: "Run command",
        inputPreview: "npm test",
      })
    ).rejects.toThrow(/disabled until workspace approvals/);
    await authority.listSkills();
    await authority.readSkill({ name: "review" });

    expect(callTargetPush).toHaveBeenNthCalledWith(1, "do:linked:one", "say", [
      { text: "hello", idempotencyKey: "mcp:1" },
    ]);
    expect(callTargetPush).toHaveBeenNthCalledWith(2, "do:linked:one", "acceptDelivery", [
      {
        bridgeSessionId: "bridge-session-1",
        attachmentGeneration: "attachment-1",
        deliveryId: "delivery-4",
        batchId: "batch-1",
      },
    ]);
    expect(call).toHaveBeenCalledWith("workspace.listSkills", []);
    expect(call).toHaveBeenCalledWith("workspace.readSkill", ["review"]);
    expect(makeClient).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4123",
      token: "agent:one:secret",
    });
    await authority.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
