import { describe, it, expect } from "vitest";
import { UndoCoordinator, type LexicalUndo } from "./undoCoordinator.js";

class FakeLexical implements LexicalUndo {
  undoable = false;
  redoable = false;
  undos = 0;
  redos = 0;
  canUndo() {
    return this.undoable;
  }
  canRedo() {
    return this.redoable;
  }
  undo() {
    this.undos++;
  }
  redo() {
    this.redos++;
  }
}

function setup() {
  const lexical = new FakeLexical();
  const reverts: string[] = [];
  const issued: string[] = [];
  let n = 0;
  const coordinator = new UndoCoordinator({
    lexical,
    revert: async ({ stateHash }) => {
      reverts.push(stateHash);
      return { stateHash: `rev:${++n}` };
    },
    onRevertIssued: (h) => issued.push(h),
  });
  return { lexical, reverts, issued, coordinator };
}

describe("UndoCoordinator", () => {
  it("drains uncommitted Lexical edits before touching GAD", async () => {
    const { lexical, coordinator, reverts } = setup();
    lexical.undoable = true;
    expect(await coordinator.undo()).toBe("lexical");
    expect(lexical.undos).toBe(1);
    expect(reverts).toEqual([]);
  });

  it("reverts the last committed transition once Lexical is drained", async () => {
    const { coordinator, reverts, issued } = setup();
    coordinator.sealCommit("state:c1");
    expect(await coordinator.undo()).toBe("revert");
    expect(reverts).toEqual(["state:c1"]);
    // Echo guard fired so the round-tripped node replace isn't re-recorded.
    expect(issued).toEqual(["rev:1"]);
  });

  it("crosses the boundary mid-stream: Lexical first, then revert", async () => {
    const { lexical, coordinator, reverts } = setup();
    coordinator.sealCommit("state:c1");
    lexical.undoable = true; // one uncommitted edit on top of the commit
    expect(await coordinator.undo()).toBe("lexical");
    lexical.undoable = false; // Lexical drained
    expect(await coordinator.undo()).toBe("revert");
    expect(reverts).toEqual(["state:c1"]);
  });

  it("reverts an agent (remote) transition", async () => {
    const { coordinator, reverts } = setup();
    coordinator.recordRemote("state:agent1", { id: "scribe", kind: "agent" });
    expect(await coordinator.undo()).toBe("revert");
    expect(reverts).toEqual(["state:agent1"]);
  });

  it("redo reapplies a reverted transition (revert of the revert)", async () => {
    const { coordinator, reverts } = setup();
    coordinator.sealCommit("state:c1");
    await coordinator.undo(); // reverts c1 → rev:1
    expect(reverts).toEqual(["state:c1"]);
    expect(await coordinator.redo()).toBe("revert");
    // Redo reverts the revert (rev:1) → reapplies the original change forward.
    expect(reverts).toEqual(["state:c1", "rev:1"]);
    // The original transition is back on the undo stack.
    expect(coordinator.canUndo).toBe(true);
  });

  it("a new commit clears the redo stack", async () => {
    const { coordinator } = setup();
    coordinator.sealCommit("state:c1");
    await coordinator.undo(); // redoStack has the revert
    expect(coordinator.canRedo).toBe(true);
    coordinator.sealCommit("state:c2"); // new edit invalidates redo
    expect(coordinator.canRedo).toBe(false);
  });

  it("undo with nothing to do is a no-op", async () => {
    const { coordinator, reverts } = setup();
    expect(await coordinator.undo()).toBe("none");
    expect(reverts).toEqual([]);
  });

  it("revertTransition reverts an arbitrary transition and drops it from the stack", async () => {
    const { coordinator, reverts, issued } = setup();
    coordinator.sealCommit("state:c1");
    coordinator.recordRemote("state:agent1", { id: "scribe", kind: "agent" });
    await coordinator.revertTransition("state:c1");
    expect(reverts).toEqual(["state:c1"]);
    expect(issued).toEqual(["rev:1"]);
    // c1 was removed; the remaining undo reverts the agent transition.
    expect(await coordinator.undo()).toBe("revert");
    expect(reverts).toEqual(["state:c1", "state:agent1"]);
  });

  it("canUndo / canRedo reflect both Lexical and the GAD stacks", async () => {
    const { lexical, coordinator } = setup();
    expect(coordinator.canUndo).toBe(false);
    lexical.undoable = true;
    expect(coordinator.canUndo).toBe(true);
    lexical.undoable = false;
    coordinator.sealCommit("state:c1");
    expect(coordinator.canUndo).toBe(true);
  });
});
