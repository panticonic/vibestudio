import { describe, expect, it, vi } from "vitest";
import { createMobileHubControlClient } from "./hubControlClient.js";

const route = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true as const,
  serverUrl: "https://workspace.example",
  controlReach: {
    room: "control-2222",
    fp: "BB".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  },
  workspaceReach: {
    room: "workspace-b-2222",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "relay" as const,
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

describe("mobile hub-control client", () => {
  it("calls the canonical list method and validates its exact result", async () => {
    const list = [
      { workspaceId: "ws-a", name: "alpha", lastOpened: 1, running: true },
      { workspaceId: "ws-b", name: "beta", lastOpened: 0, running: false },
    ];
    const { client, call } = clientWith(list);

    await expect(client.listWorkspaces()).resolves.toEqual(list);
    expect(call).toHaveBeenCalledWith("main", "hubControl.listWorkspaces", []);
  });

  it("routes with the strict shared args and result schemas", async () => {
    const { client, call } = clientWith(route);

    await expect(client.routeWorkspace({ workspace: "beta" })).resolves.toEqual(route);
    expect(call).toHaveBeenCalledWith("main", "hubControl.routeWorkspace", [{ workspace: "beta" }]);

    await expect(
      client.routeWorkspace({ workspace: "beta", retiredRoom: "old" } as never)
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or compatibility-shaped hub responses", async () => {
    const malformedList = clientWith([
      { workspaceId: "ws-a", name: "alpha", lastOpened: 1, running: true, legacy: true },
    ]).client;
    await expect(malformedList.listWorkspaces()).rejects.toThrow();

    const malformedRoute = clientWith({
      ...route,
      workspaceReach: { ...route.workspaceReach, ice: undefined },
    }).client;
    await expect(malformedRoute.routeWorkspace({ workspace: "beta" })).rejects.toThrow();
  });
});
