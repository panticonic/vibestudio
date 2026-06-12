/**
 * Backlinks panel — lists every file in the workspace that has a wikilink
 * pointing at the active file.
 *
 * Computed on demand by grepping each `.mdx` for the active file's
 * basename (without `.mdx`) inside `[[…]]` brackets. Scans are bounded
 * and concurrent so large vaults don't serialize thousands of file reads
 * onto the UI update path. Re-scans when the path index refreshes (the
 * vault controller updates it after flush/commit/file create).
 */

import { useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Box, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { Link2Icon } from "@radix-ui/react-icons";
import { extractWikilinks } from "../mdx/wikilink";
import { useApp, useAppState } from "../app/context";

interface Backlink {
  fromPath: string;
  /** Snippet of the line containing the wikilink, for context. */
  snippet: string;
}

const DEFAULT_BACKLINK_CONCURRENCY = 24;

export interface FindBacklinksOptions {
  concurrency?: number;
}

function basenameNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.mdx$/, "");
}

export async function findBacklinks(
  root: string,
  activePath: string,
  candidatePaths: string[],
  options: FindBacklinksOptions = {},
): Promise<Backlink[]> {
  const targetName = basenameNoExt(activePath);
  const fullTarget = activePath.replace(/\.mdx$/, "");
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_BACKLINK_CONCURRENCY));
  const candidates = candidatePaths.filter((path) => path !== activePath);

  async function scan(path: string): Promise<Backlink | null> {
    let content: string;
    try {
      content = await fs.readFile(`${root}/${path}`, "utf-8");
    } catch {
      return null;
    }
    if (!content.includes("[[") || (!content.includes(targetName) && !content.includes(fullTarget))) {
      return null;
    }
    const targets = extractWikilinks(content);
    const hit = targets.some((t) => {
      const trimmed = t.endsWith(".mdx") ? t.slice(0, -4) : t;
      return trimmed === targetName || trimmed === fullTarget || trimmed.endsWith(`/${targetName}`);
    });
    if (!hit) return null;
    const lineMatch = content.split("\n").find((line) => line.includes("[[") && (line.includes(targetName) || line.includes(fullTarget)));
    return { fromPath: path, snippet: lineMatch?.trim().slice(0, 120) ?? "" };
  }

  const out: Backlink[] = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(scan));
    for (const backlink of results) {
      if (backlink) out.push(backlink);
    }
  }
  return out;
}

export function BacklinksPanel({ onOpened }: { onOpened?: () => void }) {
  const app = useApp();
  const root = useAppState((s) => s.repoRoot);
  const activePath = useAppState((s) => s.activePath);
  const paths = useAppState((s) => s.paths);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!root || !activePath) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void findBacklinks(root, activePath, paths)
      .then((bl) => { if (!cancelled) setBacklinks(bl); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root, activePath, paths]);

  if (!activePath) {
    return (
      <Text size="1" color="gray" as="div" style={{ padding: "var(--space-3)" }}>
        Open a file to see its backlinks.
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="1" p="2" style={{ height: "100%", minHeight: 0 }} data-testid="spectrolite-backlinks">
      <Flex align="center" gap="1" px="1">
        <Link2Icon />
        <Text size="1" weight="bold" color="gray" style={{ letterSpacing: "0.06em" }}>BACKLINKS</Text>
        <Text size="1" color="gray">· {backlinks.length}</Text>
      </Flex>
      <Box style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea>
          {loading ? (
            <Text size="1" color="gray" as="div" style={{ padding: "var(--space-2)" }}>Scanning…</Text>
          ) : backlinks.length === 0 ? (
            <Text size="1" color="gray" as="div" style={{ padding: "var(--space-2)" }}>
              Nothing links here yet. Reference this note with [[{basenameNoExt(activePath)}]].
            </Text>
          ) : (
            <Flex direction="column" gap="1">
              {backlinks.map((bl) => (
                <button
                  key={bl.fromPath}
                  type="button"
                  className="spectrolite-backlink-row"
                  data-testid={`spectrolite-backlink-${bl.fromPath}`}
                  onClick={() => {
                    app.editor.openFile(bl.fromPath);
                    onOpened?.();
                  }}
                >
                  <span className="spectrolite-file-row-name">{bl.fromPath}</span>
                  {bl.snippet ? <span className="spectrolite-backlink-snippet">{bl.snippet}</span> : null}
                </button>
              ))}
            </Flex>
          )}
        </ScrollArea>
      </Box>
    </Flex>
  );
}
