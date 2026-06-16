/**
 * MdxEditorCore — the {@link CoEditEditor} implementation over a raw Lexical
 * editor + the vendored `@workspace/mdx-editor-core` pipeline.
 *
 * This is the node-surgery layer the rewrite is built on. It owns the editor
 * instance directly (no foreign abstraction), so:
 *  - **agent edits apply narrowly**: a contained change replaces a single
 *    top-level node; a structural change replaces a bounded run — never a
 *    whole-doc `setMarkdown` (which would reset embedded component state).
 *  - **block registry**: top-level mdast nodes ↔ their exact source ranges (via
 *    `splitMdxBlocks`), giving commit hunks + reconciliation block identity.
 *  - **historic tag + echo guard**: every programmatic apply (load, remote
 *    reconcile, revert) is tagged `HISTORIC_TAG`, so it is excluded from the
 *    local undo stack and is not mistaken for a user edit (no re-commit loop).
 *
 * Works headless (Lexical `createEditor`) — so the registry + surgery are
 * unit-testable — and with `@lexical/react`'s composer in the panel.
 */

import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  importMarkdownToLexical,
  importMdastTreeToLexical,
  exportMarkdownFromLexical,
} from "@workspace/mdx-editor-core";
import { fromMarkdown } from "mdast-util-from-markdown";

import { buildMdxConfig, type BuiltMdxConfig, type MdxConfigOptions } from "./mdxConfig.js";
import { splitMdxBlocks } from "./parseBlocks.js";
import { reconcileBlocks, type Block } from "../coedit/blockReconcile.js";
import type {
  CoEditEditor,
  ContainedApply,
  DirtyCommit,
  EditorBlock,
  StructuralApply,
} from "../coedit/docController.js";

/** Lexical update tag marking programmatic (non-user) applies. */
export const HISTORIC_TAG = "spectrolite-historic";

const NO_LIVE = new Set<string>();

/** A counting multiset of block signatures (dirty detection). */
function multiset(values: string[]): { take(value: string): boolean } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return {
    take(value: string): boolean {
      const n = counts.get(value) ?? 0;
      if (n <= 0) return false;
      counts.set(value, n - 1);
      return true;
    },
  };
}

function isEmptyTopLevel(node: LexicalNode): boolean {
  return node.getType() === "paragraph" && (node as ElementNode).getChildrenSize() === 0;
}

export class MdxEditorCore implements CoEditEditor {
  private baseCanonical = "";
  private baseBlocks: Block[] = [];
  private attributionSink: ((blockIds: string[], actor: { id: string; kind: string } | null) => void) | null =
    null;

  constructor(
    readonly editor: LexicalEditor,
    private readonly config: BuiltMdxConfig
  ) {}

  private descriptors() {
    return {
      jsxComponentDescriptors: this.config.jsxComponentDescriptors,
      codeBlockEditorDescriptors: this.config.codeBlockEditorDescriptors,
      directiveDescriptors: [],
    };
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  getCanonical(): string {
    return this.editor.getEditorState().read(() =>
      exportMarkdownFromLexical({
        root: $getRoot(),
        visitors: this.config.assembled.exportVisitors,
        toMarkdownExtensions: this.config.assembled.toMarkdownExtensions,
        // The impl defaults this to `{}`, but the option is typed required.
        toMarkdownOptions: {},
        jsxComponentDescriptors: this.config.jsxComponentDescriptors,
        jsxIsAvailable: true,
      })
    );
  }

  setCanonical(markdown: string): void {
    this.editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        importMarkdownToLexical({
          root,
          markdown,
          visitors: this.config.assembled.importVisitors,
          syntaxExtensions: this.config.assembled.syntaxExtensions,
          mdastExtensions: this.config.assembled.mdastExtensions,
          ...this.descriptors(),
        });
      },
      { discrete: true, tag: HISTORIC_TAG }
    );
    this.rebase(this.getCanonical());
  }

  rebase(canonical: string): void {
    this.baseCanonical = canonical;
    this.baseBlocks = splitMdxBlocks(canonical, "base");
  }

  // -------------------------------------------------------------------------
  // Block registry
  // -------------------------------------------------------------------------

  /** Top-level content blocks (source-split) with stable node-key ids. */
  private contentBlocks(): { blocks: Block[]; canonical: string } {
    const canonical = this.getCanonical();
    const blocks = splitMdxBlocks(canonical, "cur");
    const keys = this.topLevelKeys();
    // Source blocks and non-empty top-level nodes are in the same order; when
    // they line up 1:1, adopt the node keys as stable block ids (so apply ops
    // can resolve nodes by key). Otherwise keep the synthetic ids — alignment
    // is by signature, so reconciliation still works.
    if (keys.length === blocks.length) {
      blocks.forEach((block, i) => {
        block.id = keys[i]!;
      });
    }
    return { blocks, canonical };
  }

  private topLevelKeys(): string[] {
    return this.editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .filter((node) => !isEmptyTopLevel(node))
        .map((node) => node.getKey())
    );
  }

  getBlocks(): EditorBlock[] {
    return this.contentBlocks().blocks.map((b) => ({ id: b.id, signature: b.signature, text: b.text }));
  }

  getLiveBlockIds(): Set<string> {
    const { blocks } = this.contentBlocks();
    const baseSigs = multiset(this.baseBlocks.map((b) => b.signature));
    const live = new Set<string>();
    // Dirty: a current block whose signature isn't accounted for in the base.
    for (const block of blocks) {
      if (!baseSigs.take(block.signature)) live.add(block.id);
    }
    // Active-caret block (live even if unchanged).
    const caret = this.activeTopLevelKey();
    if (caret) live.add(caret);
    return live;
  }

  private activeTopLevelKey(): string | null {
    return this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return null;
      const top = selection.anchor.getNode().getTopLevelElement();
      return top ? top.getKey() : null;
    });
  }

  getDirtyCommit(): DirtyCommit {
    const { blocks, canonical } = this.contentBlocks();
    const dirty: DirtyCommit["dirty"] = [];
    // Reuse the block classifier in the commit direction (base → current).
    const recon = reconcileBlocks(this.baseBlocks, blocks, NO_LIVE);
    for (const op of recon.ops) {
      if (op.kind === "contained") {
        const base = this.baseBlocks[op.oldIndex];
        if (base) dirty.push({ baseStart: base.start, baseEnd: base.end, newText: op.newText });
      }
      // Structural local edits omit surgical hunks → whole-doc fallback commit.
    }
    return { canonical, dirty };
  }

  // -------------------------------------------------------------------------
  // Narrow apply (node surgery) — all tagged HISTORIC
  // -------------------------------------------------------------------------

  applyContained(op: ContainedApply): void {
    this.editor.update(
      () => {
        const target = op.oldId
          ? $getNodeByKey(op.oldId)
          : this.nodeAtContentIndex(op.oldIndex);
        if (!target) return;
        const fresh = this.importFragment(op.newText);
        for (const node of fresh) target.insertBefore(node);
        target.remove();
      },
      { discrete: true, tag: HISTORIC_TAG }
    );
  }

  applyStructural(op: StructuralApply): void {
    this.editor.update(
      () => {
        const targets = op.oldIds
          .map((id) => $getNodeByKey(id))
          .filter((node): node is LexicalNode => node != null);
        const anchor = op.beforeId ? $getNodeByKey(op.beforeId) : null;
        const fresh = op.newTexts.length ? this.importFragment(op.newTexts.join("\n\n")) : [];
        for (const node of fresh) {
          if (anchor && anchor.isAttached()) anchor.insertBefore(node);
          else $getRoot().append(node);
        }
        for (const target of targets) target.remove();
      },
      { discrete: true, tag: HISTORIC_TAG }
    );
  }

  /** Import a markdown fragment (no trailing-paragraph affordance), returning
   *  the newly-appended top-level nodes. Caller relocates them. */
  private importFragment(markdown: string): LexicalNode[] {
    const root = $getRoot();
    const before = root.getChildrenSize();
    const mdastRoot = fromMarkdown(markdown, {
      extensions: this.config.assembled.syntaxExtensions,
      mdastExtensions: this.config.assembled.mdastExtensions,
    });
    importMdastTreeToLexical({
      root,
      mdastRoot,
      visitors: this.config.assembled.importVisitors,
      ...this.descriptors(),
    });
    return root.getChildren().slice(before);
  }

  private nodeAtContentIndex(index: number): LexicalNode | null {
    return this.editor.getEditorState().read(() => {
      const blocks = $getRoot()
        .getChildren()
        .filter((node) => !isEmptyTopLevel(node));
      return blocks[index] ?? null;
    });
  }

  // -------------------------------------------------------------------------
  // Presence + user-edit subscription
  // -------------------------------------------------------------------------

  setAttributionSink(
    fn: (blockIds: string[], actor: { id: string; kind: string } | null) => void
  ): void {
    this.attributionSink = fn;
  }

  markAttribution(blockIds: string[], actor: { id: string; kind: string } | null): void {
    this.attributionSink?.(blockIds, actor);
  }

  onUserEdit(cb: () => void): () => void {
    return this.editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
      // Programmatic applies (load / remote reconcile / revert) are HISTORIC —
      // never a user edit, so they must not schedule a commit.
      if (tags.has(HISTORIC_TAG)) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      cb();
    });
  }
}

/** Create a headless editor core (tests, and the import/export engine). */
export function createMdxEditorCore(opts: MdxConfigOptions = {}): MdxEditorCore {
  const config = buildMdxConfig(opts);
  const editor = createEditor({
    namespace: "spectrolite",
    nodes: config.assembled.lexicalNodes,
    onError: (error) => {
      throw error;
    },
  });
  return new MdxEditorCore(editor, config);
}
