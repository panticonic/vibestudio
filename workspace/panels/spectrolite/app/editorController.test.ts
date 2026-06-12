import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState } from "./state";
import { EditorController } from "./editorController";

const editorMocks = vi.hoisted(() => ({
  writeBufferToDisk: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "ctx-runtime",
  setStateArgs: vi.fn(),
}));

vi.mock("../components/DocumentEditor", () => ({
  writeBufferToDisk: editorMocks.writeBufferToDisk,
}));

vi.mock("../messages/mention-delivery", () => ({
  buildMentionDeliveryMessage: vi.fn(() => null),
}));

function makeStore() {
  return createStore(initialState({
    contextId: "ctx",
    channelName: "chan",
    repoRoot: "/projects/default",
    openPath: "Note.mdx",
    installedAgents: [],
  }));
}

describe("EditorController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMocks.writeBufferToDisk.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records save failures and clears them after a successful retry", async () => {
    const store = makeStore();
    const controller = new EditorController(store, { onDiskChanged: () => {} });
    controller.editorReloaded("Note.mdx", "old");
    controller.editorChanged("Note.mdx", "new");
    editorMocks.writeBufferToDisk.mockRejectedValueOnce(new Error("disk full"));

    controller.flushNow("Note.mdx");
    await vi.waitFor(() => {
      expect(store.getState().saveErrors["Note.mdx"]?.message).toBe("disk full");
    });
    expect(store.getState().buffers["Note.mdx"]!.lastFlushedMdx).toBe("old");

    controller.flushNow("Note.mdx");
    await vi.waitFor(() => {
      expect(store.getState().saveErrors["Note.mdx"]).toBeUndefined();
    });
    expect(store.getState().buffers["Note.mdx"]!.lastFlushedMdx).toBe("new");
    controller.dispose();
  });
});
