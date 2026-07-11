import type {
  MobileHubControlConnection,
  MobileHubWorkspace,
  MobileHubWorkspaceRoute,
  StoredShellCredential,
} from "@vibestudio/mobile-webrtc";
import {
  listMobileWorkspaces,
  selectMobileWorkspace,
  type MobileWorkspaceSelectionDependencies,
} from "./workspaceSelection";

jest.mock("@vibestudio/mobile-webrtc", () => ({
  connectMobileHubControl: jest.fn(),
  loadShellCredential: jest.fn(),
  persistStoredShellCredential: jest.fn(),
  createStoredShellCredential: (
    credential: { deviceId: string; refreshToken: string },
    controlPairing: Record<string, unknown>,
    workspacePairing: Record<string, unknown>,
    pairedAt: number
  ) => ({
    schemaVersion: 3,
    ...credential,
    controlPairing,
    workspacePairing,
    pairedAt,
  }),
}));

const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);
const ROTATED_TOKEN = "n".repeat(43);
const CONTROL_PAIRING = {
  room: "control-1111",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
};
const WORKSPACE_A_PAIRING = {
  room: "workspace-a-1111",
  fp: "BB".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
};
const WORKSPACE_B_PAIRING = {
  room: "workspace-b-2222",
  fp: "CC".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "relay" as const,
  srv: "prod",
};
const ROUTED_CONTROL_PAIRING = {
  ...CONTROL_PAIRING,
  room: "control-2222",
};

const storedA: StoredShellCredential = {
  schemaVersion: 3,
  deviceId: DEVICE_ID,
  refreshToken: REFRESH_TOKEN,
  controlPairing: CONTROL_PAIRING,
  workspacePairing: WORKSPACE_A_PAIRING,
  pairedAt: 123,
};

const workspaces: MobileHubWorkspace[] = [
  {
    workspaceId: "ws-a",
    name: "alpha",
    lastOpened: 10,
    running: true,
  },
  {
    workspaceId: "ws-b",
    name: "beta",
    lastOpened: 5,
    running: false,
  },
];

const routeB: MobileHubWorkspaceRoute = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true,
  serverUrl: "https://workspace.example",
  controlReach: ROUTED_CONTROL_PAIRING,
  workspaceReach: WORKSPACE_B_PAIRING,
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
};

function dependencies(
  options: {
    events?: string[];
    stored?: StoredShellCredential | null;
    currentStored?: StoredShellCredential;
    route?: () => Promise<MobileHubWorkspaceRoute>;
    reload?: () => Promise<{ reloading: boolean }>;
    persist?: (stored: StoredShellCredential) => Promise<void>;
  } = {}
): {
  deps: MobileWorkspaceSelectionDependencies;
  listWorkspaces: jest.Mock;
  routeWorkspace: jest.Mock;
  close: jest.Mock;
  persistCredential: jest.Mock;
} {
  const events = options.events ?? [];
  const listWorkspaces = jest.fn(async () => {
    events.push("list");
    return workspaces;
  });
  const routeWorkspace = jest.fn(async ({ workspace }: { workspace: string }) => {
    events.push(`route:${workspace}`);
    return options.route ? options.route() : routeB;
  });
  const close = jest.fn(async () => {
    events.push("close-control");
  });
  const control = {
    client: { listWorkspaces, routeWorkspace },
    getStoredCredential: () => options.currentStored ?? storedA,
    close,
  } as MobileHubControlConnection;
  const persistCredential = jest.fn(async (stored: StoredShellCredential) => {
    events.push(`persist:${stored.workspacePairing.room}`);
    await options.persist?.(stored);
  });
  return {
    deps: {
      loadCredential: async () => (options.stored === undefined ? storedA : options.stored),
      connectControl: async () => control,
      persistCredential,
      reloadBootstrap: async () => {
        events.push("reload");
        return options.reload ? options.reload() : { reloading: true };
      },
    },
    listWorkspaces,
    routeWorkspace,
    close,
    persistCredential,
  };
}

describe("mobile workspace selection", () => {
  it("lists visible workspaces through the stable control connection", async () => {
    const events: string[] = [];
    const { deps, listWorkspaces, close } = dependencies({ events });

    await expect(listMobileWorkspaces(deps)).resolves.toEqual(workspaces);

    expect(listWorkspaces).toHaveBeenCalledWith();
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["list", "close-control"]);
  });

  it("routes over control and persists the exact reach before reload and close", async () => {
    const events: string[] = [];
    const currentStored = { ...storedA, refreshToken: ROTATED_TOKEN };
    const { deps, routeWorkspace, persistCredential } = dependencies({
      events,
      currentStored,
    });

    await expect(selectMobileWorkspace("beta", deps)).resolves.toEqual(routeB);

    expect(routeWorkspace).toHaveBeenCalledWith({ workspace: "beta" });
    expect(persistCredential).toHaveBeenCalledTimes(1);
    expect(persistCredential.mock.calls[0]?.[0]).toEqual({
      ...currentStored,
      controlPairing: ROUTED_CONTROL_PAIRING,
      workspacePairing: WORKSPACE_B_PAIRING,
    });
    expect(events).toEqual(["route:beta", "persist:workspace-b-2222", "reload", "close-control"]);
  });

  it("restores the prior reach and leaves the active session untouched when reload fails", async () => {
    const events: string[] = [];
    const activeWorkspaceClose = jest.fn();
    const { deps, persistCredential } = dependencies({
      events,
      reload: async () => {
        throw new Error("native reload unavailable");
      },
    });

    await expect(selectMobileWorkspace("beta", deps)).rejects.toThrow("native reload unavailable");

    expect(persistCredential.mock.calls.map((call) => call[0])).toEqual([
      {
        ...storedA,
        controlPairing: ROUTED_CONTROL_PAIRING,
        workspacePairing: WORKSPACE_B_PAIRING,
      },
      storedA,
    ]);
    expect(events).toEqual([
      "route:beta",
      "persist:workspace-b-2222",
      "reload",
      "persist:workspace-a-1111",
      "close-control",
    ]);
    expect(activeWorkspaceClose).not.toHaveBeenCalled();
  });

  it("does not write or reload when routing fails", async () => {
    const events: string[] = [];
    const { deps, persistCredential } = dependencies({
      events,
      route: async () => {
        throw new Error("membership denied");
      },
    });

    await expect(selectMobileWorkspace("beta", deps)).rejects.toThrow("membership denied");
    expect(persistCredential).not.toHaveBeenCalled();
    expect(events).toEqual(["route:beta", "close-control"]);
  });
});
