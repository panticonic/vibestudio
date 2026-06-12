import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState } from "./state";
import { VaultController } from "./vaultController";

const pathMocks = vi.hoisted(() => ({
  listMdxPaths: vi.fn(),
}));

vi.mock("../state/workspacePaths", () => ({
  listMdxPaths: pathMocks.listMdxPaths,
}));

vi.mock("@workspace/runtime", () => ({
  setStateArgs: vi.fn(),
}));

function makeStore() {
  return createStore(initialState({
    contextId: "ctx",
    channelName: "chan",
    repoRoot: "/projects/default",
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
      flushAllDirty: async () => {},
      onVaultChanged: () => {},
      onVaultSelected: () => {},
    });
    const releases: Array<(paths: string[]) => void> = [];
    pathMocks.listMdxPaths.mockImplementation(() => new Promise<string[]>((resolve) => {
      releases.push(resolve);
    }));

    const running = controller.refreshPaths();
    controller.refreshPaths();
    await Promise.resolve();
    expect(pathMocks.listMdxPaths).toHaveBeenCalledTimes(1);

    releases[0]!(["First.mdx"]);
    await vi.waitFor(() => {
      expect(pathMocks.listMdxPaths).toHaveBeenCalledTimes(2);
    });

    releases[1]!(["Second.mdx"]);
    await running;
    expect(store.getState().paths).toEqual(["Second.mdx"]);
  });
});
