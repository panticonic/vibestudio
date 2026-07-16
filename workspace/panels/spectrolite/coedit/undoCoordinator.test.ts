import { describe, expect, it, vi } from "vitest";
import { UndoCoordinator } from "./undoCoordinator.js";

const lexical = {
  canUndo: () => false,
  canRedo: () => false,
  undo: vi.fn(),
  redo: vi.fn(),
};

describe("UndoCoordinator", () => {
  it("counteracts exact changes and counteracts that counteraction for redo", async () => {
    const revert = vi
      .fn<(ids: string[]) => Promise<{ changeIds: string[] }>>()
      .mockResolvedValueOnce({ changeIds: ["change:counteraction"] })
      .mockResolvedValueOnce({ changeIds: ["change:reapplied"] });
    const undo = new UndoCoordinator({ lexical, revert });
    undo.sealCommit(["change:authored"]);

    await expect(undo.undo()).resolves.toBe("revert");
    expect(revert).toHaveBeenNthCalledWith(1, ["change:authored"]);
    await expect(undo.redo()).resolves.toBe("revert");
    expect(revert).toHaveBeenNthCalledWith(2, ["change:counteraction"]);
  });
});
