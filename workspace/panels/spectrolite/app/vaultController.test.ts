import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store.js";
import { initialState } from "./state.js";
import { VaultController, type VaultFileSession } from "./vaultController.js";

vi.mock("@workspace/runtime", () => ({
  panel: { reopen: vi.fn(async () => undefined) },
}));

describe("VaultController", () => {
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
    const controller = new VaultController(store, { onVaultSelected: vi.fn() }, files);
    await controller.refreshPaths();
    expect(store.getState().paths).toEqual(["One.mdx"]);
    expect(store.getState().pathContentHashes).toEqual({ "One.mdx": "blob:one" });
  });
});
