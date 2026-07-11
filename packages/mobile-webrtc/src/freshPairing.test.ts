import { describe, expect, it, vi } from "vitest";
import type { WebRtcConnection } from "./connect.js";
import { completeFreshMobilePairing } from "./freshPairing.js";

const credential = {
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
};
const controlReach = {
  room: "control-2222",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
};
const workspaceReach = {
  room: "workspace-b-2222",
  fp: "BB".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "relay" as const,
};
const connectionInfo = {
  serverUrl: "https://workspace.example",
  protocol: "https",
  externalHost: "workspace.example",
  gatewayPort: 443,
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
  workspaceId: "ws-b",
  callerKind: "shell",
};
const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true,
  serverUrl: "https://workspace.example",
  controlReach,
  workspaceReach,
  serverId: connectionInfo.serverId,
  serverBootId: connectionInfo.serverBootId,
};

function fixture(
  overrides: {
    route?: unknown;
    persist?: () => Promise<void>;
    close?: () => Promise<void>;
  } = {}
) {
  const events: string[] = [];
  const call = vi.fn(async (_target: string, method: string) => {
    events.push(method);
    if (method === "workspace.getActive") return "beta";
    if (method === "auth.getConnectionInfo") return connectionInfo;
    if (method === "hubControl.routeWorkspace") return overrides.route ?? route;
    throw new Error(`unexpected method: ${method}`);
  });
  const close = vi.fn(async () => {
    events.push("close");
    await overrides.close?.();
  });
  const connection = {
    rpc: { call },
    close,
    callerId: `shell:${credential.deviceId}`,
  } as unknown as WebRtcConnection;
  const persistCredential = vi.fn(async () => {
    events.push("persist");
    await overrides.persist?.();
  });
  return { connection, call, close, persistCredential, events };
}

describe("fresh mobile pairing commit", () => {
  it("validates identity and persists both routed reaches before succeeding", async () => {
    const { connection, call, close, persistCredential, events } = fixture();

    await expect(
      completeFreshMobilePairing({ connection, credential, persistCredential })
    ).resolves.toBe(connection);

    expect(call.mock.calls).toEqual([
      ["main", "workspace.getActive", []],
      ["main", "auth.getConnectionInfo", []],
      ["main", "hubControl.routeWorkspace", [{ workspace: "beta" }]],
    ]);
    expect(persistCredential).toHaveBeenCalledWith(credential, controlReach, workspaceReach);
    expect(connection.deviceId).toBe(credential.deviceId);
    expect(close).not.toHaveBeenCalled();
    expect(events).toEqual([
      "workspace.getActive",
      "auth.getConnectionInfo",
      "hubControl.routeWorkspace",
      "persist",
    ]);
  });

  it("requires a durable issuer credential and closes without issuing RPC", async () => {
    const { connection, call, close, persistCredential } = fixture();

    await expect(
      completeFreshMobilePairing({ connection, credential: null, persistCredential })
    ).rejects.toThrow(/did not issue/u);

    expect(call).not.toHaveBeenCalled();
    expect(persistCredential).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes on malformed routes or identity changes", async () => {
    const { connection, close, persistCredential } = fixture({
      route: { ...route, workspaceId: "different" },
    });

    await expect(
      completeFreshMobilePairing({ connection, credential, persistCredential })
    ).rejects.toThrow(/changed the authenticated/u);
    expect(persistCredential).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes when secure persistence fails and reports cleanup failure too", async () => {
    const first = fixture({
      persist: async () => {
        throw new Error("keychain locked");
      },
    });
    await expect(
      completeFreshMobilePairing({
        connection: first.connection,
        credential,
        persistCredential: first.persistCredential,
      })
    ).rejects.toThrow("keychain locked");
    expect(first.close).toHaveBeenCalledTimes(1);

    const second = fixture({
      persist: async () => {
        throw new Error("keychain locked");
      },
      close: async () => {
        throw new Error("pipe close failed");
      },
    });
    await expect(
      completeFreshMobilePairing({
        connection: second.connection,
        credential,
        persistCredential: second.persistCredential,
      })
    ).rejects.toThrow(/keychain locked.*pipe close failed/u);
  });
});
