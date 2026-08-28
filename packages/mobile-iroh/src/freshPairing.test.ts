import { describe, expect, it, vi } from "vitest";
import type { IrohConnection } from "./connect.js";
import { completeFreshMobilePairing } from "./freshPairing.js";
import type { StoredMobileConnection } from "./storedCredential.js";

const credential = {
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
};
const controlPairing = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
  code: "c".repeat(32),
  exp: 2_000_000_000_000,
};
const workspaceReach = {
  endpointId: "bb".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};
const pairingContext = { workspaceId: "ws-b" };
const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true as const,
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
    connect?: () => Promise<IrohConnection>;
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
    endpointIdentityId: "identity-1",
  } as unknown as IrohConnection;
  const workspaceClose = vi.fn(async () => events.push("workspace-close"));
  const workspaceConnection = {
    callerId: `shell:${credential.deviceId}`,
    rpc: { call: vi.fn() },
    close: workspaceClose,
  } as unknown as IrohConnection;
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
    persistConnection,
    connectWorkspace,
    events,
  };
}

describe("fresh mobile Iroh pairing commit", () => {
  it("persists pairing and route before opening the workspace", async () => {
    const fixtureValue = fixture();
    const connection = await completeFreshMobilePairing({
      ...fixtureValue,
      credential,
      pairingContext,
      controlPairing,
    });

    expect(fixtureValue.persistConnection.mock.calls.map(([stored]) => stored)).toEqual([
      expect.objectContaining({
        schemaVersion: 5,
        transport: "iroh",
        phase: "paired",
        endpointIdentityId: "identity-1",
        controlPairing: expect.not.objectContaining({ code: expect.anything() }),
      }),
      expect.objectContaining({
        schemaVersion: 5,
        phase: "routed",
        workspacePairing: workspaceReach,
      }),
    ]);
    expect(fixtureValue.connectWorkspace).toHaveBeenCalledWith(
      workspaceReach,
      credential,
      fixtureValue.controlConnection
    );
    expect(fixtureValue.events).toEqual([
      "persist-paired",
      "hubControl.routeWorkspace",
      "persist-routed",
      "connect-workspace",
    ]);
    expect(connection.hubControlRpc).toBe(fixtureValue.controlConnection.rpc);
    await connection.close();
    expect(fixtureValue.events.slice(-2)).toEqual(["workspace-close", "close"]);
  });

  it("closes once when credential, route, persistence, or workspace dial fails", async () => {
    const cases = [
      { credential: null, pairingContext, overrides: {} },
      { credential, pairingContext: null, overrides: {} },
      {
        credential,
        pairingContext,
        overrides: { route: { ...route, workspaceId: "different" } },
      },
      {
        credential,
        pairingContext,
        overrides: { persist: async () => Promise.reject(new Error("keychain locked")) },
      },
      {
        credential,
        pairingContext,
        overrides: { connect: async () => Promise.reject(new Error("workspace unavailable")) },
      },
    ] as const;

    for (const testCase of cases) {
      const fixtureValue = fixture(testCase.overrides);
      await expect(
        completeFreshMobilePairing({
          ...fixtureValue,
          credential: testCase.credential,
          pairingContext: testCase.pairingContext,
          controlPairing,
        })
      ).rejects.toThrow();
      expect(fixtureValue.close).toHaveBeenCalledTimes(1);
    }
  });

  it("reports both the pairing failure and cleanup failure", async () => {
    const fixtureValue = fixture({
      persist: async () => Promise.reject(new Error("keychain locked")),
      close: async () => Promise.reject(new Error("pipe close failed")),
    });
    await expect(
      completeFreshMobilePairing({
        ...fixtureValue,
        credential,
        pairingContext,
        controlPairing,
      })
    ).rejects.toThrow(/keychain locked.*pipe close failed/u);
  });
});
