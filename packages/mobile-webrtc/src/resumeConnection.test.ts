import { describe, expect, it, vi } from "vitest";
import type { WebRtcConnection } from "./connect.js";
import { resumeMobileConnection } from "./resumeConnection.js";
import { createPairedMobileConnection, type StoredMobileConnection } from "./storedCredential.js";

const credential = {
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
};
const controlPairing = {
  room: "control-2222",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 3 as const,
  ice: "all" as const,
  code: "A".repeat(32),
  exp: 4_000_000_000_000,
};
const workspacePairing = {
  room: "workspace-2222",
  fp: "BB".repeat(32),
  sig: "wss://signal.example/",
  v: 3 as const,
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
        stored: StoredMobileConnection,
        reach: "control" | "workspace"
      ): Promise<WebRtcConnection> => {
        events.push(`connect-${reach}:${stored.phase}`);
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
});
