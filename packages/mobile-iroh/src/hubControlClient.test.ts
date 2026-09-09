import { describe, expect, it, vi } from "vitest";
import { IROH_REACH_VERSION } from "@vibestudio/iroh-transport";
import { createMobileHubControlClient } from "./hubControlClient.js";

const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true as const,
  serverUrl: "https://workspace.example",
  workspaceReach: {
    endpointId: "bb".repeat(32),
    relays: ["https://relay.example/"],
    v: IROH_REACH_VERSION,
  },
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
};

function clientWith(result: unknown) {
  const call = vi.fn(async () => result);
  return {
    client: createMobileHubControlClient({ rpc: { call } } as never),
    call,
  };
}

describe("mobile Iroh hub-control client", () => {
  it("calls the canonical list method and validates its exact result", async () => {
    const list = [
      { workspaceId: "ws-a", name: "alpha", lastOpened: 1, running: true },
      { workspaceId: "ws-b", name: "beta", lastOpened: 0, running: false },
    ];
    const { client, call } = clientWith(list);

    await expect(client.listWorkspaces()).resolves.toEqual(list);
    expect(call).toHaveBeenCalledWith("main", "hubControl.listWorkspaces", []);
  });

  it("routes through the strict current Iroh schemas", async () => {
    const { client, call } = clientWith(route);

    await expect(client.routeWorkspace({ workspaceId: "ws-b" })).resolves.toEqual(route);
    expect(call).toHaveBeenCalledWith("main", "hubControl.routeWorkspace", [
      { workspaceId: "ws-b" },
    ]);

    await expect(
      client.routeWorkspace({ workspaceId: "ws-b", retiredRoom: "old" } as never)
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, extra-field, and legacy-shaped hub responses", async () => {
    await expect(
      clientWith([
        { workspaceId: "ws-a", name: "alpha", lastOpened: 1, running: true, legacy: true },
      ]).client.listWorkspaces()
    ).rejects.toThrow();

    for (const workspaceReach of [
      { ...route.workspaceReach, relays: [] },
      { ...route.workspaceReach, room: "retired", fp: "AA".repeat(32) },
      { ...route.workspaceReach, endpointId: "not-an-endpoint-id" },
    ]) {
      await expect(
        clientWith({ ...route, workspaceReach }).client.routeWorkspace({ workspaceId: "ws-b" })
      ).rejects.toThrow();
    }
  });
});
