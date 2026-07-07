import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState } from "./state";
import { VaultController } from "./vaultController";
import { vaultContextId } from "./vaultContext";

const runtimeMocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  edit: vi.fn(),
  readFile: vi.fn(),
  reopen: vi.fn(async () => ({ id: "p", title: "t" })),
  setStateArgs: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  vcs: {
    listFiles: runtimeMocks.listFiles,
    edit: runtimeMocks.edit,
    readFile: runtimeMocks.readFile,
  },
  panel: {
    reopen: runtimeMocks.reopen,
    stateArgs: { set: runtimeMocks.setStateArgs },
  },
}));

function makeStore() {
  return createStore(initialState({
    contextId: "ctx",
    channelName: "chan",
    repoRoot: "projects/default",
    openPath: null,
    installedAgents: [],
  }));
}

describe("VaultController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs a second path scan when invalidated during an in-flight scan", async () => {
    const store = makeStore();
    const controller = new VaultController(store, {
      onVaultSelected: () => {},
    });
    const releases: Array<(entries: Array<{ path: string; contentHash: string; mode: number }>) => void> = [];
    runtimeMocks.listFiles.mockImplementation(() => new Promise((resolve) => {
      releases.push(resolve);
    }));

    const running = controller.refreshPaths();
    controller.refreshPaths();
    await Promise.resolve();
    expect(runtimeMocks.listFiles).toHaveBeenCalledTimes(1);

    releases[0]!([{ path: "projects/default/First.mdx", contentHash: "a", mode: 0o644 }]);
    await vi.waitFor(() => {
      expect(runtimeMocks.listFiles).toHaveBeenCalledTimes(2);
    });

    releases[1]!([{ path: "projects/default/Second.mdx", contentHash: "b", mode: 0o644 }]);
    await running;
    expect(store.getState().paths).toEqual(["Second.mdx"]);
  });

  it("maps vcs paths to vault-relative .mdx paths and ignores other files", async () => {
    const store = makeStore();
    const controller = new VaultController(store, { onVaultSelected: () => {} });
    runtimeMocks.listFiles.mockResolvedValue([
      { path: "projects/default/A.mdx", contentHash: "1", mode: 0o644 },
      { path: "projects/default/nested/B.mdx", contentHash: "2", mode: 0o644 },
      { path: "projects/default/notes.txt", contentHash: "3", mode: 0o644 },
      { path: "projects/other/C.mdx", contentHash: "4", mode: 0o644 },
    ]);
    await controller.refreshPaths();
    expect(store.getState().paths).toEqual(["A.mdx", "nested/B.mdx"]);
  });

  it("passes starter docs through reopen so creation happens in the vault context", () => {
    const store = makeStore();
    const controller = new VaultController(store, { onVaultSelected: () => {} });
    const starterDoc = { path: "Welcome.mdx", content: "# Welcome\n" };

    controller.selectVault("/projects/fresh", { starterDoc });

    expect(runtimeMocks.reopen).toHaveBeenCalledWith({
      contextId: vaultContextId("projects/fresh"),
      stateArgs: {
        repoRoot: "projects/fresh",
        pendingStarterDoc: starterDoc,
      },
    });
    expect(runtimeMocks.edit).not.toHaveBeenCalled();
  });

  it("enters picker state and clears persisted repoRoot when switching vaults", async () => {
    const store = makeStore();
    store.setState({
      activeDeps: { chart: "1.0.0" },
      activePath: "E2E.mdx",
      dirtyPaths: ["E2E.mdx"],
      installedAgents: [{
        agentId: "SilentAgentWorker",
        className: "SilentAgentWorker",
        handle: "scribe",
        key: "scribe",
        source: "workers/silent-agent-worker",
      }],
      paths: ["E2E.mdx"],
      pathsLoaded: true,
      pendingSuggestions: [{
        id: "s",
        vcsPath: "projects/default/E2E.mdx",
        collision: {
          fromIndex: 0,
          toIndex: 1,
          oldIds: ["a"],
          oldTexts: ["old"],
          newTexts: ["new"],
          liveIds: ["a"],
        },
      }],
      roster: [{ handle: "scribe", status: "live" }],
    });
    const controller = new VaultController(store, { onVaultSelected: () => {} });

    await controller.switchVault();

    expect(store.getState()).toMatchObject({
      activeDeps: {},
      activePath: null,
      dirtyPaths: [],
      installedAgents: [],
      paths: [],
      pathsLoaded: false,
      pendingSuggestions: [],
      repoRoot: null,
      roster: [],
    });
    expect(runtimeMocks.reopen).toHaveBeenCalledWith({
      stateArgs: { repoRoot: null },
    });
  });
});
