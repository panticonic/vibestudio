/**
 * Inline @-mention autocomplete adapter for MDXEditor.
 *
 * MDXEditor wraps Lexical, which renders into a contenteditable. Rather
 * than write a custom Lexical plugin (which would require deep MDXEditor
 * realm/gurx integration), we attach a DOM-level keydown listener to the
 * editor's contenteditable root and drive a popover from there. The
 * approach is robust because the contenteditable's text + selection are
 * the source of truth for both Lexical and the DOM.
 *
 * Trigger: typing `@` while the caret is on whitespace/start-of-text.
 *   - Listens for subsequent keystrokes to refine the `@<query>` filter.
 *   - Popover renders next to the caret rect.
 *   - ArrowUp/ArrowDown navigate, Enter/Tab accept, Esc dismisses.
 *   - On accept, we remove the typed `@<query>` chars using
 *     `document.execCommand('delete')` (works inside contenteditable —
 *     Lexical observes the change) and then call `editor.insertMarkdown`
 *     to drop in the chosen handle as plain text.
 *
 * Limitations: cross-paragraph or mid-word triggers may have edge cases;
 * v1 is conservative — we require the previous char to be whitespace or
 * start-of-document. Lexical's own SELECTION_CHANGE events aren't read;
 * we rely on the browser's caret rect via `getSelection().getRangeAt(0)`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { PersonIcon } from "@radix-ui/react-icons";

export interface MentionCandidate {
  handle: string;
  name?: string;
}

export interface MentionAutocompleteProps {
  /** Container DOM element whose keydown events we listen to (the editor root). */
  container: HTMLElement | null;
  /** All known mention handles. */
  candidates: MentionCandidate[];
  /** Called after the user accepts a candidate; the trigger text has already been removed. */
  onAccept: (handle: string) => void;
}

interface OpenState {
  query: string;
  triggerRect: DOMRect;
  triggerStart: number;
  triggerNode: Node;
}

function isTriggerableContext(node: Node, offset: number): boolean {
  if (node.nodeType !== Node.TEXT_NODE) return offset === 0;
  if (offset === 0) return true;
  const prev = node.textContent?.[offset - 1];
  return !prev || /\s/.test(prev);
}

export function MentionAutocomplete({ container, candidates, onAccept }: MentionAutocompleteProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const filtered = useMemo(() => {
    if (!open) return [];
    const q = open.query.toLowerCase();
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter((c) =>
        c.handle.toLowerCase().includes(q) || (c.name?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 8);
  }, [open, candidates]);

  useEffect(() => {
    if (open && selectedIndex >= filtered.length) setSelectedIndex(0);
  }, [filtered.length, open, selectedIndex]);

  useEffect(() => {
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;

      const current = openRef.current;

      // Navigation while open
      if (current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(null);
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && filtered.length > 0) {
          event.preventDefault();
          const chosen = filtered[selectedIndex] ?? filtered[0]!;
          // Remove `@<query>` using execCommand("delete") — works in contenteditable.
          const toDelete = current.query.length + 1; // +1 for the `@`
          const editorRoot = container as HTMLElement;
          // Set selection to a range covering the @ trigger
          const r = document.createRange();
          const node = current.triggerNode;
          const startOffset = Math.max(0, current.triggerStart);
          r.setStart(node, startOffset);
          // current selection position is end of typed @query
          const endNode = range.startContainer;
          const endOffset = range.startOffset;
          r.setEnd(endNode, endOffset);
          sel.removeAllRanges();
          sel.addRange(r);
          editorRoot.focus();
          document.execCommand("delete");
          // After deletion, insert via standard input event so Lexical observes the change.
          // We dispatch a beforeinput event with `insertText`; if that's unavailable, fall back to execCommand.
          const inserted = `@${chosen.handle} `;
          try {
            document.execCommand("insertText", false, inserted);
          } catch {
            /* ignore */
          }
          onAccept(chosen.handle);
          setOpen(null);
          // toDelete computed for documentation; not used directly
          void toDelete;
          return;
        }
      }

      // Open on @ keypress
      if (event.key === "@") {
        const node = range.startContainer;
        const offset = range.startOffset;
        if (!isTriggerableContext(node, offset)) return;
        const rect = range.getBoundingClientRect();
        setOpen({
          query: "",
          triggerStart: offset, // position WHERE the @ will be inserted (before)
          triggerRect: rect,
          triggerNode: node,
        });
        setSelectedIndex(0);
        return;
      }

      // Update query as the user types more characters
      if (current && event.key.length === 1 && /[A-Za-z0-9_.-]/.test(event.key)) {
        setOpen((prev) => prev ? { ...prev, query: prev.query + event.key } : prev);
        return;
      }
      if (current && event.key === "Backspace") {
        setOpen((prev) => {
          if (!prev) return prev;
          if (prev.query.length === 0) return null;
          return { ...prev, query: prev.query.slice(0, -1) };
        });
        return;
      }
      // Any other key closes the popover
      if (current && event.key !== "Shift" && event.key !== "Meta" && event.key !== "Control" && event.key !== "Alt") {
        setOpen(null);
      }
    };
    container.addEventListener("keydown", onKeyDown, true);
    return () => container.removeEventListener("keydown", onKeyDown, true);
  }, [container, filtered, selectedIndex, onAccept]);

  if (!open || filtered.length === 0) return null;

  const top = open.triggerRect.bottom + 4;
  const left = open.triggerRect.left;
  return (
    <Box
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 9999,
        minWidth: 200,
        maxWidth: 320,
        pointerEvents: "auto",
      }}
    >
      <Card>
        <Flex direction="column" gap="0">
          {filtered.map((c, idx) => {
            const active = idx === selectedIndex;
            return (
              <Flex
                key={c.handle}
                align="center"
                gap="2"
                px="2"
                py="1"
                style={{
                  background: active ? "var(--accent-3)" : "transparent",
                  cursor: "pointer",
                  borderRadius: "var(--radius-2)",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAccept(c.handle);
                  setOpen(null);
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <PersonIcon />
                <Code variant="ghost" size="1">@{c.handle}</Code>
                {c.name ? <Text size="1" color="gray">{c.name}</Text> : null}
              </Flex>
            );
          })}
        </Flex>
      </Card>
    </Box>
  );
}
