/**
 * One-document co-edit controller.
 *
 * Typing authors semantic text changes against an exact working state. Remote
 * observation compares state identities, rereads the document, and applies a
 * narrow block reconciliation. It does not reconstruct a second merge model
 * or transport actor labels through the editor.
 */

import type { VcsReadFileResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { reconcileBlocks, type Block, type Collision } from "./blockReconcile.js";
import { buildEditOps, type ReplaceEditOp } from "./commitEdits.js";

export interface EditorBlock {
  id: string;
  signature: string;
  text: string;
}

export interface DirtyCommit {
  canonical: string;
  dirty: Array<{ baseStart: number; baseEnd: number; newText: string }>;
}

export interface ContainedApply {
  kind: "contained";
  oldId: string;
  oldIndex: number;
  newText: string;
}

export interface StructuralApply {
  kind: "structural";
  fromIndex: number;
  toIndex: number;
  oldIds: string[];
  newTexts: string[];
  beforeId: string | null;
}

export interface CoEditEditor {
  getCanonical(): string;
  setCanonical(markdown: string): void;
  rebase(canonical: string): void;
  getBlocks(): EditorBlock[];
  getLiveBlockIds(): Set<string>;
  getDirtyCommit(): DirtyCommit;
  applyContained(op: ContainedApply): void;
  applyStructural(op: StructuralApply): void;
  onUserEdit(cb: () => void): () => void;
}

export interface SemanticEditResult {
  previousWorkingHead: VcsStateNodeRef;
  workingHead: VcsStateNodeRef;
  changeIds: string[];
  paths: string[];
}

export interface DocVcs {
  readFile(path: string, state?: VcsStateNodeRef): Promise<VcsReadFileResult>;
  edit(edits: ReplaceEditOp[], expectedWorkingHead?: VcsStateNodeRef): Promise<SemanticEditResult>;
  commit(
    message: string | null,
    expectedWorkingHead?: VcsStateNodeRef
  ): Promise<{ event: { kind: "event"; eventId: string } } | null>;
  refresh(): Promise<{ status: { workingHead: VcsStateNodeRef } }>;
}

export interface UndoSink {
  sealCommit(changeIds: string[]): void;
}

export interface DocControllerDeps {
  editor: CoEditEditor;
  vcs: DocVcs;
  splitBlocks(markdown: string): Block[];
  onCollisions(collisions: Collision[], vcsPath: string): void;
  onSaveError?(vcsPath: string, error: unknown): void;
  onDirtyChange?(vcsPath: string, dirty: boolean): void;
  undo?: UndoSink;
  editDebounceMs?: number;
  observationMs?: number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function sameState(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "event"
    ? left.eventId === (right as { kind: "event"; eventId: string }).eventId
    : left.applicationId ===
        (right as { kind: "application"; applicationId: string }).applicationId;
}

export class DocController {
  private vcsPath: string | null = null;
  private baseState: VcsStateNodeRef | null = null;
  private baseText = "";
  private readonly authoredChangeIds = new Set<string>();
  private editTimer: unknown = null;
  private observationTimer: unknown = null;
  private editPromise: Promise<void> | null = null;
  private editAgain = false;
  private editAgainForce = false;
  private disposed = false;
  private offUserEdit: (() => void) | null = null;

  editCount = 0;
  fallbackCount = 0;

  constructor(private readonly deps: DocControllerDeps) {}

  get fallbackRate(): number {
    return this.editCount === 0 ? 0 : this.fallbackCount / this.editCount;
  }

  async load(vcsPath: string): Promise<void> {
    this.offUserEdit?.();
    this.vcsPath = vcsPath;
    const revision = await this.deps.vcs.refresh();
    const file = await this.deps.vcs.readFile(vcsPath, revision.status.workingHead);
    const original = file?.content.kind === "text" ? file.content.text : "";
    this.baseState = revision.status.workingHead;

    this.deps.editor.setCanonical(original);
    this.baseText = original;
    this.offUserEdit = this.deps.editor.onUserEdit(() => this.scheduleEdit());
    this.emitDirty();
    this.scheduleObservation();
  }

  isDirty(): boolean {
    return this.vcsPath !== null && this.deps.editor.getCanonical() !== this.baseText;
  }

  private emitDirty(): void {
    if (this.vcsPath) this.deps.onDirtyChange?.(this.vcsPath, this.isDirty());
  }

  private setTimer(fn: () => void, delay: number): unknown {
    return (this.deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(fn, delay);
  }

  private clearTimer(handle: unknown): void {
    (this.deps.clearTimer ?? ((value) => clearTimeout(value as ReturnType<typeof setTimeout>)))(
      handle
    );
  }

  private scheduleEdit(): void {
    if (this.disposed) return;
    if (this.editTimer !== null) this.clearTimer(this.editTimer);
    this.editTimer = this.setTimer(() => {
      this.editTimer = null;
      void this.recordEdit();
    }, this.deps.editDebounceMs ?? 600);
  }

  private scheduleObservation(): void {
    if (this.disposed || this.observationTimer !== null) return;
    this.observationTimer = this.setTimer(() => {
      this.observationTimer = null;
      void this.observeRemote().finally(() => this.scheduleObservation());
    }, this.deps.observationMs ?? 1200);
  }

  private async recordEdit(force = false): Promise<void> {
    if ((this.disposed && !force) || !this.vcsPath || !this.baseState) return;
    if (this.editPromise) {
      this.editAgain = true;
      this.editAgainForce ||= force;
      await this.editPromise;
      return;
    }
    this.editPromise = (async () => {
      let iterationForce = force;
      do {
        this.editAgain = false;
        this.editAgainForce = false;
        await this.recordEditOnce(iterationForce);
        iterationForce = this.editAgainForce;
      } while (this.editAgain && (!this.disposed || iterationForce));
    })();
    try {
      await this.editPromise;
    } finally {
      this.editPromise = null;
    }
  }

  private async recordEditOnce(force: boolean): Promise<void> {
    if ((this.disposed && !force) || !this.vcsPath) return;
    const { canonical, dirty } = this.deps.editor.getDirtyCommit();
    const built = buildEditOps({
      path: this.vcsPath,
      baseText: this.baseText,
      currentCanonical: canonical,
      dirtyBlocks: dirty,
    });
    if (!built.changed) return this.emitDirty();
    this.editCount += 1;
    if (built.usedFallback) this.fallbackCount += 1;
    try {
      const result = await this.deps.vcs.edit(built.edits, this.baseState ?? undefined);
      this.baseState = result.workingHead;
      result.changeIds.forEach((id) => this.authoredChangeIds.add(id));
      this.baseText = canonical;
      this.deps.editor.rebase(canonical);
    } catch (error) {
      this.deps.onSaveError?.(this.vcsPath, error);
      await this.observeRemote();
    }
    this.emitDirty();
  }

  async commitNow(message: string): Promise<{ eventId: string; changed: boolean } | null> {
    if (this.disposed || !this.vcsPath || !this.baseState) return null;
    if (this.editTimer !== null) {
      this.clearTimer(this.editTimer);
      this.editTimer = null;
    }
    await this.recordEdit();
    if (this.authoredChangeIds.size === 0) return { eventId: "", changed: false };
    const result = await this.deps.vcs.commit(message, this.baseState);
    if (!result) return { eventId: "", changed: false };
    const sealed = [...this.authoredChangeIds];
    this.authoredChangeIds.clear();
    this.deps.undo?.sealCommit(sealed);
    this.baseState = (await this.deps.vcs.refresh()).status.workingHead;
    this.emitDirty();
    return { eventId: result.event.eventId, changed: true };
  }

  private async observeRemote(): Promise<void> {
    if (this.disposed || !this.vcsPath || !this.baseState) return;
    try {
      const current = await this.deps.vcs.refresh();
      if (sameState(current.status.workingHead, this.baseState)) return;
      const file = await this.deps.vcs.readFile(this.vcsPath, current.status.workingHead);
      if (!file || file.content.kind !== "text") return;
      if (file.content.text === this.baseText) {
        this.baseState = current.status.workingHead;
        return;
      }
      this.applyIncoming(current.status.workingHead, file.content.text);
    } catch (error) {
      if (this.vcsPath) this.deps.onSaveError?.(this.vcsPath, error);
    }
  }

  private applyIncoming(state: VcsStateNodeRef, incomingText: string): void {
    if (!this.vcsPath) return;
    const { ops, collisions } = reconcileBlocks(
      this.deps.editor.getBlocks() as Block[],
      this.deps.splitBlocks(incomingText),
      this.deps.editor.getLiveBlockIds()
    );
    for (const op of ops) {
      if (op.kind === "contained") this.deps.editor.applyContained(op);
      else this.deps.editor.applyStructural(op);
    }
    if (collisions.length > 0) this.deps.onCollisions(collisions, this.vcsPath);
    this.baseState = state;
    this.baseText = incomingText;
    this.deps.editor.rebase(incomingText);
    this.emitDirty();
  }

  dispose(): void {
    if (this.editTimer !== null) {
      this.clearTimer(this.editTimer);
      this.editTimer = null;
    }
    if (this.observationTimer !== null) {
      this.clearTimer(this.observationTimer);
      this.observationTimer = null;
    }
    void this.recordEdit(true).catch((error) => {
      if (this.vcsPath) this.deps.onSaveError?.(this.vcsPath, error);
    });
    this.disposed = true;
    this.offUserEdit?.();
    this.offUserEdit = null;
  }
}
