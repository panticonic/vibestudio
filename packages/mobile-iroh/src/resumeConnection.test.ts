import { describe, expect, it, vi } from "vitest";
import { IROH_REACH_VERSION } from "@vibestudio/iroh-transport";
import { resumeMobileConnection } from "./resumeConnection.js";
import { createPairedMobileConnection, createRoutedMobileConnection } from "./storedCredential.js";
import type { IrohConnection } from "./connect.js";

const reach = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: IROH_REACH_VERSION,
};
const systemReach = { ...reach, endpointId: "bb".repeat(32) };
const stored = createRoutedMobileConnection(
  createPairedMobileConnection(
    { deviceId: `dev_${"d".repeat(24)}`, refreshToken: "r".repeat(43) },
    { ...reach, code: "c".repeat(32), exp: 2_000_000_000_000 },
    "previously-browsed-untrusted-workspace",
    "identity-1"
  ),
  reach
);

function fixture() {
  const events: string[] = [];
  const call = vi.fn(async (_target: string, method: string): Promise<unknown> => {
    events.push(method);
    if (method === "hubControl.ensureUserWorkspaces")
      return {
        personal: {
          workspaceId: "personal",
          name: "Personal",
          lastOpened: 0,
          pendingApprovalCount: 0,
          running: true,
        },
        system: {
          workspaceId: "system",
          name: "System",
          lastOpened: 0,
          pendingApprovalCount: 0,
          running: true,
        },
      };
    return {
      workspace: "System",
      workspaceId: "system",
      running: true,
      serverUrl: "https://workspace.example",
      workspaceReach: systemReach,
      serverId: `srv_${"s".repeat(24)}`,
      serverBootId: `boot_${"b".repeat(24)}`,
    };
  });
  const control = {
    rpc: { call },
    close: vi.fn(async () => undefined),
  } as unknown as IrohConnection;
  const workspace = {
    rpc: { call: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as IrohConnection;
  const connect = vi.fn(async (_stored: unknown, kind: string) => {
    events.push(`connect-${kind}`);
    return kind === "control" ? control : workspace;
  });
  const persist = vi.fn(async () => {
    events.push("persist");
  });
  return { control, workspace, connect, persist, events, call };
}

describe("returning mobile app source", () => {
  it("resolves System through the authenticated account before loading any workspace code", async () => {
    const value = fixture();
    const result = await resumeMobileConnection(stored, value);
    expect(value.events).toEqual([
      "connect-control",
      "hubControl.ensureUserWorkspaces",
      "hubControl.routeWorkspace",
      "persist",
      "connect-workspace",
    ]);
    expect(value.connect.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        selectedWorkspaceId: "system",
        workspacePairing: systemReach,
      })
    );
    expect(value.call).toHaveBeenCalledWith("main", "hubControl.routeWorkspace", [
      { workspaceId: "system" },
    ]);
    expect(result.hubControlRpc).toBe(value.control.rpc);
    await result.close();
    expect(value.control.close).toHaveBeenCalledOnce();
    expect(value.workspace.close).toHaveBeenCalledOnce();
  });

  it("closes account control and refuses to dial if the host routes another workspace", async () => {
    const value = fixture();
    const implementation = value.call.getMockImplementation()!;
    value.call.mockImplementation(async (target, method) => {
      const response = (await implementation(target, method)) as Record<string, unknown>;
      return method === "hubControl.routeWorkspace"
        ? { ...response, workspaceId: "other" }
        : response;
    });
    await expect(resumeMobileConnection(stored, value)).rejects.toThrow("System app source");
    expect(value.connect).toHaveBeenCalledOnce();
    expect(value.persist).not.toHaveBeenCalled();
    expect(value.control.close).toHaveBeenCalledOnce();
  });

  it("preserves both routing and cleanup failures", async () => {
    const value = fixture();
    value.call.mockRejectedValue(new Error("account unavailable"));
    vi.mocked(value.control.close).mockRejectedValue(new Error("cleanup failed"));
    await expect(resumeMobileConnection(stored, value)).rejects.toThrow(
      "account unavailable) and cleanup failed (cleanup failed)"
    );
    expect(value.control.close).toHaveBeenCalledOnce();
  });
});
