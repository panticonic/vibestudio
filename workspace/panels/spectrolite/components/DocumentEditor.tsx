/**
 * Live MDX editor host.
 *
 * Wraps `@mdxeditor/editor`'s `MDXEditor` with our plugin set:
 *   - `headingsPlugin`, `listsPlugin`, `quotePlugin`, `thematicBreakPlugin`
 *   - `linkPlugin` + `linkDialogPlugin`
 *   - `codeBlockPlugin` + `codeMirrorPlugin` for fenced code
 *   - `diffSourcePlugin` — toggle between WYSIWYG and raw source (= the
 *     whole-doc "break open" escape hatch)
 *   - `jsxPlugin` + `LiveJsxEditor` — per-component live render via
 *     `compileComponent`, falls back to GenericJsxEditor on errors via the
 *     LiveJsxEditor itself
 *   - `frontmatterPlugin` so `---` YAML at the top is preserved
 *   - `toolbarPlugin` with the diff/source toggle button
 *
 * Wikilink bridge: on read, `[[Page]]` becomes `<WikiLink target="Page" />`;
 * on flush (Workspace.tsx calls writeBufferToDisk), JSX wikilinks become
 * `[[Page]]` again. This keeps the on-disk format Obsidian-compatible
 * while letting MDXEditor render wikilinks as proper JSX with our
 * `WikiLink` component.
 *
 * Mention autocomplete: `MentionAutocomplete` attaches a DOM keydown
 * listener to the editor's contenteditable root, opens a popover on `@`,
 * and inserts the chosen handle as plain text via execCommand. Lexical
 * observes the contenteditable mutations and updates its state.
 *
 * Owns:
 *   - reading the file on open (and applying wikilink read-transform)
 *   - propagating in-memory edits to disk on flush
 *   - notifying parent of dirty state for the flush controller
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Flex, SegmentedControl, Text } from "@radix-ui/themes";
import { LightningBoltIcon, ReloadIcon, EyeOpenIcon, Pencil1Icon } from "@radix-ui/react-icons";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  jsxPlugin,
  toolbarPlugin,
  DiffSourceToggleWrapper,
  UndoRedo,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  ListsToggle,
  BlockTypeSelect,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { PreviewPane } from "./PreviewPane";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";
import { knownJsxDescriptors } from "../mdx/runtime";
import { LiveJsxEditor } from "../mdx/LiveJsxEditor";
import { wikilinksFromJsx, wikilinksToJsx } from "../mdx/wikilink";
import { DocStateContext, type DocStateContextValue, useDocState } from "../mdx/docState";
import { parseFrontmatter, replaceFrontmatterState } from "../mdx/frontmatter";
import { joinSafe, parentDir } from "../state/safePath";

export interface DocumentEditorProps {
  repoRoot: string;
  relPath: string;
  theme: "light" | "dark";
  onChange: (path: string, markdown: string) => void;
  onReload: (path: string, markdown: string) => void;
  onFlushClick: (path: string) => void;
  hasUnflushedChanges: boolean;
  /** Mention candidates from the channel roster. */
  mentionCandidates: MentionCandidate[];
  /** Frontmatter-declared dependencies; passed to inline JSX + preview compile. */
  dependencies: Record<string, string>;
}

const POLL_MS = 600;
/**
 * Debounce window for merging in-memory `state:` mutations back into the
 * MDX frontmatter. Short enough that the user sees state changes
 * reflected in the diff/source view on a glance; long enough that
 * dragging a slider doesn't rewrite the frontmatter on every animation
 * frame.
 */
const DOC_STATE_MERGE_MS = 600;

export function DocumentEditor({
  repoRoot,
  relPath,
  theme,
  onChange,
  onReload,
  onFlushClick,
  hasUnflushedChanges,
  mentionCandidates,
  dependencies,
}: DocumentEditorProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const lastDiskRef = useRef<string | null>(null);
  const inFlightWriteRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [contentEditableEl, setContentEditableEl] = useState<HTMLElement | null>(null);

  // In-memory state map mirrors the doc's frontmatter `state:` block.
  // Mutations from `useDocState` setters land here immediately so that
  // every other consumer re-renders, but the merge into the markdown
  // buffer is debounced — we don't want to rewrite the frontmatter on
  // every slider tick.
  const [docState, setDocState] = useState<Record<string, unknown>>({});
  const docStateRef = useRef(docState);
  docStateRef.current = docState;
  const mergeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const relPathRef = useRef(relPath);
  relPathRef.current = relPath;

  // Resolved + traversal-checked. Defensive even though the panel's fs is
  // RPC-scoped to the context root.
  const fullPath = useMemo(() => joinSafe(repoRoot, relPath), [repoRoot, relPath]);

  const loadFromDisk = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!fullPath) {
      setError(`Refusing to open "${relPath}" — path escapes the workspace root.`);
      return;
    }
    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      if (signal?.cancelled) return;
      const transformed = wikilinksToJsx(raw);
      lastDiskRef.current = raw;
      setMarkdown(transformed);
      setError(null);
      // Cancel any in-flight state merge; the on-disk content is authoritative.
      if (mergeTimerRef.current) {
        clearTimeout(mergeTimerRef.current);
        mergeTimerRef.current = null;
      }
      setDocState(parseFrontmatter(transformed).state);
      editorRef.current?.setMarkdown(transformed);
      onReload(relPath, transformed);
    } catch (err) {
      if (signal?.cancelled) return;
      setError(`Failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [fullPath, relPath, onReload]);

  // Read on open + when the path changes
  useEffect(() => {
    const signal = { cancelled: false };
    void loadFromDisk(signal);
    return () => { signal.cancelled = true; };
  }, [loadFromDisk]);

  // Poll for external (agent) file writes. On detected change, reload AND
  // clear any stale error state (the previous read may have failed because
  // the file didn't exist yet).
  useEffect(() => {
    if (!fullPath) return;
    const handle = setInterval(async () => {
      if (inFlightWriteRef.current) return;
      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        if (raw === lastDiskRef.current) return;
        lastDiskRef.current = raw;
        if (hasUnflushedChanges) {
          console.info(`[Spectrolite] ${relPath} changed on disk while user has unflushed edits — keeping buffer`);
          return;
        }
        const transformed = wikilinksToJsx(raw);
        setMarkdown(transformed);
        setError(null);
        // Disk wrote a new version (e.g. the agent edited it); refresh
        // our local docState from the fresh frontmatter so consumers see
        // any state the agent updated. Cancel any pending merge — the
        // disk content takes precedence.
        if (mergeTimerRef.current) {
          clearTimeout(mergeTimerRef.current);
          mergeTimerRef.current = null;
        }
        setDocState(parseFrontmatter(transformed).state);
        editorRef.current?.setMarkdown(transformed);
        onReload(relPath, transformed);
      } catch {
        /* file may have been deleted; ignore for v1 */
      }
    }, POLL_MS);
    return () => clearInterval(handle);
  }, [fullPath, relPath, hasUnflushedChanges, onReload]);

  const handleChange = useCallback((next: string) => {
    onChange(relPath, next);
  }, [onChange, relPath]);

  const flushNow = useCallback(() => {
    onFlushClick(relPath);
  }, [onFlushClick, relPath]);

  // useDocState setter — invoked by inline JSX components. The update
  // happens in two steps:
  //   1. We update the in-memory state map immediately so the React
  //      context re-renders and every other useDocState consumer sees
  //      the new value within the same tick.
  //   2. We schedule a debounced merge into the editor buffer. After
  //      DOC_STATE_MERGE_MS of no further state changes, we rewrite the
  //      frontmatter's `state:` block and push the new markdown into
  //      the editor via setMarkdown. The editor's onChange fires and
  //      routes through handleEditorChange in the usual way, so the
  //      flush pipeline picks the doc up as dirty.
  const handleDocStateChange = useCallback((key: string, value: unknown) => {
    setDocState((prev) => {
      // Skip the update if the new value is structurally equal — common
      // when controlled inputs re-emit the same value on focus changes.
      const current = prev[key];
      if (Object.is(current, value)) return prev;
      try {
        if (JSON.stringify(current) === JSON.stringify(value)) return prev;
      } catch { /* fallthrough */ }
      return { ...prev, [key]: value };
    });
    if (mergeTimerRef.current) clearTimeout(mergeTimerRef.current);
    mergeTimerRef.current = setTimeout(() => {
      mergeTimerRef.current = null;
      const editor = editorRef.current;
      if (!editor) return;
      const current = editor.getMarkdown();
      const newMdx = replaceFrontmatterState(current, docStateRef.current);
      if (newMdx === current) return;
      // Set the inFlightWrite flag briefly so the disk-poll doesn't
      // think the editor's content drifted from disk while we're still
      // mutating it.
      inFlightWriteRef.current = true;
      try {
        editor.setMarkdown(newMdx);
        // MDXEditor's onChange will fire and call handleChange →
        // onChange(relPath, newMdx). That's exactly what we want.
        // Also nudge in case the editor swallows the change event for
        // a setMarkdown that only differs in frontmatter.
        onChangeRef.current(relPathRef.current, newMdx);
      } finally {
        // Release on the next tick so any synchronous onChange has a
        // chance to land first.
        setTimeout(() => { inFlightWriteRef.current = false; }, 0);
      }
    }, DOC_STATE_MERGE_MS);
  }, []);

  // Drop the pending merge timer on unmount so we don't fire after the
  // editor ref is null.
  useEffect(() => () => {
    if (mergeTimerRef.current) clearTimeout(mergeTimerRef.current);
  }, []);

  const docStateContextValue: DocStateContextValue = useMemo(() => ({
    state: docState,
    setState: handleDocStateChange,
  }), [docState, handleDocStateChange]);

  // Expose useDocState to sandbox-compiled JSX (LiveJsxEditor wrapper and
  // PreviewPane's evaluated MDX) via a globalThis backdoor. The sandbox
  // can't `import` a panel-local module, so we publish the hook
  // alongside the panel's other globals. The hook itself uses React
  // context, so it picks up the active <DocStateContext.Provider> that
  // we render below.
  useEffect(() => {
    (globalThis as Record<string, unknown>)["__spectroliteUseDocState__"] = useDocState;
  }, []);

  // Locate the contenteditable root for the mention autocomplete keylistener
  useEffect(() => {
    if (!containerRef.current) return;
    if (mode !== "edit") {
      setContentEditableEl(null);
      return;
    }
    const find = () => {
      const el = containerRef.current?.querySelector<HTMLElement>("[contenteditable=\"true\"]");
      if (el && el !== contentEditableEl) setContentEditableEl(el);
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(containerRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mode, contentEditableEl]);

  const descriptors = useMemo(() => {
    // Bind the current dependency map into the Editor so live-compiled JSX
    // can resolve frontmatter-declared packages.
    const EditorWithDeps = (jsxProps: Parameters<typeof LiveJsxEditor>[0]) =>
      <LiveJsxEditor {...jsxProps} dependencies={dependencies} />;
    return knownJsxDescriptors().map((d) => ({ ...d, Editor: EditorWithDeps }));
  }, [dependencies]);

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "tsx" }),
    codeMirrorPlugin({
      codeBlockLanguages: {
        tsx: "TSX",
        ts: "TypeScript",
        js: "JavaScript",
        json: "JSON",
        bash: "Shell",
        md: "Markdown",
        mdx: "MDX",
        "": "Plain",
      },
    }),
    diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: "" }),
    jsxPlugin({ jsxComponentDescriptors: descriptors }),
    toolbarPlugin({
      toolbarContents: () => (
        <DiffSourceToggleWrapper>
          <UndoRedo />
          <BoldItalicUnderlineToggles />
          <CodeToggle />
          <CreateLink />
          <ListsToggle />
          <BlockTypeSelect />
          <Box style={{ flex: 1 }} />
          <Button
            size="1"
            variant={hasUnflushedChanges ? "solid" : "soft"}
            color={hasUnflushedChanges ? "amber" : "gray"}
            disabled={!hasUnflushedChanges}
            onClick={flushNow}
          >
            <LightningBoltIcon /> Flush
          </Button>
        </DiffSourceToggleWrapper>
      ),
    }),
  ], [descriptors, hasUnflushedChanges, flushNow]);

  const handleMentionAccept = useCallback((_handle: string) => {
    // The MentionAutocomplete adapter already performed the contenteditable
    // mutation via execCommand. Trigger a synthetic change so Lexical's
    // editorState picks up the new text via getMarkdown.
    const md = editorRef.current?.getMarkdown();
    if (md != null) onChange(relPath, md);
  }, [onChange, relPath]);

  if (error) {
    return (
      <Flex direction="column" gap="2" p="3">
        <Text color="red" size="2">{error}</Text>
        <Button
          size="1"
          variant="soft"
          onClick={() => {
            lastDiskRef.current = null;
            void loadFromDisk();
          }}
        >
          <ReloadIcon /> Retry
        </Button>
      </Flex>
    );
  }

  if (markdown === null) {
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Text size="2" color="gray">Loading {relPath}…</Text>
      </Flex>
    );
  }

  return (
    <DocStateContext.Provider value={docStateContextValue}>
      <Flex direction="column" className={`spectrolite-mdx ${theme === "dark" ? "dark-theme" : ""}`} style={{ height: "100%" }}>
        <Flex
          align="center"
          justify="end"
          gap="2"
          px="2"
          py="1"
          style={{ borderBottom: "1px solid var(--gray-5)", flexShrink: 0 }}
        >
          <SegmentedControl.Root size="1" value={mode} onValueChange={(v) => setMode(v as "edit" | "preview")}>
            <SegmentedControl.Item value="edit">
              <Flex align="center" gap="1"><Pencil1Icon /> Edit</Flex>
            </SegmentedControl.Item>
            <SegmentedControl.Item value="preview">
              <Flex align="center" gap="1"><EyeOpenIcon /> Preview</Flex>
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </Flex>
        <Box ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
          {mode === "edit" ? (
            <Box style={{ height: "100%", overflow: "auto" }}>
              <MDXEditor
                ref={editorRef}
                markdown={markdown}
                onChange={handleChange}
                plugins={plugins}
                contentEditableClassName={`spectrolite-content ${theme === "dark" ? "spectrolite-content--dark" : ""}`}
              />
              <MentionAutocomplete
                container={contentEditableEl}
                candidates={mentionCandidates}
                onAccept={handleMentionAccept}
              />
            </Box>
          ) : (
            <PreviewPane markdown={markdown} dependencies={dependencies} />
          )}
        </Box>
      </Flex>
    </DocStateContext.Provider>
  );
}

/**
 * Write the in-memory buffer to disk. Called by the flush pipeline.
 * Applies the inverse wikilink transformation (`<WikiLink>` → `[[Page]]`)
 * so the on-disk format stays Obsidian-compatible.
 *
 * Refuses to write paths that escape `repoRoot` via `../`.
 */
export async function writeBufferToDisk(repoRoot: string, relPath: string, content: string): Promise<void> {
  const full = joinSafe(repoRoot, relPath);
  if (!full) {
    throw new Error(`Refusing to write "${relPath}" — path escapes the workspace root.`);
  }
  const parent = parentDir(full);
  if (parent) {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFile(full, wikilinksFromJsx(content));
}
