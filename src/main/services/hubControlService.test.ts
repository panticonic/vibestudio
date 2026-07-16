import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { createHubControlHostService } from "./hubControlService.js";

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };

describe("hubControlHostService", () => {
  it("forwards device lifecycle calls unchanged over the stable hub client", async () => {
    const coordinates = {
      room: `room_${"i".repeat(24)}`,
      fp: "AA".repeat(32),
      code: "C".repeat(32),
      sig: "wss://sig.example/",
      v: 2 as const,
      ice: "all" as const,
    };
    const pairing = {
      ...coordinates,
      deepLink: createConnectDeepLink(coordinates),
      pairUrl: createConnectPairUrl(coordinates),
      expiresAt: Date.now() + 60_000,
      expiresInMs: 60_000,
      serverId: `srv_${"s".repeat(24)}`,
      serverBootId: `boot_${"b".repeat(24)}`,
    };
    const devices = [{ deviceId: "device-1", userId: "user-1", label: "Desktop", createdAt: 1 }];
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "pairDevice") {
        return { userId: "user-1", handle: "alice", workspace: "main", pairing };
      }
      if (method === "listDevices") return { serverId: pairing.serverId, devices };
      if (method === "revokeDevice") return { revoked: true, closedSessions: 2 };
      throw new Error(`Unexpected method ${method}`);
    });
    const service = createHubControlHostService({
      client: { call } as never,
      getViewManager: () => ({}) as never,
      onWorkspaceRoute: vi.fn(),
    });

    await expect(
      service.handler(shellCtx, "pairDevice", [{ workspace: "main", ttlMs: 60_000 }])
    ).resolves.toEqual({ userId: "user-1", handle: "alice", workspace: "main", pairing });
    await expect(service.handler(shellCtx, "listDevices", [])).resolves.toEqual({
      serverId: pairing.serverId,
      devices,
    });
    await expect(service.handler(shellCtx, "revokeDevice", ["device-1"])).resolves.toEqual({
      revoked: true,
      closedSessions: 2,
    });

    expect(call).toHaveBeenNthCalledWith(1, "hubControl", "pairDevice", [
      { workspace: "main", ttlMs: 60_000 },
    ]);
    expect(call).toHaveBeenNthCalledWith(2, "hubControl", "listDevices", []);
    expect(call).toHaveBeenNthCalledWith(3, "hubControl", "revokeDevice", ["device-1"]);
  });
});
