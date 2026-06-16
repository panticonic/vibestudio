import { describe, it, expect, beforeEach } from "vitest";
import {
  DocController,
  type CoEditEditor,
  type DocVcs,
  type DirtyCommit,
  type EditorBlock,
  type HeadAdvance,
  type ContainedApply,
  type StructuralApply,
} from "./docController.js";
import { applyReplaceHunks, type ReplaceEditOp } from "./commitEdits.js";
import { ViewStateStore, type ViewStateBackend } from "./viewState.js";
import type { Block } from "./blockReconcile.js";

const VAULT_HEAD = "ctx:vault-test";
const PATH = "projects/default/Doc.mdx";

/** Split a doc into blocks on blank lines (shared by editor + incoming). */
function splitOn(md: string, idPrefix: string): Block[] {
  const parts = md.split("\n\n");
  const out: Block[] = [];
  let pos = 0;
  parts.forEach((text, i) => {
    const start = pos;
    const end = pos + text.length;
    pos = end + 2;
    if (text.length) out.push({ id: `${idPrefix}${i}`, signature: text, text, start, end });
  });
  return out;
}

class FakeEditor implements CoEditEditor {
  canonical = "";
  liveIds = new Set<string>();
  private dirty: DirtyCommit["dirty"] = [];
  applied: Array<ContainedApply | StructuralApply> = [];
  attributions: Array<{ ids: string[]; actor: unknown }> = [];
  rebases: string[] = [];
  private cb: (() => void) | null = null;

  getCanonical(): string {
    return this.canonical;
  }
  setCanonical(md: string): void {
    this.canonical = md;
  }
  rebase(canonical: string): void {
    this.canonical = canonical;
    this.dirty = [];
    this.liveIds = new Set();
    this.rebases.push(canonical);
  }
  getBlocks(): EditorBlock[] {
    return splitOn(this.canonical, "b").map((b) => ({ id: b.id, signature: b.signature, text: b.text }));
  }
  getLiveBlockIds(): Set<string> {
    return this.liveIds;
  }
  getDirtyCommit(): DirtyCommit {
    return { canonical: this.canonical, dirty: this.dirty };
  }
  applyContained(op: ContainedApply): void {
    this.applied.push(op);
  }
  applyStructural(op: StructuralApply): void {
    this.applied.push(op);
  }
  markAttribution(blockIds: string[], actor: { id: string; kind: string } | null): void {
    this.attributions.push({ ids: blockIds, actor });
  }
  onUserEdit(cb: () => void): () => void {
    this.cb = cb;
    return () => {
      this.cb = null;
    };
  }
  /** Test helper: simulate a local user edit producing new canonical + dirty set. */
  userEdit(canonical: string, dirty: DirtyCommit["dirty"], live: string[] = []): void {
    this.canonical = canonical;
    this.dirty = dirty;
    this.liveIds = new Set(live);
    this.cb?.();
  }
}

class FakeVcs implements DocVcs {
  files = new Map<string, string>();
  private hashN = 0;
  stateHash = "state:0";
  applied: Array<{ baseStateHash?: string; edits: ReplaceEditOp[] }> = [];
  private cb: ((advance: HeadAdvance) => void) | null = null;

  async readFile(_ref: string, path: string) {
    const text = this.files.get(path);
    if (text == null) return null;
    return { content: { kind: "text" as const, text }, stateHash: this.stateHash };
  }
  async applyEdits(input: { baseStateHash?: string; edits: ReplaceEditOp[] }) {
    this.applied.push(input);
    for (const op of input.edits) {
      const cur = this.files.get(op.path) ?? "";
      this.files.set(op.path, applyReplaceHunks(cur, op.hunks));
    }
    this.stateHash = `state:s${++this.hashN}`;
    return { stateHash: this.stateHash, status: "clean" as const, changedPaths: input.edits.map((e) => e.path) };
  }
  subscribeHead(_head: string, onAdvance: (advance: HeadAdvance) => void): () => void {
    this.cb = onAdvance;
    return () => {
      this.cb = null;
    };
  }
  /** Test helper: a remote actor advanced the head, changing `path`. */
  remoteAdvance(path: string, newContent: string, actor: { id: string; kind: string }): void {
    this.files.set(path, newContent);
    this.stateHash = `state:r${++this.hashN}`;
    this.cb?.({ head: VAULT_HEAD, stateHash: this.stateHash, actor, changedPaths: [path] });
  }
  /** Echo a specific stateHash back as an advance (own-commit echo). */
  echo(path: string, stateHash: string): void {
    this.cb?.({ head: VAULT_HEAD, stateHash, actor: { id: "panel", kind: "panel" }, changedPaths: [path] });
  }
}

function mapBackend(): ViewStateBackend {
  const store = new Map<string, string>();
  return {
    read: (k) => store.get(k) ?? null,
    write: (k, v) => void store.set(k, v),
    remove: (k) => void store.delete(k),
  };
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function makeController(extra?: Partial<{ collisions: Array<{ collisions: unknown; path: string }> }>) {
  const editor = new FakeEditor();
  const vcs = new FakeVcs();
  const viewState = new ViewStateStore(mapBackend());
  const collisions: Array<{ collisions: unknown; path: string }> = extra?.collisions ?? [];
  const controller = new DocController({
    editor,
    vcs,
    vaultHead: VAULT_HEAD,
    viewState,
    splitBlocks: (md) => splitOn(md, "i"),
    onCollisions: (c, p) => collisions.push({ collisions: c, path: p }),
    setTimer: (fn) => {
      fn();
      return 1;
    },
    clearTimer: () => {},
  });
  return { editor, vcs, viewState, controller, collisions };
}

describe("DocController", () => {
  let h: ReturnType<typeof makeController>;
  beforeEach(() => {
    h = makeController();
  });

  it("loads content from vcs (no fs) and seeds the editor", async () => {
    h.vcs.files.set(PATH, "# Title\n\nbody");
    await h.controller.load(PATH);
    expect(h.editor.canonical).toBe("# Title\n\nbody");
  });

  it("migrates legacy state: frontmatter into the sidecar and strips canonical", async () => {
    h.vcs.files.set(PATH, "---\ntitle: D\nstate:\n  count: 9\n---\n\nbody\n");
    await h.controller.load(PATH);
    await flush();
    // Sidecar seeded.
    expect(h.viewState.get(PATH, "count", 0)).toBe(9);
    // Canonical lost `state:` and a one-time strip commit fired.
    expect(h.editor.canonical).not.toContain("state:");
    expect(h.vcs.applied.length).toBe(1);
    expect(h.vcs.files.get(PATH)).not.toContain("state:");
  });

  it("commits dirty blocks as surgical hunks (no fallback) and advances base", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B\n\nCCC", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();
    expect(h.vcs.applied.length).toBe(1);
    expect(h.vcs.applied[0]!.edits[0]!.hunks).toEqual([
      { start: 5, end: 8, oldText: "BBB", newText: "B2B" },
    ]);
    expect(h.controller.fallbackRate).toBe(0);
    expect(h.vcs.files.get(PATH)).toBe("AAA\n\nB2B\n\nCCC");
  });

  it("does not commit when nothing changed (auto-save ≠ churn)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nBBB", [], []); // no actual change
    await flush();
    expect(h.vcs.applied.length).toBe(0);
  });

  it("ignores the echo of its own commit (no reconcile)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB");
    await h.controller.load(PATH);
    h.editor.userEdit("AAA\n\nB2B", [{ baseStart: 5, baseEnd: 8, newText: "B2B" }], ["b1"]);
    await flush();
    const selfHash = h.vcs.stateHash;
    h.vcs.echo(PATH, selfHash);
    await flush();
    expect(h.editor.applied).toEqual([]); // echo was not treated as a remote edit
  });

  it("reconciles a non-colliding remote edit surgically (contained, attributed)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    h.vcs.remoteAdvance(PATH, "AAA\n\nB2B\n\nCCC", { id: "scribe", kind: "agent" });
    await flush();
    expect(h.editor.applied).toEqual([
      { kind: "contained", oldId: "b1", oldIndex: 1, newText: "B2B" },
    ]);
    expect(h.editor.attributions[0]).toMatchObject({ ids: ["b1"], actor: { kind: "agent" } });
    expect(h.collisions).toEqual([]);
  });

  it("routes a remote edit that collides with a live block to SuggestionCards (no apply)", async () => {
    h.vcs.files.set(PATH, "AAA\n\nBBB\n\nCCC");
    await h.controller.load(PATH);
    // User is live in the middle block (b1).
    h.editor.userEdit("AAA\n\nBBB\n\nCCC", [], ["b1"]);
    h.vcs.remoteAdvance(PATH, "AAA\n\nB2B\n\nCCC", { id: "scribe", kind: "agent" });
    await flush();
    expect(h.editor.applied).toEqual([]);
    expect(h.collisions).toHaveLength(1);
    expect(h.collisions[0]!.path).toBe(PATH);
  });
});
