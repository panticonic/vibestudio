/**
 * Spectrolite — Obsidian-style MDX knowledge base panel.
 *
 * Architecture: `app/createApp` builds a small external store plus four
 * controllers (session, vault, editor, git) that own ALL imperative
 * lifecycle — channel connection, agent bootstrap/rehydration, the flush
 * pipeline, and git operations. The React tree below is a pure view of
 * the store; components subscribe to slices via `useAppState` so editing
 * keystrokes never re-render the shell.
 *
 * The panel and its resident agent share `contextId`, so the agent's
 * normal file-editing tools see the same `.mdx` files the user edits.
 */

import { useEffect, useMemo } from "react";
import { promises as fs } from "fs";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";
import { ErrorBoundary } from "@workspace/agentic-chat";
import { createSpectroliteApp } from "./app/createApp";
import { AppProvider, useAppState } from "./app/context";
import { Shell } from "./components/Shell";
import { joinSafe, parentDir } from "./state/safePath";
import "@workspace/agentic-chat/styles.css";
import "./style.css";

export default function SpectrolitePanel() {
  const theme = usePanelTheme();
  const app = useMemo(() => createSpectroliteApp(), []);

  useEffect(() => {
    app.start();
    return () => app.dispose();
  }, [app]);

  // E2E-only panel hook. Tests must call the installer explicitly, and
  // every file operation is scoped through joinSafe() to the active vault.
  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    if (process.env["NATSTACK_TEST_MODE"] !== "1") {
      delete g["__spectroliteInstallE2E__"];
      delete g["__spectroliteE2E__"];
      return;
    }
    const resolve = (relPath: string, verb: string): string => {
      const root = app.store.getState().repoRoot;
      if (!root) throw new Error("No Spectrolite vault is selected");
      const full = joinSafe(root, relPath);
      if (!full) throw new Error(`Refusing to ${verb} "${relPath}" outside the active vault`);
      return full;
    };
    g["__spectroliteInstallE2E__"] = () => {
      g["__spectroliteE2E__"] = {
        writeFile: async (relPath: string, content: string) => {
          const full = resolve(relPath, "write");
          const parent = parentDir(full);
          if (parent) await fs.mkdir(parent, { recursive: true });
          await fs.writeFile(full, content);
        },
        readFile: async (relPath: string) => fs.readFile(resolve(relPath, "read"), "utf-8"),
        unlink: async (relPath: string) => fs.unlink(resolve(relPath, "delete")),
      };
      return true;
    };
    return () => {
      delete g["__spectroliteInstallE2E__"];
      delete g["__spectroliteE2E__"];
    };
  }, [app]);

  return (
    <ErrorBoundary>
      <AppProvider value={app}>
        <Theme
          appearance={theme}
          accentColor="iris"
          grayColor="slate"
          radius="medium"
          panelBackground="solid"
          style={{ height: "100dvh" }}
        >
          <SessionGate theme={theme} />
        </Theme>
      </AppProvider>
    </ErrorBoundary>
  );
}

function SessionGate({ theme }: { theme: "light" | "dark" }) {
  const ready = useAppState((s) => Boolean(s.channelName && s.contextId));
  if (!ready) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100%" }}>
        <Spinner />
        <Text size="2" color="gray">Starting Spectrolite…</Text>
      </Flex>
    );
  }
  return <Shell theme={theme} />;
}
