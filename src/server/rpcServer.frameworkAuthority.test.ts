import { describe, expect, it, vi } from "vitest";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { createHostCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { RpcServer } from "./rpcServer.js";

describe("direct receiver framework authority", () => {
  it("uses framework ownership before service projection and retains product admission", async () => {
    const resolveWorkspaceDirectAuthority = vi.fn(async () => [
      {
        capability: "workspace-service:receiver",
        serviceBinding: "declared" as const,
        principals: ["code" as const],
        methodEffect: { kind: "open" as const },
        methodTier: "open" as const,
        methodWebsite: { kind: "closed" as const, reason: "Test receiver" },
        presentation: { domain: "computer" as const, verb: "see" as const },
        title: "Receiver",
        action: "read greeting",
        declaredBy: "workers/receiver",
      },
    ]);
    const server = new RpcServer({
      tokenManager: new TokenManager(),
      dispatcher: new ServiceDispatcher(),
      workspaceId: "workspace:test",
      entityCache: new EntityCache(),
      ensureUserlandDoReady: async () => {},
      resolveWorkspaceDirectAuthority,
    });
    const receiver = server as unknown as {
      directDOAuthorization(input: {
        caller: ReturnType<typeof createHostCaller>;
        ref: { source: string; className: string; objectKey: string };
        method: string;
        args: readonly unknown[];
      }): Promise<DirectAuthorityAttestation>;
    };
    const input = {
      caller: createHostCaller("main"),
      ref: { source: "workers/receiver", className: "Receiver", objectKey: "main" },
      args: [],
    };
    try {
      const probe = await receiver.directDOAuthorization({
        ...input,
        method: "durableWorkCapabilities",
      });
      expect(resolveWorkspaceDirectAuthority).not.toHaveBeenCalled();
      expect(probe.targetRequirement).toBeUndefined();
      expect(probe.capability).toBe("rpc:durableWorkCapabilities");
      await expect(
        receiver.directDOAuthorization({ ...input, method: "readGreeting" })
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(resolveWorkspaceDirectAuthority).toHaveBeenCalledOnce();
    } finally {
      await server.stop();
    }
  });
});
