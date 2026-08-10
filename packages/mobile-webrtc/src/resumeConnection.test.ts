import { describe, expect, it, vi } from "vitest";
import type { WebRtcConnection } from "./connect.js";
import { resumeMobileConnection } from "./resumeConnection.js";
import {
  createPairedMobileConnection,
  type LegacyStoredMobileConnectionV3,
  type LoadedMobileConnection,
  type StoredMobileConnection,
} from "./storedCredential.js";

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
};
const workspacePairing = {
  room: "workspace-2222",
  fp: "BB".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "relay" as const,
};
const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true,
  serverUrl: "https://workspace.example",
  workspaceReach: workspacePairing,
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
};

function connection(
  call: (...args: never[]) => Promise<unknown>,
  events: string[],
  name: string
): WebRtcConnection {
  return {
    callerId: `shell:${credential.deviceId}`,
    rpc: { call: call as WebRtcConnection["rpc"]["call"] },
    close: vi.fn(async () => {
      events.push(`close-${name}`);
    }),
  } as unknown as WebRtcConnection;
}

describe("durable mobile connection resume", () => {
  it("routes a paired record, commits routed, then opens the workspace", async () => {
    const events: string[] = [];
    const paired = createPairedMobileConnection(credential, controlPairing, "ws-b", 123);
    const control = connection(
      vi.fn(async (_target, method, args) => {
        events.push(`${method}:${(args as [{ workspaceId: string }])[0].workspaceId}`);
        return route;
      }),
      events,
      "control"
    );
    const workspace = connection(vi.fn(), events, "workspace");
    const persisted: StoredMobileConnection[] = [];
    const connect = vi.fn(
      async (
        stored: LoadedMobileConnection,
        reach: "control" | "workspace"
      ): Promise<WebRtcConnection> => {
        events.push(`connect-${reach}:${stored.schemaVersion === 4 ? stored.phase : "legacy"}`);
        return reach === "control" ? control : workspace;
      }
    );

    const resumed = await resumeMobileConnection(paired, {
      connect,
      persist: async (stored) => {
        events.push(`persist-${stored.phase}`);
        persisted.push(stored);
      },
    });

    expect(events).toEqual([
      "connect-control:paired",
      "hubControl.routeWorkspace:ws-b",
      "persist-routed",
      "connect-workspace:routed",
    ]);
    expect(persisted).toEqual([
      expect.objectContaining({
        schemaVersion: 4,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing,
      }),
    ]);
    expect(resumed.hubControlRpc).toBe(control.rpc);
  });

  it("migrates strict v3 using authenticated workspace info before exposure", async () => {
    const events: string[] = [];
    const legacy: LegacyStoredMobileConnectionV3 = {
      schemaVersion: 3,
      ...credential,
      controlPairing,
      workspacePairing,
      pairedAt: 123,
    };
    const control = connection(vi.fn(), events, "control");
    const workspace = connection(
      vi.fn(async (_target, method) => {
        events.push(method);
        return {
          id: "catalog-name-is-not-authority",
          name: "beta",
          path: "/workspace",
          statePath: "/state",
          contextProjectionsPath: "/contexts",
          config: { id: "ws-authoritative", systemEpoch: 1 },
        };
      }),
      events,
      "workspace"
    );
    const persisted: StoredMobileConnection[] = [];

    const resumed = await resumeMobileConnection(legacy, {
      connect: async (_stored, reach) => {
        events.push(`connect-${reach}`);
        return reach === "control" ? control : workspace;
      },
      persist: async (stored) => {
        events.push(`persist-${stored.phase}:${stored.selectedWorkspaceId}`);
        persisted.push(stored);
      },
    });

    expect(events).toEqual([
      "connect-control",
      "connect-workspace",
      "workspace.getInfo",
      "persist-routed:ws-authoritative",
    ]);
    expect(persisted[0]).toMatchObject({
      schemaVersion: 4,
      phase: "routed",
      selectedWorkspaceId: "ws-authoritative",
      credential,
      controlPairing,
      workspacePairing,
    });
    expect(resumed.hubControlRpc).toBe(control.rpc);
  });

  it("does not expose or leak connections when migration persistence fails", async () => {
    const events: string[] = [];
    const legacy: LegacyStoredMobileConnectionV3 = {
      schemaVersion: 3,
      ...credential,
      controlPairing,
      workspacePairing,
      pairedAt: 123,
    };
    const info = {
      id: "ws",
      name: "beta",
      path: "/workspace",
      statePath: "/state",
      contextProjectionsPath: "/contexts",
      config: { id: "ws-authoritative", systemEpoch: 1 },
    };
    const control = connection(vi.fn(), events, "control");
    const workspace = connection(
      vi.fn(async () => info),
      events,
      "workspace"
    );

    await expect(
      resumeMobileConnection(legacy, {
        connect: async (_stored, reach) => (reach === "control" ? control : workspace),
        persist: async () => {
          throw new Error("keychain locked");
        },
      })
    ).rejects.toThrow("keychain locked");

    expect(events).toEqual(["close-workspace", "close-control"]);
  });
});
