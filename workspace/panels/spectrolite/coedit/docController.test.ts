import { describe, expect, it, vi } from "vitest";
import { DocController, type CoEditEditor, type DocVcs } from "./docController.js";

const working = { kind: "application" as const, applicationId: "application:working" };

function editorState(initial = "") {
  let canonical = initial;
  const callbacks: Array<() => void> = [];
  const editor: CoEditEditor = {
    getCanonical: () => canonical,
    setCanonical: (value) => {
      canonical = value;
    },
    rebase: () => undefined,
    getBlocks: () => [],
    getLiveBlockIds: () => new Set(),
    getDirtyCommit: () => ({
      canonical,
      dirty: [{ baseStart: "# Base\n".length, baseEnd: "# Base\n".length, newText: "\nLocal\n" }],
    }),
    applyContained: vi.fn(),
    applyStructural: vi.fn(),
    onUserEdit: (callback) => {
      callbacks.push(callback);
      return () => undefined;
    },
  };
  return {
    editor,
    callbacks,
    canonical: () => canonical,
    setCanonical: (value: string) => {
      canonical = value;
    },
  };
}

function vcs(overrides: Partial<DocVcs> = {}): DocVcs {
  return {
    readFile: async () => ({
      repositoryId: "repo:notes",
      repoPath: "projects/default",
      fileId: "file:note",
      path: "Note.mdx",
      content: { kind: "text", text: "# Base\n" },
      contentHash: "blob:base",
      mode: 0o644,
    }),
    edit: async () => {
      throw new Error("unexpected edit");
    },
    commit: async () => {
      throw new Error("unexpected commit");
    },
    refresh: async () => ({ status: { workingHead: working } }),
    ...overrides,
  };
}

describe("DocController", () => {
  it("loads from the exact working state without a second subscription model", async () => {
    const state = editorState();
    const controller = new DocController({
      editor: state.editor,
      vcs: vcs(),
      splitBlocks: () => [],
      onCollisions: vi.fn(),
      setTimer: () => 1,
      clearTimer: vi.fn(),
    });

    await controller.load("projects/default/Note.mdx");
    expect(state.canonical()).toBe("# Base\n");
    expect(controller.isDirty()).toBe(false);
    controller.dispose();
  });

  it("authors strict hunks against the state the editor observed", async () => {
    const state = editorState();
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const next = { kind: "application" as const, applicationId: "application:edited" };
    const edit = vi.fn<DocVcs["edit"]>(async () => ({
      previousWorkingHead: working,
      workingHead: next,
      changeIds: ["change:local"],
      paths: ["projects/default/Note.mdx"],
    }));
    const controller = new DocController({
      editor: state.editor,
      vcs: vcs({ edit }),
      splitBlocks: () => [],
      onCollisions: vi.fn(),
      editDebounceMs: 5,
      observationMs: 999,
      setTimer: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length;
      },
      clearTimer: vi.fn(),
    });

    await controller.load("projects/default/Note.mdx");
    state.setCanonical("# Base\n\nLocal\n");
    state.callbacks[0]?.();
    timers.find((timer) => timer.delay === 5)?.fn();
    await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
    expect(edit.mock.calls[0]?.[1]).toEqual(working);
    expect(edit.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ kind: "replace", path: "projects/default/Note.mdx" }),
    ]);
    controller.dispose();
  });

  it("flushes the newest editor text when disposal races an in-flight edit", async () => {
    const state = editorState();
    const timers: Array<{ fn: () => void; delay: number }> = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = { kind: "application" as const, applicationId: "application:first" };
    const second = { kind: "application" as const, applicationId: "application:second" };
    const edit = vi.fn<DocVcs["edit"]>(async () => {
      if (edit.mock.calls.length === 1) {
        await firstPending;
        return {
          previousWorkingHead: working,
          workingHead: first,
          changeIds: ["change:first"],
          paths: ["projects/default/Note.mdx"],
        };
      }
      return {
        previousWorkingHead: first,
        workingHead: second,
        changeIds: ["change:second"],
        paths: ["projects/default/Note.mdx"],
      };
    });
    const controller = new DocController({
      editor: state.editor,
      vcs: vcs({ edit }),
      splitBlocks: () => [],
      onCollisions: vi.fn(),
      editDebounceMs: 5,
      observationMs: 999,
      setTimer: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length;
      },
      clearTimer: vi.fn(),
    });

    await controller.load("projects/default/Note.mdx");
    state.setCanonical("# Base\n\nFirst\n");
    state.callbacks[0]?.();
    timers.find((timer) => timer.delay === 5)?.fn();
    await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());

    state.setCanonical("# Base\n\nNewest\n");
    controller.dispose();
    releaseFirst();

    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect(edit.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        kind: "replace",
        path: "projects/default/Note.mdx",
        hunks: [expect.objectContaining({ newText: expect.stringContaining("Newest") })],
      }),
    ]);
  });
});
