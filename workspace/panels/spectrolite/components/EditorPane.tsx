/**
 * Editor pane — hosts the GAD-native {@link DocumentEditor} for the active
 * file, or the appropriate empty state (loading / empty vault / no file open),
 * and overlays the live same-block {@link SuggestionStack}.
 *
 * Subscribes only to the slices the chrome needs; document content + dirty
 * tracking live in the per-doc DocController, so keystrokes don't ripple
 * through the shell.
 */

import { useCallback, useMemo } from "react";
import { Box, Button, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import { FilePlusIcon, HamburgerMenuIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";
import { DocumentEditor } from "./DocumentEditor";
import { SuggestionStack } from "./SuggestionCard";
import type { MentionCandidate } from "./MentionAutocomplete";

export const SAMPLE_DOC_NAME = "Welcome.mdx";

export const SAMPLE_DOC = `---
title: Welcome to Spectrolite
dependencies: {}
---

# Welcome to Spectrolite

This is an **MDX** knowledge base backed by version-controlled storage. Try the following:

1. **Edit prose** like you would in any rich-text editor — your changes save
   automatically and never get yanked away mid-edit.
2. **Ask @scribe** to help — use the "Ask @scribe" button (your pending edits
   are committed first). The scribe edits in place; its changes briefly
   highlight and you can undo them.
3. **Link between notes** with double brackets — for example,
   [[Another Note]] (click to create it).
4. **Publish** when you're ready to share with the rest of the workspace.

<Callout color="blue">
  <Callout.Icon><Icons.InfoCircledIcon /></Callout.Icon>
  <Callout.Text>
    Components like this Callout render live inline.
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

The panel prefetches them into the sandbox module map. The resident scribe's
\`eval\` tool picks them up automatically, and you can use them in inline JSX
blocks in this doc without redeclaring imports.

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
  const activeDeps = useAppState((s) => s.activeDeps);
  const roster = useAppState((s) => s.roster);
  const removedHandles = useAppState((s) => s.removedHandles);

  const mentionCandidates: MentionCandidate[] = useMemo(
    () => roster
      .filter((agent) => !removedHandles.includes(agent.handle))
      .map((agent) => ({ handle: agent.handle })),
    [roster, removedHandles],
  );

  const handleCreateWelcomeDoc = useCallback(async () => {
    try {
      const created = await app.vault.createFile(SAMPLE_DOC_NAME, SAMPLE_DOC);
      app.openFile(created);
    } catch (err) {
      console.warn("[Spectrolite] failed to create starter note:", err);
    }
  }, [app]);

  if (repoRoot === null) return null;

  if (activePath) {
    return (
      <Box style={{ position: "relative", height: "100%", minHeight: 0 }}>
        <DocumentEditor
          key={activePath}
          relPath={activePath}
          theme={theme}
          mentionCandidates={mentionCandidates}
          dependencies={activeDeps}
        />
        <SuggestionStack />
      </Box>
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
