import type {
  MobileHubWorkspace,
  MobileHubWorkspaceRoute,
  StoredMobileConnection,
  StoredRoutedMobileConnection,
} from "@vibestudio/mobile-webrtc";
import {
  listMobileWorkspaces,
  selectMobileWorkspace,
  type MobileWorkspaceSelectionDependencies,
} from "./workspaceSelection";

jest.mock("@vibestudio/mobile-webrtc", () => ({
  loadShellCredential: jest.fn(),
  persistStoredMobileConnection: jest.fn(),
  createPairedMobileConnection: (
    credential: { deviceId: string; refreshToken: string },
    controlPairing: Record<string, unknown>,
    selectedWorkspaceId: string,
    pairedAt: number
  ) => ({
    schemaVersion: 4,
    phase: "paired",
    credential,
    controlPairing,
    selectedWorkspaceId,
    pairedAt,
  }),
  createRoutedMobileConnection: (
    paired: Record<string, unknown>,
    workspacePairing: Record<string, unknown>
  ) => ({ ...paired, phase: "routed", workspacePairing }),
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
const storedA: StoredRoutedMobileConnection = {
  schemaVersion: 4,
  phase: "routed",
  credential: { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
  controlPairing: CONTROL_PAIRING,
  selectedWorkspaceId: "ws-a",
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
    stored?: StoredMobileConnection | null;
    currentStored?: StoredRoutedMobileConnection;
    route?: () => Promise<MobileHubWorkspaceRoute>;
    reload?: () => Promise<{ reloading: boolean }>;
    persist?: (stored: StoredMobileConnection) => Promise<void>;
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
  const persistCredential = jest.fn(async (stored: StoredMobileConnection) => {
    events.push(
      `persist:${stored.phase === "routed" ? stored.workspacePairing.room : stored.phase}`
    );
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
    const currentStored = {
      ...storedA,
      credential: { ...storedA.credential, refreshToken: ROTATED_TOKEN },
    };
    const { deps, routeWorkspace, persistCredential } = dependencies({
      events,
      currentStored,
    });

    await expect(selectMobileWorkspace("ws-b", deps)).resolves.toEqual(routeB);

    expect(routeWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(persistCredential).toHaveBeenCalledTimes(2);
    expect(persistCredential.mock.calls.map(([stored]) => stored)).toEqual([
      {
        ...currentStored,
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      {
        ...currentStored,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing: WORKSPACE_B_PAIRING,
      },
    ]);
    expect(events).toEqual(["persist:paired", "route:ws-b", "persist:workspace-b-2222", "reload"]);
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
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      {
        ...storedA,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing: WORKSPACE_B_PAIRING,
      },
      storedA,
    ]);
    expect(events).toEqual([
      "persist:paired",
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
    expect(persistCredential.mock.calls.map((call) => call[0])).toEqual([
      {
        ...storedA,
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      storedA,
    ]);
    expect(events).toEqual(["persist:paired", "route:ws-b", "persist:workspace-a-1111"]);
  });
});
