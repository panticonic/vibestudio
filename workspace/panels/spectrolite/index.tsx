/**
 * Spectrolite — Obsidian-style MDX knowledge base panel (GAD-native co-edit).
 *
 * `app/createApp` builds a small external store plus the session + vault
 * controllers and the publish/view-state pieces. Each open document owns a
 * `DocController` (commit-on-quiescence + narrow remote reconcile) and an
 * `UndoCoordinator` (one ⌘Z stack over Lexical undo + GAD revert). The React
 * tree is a pure view of the store; editing keystrokes never re-render the shell.
 *
 * The panel keeps the semantic workspace context assigned by the panel tree.
 * Selecting a vault changes only the repository root used by VCS and the
 * resident scribe; repository selection never moves the panel to another
 * workspace context.
 */

import { useEffect, useMemo } from "react";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { usePanelTheme, useAgentState } from "@workspace/react";
import { ErrorBoundary } from "@workspace/agentic-chat";
import { useAppTheme } from "@workspace/ui/panel";
import "@workspace/ui/tokens.css";
import { createSpectroliteApp } from "./app/createApp";
import { AppProvider, useAppState } from "./app/context";
import { Shell } from "./components/Shell";
import "@workspace/agentic-chat/styles.css";
import "./style.css";

export default function SpectrolitePanel() {
  const theme = usePanelTheme();
  const appTheme = useAppTheme();
  const app = useMemo(() => createSpectroliteApp(), []);

  useEffect(() => {
    app.start();
    return () => app.dispose();
  }, [app]);

  return (
    <ErrorBoundary surfaceName="Spectrolite panel">
      <AppProvider value={app}>
        <Theme appearance={theme} {...appTheme} style={{ height: "100dvh" }}>
          <SessionGate theme={theme} />
        </Theme>
      </AppProvider>
    </ErrorBoundary>
  );
}

function SessionGate({ theme }: { theme: "light" | "dark" }) {
  const ready = useAppState((s) => Boolean(s.channelName && s.contextId));
  // Expose live editor state to debugging agents.
  const activePath = useAppState((s) => s.activePath);
  const dirtyPaths = useAppState((s) => s.dirtyPaths);
  const pendingSuggestions = useAppState((s) => s.pendingSuggestions.length);
  const repoRoot = useAppState((s) => s.repoRoot);
  const agentState = useMemo(
    () => ({
      path: activePath,
      dirtyPaths,
      pendingSuggestions,
      conflicts: pendingSuggestions,
      repoRoot,
    }),
    [activePath, dirtyPaths, pendingSuggestions, repoRoot]
  );
  useAgentState("spectrolite", agentState);

  if (!ready) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100%" }}>
        <Spinner />
        <Text size="2" color="gray">
          Starting Spectrolite…
        </Text>
      </Flex>
    );
  }
  return <Shell theme={theme} />;
}
