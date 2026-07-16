import type {
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
  persistCredential: jest.Mock;
} {
  const events = options.events ?? [];
  const listWorkspaces = jest.fn(async () => {
    events.push("list");
    return workspaces;
  });
  const routeWorkspace = jest.fn(async ({ workspaceId }: { workspaceId: string }) => {
    events.push(`route:${workspaceId}`);
    return options.route ? options.route() : routeB;
  });
  const persistCredential = jest.fn(async (stored: StoredShellCredential) => {
    events.push(`persist:${stored.workspacePairing.room}`);
    await options.persist?.(stored);
  });
  return {
    deps: {
      control: { listWorkspaces, routeWorkspace },
      loadCredential: async () =>
        options.stored === undefined ? (options.currentStored ?? storedA) : options.stored,
      persistCredential,
      reloadBootstrap: async () => {
        events.push("reload");
        return options.reload ? options.reload() : { reloading: true };
      },
    },
    listWorkspaces,
    routeWorkspace,
    persistCredential,
  };
}

describe("mobile workspace selection", () => {
  it("lists visible workspaces through the stable control connection", async () => {
    const events: string[] = [];
    const { deps, listWorkspaces } = dependencies({ events });

    await expect(listMobileWorkspaces(deps)).resolves.toEqual(workspaces);

    expect(listWorkspaces).toHaveBeenCalledWith();
    expect(events).toEqual(["list"]);
  });

  it("routes over retained control and persists the exact reach before reload", async () => {
    const events: string[] = [];
    const currentStored = { ...storedA, refreshToken: ROTATED_TOKEN };
    const { deps, routeWorkspace, persistCredential } = dependencies({
      events,
      currentStored,
    });

    await expect(selectMobileWorkspace("ws-b", deps)).resolves.toEqual(routeB);

    expect(routeWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(persistCredential).toHaveBeenCalledTimes(1);
    expect(persistCredential.mock.calls[0]?.[0]).toEqual({
      ...currentStored,
      controlPairing: CONTROL_PAIRING,
      workspacePairing: WORKSPACE_B_PAIRING,
    });
    expect(events).toEqual(["route:ws-b", "persist:workspace-b-2222", "reload"]);
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

    await expect(selectMobileWorkspace("ws-b", deps)).rejects.toThrow("native reload unavailable");

    expect(persistCredential.mock.calls.map((call) => call[0])).toEqual([
      {
        ...storedA,
        controlPairing: CONTROL_PAIRING,
        workspacePairing: WORKSPACE_B_PAIRING,
      },
      storedA,
    ]);
    expect(events).toEqual([
      "route:ws-b",
      "persist:workspace-b-2222",
      "reload",
      "persist:workspace-a-1111",
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

    await expect(selectMobileWorkspace("ws-b", deps)).rejects.toThrow("membership denied");
    expect(persistCredential).not.toHaveBeenCalled();
    expect(events).toEqual(["route:ws-b"]);
  });
});
