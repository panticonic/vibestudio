import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectLink,
  DEFAULT_IROH_RELAYS,
  IROH_REACH_VERSION,
} from "@vibestudio/iroh-transport";

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  options: null as {
    onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
  } | null,
}));

vi.mock("../node/iroh/irohRpcClient.js", () => ({
  IrohRpcClient: class {
    constructor(options: typeof transport.options) {
      transport.options = options;
    }

    async ready(): Promise<void> {
      await transport.options?.onPaired?.({
        deviceId: "dev_123456789012345678901234",
        refreshToken: "refresh-token",
      });
    }

    async call(method: string, args: unknown[] = []): Promise<unknown> {
      transport.calls.push({ method, args });
      if (method === "hubControl.ensureUserWorkspaces") {
        return {
          personal: {
            workspaceId: "ws_personal",
            name: "personal",
            lastOpened: 0,
            running: false,
            pendingApprovalCount: 0,
            privateRole: "personal",
          },
          system: {
            workspaceId: "ws_system",
            name: "system",
            lastOpened: 0,
            running: false,
            pendingApprovalCount: 0,
            privateRole: "system",
          },
        };
      }
      if (method === "hubControl.routeWorkspace") {
        return {
          workspace: "personal",
          workspaceId: "ws_personal",
          running: true,
          serverUrl: "http://127.0.0.1:3000",
          workspaceReach: {
            endpointId: "22".repeat(32),
            relays: ["https://relay.example/"],
            v: 5,
          },
          serverId: `srv_${"s".repeat(24)}`,
          serverBootId: `boot_${"b".repeat(24)}`,
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    }

    async close(): Promise<void> {}
  },
}));

import { pairRemoteServer } from "./remoteClient.js";

describe("pairRemoteServer", () => {
  beforeEach(() => {
    transport.calls = [];
    transport.options = null;
  });

  it("uses service-qualified hub control methods on the Iroh transport", async () => {
    const pairingLink = createConnectLink({
      endpointId: "11".repeat(32),
      relays: [...DEFAULT_IROH_RELAYS],
      v: IROH_REACH_VERSION,
      code: "A".repeat(22),
    });

    const credential = await pairRemoteServer({ link: pairingLink });

    expect(transport.calls).toEqual([
      { method: "hubControl.ensureUserWorkspaces", args: [] },
      { method: "hubControl.routeWorkspace", args: [{ workspaceId: "ws_personal" }] },
    ]);
    expect(credential.workspaceId).toBe("ws_personal");
  });
});
