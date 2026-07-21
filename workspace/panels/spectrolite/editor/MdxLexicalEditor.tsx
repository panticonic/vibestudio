/**
 * MdxLexicalEditor — the thin React shell over {@link MdxEditorCore}.
 *
 * We own the `LexicalComposer`/editor instance directly (decision B): a single
 * WYSIWYG editor on raw Lexical + the vendored MDX pipeline, no `@mdxeditor/editor`
 * realm/toolbar. Native cross-block selection is preserved (one editor, not N
 * block editors); editing one block re-renders only that block (Lexical's
 * incremental reconciler) — embedded component state in other blocks is never
 * reset.
 *
 * The shell mounts the composer, hands a ready {@link MdxEditorCore} (bound to
 * the live editor) up to the controller, and wires Lexical-native history as
 * tier 1 of the two-tier undo (the {@link UndoCoordinator} drives ⌘Z).
 */

import { useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import { DescriptorProvider, type JsxComponentDescriptor } from "@workspace/mdx-editor-core";

import { FrontmatterEditor } from "../components/FrontmatterEditor.js";
import { MdxEditorCore } from "./mdxEditorCore.js";
import type { BuiltMdxConfig } from "./mdxConfig.js";
import type { LexicalUndo } from "../coedit/undoCoordinator.js";

/** A Lexical-native undo adapter (tier 1 of the two-tier undo). */
export interface LexicalUndoHandle extends LexicalUndo {}

export interface MdxLexicalEditorProps {
  config: BuiltMdxConfig;
  /** Called once the editor is mounted, with the core + the tier-1 undo handle. */
  onReady: (core: MdxEditorCore, undo: LexicalUndoHandle) => void;
  className?: string;
  ariaLabel?: string;
  readOnly?: boolean;
}

function EditorBridge({
  config,
  onReady,
}: {
  config: BuiltMdxConfig;
  onReady: MdxLexicalEditorProps["onReady"];
}): null {
  const [editor] = useLexicalComposerContext();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const core = new MdxEditorCore(editor, config);

    // Track Lexical's own undo/redo availability (tier 1).
    let canUndo = false;
    let canRedo = false;
    const offCanUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (payload) => {
        canUndo = payload;
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    const offCanRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (payload) => {
        canRedo = payload;
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    const undoHandle: LexicalUndoHandle = {
      canUndo: () => canUndo,
      canRedo: () => canRedo,
      undo: () => editor.dispatchCommand(UNDO_COMMAND, undefined),
      redo: () => editor.dispatchCommand(REDO_COMMAND, undefined),
    };

    onReady(core, undoHandle);
    return () => {
      offCanUndo();
      offCanRedo();
    };
  }, [editor, config, onReady]);
  return null;
}

export function MdxLexicalEditor({
  config,
  onReady,
  className,
  ariaLabel = "Document",
  readOnly = false,
}: MdxLexicalEditorProps): JSX.Element {
  const initialConfig = useMemo(
    () => ({
      namespace: "spectrolite",
      nodes: config.assembled.lexicalNodes,
      editable: !readOnly,
      onError: (error: Error) => {
        console.error("[spectrolite/lexical]", error);
      },
      theme: {},
    }),
    [config, readOnly]
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <DescriptorProvider
        value={{
          jsxComponentDescriptors: config.jsxComponentDescriptors as JsxComponentDescriptor[],
          codeBlockLanguages: {},
          defaultCodeBlockLanguage: "tsx",
          frontmatterEditor: FrontmatterEditor,
        }}
      >
        <RichTextPlugin
          contentEditable={<ContentEditable className={className} aria-label={ariaLabel} />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        {/* Lexical-native history = tier 1 of the two-tier undo. */}
        <HistoryPlugin />
        <EditorBridge config={config} onReady={onReady} />
      </DescriptorProvider>
    </LexicalComposer>
  );
}
