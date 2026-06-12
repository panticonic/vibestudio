/**
 * Editor pane — hosts DocumentEditor for the active file, or the
 * appropriate empty state (loading / empty vault / no file open).
 *
 * Subscribes only to the slices the editor chrome needs; buffer text
 * lives inside DocumentEditor + the store, so keystrokes don't ripple
 * through the shell.
 */

import { useCallback, useMemo, useState } from "react";
import { Box, Button, Callout, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import { CheckIcon, CopyIcon, ExclamationTriangleIcon, FilePlusIcon, HamburgerMenuIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";
import { hasUnflushedChanges } from "../state/fileBuffer";
import { DocumentEditor } from "./DocumentEditor";
import type { MentionCandidate } from "./MentionAutocomplete";

export const SAMPLE_DOC_NAME = "Welcome.mdx";

export const SAMPLE_DOC = `---
title: Welcome to Spectrolite
dependencies: {}
---

# Welcome to Spectrolite

This is an **MDX** knowledge base backed by a git repo. Try the following:

1. **Edit prose** like you would in any rich-text editor.
2. **@-mention an agent** to ask for help — type \`@\` to bring up the
   autocomplete. The agent sees the diff after you click **Flush** (or
   1.5 s of inactivity) and edits the file in-place.
3. **Link between notes** with double brackets — for example,
   [[Another Note]] (click to create it).
4. **Commit** dirty files from the strip at the bottom; click
   "Suggest message" to have the agent draft a commit message.

<Callout color="blue">
  <Callout.Icon><Icons.InfoCircledIcon /></Callout.Icon>
  <Callout.Text>
    Components like this Callout render live inline. Switch to **Preview**
    mode (top-right) to see the page rendered with full runtime access.
  </Callout.Text>
</Callout>

## Declaring dependencies

Add npm or workspace packages to this file via the YAML frontmatter:

\`\`\`yaml
dependencies:
  "date-fns": "npm:^2.30.0"
  lodash: "npm:^4.17.21"
  "@workspace/agentic-chat": latest
\`\`\`

The panel prefetches them into the sandbox module map. The resident agent's
\`eval\` tool picks them up automatically, and you can use them in inline
JSX blocks in this doc without redeclaring imports.

Delete this file or replace its contents when you're ready.
`;

export interface EditorPaneProps {
  theme: "light" | "dark";
  /** Open the file browser (drawer on desktop, sidebar on mobile). */
  onOpenFiles: () => void;
  mobile?: boolean;
}

export function EditorPane({ theme, onOpenFiles, mobile = false }: EditorPaneProps) {
  const app = useApp();
  const repoRoot = useAppState((s) => s.repoRoot);
  const activePath = useAppState((s) => s.activePath);
  const pathsLoading = useAppState((s) => s.pathsLoading || !s.pathsLoaded);
  const vaultEmpty = useAppState((s) => s.pathsLoaded && !s.pathsLoading && s.paths.length === 0);
  const activeDirty = useAppState((s) => {
    const buffer = s.activePath ? s.buffers[s.activePath] : undefined;
    return buffer ? hasUnflushedChanges(buffer) : false;
  });
  const saveError = useAppState((s) => (s.activePath ? s.saveErrors[s.activePath] : undefined));
  const activeDeps = useAppState((s) => s.activeDeps);
  const roster = useAppState((s) => s.roster);
  const removedHandles = useAppState((s) => s.removedHandles);
  const [copiedSaveError, setCopiedSaveError] = useState(false);

  const mentionCandidates: MentionCandidate[] = useMemo(
    () => roster
      .filter((agent) => !removedHandles.includes(agent.handle))
      .map((agent) => ({ handle: agent.handle })),
    [roster, removedHandles],
  );

  const handleChange = useCallback(
    (path: string, markdown: string) => app.editor.editorChanged(path, markdown),
    [app],
  );
  const handleReload = useCallback(
    (path: string, markdown: string) => app.editor.editorReloaded(path, markdown),
    [app],
  );
  const handleFlushClick = useCallback(
    (path: string) => app.editor.flushNow(path),
    [app],
  );

  const handleCreateWelcomeDoc = useCallback(async () => {
    try {
      const created = await app.vault.createFile(SAMPLE_DOC_NAME, SAMPLE_DOC);
      app.editor.openFile(created);
    } catch (err) {
      console.warn("[Spectrolite] failed to create starter note:", err);
    }
  }, [app]);

  const copySaveErrorDetails = useCallback(async () => {
    if (!saveError) return;
    const detail = [
      `Spectrolite save failed for ${saveError.path}`,
      `At: ${new Date(saveError.at).toLocaleString()}`,
      "",
      saveError.message,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(detail);
      setCopiedSaveError(true);
      setTimeout(() => setCopiedSaveError(false), 1500);
    } catch (err) {
      console.warn("[Spectrolite] failed to copy save error:", err);
    }
  }, [saveError]);

  if (!repoRoot) return null;

  if (activePath) {
    return (
      <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
        {saveError ? (
          <Callout.Root color="red" size="1" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }} data-testid="spectrolite-save-error">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text size="2">
              Could not save {saveError.path}: {saveError.message}
            </Callout.Text>
            <Flex gap="2" mt="2">
              <Button size="1" variant="solid" color="red" onClick={() => app.editor.flushNow(saveError.path)}>
                <ReloadIcon /> Retry save
              </Button>
              <Button size="1" variant="soft" color="gray" onClick={() => void copySaveErrorDetails()} data-testid="spectrolite-save-error-copy">
                {copiedSaveError ? <CheckIcon /> : <CopyIcon />} {copiedSaveError ? "Copied" : "Copy details"}
              </Button>
            </Flex>
          </Callout.Root>
        ) : null}
        <Box style={{ flex: 1, minHeight: 0 }}>
          <DocumentEditor
            key={activePath}
            repoRoot={repoRoot}
            relPath={activePath}
            theme={theme}
            onChange={handleChange}
            onReload={handleReload}
            onFlushClick={handleFlushClick}
            hasUnflushedChanges={activeDirty}
            mentionCandidates={mentionCandidates}
            dependencies={activeDeps}
            onRecoveryCreated={() => void app.vault.refreshPaths()}
          />
        </Box>
      </Flex>
    );
  }

  if (pathsLoading) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100%" }}>
        <Spinner size="1" />
        <Text size="2" color="gray">Loading files...</Text>
      </Flex>
    );
  }

  if (vaultEmpty) {
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }} p="6">
        <Flex direction="column" align="center" gap="3" className="spectrolite-empty-card">
          <Heading size="4">This vault is empty</Heading>
          <Text size="2" color="gray" align="center">
            Create your first note to get started.
          </Text>
          <Button size="3" onClick={() => void handleCreateWelcomeDoc()} variant="solid">
            <FilePlusIcon /> Create starter note
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex align="center" justify="center" style={{ height: "100%" }} p="4">
      <Flex direction="column" align="center" gap="3" className="spectrolite-empty-card">
        <Text size="2" color="gray" align="center">
          {mobile ? "Tap the menu icon to pick a file." : "Open a file to start editing."}
        </Text>
        <Flex gap="2">
          <Button size="3" onClick={onOpenFiles} data-testid="spectrolite-empty-open-files">
            <HamburgerMenuIcon /> Open files
          </Button>
          {!mobile ? (
            <Button size="3" variant="soft" color="gray" onClick={() => void handleCreateWelcomeDoc()}>
              <FilePlusIcon /> Create note
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Flex>
  );
}
