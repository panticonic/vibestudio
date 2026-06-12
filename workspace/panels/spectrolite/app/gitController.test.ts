import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState, type SpectroliteState } from "./state";
import { GitController } from "./gitController";
import { createBufferEntry } from "../state/fileBuffer";

const runtimeMocks = vi.hoisted(() => {
  const client = {
    status: vi.fn(),
    addAll: vi.fn(),
    commit: vi.fn(),
    checkout: vi.fn(),
  };
  return {
    client,
    listBranches: vi.fn(),
  };
});

vi.mock("@workspace/runtime", () => ({
  contextId: "ctx-runtime",
  git: { client: () => runtimeMocks.client },
  listBranches: runtimeMocks.listBranches,
}));

function makeState() {
  return initialState({
    contextId: "ctx",
    channelName: "chan",
    repoRoot: "/projects/default",
    openPath: "Note.mdx",
    installedAgents: [],
  });
}

function dirtyBuffer(path = "Note.mdx") {
  const entry = createBufferEntry(path, "old");
  return { ...entry, currentMdx: "typed" };
}

describe("GitController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.client.status.mockResolvedValue({
      branch: "main",
      files: [{ path: "Note.mdx", status: "modified" }],
    });
    runtimeMocks.client.addAll.mockResolvedValue(undefined);
    runtimeMocks.client.commit.mockResolvedValue("sha-1");
    runtimeMocks.client.checkout.mockResolvedValue(undefined);
    runtimeMocks.listBranches.mockResolvedValue([]);
  });

  it("flushes editor buffers before staging and committing", async () => {
    const store = createStore<SpectroliteState>({
      ...makeState(),
      commitMessage: "Commit note",
      buffers: { "Note.mdx": dirtyBuffer() },
      gitDirty: ["Note.mdx"],
    });
    const order: string[] = [];
    runtimeMocks.client.status.mockImplementation(async () => {
      order.push("status");
      return { branch: "main", files: [{ path: "Note.mdx", status: "modified" }] };
    });
    runtimeMocks.client.addAll.mockImplementation(async () => { order.push("add"); });
    runtimeMocks.client.commit.mockImplementation(async () => {
      order.push("commit");
      return "sha-1";
    });
    const controller = new GitController(store, {
      flushAllDirty: async () => {
        order.push("flush");
        store.setState((prev) => {
          const cur = prev.buffers["Note.mdx"]!;
          return {
            buffers: {
              ...prev.buffers,
              "Note.mdx": { ...cur, savedMdx: cur.currentMdx, lastFlushedMdx: cur.currentMdx },
            },
          };
        });
      },
    });

    await expect(controller.commit()).resolves.toEqual({ sha: "sha-1" });
    expect(order.slice(0, 4)).toEqual(["flush", "status", "add", "commit"]);
  });

  it("refuses to commit when flushing leaves buffers unflushed", async () => {
    const store = createStore<SpectroliteState>({
      ...makeState(),
      commitMessage: "Commit note",
      buffers: { "Note.mdx": dirtyBuffer() },
      gitDirty: ["Note.mdx"],
    });
    const controller = new GitController(store, { flushAllDirty: async () => {} });

    await expect(controller.commit()).resolves.toMatchObject({
      error: "Flush pending editor changes before committing.",
    });
    expect(runtimeMocks.client.addAll).not.toHaveBeenCalled();
    expect(runtimeMocks.client.commit).not.toHaveBeenCalled();
  });

  it("refuses branch checkout when flushing leaves buffers unflushed", async () => {
    const store = createStore<SpectroliteState>({
      ...makeState(),
      buffers: { "Note.mdx": dirtyBuffer() },
      branches: [
        { name: "main", current: true },
        { name: "next", current: false },
      ],
    });
    const controller = new GitController(store, { flushAllDirty: async () => {} });

    await controller.checkout("next");
    expect(store.getState().branchError).toBe("Flush pending editor changes before switching branches.");
    expect(runtimeMocks.client.checkout).not.toHaveBeenCalled();
  });

  it("runs a second status refresh when invalidated during an in-flight refresh", async () => {
    const store = createStore(makeState());
    const controller = new GitController(store, { flushAllDirty: async () => {} });
    const releases: Array<(value: unknown) => void> = [];
    runtimeMocks.client.status.mockImplementation(() => new Promise((resolve) => {
      releases.push(resolve);
    }));

    const running = controller.refreshStatus();
    controller.refreshStatus();
    await Promise.resolve();
    expect(runtimeMocks.client.status).toHaveBeenCalledTimes(1);

    releases[0]!({ branch: "main", files: [] });
    await vi.waitFor(() => {
      expect(runtimeMocks.client.status).toHaveBeenCalledTimes(2);
    });

    releases[1]!({ branch: "main", files: [{ path: "Late.mdx", status: "modified" }] });
    await running;
    expect(store.getState().gitDirty).toEqual(["Late.mdx"]);
  });
});
