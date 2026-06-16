/**
 * DocController — the GAD-native document controller (plan section A + C).
 *
 * Replaces the old editorController + flush + 600ms disk poll + diskConflict
 * banner. One per open document. It owns, per path:
 *  - the loaded `baseStateHash` + the base canonical text it represents,
 *  - the live editor (Lexical) via the {@link CoEditEditor} contract,
 *  - debounced **commit** (quiescence): dirty blocks → `replace` hunks →
 *    one `vcs.applyEdits`; advance base to the returned stateHash. NEVER
 *    dispatches to the agent (decision 7: auto-save ≠ dispatch).
 *  - **remote reconcile**: `vcs.subscribeHead` → on advance, read the changed
 *    file, block-diff vs current, classify (contained / structural / colliding)
 *    and apply narrowly (decisions 3–4). Disk is a projection of head; the
 *    editor never reads or writes the filesystem.
 *
 * Pure orchestration over injected `editor` / `vcs` / `viewState` / `splitBlocks`
 * so it is unit-testable without Lexical or a live server.
 */

import { reconcileBlocks, type Block, type Collision } from "./blockReconcile.js";
import { buildCommitEdits, type ReplaceEditOp } from "./commitEdits.js";
import { liftLegacyViewState, type ViewStateStore } from "./viewState.js";

/** A single top-level editor block for reconciliation (registry view). */
export interface EditorBlock {
  id: string;
  signature: string;
  text: string;
}

/** A dirty block's base range + current text, for commit hunks. */
export interface DirtyCommit {
  /** Full serialization of the editor's current state. */
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
  /** Stable id (node key) to insert the new content before; null = append. */
  beforeId: string | null;
}

/** The contract the Lexical editor (with its block registry) must satisfy. */
export interface CoEditEditor {
  /** Full canonical serialization of the current state. */
  getCanonical(): string;
  /** Replace the whole document — load / migration only (never mid-edit). */
  setCanonical(markdown: string): void;
  /** Re-baseline the registry: `canonical` is the new committed base; clear
   *  dirty marks and recompute base ranges. */
  rebase(canonical: string): void;
  /** Current top-level blocks for reconciliation. */
  getBlocks(): EditorBlock[];
  /** Block ids the user is live in (dirty or active-caret). */
  getLiveBlockIds(): Set<string>;
  /** Current canonical + dirty blocks with base ranges, for commit. */
  getDirtyCommit(): DirtyCommit;
  /** Apply a contained single-node replace — tagged `historic` (no re-commit,
   *  no local undo entry). */
  applyContained(op: ContainedApply): void;
  /** Apply a structural bounded-range replace — tagged `historic`. */
  applyStructural(op: StructuralApply): void;
  /** Briefly highlight + attribute blocks to an actor (presence). */
  markAttribution(blockIds: string[], actor: { id: string; kind: string } | null): void;
  /** Fires on each local user edit (controller debounces). Returns unsubscribe. */
  onUserEdit(cb: () => void): () => void;
}

export interface HeadAdvance {
  head: string;
  stateHash: string;
  actor: { id: string; kind: string } | null;
  changedPaths: string[];
}

/** Minimal vcs surface the controller needs (structurally a subset of VcsClient). */
export interface DocVcs {
  readFile(
    ref: string,
    path: string
  ): Promise<{
    content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
    stateHash: string;
  } | null>;
  applyEdits(input: {
    baseStateHash?: string;
    edits: ReplaceEditOp[];
  }): Promise<{ stateHash: string; status: "clean" | "conflicted"; changedPaths: string[] }>;
  subscribeHead(head: string, onAdvance: (advance: HeadAdvance) => void): () => void;
}

export interface UndoSink {
  /** A local commit sealed a Lexical checkpoint; `stateHash` is revertable. */
  sealCommit(stateHash: string): void;
  /** A remote (agent) transition landed; `stateHash` is revertable + attributed. */
  recordRemote(stateHash: string, actor: { id: string; kind: string } | null): void;
}

export interface DocControllerDeps {
  editor: CoEditEditor;
  vcs: DocVcs;
  /** The vault's stable head (`ctx:vault-<hash>`). */
  vaultHead: string;
  viewState: ViewStateStore;
  /** Parse canonical markdown into reconciliation blocks (mdast-based). */
  splitBlocks: (markdown: string) => Block[];
  /** Surface live same-block collisions as SuggestionCards. */
  onCollisions: (collisions: Collision[], vcsPath: string) => void;
  /** A save 3-way-conflicted: the head now holds a parked pending merge with
   *  materialized conflict markers. The app routes this to the pending-merge
   *  resolution UX (do not treat the save as clean). */
  onConflict?: (vcsPath: string) => void;
  /** A save FAILED (notably a teardown/dispose-time flush that can't retry).
   *  The app should keep the path marked unsaved rather than silently clearing
   *  the dirty indicator. */
  onSaveError?: (vcsPath: string, error: unknown) => void;
  undo?: UndoSink;
  /** Debounce window for commit-on-quiescence (default 800ms). */
  quiescenceMs?: number;
  /** Schedule a debounced callback (injectable for tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DocController {
  private vcsPath: string | null = null;
  private baseStateHash: string | null = null;
  private baseText = "";
  /** The stateHash of our own last commit — skip it when it echoes back. */
  private lastSelfStateHash: string | null = null;
  /** Head advances the undo coordinator initiated (reverts): apply their
   *  content, but do not attribute or re-record them (echo guard, decision 8). */
  private readonly historicAdvances = new Set<string>();
  private commitTimer: unknown = null;
  private disposed = false;
  private offUserEdit: (() => void) | null = null;
  private offHead: (() => void) | null = null;

  // Fallback-rate metric (the rewrite's success bar).
  commitCount = 0;
  fallbackCount = 0;

  constructor(private readonly deps: DocControllerDeps) {}

  get fallbackRate(): number {
    return this.commitCount === 0 ? 0 : this.fallbackCount / this.commitCount;
  }

  /** Load a document: read at the caller's head, migrate legacy view-state,
   *  seed the editor. No `fs.readFile`. */
  async load(vcsPath: string): Promise<void> {
    this.vcsPath = vcsPath;
    const file = await this.deps.vcs.readFile("", vcsPath);
    const original = file && file.content.kind === "text" ? file.content.text : "";
    this.baseStateHash = file?.stateHash ?? null;

    const { viewState, canonical: stripped, migrated } = liftLegacyViewState(original);
    if (viewState) this.deps.viewState.seedIfAbsent(vcsPath, viewState);

    // `baseText` always mirrors what `baseStateHash` actually holds on the
    // server (the original bytes); the editor shows the migrated/stripped view.
    this.baseText = original;
    this.deps.editor.setCanonical(migrated ? stripped : original);
    this.offUserEdit = this.deps.editor.onUserEdit(() => this.scheduleCommit());
    this.offHead = this.deps.vcs.subscribeHead(this.deps.vaultHead, (advance) => {
      void this.onHeadAdvance(advance);
    });

    // One-time migration: a whole-doc strip commit (a real forward transition,
    // not counted against the co-edit fallback metric).
    if (migrated && this.baseStateHash != null) {
      const result = await this.deps.vcs.applyEdits({
        baseStateHash: this.baseStateHash,
        edits: [
          {
            kind: "replace",
            path: vcsPath,
            hunks: [{ start: 0, end: original.length, oldText: original, newText: stripped }],
          },
        ],
      });
      this.baseStateHash = result.stateHash;
      this.baseText = stripped;
      this.lastSelfStateHash = result.stateHash;
      this.deps.editor.rebase(stripped);
    }
  }

  private scheduleCommit(): void {
    if (this.disposed) return;
    const ms = this.deps.quiescenceMs ?? 800;
    const set = this.deps.setTimer ?? ((fn, d) => setTimeout(fn, d));
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.commitTimer != null) clear(this.commitTimer);
    this.commitTimer = set(() => {
      this.commitTimer = null;
      void this.commitNow();
    }, ms);
  }

  /** The undo coordinator calls this before issuing a `vcs.revert`, so the
   *  resulting head advance applies the reverted content WITHOUT recording it
   *  as a new (undoable) remote transition — preventing undo loops. */
  expectHistoric(stateHash: string): void {
    this.historicAdvances.add(stateHash);
  }

  /** Commit dirty blocks now (used by quiescence + Send-to-scribe flush-first). */
  async commitNow(): Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null> {
    if (this.disposed || this.vcsPath == null || this.baseStateHash == null) return null;
    const vcsPath = this.vcsPath;
    const { canonical, dirty } = this.deps.editor.getDirtyCommit();
    const built = buildCommitEdits({
      path: vcsPath,
      baseText: this.baseText,
      currentCanonical: canonical,
      dirtyBlocks: dirty,
    });
    if (!built.changed) return { stateHash: this.baseStateHash, changed: false };

    this.commitCount += 1;
    if (built.usedFallback) this.fallbackCount += 1;

    let result: { stateHash: string; status: "clean" | "conflicted"; changedPaths: string[] };
    try {
      result = await this.deps.vcs.applyEdits({
        baseStateHash: this.baseStateHash,
        edits: built.edits,
      });
    } catch (error) {
      // A parked pending merge on the head (e.g. a conflicted publish-pull
      // awaiting resolution) rejects per-doc edits. Don't crash the debounced
      // commit — surface the pending merge so the resolution UX takes over.
      if (error instanceof Error && /merge in progress/u.test(error.message)) {
        this.deps.onConflict?.(vcsPath);
        return null;
      }
      throw error;
    }
    if (result.status === "conflicted") {
      // A concurrent change conflicted with this save: the head now holds a
      // parked pending merge with conflict markers materialized. Do NOT advance
      // base/rebase as clean — that drops the markers and wedges the next save
      // with "merge in progress". Surface it to the pending-merge resolution UX.
      this.deps.onConflict?.(vcsPath);
      return { stateHash: result.stateHash, changed: true, conflicted: true };
    }
    // Advance our base + remember the hash so its head-advance echo is a no-op.
    this.baseStateHash = result.stateHash;
    this.baseText = canonical;
    this.lastSelfStateHash = result.stateHash;
    this.deps.editor.rebase(canonical);
    this.deps.undo?.sealCommit(result.stateHash);
    return { stateHash: result.stateHash, changed: true };
  }

  private async onHeadAdvance(advance: HeadAdvance): Promise<void> {
    if (this.disposed || this.vcsPath == null) return;
    if (advance.head !== this.deps.vaultHead) return;
    // Echo guard: our own commit coming back is not a remote edit.
    if (advance.stateHash === this.lastSelfStateHash) {
      this.lastSelfStateHash = null;
      return;
    }
    const isHistoric = this.historicAdvances.delete(advance.stateHash);
    if (!advance.changedPaths.includes(this.vcsPath)) return;

    const file = await this.deps.vcs.readFile("", this.vcsPath);
    if (!file || file.content.kind !== "text") return;
    const incomingText = file.content.text;

    const incoming = this.deps.splitBlocks(incomingText);
    const current = this.deps.editor.getBlocks();
    const live = this.deps.editor.getLiveBlockIds();
    // `reconcileBlocks` reads only id/signature/text from `current` (the source
    // ranges come from `incoming`); EditorBlock carries exactly those. Cast is
    // type-only — no runtime effect.
    const { ops, collisions } = reconcileBlocks(current as Block[], incoming, live);

    const appliedIds: string[] = [];
    for (const op of ops) {
      if (op.kind === "contained") {
        this.deps.editor.applyContained(op);
        appliedIds.push(op.oldId);
      } else {
        this.deps.editor.applyStructural(op);
        appliedIds.push(...op.oldIds);
      }
    }
    // A revert (historic) applies its content but is neither attributed to an
    // agent nor recorded as a new undoable transition (the coordinator owns it).
    if (appliedIds.length > 0 && !isHistoric) {
      this.deps.editor.markAttribution(appliedIds, advance.actor);
      this.deps.undo?.recordRemote(advance.stateHash, advance.actor);
    }
    if (collisions.length > 0) {
      this.deps.onCollisions(collisions, this.vcsPath);
    }

    // With no unresolved collisions the editor now equals head → re-baseline.
    // With collisions, the user's live blocks still diverge, so KEEP the base at
    // its pre-advance value: the next commitNow then sends against the stale base
    // and the server takes the 3-way diff3 merge path (surfacing/resolving the
    // conflict) instead of fast-forwarding the local block over the remote one.
    // (Applied non-colliding blocks re-emit as dirty and fold cleanly in diff3.)
    if (collisions.length === 0) {
      this.baseStateHash = file.stateHash;
      this.baseText = incomingText;
      this.deps.editor.rebase(incomingText);
    }
  }

  dispose(): void {
    // Flush a pending debounced commit before teardown — otherwise edits typed
    // within the quiescence window are silently dropped when the controller is
    // disposed on a file/vault switch (the editor state unmounts right after).
    const hadPending = this.commitTimer != null;
    if (this.commitTimer != null) {
      const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.commitTimer);
      this.commitTimer = null;
    }
    if (hadPending) {
      const vcsPath = this.vcsPath;
      // commitNow captures the dirty edits synchronously (getDirtyCommit +
      // buildCommitEdits) before its first await, so they are persisted even as
      // the editor unmounts; the post-await editor ops are swallowed. Must run
      // BEFORE `disposed` is set (commitNow no-ops once disposed).
      void this.commitNow().catch((err) => {
        // A failed teardown flush has no retry (the editor is unmounting), so
        // surface it instead of swallowing — the app keeps the path unsaved.
        if (vcsPath) this.deps.onSaveError?.(vcsPath, err);
      });
    }
    this.disposed = true;
    this.offUserEdit?.();
    this.offHead?.();
  }
}
