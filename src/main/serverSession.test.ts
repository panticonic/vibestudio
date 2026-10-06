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
  it("retires the supervisor while a workspace directory acquisition is pending", async () => {
    let release!: () => void;
    const retirement = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted!: () => void;
    const pending = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const failure = new Error("Workspace route cancelled by supervisor retirement");
    const hub = {
      call: vi.fn(async (_service: string, method: string, args: unknown[]) => {
        if (method === "ensureUserWorkspaces") return pair;
        if (method === "listWorkspaces") return entries;
        if (method === "routeWorkspace") {
          const id = (args[0] as { workspaceId: string }).workspaceId;
          if (id === "project-id") {
            admitted();
            await retirement;
            throw failure;
          }
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
        options.onPaired({ deviceId: "device-test", refreshToken: "test-token" });
        return hub;
      })
      .mockResolvedValue(workspace);
    mocks.close.mockImplementationOnce(async () => {
      release();
    });
    const connection = await establishServerSession({
      mode: null,
      pendingPairing: { ...reach, code: "test-code" },
      centralData: {} as CentralDataManager,
    });
    const rejected = expect(connection.workspaceSessions.get("project-id")).rejects.toBe(failure);
    await pending;
    const closing = connection.close();
    try {
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(mocks.close).toHaveBeenCalledOnce();
      await closing;
    } finally {
      release();
      await Promise.all([rejected, closing]);
    }
  });
  it("pairs the account into Personal while hosting the shell in System", async () => {
    let finishPersonal!: () => void;
    const personalHost = new Promise<void>((resolve) => {
      finishPersonal = resolve;
    });
    let preparing: Promise<void> | undefined;
    const hub = {
      call: vi.fn(async (_service: string, method: string, args: unknown[]) => {
        if (method === "ensureUserWorkspaces") return pair;
        if (method === "listWorkspaces") return entries;
        if (method === "routeWorkspace") {
          const id = (args[0] as { workspaceId: string }).workspaceId;
          if (id === "personal-id") await personalHost;
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
        options.onPaired({ deviceId: "device-test", refreshToken: "test-token" });
        return hub;
      })
      .mockResolvedValue(workspace);
    const connection = await establishServerSession({
      mode: null,
      pendingPairing: { ...reach, code: "test-code" },
      centralData: {} as CentralDataManager,
      onInitialWorkspaceResolved: (id, prepare) => {
        expect(id).toBe("personal-id");
        preparing = prepare();
      },
    });
    try {
      // System is usable while the independent Personal host is still starting.
      expect(preparing).toBeDefined();
      expect(hub.call).toHaveBeenCalledWith("hubControl", "routeWorkspace", [
        { workspaceId: "personal-id" },
      ]);
      expect(connection.initialFocusedWorkspaceId).toBe("personal-id");
      expect(connection.workspaceId).toBe("system-id");
      expect(mocks.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ workspaceName: expect.anything() })
      );
      expect(mocks.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ workspacePairing: expect.anything() })
      );
      expect(mocks.connect).toHaveBeenLastCalledWith(workspaceReach, expect.any(Object));
    } finally {
      finishPersonal();
      await preparing;
      await connection.close();
    }
    expect(workspace.close).toHaveBeenCalledOnce();
    expect(mocks.facadeClose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
