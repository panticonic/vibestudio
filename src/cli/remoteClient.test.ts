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

import { findWorkspace, pairRemoteServer } from "./remoteClient.js";

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

describe("findWorkspace", () => {
  const entry = (workspaceId: string, name: string, extra = {}) => ({
    workspaceId,
    name,
    lastOpened: 0,
    running: true,
    pendingApprovalCount: 0,
    ...extra,
  });
  const entries = [
    entry("ws_personal", "personal-ws_P1", { privateRole: "personal" as const }),
    entry("ws_system", "system-ws_S1", { privateRole: "system" as const }),
    entry("ws_lab", "lab", { displayName: "Research lab" }),
  ];

  it("finds a workspace by the label the CLI shows or by its name", () => {
    expect(findWorkspace(entries, "Personal").workspaceId).toBe("ws_personal");
    expect(findWorkspace(entries, "System").workspaceId).toBe("ws_system");
    expect(findWorkspace(entries, "Research lab").workspaceId).toBe("ws_lab");
    expect(findWorkspace(entries, "lab").workspaceId).toBe("ws_lab");
  });

  it("rejects a workspace the account cannot see, and an ambiguous label", () => {
    expect(() => findWorkspace(entries, "elsewhere")).toThrow("is not visible");
    const twins = [...entries, entry("ws_lab2", "lab-2", { displayName: "Research lab" })];
    expect(() => findWorkspace(twins, "Research lab")).toThrow("2 workspaces are called");
  });
});
