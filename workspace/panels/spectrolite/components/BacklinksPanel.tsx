/**
 * Backlinks panel — lists every file in the workspace that has a wikilink
 * pointing at the active file.
 *
 * Computed on demand by grepping each `.mdx` for the active file's
 * basename (without `.mdx`) inside `[[…]]` brackets. v1 caches per
 * (activePath, refreshKey) — invalidate by bumping `refreshKey` after
 * flush or commit. For workspaces of a few hundred files this is fine
 * without a real index.
 */

import { useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Box, Code, Flex, Link, ScrollArea, Text } from "@radix-ui/themes";
import { Link2Icon } from "@radix-ui/react-icons";
import { extractWikilinks } from "../mdx/wikilink";

export interface BacklinksPanelProps {
  root: string;
  /** Active file, relative to root. */
  activePath: string | null;
  /** Workspace `.mdx` paths (relative). Refreshed by FileTree. */
  paths: string[];
  /** Bump to force re-scan after flush/commit. */
  refreshKey: number;
  /** Click handler — opens the referencing file in the editor. */
  onOpen: (path: string) => void;
}

interface Backlink {
  fromPath: string;
  /** Snippet of the line containing the wikilink, for context. */
  snippet: string;
}

function basenameNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.mdx$/, "");
}

async function findBacklinks(
  root: string,
  activePath: string,
  candidatePaths: string[],
): Promise<Backlink[]> {
  const targetName = basenameNoExt(activePath);
  const fullTarget = activePath.replace(/\.mdx$/, "");
  const out: Backlink[] = [];

  for (const path of candidatePaths) {
    if (path === activePath) continue;
    let content: string;
    try {
      content = await fs.readFile(`${root}/${path}`, "utf-8");
    } catch {
      continue;
    }
    const targets = extractWikilinks(content);
    const hit = targets.some((t) => {
      const trimmed = t.endsWith(".mdx") ? t.slice(0, -4) : t;
      return trimmed === targetName || trimmed === fullTarget || trimmed.endsWith(`/${targetName}`);
    });
    if (!hit) continue;
    const lineMatch = content.split("\n").find((line) => line.includes("[[") && (line.includes(targetName) || line.includes(fullTarget)));
    out.push({ fromPath: path, snippet: lineMatch?.trim().slice(0, 120) ?? "" });
  }
  return out;
}

export function BacklinksPanel({ root, activePath, paths, refreshKey, onOpen }: BacklinksPanelProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activePath) {
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
  }, [root, activePath, paths, refreshKey]);

  if (!activePath) return null;

  return (
    <Flex direction="column" gap="1" p="2" style={{ borderTop: "1px solid var(--gray-5)" }}>
      <Flex align="center" gap="1">
        <Link2Icon />
        <Text size="1" weight="medium" color="gray">BACKLINKS</Text>
        <Text size="1" color="gray">· {backlinks.length}</Text>
      </Flex>
      <Box style={{ maxHeight: "30vh" }}>
        <ScrollArea>
          {loading ? (
            <Text size="1" color="gray">Scanning…</Text>
          ) : backlinks.length === 0 ? (
            <Text size="1" color="gray">None</Text>
          ) : (
            <Flex direction="column" gap="1">
              {backlinks.map((bl) => (
                <Box key={bl.fromPath}>
                  <Link size="1" onClick={(e) => { e.preventDefault(); onOpen(bl.fromPath); }} href="#">
                    <Code variant="ghost" size="1">{bl.fromPath}</Code>
                  </Link>
                  {bl.snippet ? (
                    <Text as="div" size="1" color="gray" style={{ marginLeft: "var(--space-2)" }}>
                      {bl.snippet}
                    </Text>
                  ) : null}
                </Box>
              ))}
            </Flex>
          )}
        </ScrollArea>
      </Box>
    </Flex>
  );
}
