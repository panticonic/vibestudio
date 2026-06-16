/**
 * Backlinks panel — lists every note that has a wikilink pointing at the
 * active file.
 *
 * Computed on demand by reading each `.mdx` and matching the active file's
 * basename (or path) inside `[[…]]`. GAD-native: the panel reads through
 * `vcs.readFile` (the vault head), mapping vault-relative paths to vcs paths.
 * The core scan (`findBacklinks`) takes an injected reader so it stays a pure,
 * fs-free, unit-testable function. Scans are bounded + concurrent so large
 * vaults don't serialize thousands of reads onto the UI update path.
 */

import { useEffect, useState } from "react";
import { Box, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { Link2Icon } from "@radix-ui/react-icons";
import { vcs } from "@workspace/runtime";
import { findBacklinks, type Backlink, type BacklinkReader } from "../state/backlinks";
import { useApp, useAppState } from "../app/context";

function basenameNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.mdx$/, "");
}

export function BacklinksPanel({ onOpened }: { onOpened?: () => void }) {
  const app = useApp();
  const root = useAppState((s) => s.repoRoot);
  const activePath = useAppState((s) => s.activePath);
  const paths = useAppState((s) => s.paths);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (root === null || !activePath) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const mapping = app.vault.mapping();
    const readFile: BacklinkReader = async (relPath) => {
      const file = await vcs.readFile("", mapping.toVcsPath(relPath)).catch(() => null);
      return file && file.content.kind === "text" ? file.content.text : null;
    };
    void findBacklinks(root, activePath, paths, { readFile })
      .then((bl) => { if (!cancelled) setBacklinks(bl); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app, root, activePath, paths]);

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
                    app.openFile(bl.fromPath);
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
