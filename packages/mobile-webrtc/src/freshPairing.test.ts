import { describe, expect, it, vi } from "vitest";
import type { WebRtcConnection } from "./connect.js";
import { completeFreshMobilePairing } from "./freshPairing.js";
import type { StoredMobileConnection } from "./storedCredential.js";

const credential = {
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
};
const controlPairing = {
  room: "control-2222",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
  code: "c".repeat(32),
  exp: 2_000_000_000_000,
};
const workspaceReach = {
  room: "workspace-b-2222",
  fp: "BB".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "relay" as const,
};
const pairingContext = { workspaceId: "ws-b" };
const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true,
  serverUrl: "https://workspace.example",
  workspaceReach,
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
};

function fixture(
  overrides: {
    route?: unknown;
    persist?: () => Promise<void>;
    close?: () => Promise<void>;
    connect?: () => Promise<WebRtcConnection>;
  } = {}
) {
  const events: string[] = [];
  const call = vi.fn(async (_target: string, method: string) => {
    events.push(method);
    if (method === "hubControl.routeWorkspace") return overrides.route ?? route;
    throw new Error(`unexpected method: ${method}`);
  });
  const close = vi.fn(async () => {
    events.push("close");
    await overrides.close?.();
  });
  const controlConnection = {
    rpc: { call },
    close,
    callerId: `shell:${credential.deviceId}`,
  } as unknown as WebRtcConnection;
  const workspaceClose = vi.fn(async () => {
    events.push("workspace-close");
  });
  const workspaceConnection = {
    callerId: `shell:${credential.deviceId}`,
    rpc: { call: vi.fn() },
    close: workspaceClose,
  } as unknown as WebRtcConnection;
  const persistConnection = vi.fn(async (stored: StoredMobileConnection) => {
    events.push(`persist-${stored.phase}`);
    await overrides.persist?.();
  });
  const connectWorkspace = vi.fn(async () => {
    events.push("connect-workspace");
    return (await overrides.connect?.()) ?? workspaceConnection;
  });
  return {
    controlConnection,
    workspaceConnection,
    call,
    close,
    workspaceClose,
    persistConnection,
    connectWorkspace,
    events,
  };
}

describe("fresh mobile pairing commit", () => {
  it("routes the issued workspace and preserves the original control pairing", async () => {
    const {
      controlConnection,
      workspaceConnection,
      call,
      close,
      persistConnection,
      connectWorkspace,
      events,
    } = fixture();

    const connection = await completeFreshMobilePairing({
      controlConnection,
      credential,
      pairingContext,
      controlPairing,
      persistConnection,
      connectWorkspace,
    });

    expect(call.mock.calls).toEqual([
      ["main", "hubControl.routeWorkspace", [{ workspaceId: "ws-b" }]],
    ]);
    expect(persistConnection.mock.calls.map(([stored]) => stored)).toEqual([
      expect.objectContaining({
        schemaVersion: 4,
        phase: "paired",
        credential,
        selectedWorkspaceId: "ws-b",
        controlPairing: expect.not.objectContaining({ code: expect.anything() }),
      }),
      expect.objectContaining({
        schemaVersion: 4,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing: workspaceReach,
      }),
    ]);
    expect(connectWorkspace).toHaveBeenCalledWith(workspaceReach, credential);
    expect(workspaceConnection.deviceId).toBe(credential.deviceId);
    expect(connection.hubControlRpc).toBe(controlConnection.rpc);
    expect(close).not.toHaveBeenCalled();
    expect(events).toEqual([
      "persist-paired",
      "hubControl.routeWorkspace",
      "persist-routed",
      "connect-workspace",
    ]);
    await connection.close();
    expect(events.slice(-2)).toEqual(["workspace-close", "close"]);
  });

  it("requires a durable issuer credential and closes without issuing RPC", async () => {
    const { controlConnection, call, close, persistConnection, connectWorkspace } = fixture();

    await expect(
      completeFreshMobilePairing({
        controlConnection,
        credential: null,
        pairingContext,
        controlPairing,
        persistConnection,
        connectWorkspace,
      })
    ).rejects.toThrow(/did not issue/u);

    expect(call).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("requires the workspace identity issued with the credential", async () => {
    const { controlConnection, call, close, persistConnection, connectWorkspace } = fixture();

    await expect(
      completeFreshMobilePairing({
        controlConnection,
        credential,
        pairingContext: null,
        controlPairing,
        persistConnection,
        connectWorkspace,
      })
    ).rejects.toThrow(/did not identify its workspace/u);

    expect(call).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes on malformed routes or identity changes", async () => {
    const { controlConnection, close, persistConnection, connectWorkspace } = fixture({
      route: { ...route, workspaceId: "different" },
    });

    await expect(
      completeFreshMobilePairing({
        controlConnection,
        credential,
        pairingContext,
        controlPairing,
        persistConnection,
        connectWorkspace,
      })
    ).rejects.toThrow(/changed the pairing target/u);
    expect(persistConnection).toHaveBeenCalledTimes(1);
    expect(persistConnection.mock.calls[0]?.[0]).toMatchObject({ phase: "paired" });
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
        controlConnection: first.controlConnection,
        credential,
        pairingContext,
        controlPairing,
        persistConnection: first.persistConnection,
        connectWorkspace: first.connectWorkspace,
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
        controlConnection: second.controlConnection,
        credential,
        pairingContext,
        controlPairing,
        persistConnection: second.persistConnection,
        connectWorkspace: second.connectWorkspace,
      })
    ).rejects.toThrow(/keychain locked.*pipe close failed/u);
  });

  it("keeps the durable route and closes control after a workspace dial failure", async () => {
    const failed = fixture({
      connect: async () => {
        throw new Error("workspace unavailable");
      },
    });

    await expect(
      completeFreshMobilePairing({
        controlConnection: failed.controlConnection,
        credential,
        pairingContext,
        controlPairing,
        persistConnection: failed.persistConnection,
        connectWorkspace: failed.connectWorkspace,
      })
    ).rejects.toThrow("workspace unavailable");

    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(failed.events).toEqual([
      "persist-paired",
      "hubControl.routeWorkspace",
      "persist-routed",
      "connect-workspace",
      "close",
    ]);
  });
});
