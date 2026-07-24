import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store.js";
import { initialState } from "./state.js";
import { VaultController, type VaultFileSession } from "./vaultController.js";

const runtimeMocks = vi.hoisted(() => ({
  reopen: vi.fn(async () => undefined),
  getStateArgs: vi.fn(() => ({})),
  setStateArgs: vi.fn(async () => undefined),
}));

vi.mock("@workspace/runtime", () => ({
  panel: {
    reopen: runtimeMocks.reopen,
    stateArgs: { get: runtimeMocks.getStateArgs, set: runtimeMocks.setStateArgs },
  },
}));

describe("VaultController", () => {
  it("shows the picker without reopening a second transient panel session", async () => {
    runtimeMocks.reopen.mockClear();
    runtimeMocks.setStateArgs.mockClear();
    const store = createStore(
      initialState({
        contextId: "vault-notes",
        channelName: "channel-notes",
        repoRoot: "projects/notes",
        openPath: "Note.mdx",
        installedAgents: [
          {
            agentId: "Agent",
            className: "Agent",
            handle: "scribe",
            key: "scribe-key",
            source: "workers/agent",
          },
        ],
      })
    );
    const beforeVaultSwitch = vi.fn(async () => undefined);
    const controller = new VaultController(store, {
      beforeVaultSwitch,
      bindVault: vi.fn(() => null),
      onVaultSelected: vi.fn(),
    });

    await controller.switchVault();

    expect(beforeVaultSwitch).toHaveBeenCalledOnce();
    expect(store.getState().repoRoot).toBeNull();
    expect(store.getState().installedAgents).toHaveLength(1);
    expect(runtimeMocks.setStateArgs).toHaveBeenCalledWith({
      repoRoot: null,
      openPath: null,
    });
    expect(runtimeMocks.reopen).not.toHaveBeenCalled();
  });

  it("indexes repository files by durable semantic listing", async () => {
    const store = createStore(
      initialState({
        contextId: "vault-notes",
        channelName: null,
        repoRoot: "projects/notes",
        openPath: null,
        installedAgents: [],
      })
    );
    const files: VaultFileSession = {
      listFiles: async () => [
        {
          repositoryId: "repository:notes",
          repoPath: "projects/notes",
          fileId: "file:one",
          path: "projects/notes/One.mdx",
          contentHash: "blob:one",
          authoredChangeId: "change:one",
          authoredByWorkUnitId: "work:one",
          contentClass: "internal",
          externalKeys: [],
          mode: 0o644,
          executable: false,
          contentKind: "text",
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      readFile: async () => null,
      createFile: async () => {
        throw new Error("unexpected create");
      },
    };
    const controller = new VaultController(
      store,
      {
        beforeVaultSwitch: vi.fn(async () => undefined),
        bindVault: vi.fn(() => files),
        onVaultSelected: vi.fn(),
      },
      files
    );
    await controller.refreshPaths();
    expect(store.getState().paths).toEqual(["One.mdx"]);
    expect(store.getState().pathContentHashes).toEqual({ "One.mdx": "blob:one" });
  });

  it("selects a repository without reopening or changing the panel context", async () => {
    runtimeMocks.reopen.mockClear();
    runtimeMocks.setStateArgs.mockClear();
    const store = createStore(
      initialState({
        contextId: "ctx-panel",
        channelName: "channel-notes",
        repoRoot: null,
        openPath: null,
        installedAgents: [],
      })
    );
    const files: VaultFileSession = {
      listFiles: async () => [],
      readFile: async () => null,
      createFile: async () => {
        throw new Error("unexpected create");
      },
    };
    const onVaultSelected = vi.fn();
    const bindVault = vi.fn(() => files);
    const controller = new VaultController(store, {
      beforeVaultSwitch: vi.fn(async () => undefined),
      bindVault,
      onVaultSelected,
    });

    controller.selectVault("/projects/default/");
    await vi.waitFor(() => expect(onVaultSelected).toHaveBeenCalledWith("projects/default"));

    expect(store.getState().contextId).toBe("ctx-panel");
    expect(store.getState().repoRoot).toBe("projects/default");
    expect(bindVault).toHaveBeenCalledWith("projects/default");
    expect(runtimeMocks.setStateArgs).toHaveBeenCalledWith({
      repoRoot: "projects/default",
      openPath: null,
    });
    expect(runtimeMocks.reopen).not.toHaveBeenCalled();
  });
});
