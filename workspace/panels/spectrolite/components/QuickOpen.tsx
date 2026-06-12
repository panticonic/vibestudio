/**
 * Quick-open command for vault files. Fuzzy enough for paths/titles,
 * keyboard friendly, and available from both desktop and mobile chrome.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { FilePlusIcon, FileTextIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";

function labelFor(path: string): string {
  return path.split("/").pop()?.replace(/\.mdx$/i, "") ?? path;
}

function fuzzyScore(path: string, query: string): number {
  const haystack = path.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);
  let score = 0;
  let pos = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, pos);
    if (found < 0) return 0;
    score += Math.max(1, 16 - (found - pos));
    pos = found + 1;
  }
  return score;
}

function normalizeCreateName(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return trimmed.endsWith(".mdx") ? trimmed : `${trimmed}.mdx`;
}

function highlightedText(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const direct = lower.indexOf(needle);
  if (direct >= 0) {
    return (
      <>
        {text.slice(0, direct)}
        <mark className="spectrolite-quick-match">{text.slice(direct, direct + needle.length)}</mark>
        {text.slice(direct + needle.length)}
      </>
    );
  }
  const chars = new Set<number>();
  let pos = 0;
  for (const ch of needle) {
    const found = lower.indexOf(ch, pos);
    if (found < 0) return text;
    chars.add(found);
    pos = found + 1;
  }
  return (
    <>
      {Array.from(text).map((ch, index) => (
        chars.has(index)
          ? <mark key={index} className="spectrolite-quick-match">{ch}</mark>
          : ch
      ))}
    </>
  );
}

export function QuickOpenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const app = useApp();
  const paths = useAppState((s) => s.paths);
  const recentPaths = useAppState((s) => s.recentPaths);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      const existingRecent = recentPaths.filter((path) => paths.includes(path));
      const source = existingRecent.length > 0 ? existingRecent : paths;
      return source.slice(0, 12).map((path) => ({ path, score: 1, recent: existingRecent.includes(path) }));
    }
    return paths
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 12);
  }, [paths, query, recentPaths]);

  const createName = normalizeCreateName(query);
  const canCreate = createName && !paths.some((path) => path.toLowerCase() === createName.toLowerCase());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const openPath = (path: string) => {
    app.editor.openFile(path);
    onOpenChange(false);
  };

  const createPath = async () => {
    if (!canCreate) return;
    const title = createName.replace(/\.mdx$/i, "").split("/").pop() ?? createName;
    const created = await app.vault.createFile(createName, `# ${title}\n\n`);
    openPath(created);
  };

  const pickSelected = () => {
    const item = results[selected];
    if (item) {
      openPath(item.path);
      return;
    }
    if (canCreate) void createPath();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="560px" data-testid="spectrolite-quick-open">
        <Dialog.Title>Quick open</Dialog.Title>
        <Flex direction="column" gap="3">
          <TextField.Root
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((prev) => Math.min(prev + 1, Math.max(0, results.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((prev) => Math.max(0, prev - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pickSelected();
              }
            }}
            placeholder="Find or create a note"
            aria-label="Quick open"
            data-testid="spectrolite-quick-open-input"
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>

          <Box>
            {results.length === 0 ? (
              <Box p="2">
                <Text size="2" color="gray" as="div">
                  {query.trim() ? "No matching notes." : "Type to search this vault."}
                </Text>
              </Box>
            ) : (
              <Flex direction="column" gap="1">
                <Text size="1" color="gray" className="spectrolite-quick-section">
                  {query.trim() ? "Matches" : recentPaths.length > 0 ? "Recent" : "All notes"}
                </Text>
                {results.map((item, index) => (
                  <button
                    key={item.path}
                    type="button"
                    className={`spectrolite-quick-row${index === selected ? " spectrolite-quick-row--selected" : ""}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => openPath(item.path)}
                    data-testid={`spectrolite-quick-open-${item.path}`}
                  >
                    <FileTextIcon />
                    <span className="spectrolite-quick-row-title">{highlightedText(labelFor(item.path), query)}</span>
                    <span className="spectrolite-quick-row-path">{highlightedText(item.path, query)}</span>
                  </button>
                ))}
              </Flex>
            )}
          </Box>

          {canCreate ? (
            <Button variant="soft" onClick={() => void createPath()} data-testid="spectrolite-quick-create">
              <FilePlusIcon /> Create {createName}
            </Button>
          ) : null}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
