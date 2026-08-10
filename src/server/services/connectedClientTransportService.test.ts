import { describe, expect, it, vi } from "vitest";
import { createConnectedClientTransportService } from "./connectedClientTransportService.js";

const context = {
  caller: {
    runtime: { id: "do:phone", kind: "do" },
    subject: { userId: "system", handle: "system" },
  },
  authorizingCaller: {
    runtime: { id: "agent:alice", kind: "agent" },
    subject: { userId: "alice", handle: "alice" },
  },
} as never;

describe("connected-client transport", () => {
  it("lists and invokes only endpoints on the authenticated user's account", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const service = createConnectedClientTransportService({
      getUserConnections: (userId) =>
        userId === "alice"
          ? [
              {
                caller: { runtime: { id: "shell:alice", kind: "shell" } },
                userId,
                clientLabel: "Alice's desktop",
                clientPlatform: "desktop",
              },
            ]
          : [],
      getClientBridge: (clientId) => (clientId === "shell:alice" ? { call } : undefined),
    });

    await expect(service.handler(context, "list", [])).resolves.toEqual([
      {
        clientId: "shell:alice",
        label: "Alice's desktop",
        platform: "desktop",
        runtimeKind: "shell",
      },
    ]);
    await expect(
      service.handler(context, "invoke", [
        {
          clientId: "shell:alice",
          method: "desktopPhoneProvider.providers",
          args: [],
        },
      ])
    ).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith("shell:alice", "desktopPhoneProvider.providers", []);
    await expect(
      service.handler(context, "invoke", [
        { clientId: "shell:bob", method: "desktopPhoneProvider.providers", args: [] },
      ])
    ).rejects.toThrow("no longer connected");
  });

  it("does not treat a bare system deputy as a human account", async () => {
    const service = createConnectedClientTransportService({
      getUserConnections: () => [],
      getClientBridge: () => undefined,
    });

    await expect(
      service.handler(
        {
          caller: {
            runtime: { id: "do:phone", kind: "do" },
            subject: { userId: "system", handle: "system" },
          },
        } as never,
        "list",
        []
      )
    ).rejects.toThrow("requires an authenticated user account");
  });
});
