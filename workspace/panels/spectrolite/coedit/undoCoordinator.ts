/** Lexical undo first; committed semantic undo counteracts exact change IDs. */

import type { UndoSink } from "./docController.js";

export interface LexicalUndo {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
}

export interface RevertResult {
  changeIds: string[];
}

export type RevertFn = (changeIds: string[]) => Promise<RevertResult>;

export type UndoOutcome = "lexical" | "revert" | "none";

export interface UndoCoordinatorDeps {
  lexical: LexicalUndo;
  revert: RevertFn;
}

export class UndoCoordinator implements UndoSink {
  private readonly undoStack: string[][] = [];
  private readonly redoStack: Array<{
    originalChangeIds: string[];
    counteractionChangeIds: string[];
  }> = [];

  constructor(private readonly deps: UndoCoordinatorDeps) {}

  sealCommit(changeIds: string[]): void {
    if (changeIds.length === 0) return;
    this.undoStack.push([...changeIds]);
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.deps.lexical.canUndo() || this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.deps.lexical.canRedo() || this.redoStack.length > 0;
  }

  async undo(): Promise<UndoOutcome> {
    if (this.deps.lexical.canUndo()) {
      this.deps.lexical.undo();
      return "lexical";
    }
    const originalChangeIds = this.undoStack.pop();
    if (!originalChangeIds) return "none";
    const result = await this.deps.revert(originalChangeIds);
    this.redoStack.push({ originalChangeIds, counteractionChangeIds: result.changeIds });
    return "revert";
  }

  async redo(): Promise<UndoOutcome> {
    if (this.deps.lexical.canRedo()) {
      this.deps.lexical.redo();
      return "lexical";
    }
    const entry = this.redoStack.pop();
    if (!entry) return "none";
    await this.deps.revert(entry.counteractionChangeIds);
    this.undoStack.push(entry.originalChangeIds);
    return "revert";
  }

  async revertTransition(changeIds: string[]): Promise<RevertResult> {
    const result = await this.deps.revert(changeIds);
    const selected = new Set(changeIds);
    const index = this.undoStack.findIndex((entry) => entry.some((id) => selected.has(id)));
    if (index >= 0) this.undoStack.splice(index, 1);
    return result;
  }
}
