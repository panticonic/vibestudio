import { beforeEach, describe, expect, it, vi } from "vitest";
import { IROH_REACH_VERSION } from "@vibestudio/iroh-transport";
import type { CentralDataManager } from "@vibestudio/shared/centralData";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(async () => {}),
  save: vi.fn(),
  facadeClose: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/session-test" } }));
vi.mock("./paths.js", () => ({ getAppRoot: vi.fn(), getServerProcessBuildId: vi.fn() }));
vi.mock("./hubProcessManager.js", () => ({ HubProcessManager: vi.fn() }));
vi.mock("./serverClient.js", () => ({ createServerClient: vi.fn() }));
vi.mock("./services/deviceCredentialStore.js", () => ({
  preflightDeviceCredentialStoreForPairing: vi.fn(),
  saveDeviceCredential: mocks.save,
}));
vi.mock("./desktopIrohConnectionSupervisor.js", () => ({
  DesktopIrohConnectionSupervisor: class {
    connect = mocks.connect;
    close = mocks.close;
  },
}));
vi.mock("../node/panelAssets/panelAssetFacade.js", () => ({
  startPanelAssetFacade: async () => ({ port: 12345, close: mocks.facadeClose }),
}));
import { establishServerSession } from "./serverSession.js";

const reach = {
  endpointId: "01".repeat(32),
  relays: ["https://relay.example/"],
  v: IROH_REACH_VERSION,
};
const workspaceReach = { ...reach, endpointId: "02".repeat(32) };
const entryState = { lastOpened: 0, running: true, pendingApprovalCount: 0 };
const pair = {
  personal: { ...entryState, workspaceId: "personal-id", name: "Personal" },
  system: { ...entryState, workspaceId: "system-id", name: "System" },
};
const entries = [
  ...Object.values(pair),
  { ...entryState, workspaceId: "project-id", name: "Project" },
];

beforeEach(() => vi.clearAllMocks());
describe("remote startup workspace focus", () => {
  it.each([
    [undefined, "personal-id", "Personal"],
    ["project-id", "project-id", "Project"],
    ["system-id", "system-id", "System"],
  ])("pairs with target %s while hosting the shell in System", async (target, focus, name) => {
    const hub = {
      call: vi.fn(async (_service: string, method: string, args: unknown[]) => {
        if (method === "ensureUserWorkspaces") return pair;
        if (method === "listWorkspaces") return entries;
        if (method === "routeWorkspace") {
          const id = (args[0] as { workspaceId: string }).workspaceId;
          const entry = entries.find((entry) => entry.workspaceId === id)!;
          return {
            workspaceId: id,
            workspace: entry.name,
            serverId: "srv_" + "a".repeat(24),
            serverBootId: "boot_" + "b".repeat(24),
            running: true,
            serverUrl: "http://localhost:1234",
            workspaceReach,
          };
        }
        throw new Error(`Unexpected hub call: ${method}`);
      }),
    };
    const workspace = {
      call: vi.fn(async () => ({
        id: "system-id",
        name: "System",
        config: { id: "system-id", systemEpoch: 0 },
        path: "/remote/system",
        statePath: "/remote/state",
        contextProjectionsPath: "/remote/contexts",
      })),
      close: vi.fn(async () => {}),
    };
    mocks.connect
      .mockImplementationOnce(async (_reach, options) => {
        options.onPaired(
          { deviceId: "device-test", refreshToken: "test-token" },
          target ? { workspaceId: target } : undefined
        );
        return hub;
      })
      .mockResolvedValue(workspace);
    const connection = await establishServerSession({
      mode: null,
      pendingPairing: { ...reach, code: "test-code" },
      centralData: {} as CentralDataManager,
    });
    try {
      expect(connection.initialFocusedWorkspaceId).toBe(focus);
      expect(connection.workspaceId).toBe("system-id");
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ workspaceName: name }));
      expect(mocks.connect).toHaveBeenLastCalledWith(workspaceReach, expect.any(Object));
    } finally {
      await connection.close();
    }
    expect(workspace.close).toHaveBeenCalledOnce();
    expect(mocks.facadeClose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
