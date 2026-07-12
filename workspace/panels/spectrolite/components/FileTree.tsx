/**
 * File browser for the active vault. Reads the path index from the app
 * store (refreshed by the vault controller); rows show the basename
 * prominently with the directory as secondary text.
 *
 * Every file gets its own DOM row (no virtualization) — the e2e suite
 * and wikilink resolution both rely on the full list being present.
 */

import { useCallback, useState } from "react";
import { Box, Callout, Flex, IconButton, ScrollArea, Text, TextField } from "@radix-ui/themes";
import { FileTextIcon, PlusIcon, ReloadIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";

export interface FileTreeProps {
  /** Close the hosting drawer/sidebar after opening a file. */
  onOpened?: () => void;
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: path };
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

export function FileTree({ onOpened }: FileTreeProps) {
  const app = useApp();
  const files = useAppState((s) => s.paths);
  const loading = useAppState((s) => s.pathsLoading || !s.pathsLoaded);
  const pathsError = useAppState((s) => s.pathsError);
  const activePath = useAppState((s) => s.activePath);
  const dirtyPaths = useAppState((s) => s.dirtyPaths);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const open = useCallback(
    (path: string) => {
      app.openFile(path);
      onOpened?.();
    },
    [app, onOpened]
  );

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreateError(null);
    try {
      const created = await app.vault.createFile(trimmed, `# ${trimmed.replace(/\.mdx$/, "")}\n\n`);
      setNewName("");
      open(created);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  }, [app, newName, open]);

  return (
    <Flex
      direction="column"
      gap="2"
      className="spectrolite-file-tree"
      style={{ height: "100%", padding: "var(--space-2)" }}
    >
      <Flex align="center" justify="between" gap="2" px="1">
        <Text size="1" weight="bold" color="gray" style={{ letterSpacing: "0.06em" }}>
          FILES
        </Text>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => void app.vault.refreshPaths()}
          aria-label="Refresh"
        >
          <ReloadIcon />
        </IconButton>
      </Flex>
      <Flex gap="1">
        <TextField.Root
          size="1"
          placeholder="new-note.mdx"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            if (createError) setCreateError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          style={{ flex: 1 }}
        />
        <IconButton
          size="1"
          variant="soft"
          onClick={() => void handleCreate()}
          disabled={!newName.trim()}
          aria-label="Create note"
        >
          <PlusIcon />
        </IconButton>
      </Flex>
      {createError ? (
        <Callout.Root size="1" color="red">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text size="1">{createError}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Box style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea>
          {loading ? (
            <Text size="1" color="gray" as="div" style={{ padding: "var(--space-2)" }}>
              Loading…
            </Text>
          ) : pathsError ? (
            <Callout.Root size="1" color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text size="1">
                {pathsError}
                <button type="button" onClick={() => void app.vault.refreshPaths()}>
                  Retry
                </button>
              </Callout.Text>
            </Callout.Root>
          ) : files.length === 0 ? (
            <Text size="1" color="gray" as="div" style={{ padding: "var(--space-2)" }}>
              No .mdx files yet
            </Text>
          ) : (
            <Flex direction="column">
              {files.map((path) => {
                const active = path === activePath;
                const dirty = dirtyPaths.includes(path);
                const { dir, name } = splitPath(path);
                return (
                  <button
                    key={path}
                    type="button"
                    className={`spectrolite-file-row${active ? " spectrolite-file-row--active" : ""}`}
                    onClick={() => open(path)}
                    title={path}
                  >
                    <FileTextIcon className="spectrolite-file-row-icon" />
                    <span className="spectrolite-file-row-name">{name}</span>
                    {dirty ? (
                      <span
                        aria-hidden
                        title="Unsaved edits"
                        style={{
                          color: "var(--iris-9)",
                          fontSize: 9,
                          lineHeight: 1,
                          marginLeft: 4,
                        }}
                      >
                        ●
                      </span>
                    ) : null}
                    {dir ? <span className="spectrolite-file-row-dir">{dir}</span> : null}
                  </button>
                );
              })}
            </Flex>
          )}
        </ScrollArea>
      </Box>
    </Flex>
  );
}
