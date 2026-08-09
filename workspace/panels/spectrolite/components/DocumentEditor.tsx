/**
 * Document editor host — the GAD-native co-editing surface.
 *
 * Renders a single {@link MdxLexicalEditor} (raw Lexical + the vendored MDX
 * pipeline). On ready it builds the per-document {@link DocController}
 * (working-state autosave + narrow remote reconcile) and the {@link UndoCoordinator}
 * (one ⌘Z stack over Lexical-native undo + GAD revert), then `load`s the doc
 * from the vault's exact semantic working state via `vcs`. A bounded semantic
 * watcher observes other authors, and navigation explicitly flushes local work.
 *
 * Per-JSX-node live render goes through {@link LiveJsxEditor}; component
 * view-state (`useDocState`) is private and lives in the panel-local
 * {@link ViewStateStore}, keyed by the doc's vcs path. When the scribe lands a
 * change, the affected blocks briefly highlight via the attribution sink.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Callout, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ReloadIcon } from "@radix-ui/react-icons";
import { $getNodeByKey, $getRoot, type LexicalNode } from "lexical";
import { fromMarkdown } from "mdast-util-from-markdown";
import { importMdastTreeToLexical } from "@workspace/mdx-editor-core";
import { buildMdxConfig, type BuiltMdxConfig } from "../editor/mdxConfig";
import { MdxLexicalEditor, type LexicalUndoHandle } from "../editor/MdxLexicalEditor";
import type { MdxEditorCore } from "../editor/mdxEditorCore";
import { splitMdxBlocks } from "../editor/parseBlocks";
import { DocController, type DocVcs } from "../coedit/docController";
import { UndoCoordinator } from "../coedit/undoCoordinator";
import { knownJsxDescriptors } from "../mdx/runtime";
import { DocModuleSourceContext, LiveJsxEditor } from "../mdx/LiveJsxEditor";
import { DocStateContext, useDocState } from "../mdx/docState";
import { DepsContext, runtimeNamespace } from "../mdx/runtimeNamespace";
import { useApp } from "../app/context";
import type { JsxComponentDescriptor, JsxEditorProps } from "@workspace/mdx-editor-core";

export interface DocumentEditorProps {
  /** Vault-relative path of the open document, e.g. `notes/E2E.mdx`. */
  relPath: string;
  theme: "light" | "dark";
  /** Frontmatter-declared dependencies; threaded into inline JSX + eval. */
  dependencies: Record<string, string>;
}

/** A canonical-derived recompute is debounced — full serialization isn't free. */
const RECOMPUTE_MS = 350;
export function DocumentEditor({
  relPath,
  theme,
  dependencies,
}: DocumentEditorProps) {
  const app = useApp();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [moduleSource, setModuleSource] = useState("");
  const [documentIssue, setDocumentIssue] = useState<{
    reason: "missing" | "unreadable";
    message: string;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);

  const vcsPath = useMemo(() => app.vault.mapping().toVcsPath(relPath), [app, relPath]);

  const coreRef = useRef<MdxEditorCore | null>(null);
  const controllerRef = useRef<DocController | null>(null);
  const undoRef = useRef<UndoCoordinator | null>(null);

  // Build the editor config once: known descriptors get an incremental live JSX
  // editor with frontmatter dependencies and the document's preserved ESM scope.
  // The wildcard `"*"` descriptor gets the same editor.
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;

  const config = useMemo<BuiltMdxConfig>(() => {
    const JsxEditor = (props: JsxEditorProps) => (
      <LiveJsxEditor {...props} dependencies={dependenciesRef.current} />
    );
    const descriptors: JsxComponentDescriptor[] = knownJsxDescriptors().map((d) => ({
      ...d,
      Editor: JsxEditor,
    }));
    return buildMdxConfig({ jsxComponentDescriptors: descriptors });
    // Built once per mounted document — the editor inputs (deps, exports) are
    // read through refs so the live editor never tears down mid-edit.
  }, []);

  // Set up the controller once the core is ready, then load the document. The
  // `relPath` is part of the key (see EditorPane), so a new doc remounts.
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      undoRef.current = null;
      coreRef.current = null;
      app.registerSuggestionApplier(null);
      app.registerCommitActiveDoc(null);
      app.registerFlushActiveDoc(null);
      app.registerReloadActiveDoc(null);
      app.setDirty(relPath, false);
    };
  }, [app, relPath]);

  // Pull canonical once and update the cheap derived state. Dirtiness now means
  // "working copy diverges from the last recorded base" (the controller's view) —
  // not "has a live block", since typing records tracked working edits rather
  // than commits.
  const recompute = useMemo(
    () => (core: MdxEditorCore) => {
      const canonical = core.getCanonical();
      app.setActiveDocSource(relPath, canonical);
      try {
        const tree = fromMarkdown(canonical, {
          extensions: config.assembled.syntaxExtensions,
          mdastExtensions: config.assembled.mdastExtensions,
        });
        setModuleSource(
          tree.children
            .filter((node) => node.type === "mdxjsEsm")
            .map((node) => node.value)
            .join("\n\n")
        );
        const controller = controllerRef.current;
        app.setDirty(relPath, controller ? controller.isDirty() : core.getLiveBlockIds().size > 0);
        setSaveIssue(null);
      } catch (nextError) {
        app.setDirty(relPath, true);
        setSaveIssue(
          `The MDX source is invalid and has not been saved: ${nextError instanceof Error ? nextError.message : String(nextError)}`
        );
      }
    },
    [app, relPath]
  );

  const onReady = useMemo(
    () => (core: MdxEditorCore, lexicalUndo: LexicalUndoHandle) => {
      coreRef.current = core;
      const semanticVcs = app.semanticVcs;
      if (!semanticVcs) {
        setError("This vault is not bound to a writable VCS context");
        return;
      }
      const docVcs: DocVcs = semanticVcs;

      const undo = new UndoCoordinator({
        lexical: lexicalUndo,
        revert: async (changeIds) => {
          const result = await semanticVcs.revert(changeIds);
          controllerRef.current?.noteAuthoredChanges(result.changeIds);
          return { changeIds: result.changeIds };
        },
      });
      undoRef.current = undo;

      const controller = new DocController({
        editor: core,
        vcs: docVcs,
        splitBlocks: (markdown) => splitMdxBlocks(markdown),
        onCollisions: (collisions, path) => app.pushCollisions(collisions, path),
        onSaveError: (path, err) => {
          // A working-edit record (or teardown flush) failed and can't retry —
          // keep the path marked unsaved (the edit may not be durable).
          const rel = app.vault.mapping().toVaultRelPath(path);
          app.setDirty(rel ?? path, true);
          setSaveIssue(
            `This note is not saved: ${err instanceof Error ? err.message : String(err)}`
          );
          console.warn("[spectrolite] working edit failed:", path, err);
        },
        // Working-copy dirtiness changed (working edit / commit / remote apply) —
        // mirror it into the store so the file index dot + PublishBar reflect it.
        onDirtyChange: (path, dirty) => {
          const rel = app.vault.mapping().toVaultRelPath(path);
          if (rel) app.setDirty(rel, dirty);
        },
        onWorkingStateChange: async (path, reason) => {
          await app.workingStateChanged(path, reason);
          if (reason !== "observed") setSaveIssue(null);
        },
        onUnavailable: (_path, reason, issue) => {
          setDocumentIssue({
            reason,
            message:
              reason === "missing"
                ? "This note was deleted from the semantic working state. Your visible editor is still the only copy."
                : `This note cannot currently be read${issue ? `: ${issue instanceof Error ? issue.message : String(issue)}` : "."}`,
          });
        },
        onAvailabilityRestored: () => setDocumentIssue(null),
        undo,
      });
      controllerRef.current = controller;
      // The deliberate commit (Publish / Send-to-scribe) — carries a message.
      app.registerCommitActiveDoc((message) => controller.commitNow(message));
      app.registerFlushActiveDoc(() => controller.flushNow());
      // Re-read after semantic Sync advances the context to a new exact state.
      app.registerReloadActiveDoc(() => controller.load(vcsPath));

      // A user-chosen collision resolution: replace the live blocks with the
      // resolved text as a NORMAL user edit (no historic tag) so the
      // DocController records it like any other keystroke.
      app.registerSuggestionApplier((resolution) => {
        core.editor.update(() => {
          const targets = resolution.oldIds
            .map((id) => $getNodeByKey(id))
            .filter((node): node is LexicalNode => node != null);
          const anchor = resolution.beforeId ? $getNodeByKey(resolution.beforeId) : null;
          const root = $getRoot();
          const before = root.getChildrenSize();
          const tree = fromMarkdown(resolution.text, {
            extensions: config.assembled.syntaxExtensions,
            mdastExtensions: config.assembled.mdastExtensions,
          });
          importMdastTreeToLexical({
            root,
            mdastRoot: tree,
            visitors: config.assembled.importVisitors,
            jsxComponentDescriptors: config.jsxComponentDescriptors,
            codeBlockEditorDescriptors: config.codeBlockEditorDescriptors,
            directiveDescriptors: [],
          });
          const fresh = root.getChildren().slice(before);
          for (const node of fresh) {
            if (anchor && anchor.isAttached()) anchor.insertBefore(node);
            // else: leave the freshly-appended node at the end (append path).
          }
          for (const target of targets) target.remove();
        });
      });

      void controller
        .load(vcsPath)
        .then(() => {
          setReady(true);
          recompute(core);
        })
        .catch((err) => {
          console.warn(`[Spectrolite] failed to load ${vcsPath}:`, err);
          setError(err instanceof Error ? err.message : String(err));
        });

      // Recompute canonical-derived state (dirty flag, deps, export names) on a
      // debounce after each editor change (user OR remote apply).
      let timer: ReturnType<typeof setTimeout> | null = null;
      core.editor.registerUpdateListener(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          recompute(core);
        }, RECOMPUTE_MS);
      });
    },
    [app, vcsPath, recompute]
  );

  // ⌘Z / ⇧⌘Z drive the two-tier undo coordinator.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const coordinator = undoRef.current;
      if (!coordinator) return;
      event.preventDefault();
      if (event.shiftKey) void coordinator.redo();
      else void coordinator.undo();
    };
    const root = containerRef.current;
    root?.addEventListener("keydown", onKeyDown);
    return () => root?.removeEventListener("keydown", onKeyDown);
  }, [ready]);

  const docStateValue = useMemo(() => ({ store: app.viewState, path: vcsPath }), [app, vcsPath]);

  const recoverDocument = async () => {
    const core = coreRef.current;
    const controller = controllerRef.current;
    const semanticVcs = app.semanticVcs;
    if (!core || !controller || !semanticVcs) return;
    setRecovering(true);
    try {
      if (documentIssue?.reason === "missing") {
        const recreated = await semanticVcs.createFile(vcsPath, core.getCanonical());
        controller.noteLocalChanges(recreated.changeIds);
        await app.workingStateChanged(vcsPath, "local-edit");
      }
      await controller.load(vcsPath);
      setDocumentIssue(null);
      recompute(core);
    } catch (nextError) {
      setDocumentIssue({
        reason: documentIssue?.reason ?? "unreadable",
        message: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setRecovering(false);
    }
  };

  if (error) {
    return (
      <Flex direction="column" gap="2" p="3">
        <Text color="red" size="2">
          Could not open {relPath}: {error}
        </Text>
      </Flex>
    );
  }

  return (
    <DocStateContext.Provider value={docStateValue}>
      <DepsContext.Provider value={dependencies}>
        <DocModuleSourceContext.Provider value={moduleSource}>
          <Flex
            direction="column"
            className={`spectrolite-mdx ${theme === "dark" ? "dark-theme" : ""}`}
            style={{ height: "100%" }}
          >
          <Box
            ref={containerRef}
            data-testid="spectrolite-editor"
            style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
          >
            <MdxLexicalEditor
              config={config}
              onReady={onReady}
              ariaLabel={relPath}
              className={`spectrolite-content ${theme === "dark" ? "spectrolite-content--dark" : ""}`}
            />
            {documentIssue ? (
              <Callout.Root
                color="amber"
                data-testid={
                  documentIssue.reason === "missing"
                    ? "spectrolite-file-missing"
                    : "spectrolite-document-unreadable"
                }
                style={{ position: "sticky", left: 12, right: 12, bottom: 12, zIndex: 30 }}
              >
                <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
                <Callout.Text>
                  <Flex direction="column" gap="2">
                    <Text size="2">{documentIssue.message}</Text>
                    <Button
                      size="1"
                      color="amber"
                      disabled={recovering}
                      onClick={() => void recoverDocument()}
                    >
                      <ReloadIcon />
                      {documentIssue.reason === "missing" ? "Recreate from editor" : "Retry read"}
                    </Button>
                  </Flex>
                </Callout.Text>
              </Callout.Root>
            ) : null}
            {saveIssue ? (
              <Callout.Root
                color="red"
                role="alert"
                data-testid="spectrolite-save-error"
                style={{ position: "sticky", left: 12, right: 12, bottom: 12, zIndex: 31 }}
              >
                <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
                <Callout.Text>{saveIssue}</Callout.Text>
              </Callout.Root>
            ) : null}
            {!ready ? (
              <Flex
                align="center"
                justify="center"
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              >
                <Text size="2" color="gray">
                  Loading {relPath}…
                </Text>
              </Flex>
            ) : null}
          </Box>
          </Flex>
        </DocModuleSourceContext.Provider>
      </DepsContext.Provider>
    </DocStateContext.Provider>
  );
}

// `runtimeNamespace` + `useDocState` are exposed to sandboxed inline JSX via
// globalThis backdoors (the sandbox can't import panel-local modules). They use
// React context, so they bind to the providers above. Installed once.
const g = globalThis as Record<string, unknown>;
g["__spectroliteUseDocState__"] = useDocState;
g["__spectroliteRuntime__"] = runtimeNamespace;
g["__spectroliteUseIsMobile__"] = runtimeNamespace["useIsMobile"];
g["__spectroliteUseTouchDevice__"] = runtimeNamespace["useTouchDevice"];
g["__spectroliteUseViewportHeight__"] = runtimeNamespace["useViewportHeight"];
