/**
 * Quick-open for vault files, built on the shared `CommandPalette` primitive.
 * Fuzzy enough for paths/titles, keyboard friendly, available from both desktop
 * and mobile chrome. "Create note" rides in as a trailing command item so Enter
 * falls through to it when nothing matches — exactly the old behaviour.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FilePlusIcon, FileTextIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { CommandPalette, type CommandItem } from "@workspace/ui";
import { useApp, useAppState } from "../app/context";
import { computeQuickOpen, fuzzyMatch, labelFor, matchRanges } from "./quickOpenModel";

function highlightedText(text: string, query: string): ReactNode {
  // Reuse the model's single fuzzy walk, then mark contiguous matched runs —
  // so a substring hit renders one <mark> and a subsequence hit marks its chars.
  const match = fuzzyMatch(text, query);
  if (!match || match.positions.length === 0) return text;
  const ranges = matchRanges(match.positions);
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(
      <mark key={i} className="spectrolite-quick-match">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

type QuickAction = { kind: "open"; path: string } | { kind: "create"; name: string };

export function QuickOpenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const app = useApp();
  const paths = useAppState((s) => s.paths);
  const recentPaths = useAppState((s) => s.recentPaths);
  const pathsError = useAppState((s) => s.pathsError);
  const [query, setQuery] = useState("");

  // Reset the query each time the palette opens.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const { results, createName, canCreate, section } = useMemo(
    () => computeQuickOpen({ paths, recentPaths, query }),
    [paths, recentPaths, query]
  );

  const items = useMemo<CommandItem<QuickAction>[]>(() => {
    const out: CommandItem<QuickAction>[] = results.map((path) => ({
      id: `open:${path}`,
      label: labelFor(path),
      labelNode: highlightedText(labelFor(path), query),
      hint: path,
      hintNode: highlightedText(path, query),
      icon: <FileTextIcon />,
      section,
      value: { kind: "open", path },
    }));
    if (canCreate) {
      out.push({
        id: "create",
        label: `Create ${createName}`,
        icon: <FilePlusIcon />,
        section: "Create",
        value: { kind: "create", name: createName },
      });
    }
    return out;
  }, [results, query, canCreate, createName, section]);

  const run = (action: QuickAction) => {
    if (action.kind === "open") {
      app.openFile(action.path);
      onOpenChange(false);
      return;
    }
    void (async () => {
      const title =
        action.name
          .replace(/\.mdx$/i, "")
          .split("/")
          .pop() ?? action.name;
      const created = await app.vault.createFile(action.name, `# ${title}\n\n`);
      app.openFile(created);
      onOpenChange(false);
    })();
  };

  return (
    <CommandPalette<QuickAction>
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      onSelect={(item) => item.value && run(item.value)}
      placeholder="Find or create a note"
      searchIcon={<MagnifyingGlassIcon />}
      maxWidth={560}
      emptyMessage={
        pathsError ? pathsError : query.trim() ? "No matching notes." : "Type to search this vault."
      }
    />
  );
}
