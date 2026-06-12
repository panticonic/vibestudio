/**
 * Top-level layout.
 *
 *   No vault   → picker screen (channel dock + notifier still live so the
 *                resident agent stays reachable)
 *   Desktop    → header / editor / commit bar / channel dock, with Files,
 *                Backlinks and Workspace slide-over panels
 *   Mobile     → compact header, full-bleed editor, bottom action strip,
 *                slide-in sidebar + bottom sheets
 *
 * Pure view code — every mutation goes through the app controllers.
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flex, Heading, IconButton, Text } from "@radix-ui/themes";
import {
  DotsHorizontalIcon,
  HamburgerMenuIcon,
  Link2Icon,
  ListBulletIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import { useApp, useAppState } from "../app/context";
import { WikilinkContext } from "../mdx/components";
import { resolveWikilinkTarget } from "../mdx/wikilink";
import { parseFrontmatter } from "../mdx/frontmatter";
import { EditorPane } from "./EditorPane";
import { CommitStrip } from "./CommitStrip";
import { ChannelDrawer } from "./ChannelDrawer";
import { AgentMessageNotifier } from "./AgentMessageNotifier";
import { AgentBadges } from "./AgentRoster";
import { VaultPicker } from "./VaultPicker";
import { AgentVaultStatus, MentionDeliveryStatus, SaveStatus, formatTimeAgo, useNowTick } from "./StatusChips";
import { FilesDrawer, BacklinksDrawer, SettingsDrawer } from "./drawers";
import { MobileSidebar } from "./mobile/MobileSidebar";
import { BottomSheet } from "./mobile/BottomSheet";
import { MobileCommitButton } from "./mobile/MobileCommitButton";
import { WorkspaceSettingsSheet } from "./mobile/WorkspaceSettingsSheet";
import { BacklinksPanel } from "./BacklinksPanel";
import { FileTree } from "./FileTree";
import { QuickOpenDialog } from "./QuickOpen";
import { hasUnflushedChanges } from "../state/fileBuffer";

function pathToTitle(relPath: string): string {
  const name = relPath.split("/").pop() ?? relPath;
  return name.replace(/\.mdx$/, "");
}

function useActiveTitle(): string | null {
  return useAppState((s) => {
    if (!s.activePath) return null;
    const buffer = s.buffers[s.activePath];
    if (!buffer) return pathToTitle(s.activePath);
    return parseFrontmatter(buffer.currentMdx).title ?? pathToTitle(s.activePath);
  });
}

export function Shell({ theme }: { theme: "light" | "dark" }) {
  const app = useApp();
  const repoRoot = useAppState((s) => s.repoRoot);
  const isMobile = useIsMobile();
  const [quickOpen, setQuickOpen] = useState(false);

  // Wikilink bridge for the rendered doc: [[Page]] resolves against the
  // live path index at click time (no stale closures), and unresolved
  // targets are created Obsidian-style.
  const wikilinkContext = useMemo(() => ({
    resolve: (target: string) => resolveWikilinkTarget(target, app.store.getState().paths),
    open: (path: string) => app.editor.openFile(path),
    openOrCreate: async (target: string) => {
      const resolved = resolveWikilinkTarget(target, app.store.getState().paths);
      if (resolved) {
        app.editor.openFile(resolved);
        return;
      }
      try {
        const created = await app.vault.createFile(target, `# ${target}\n\n`);
        app.editor.openFile(created);
      } catch (err) {
        console.warn(`[Spectrolite] create failed for "${target}":`, err);
      }
    },
  }), [app]);

  useEffect(() => {
    if (!repoRoot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [repoRoot]);

  if (!repoRoot) {
    return <PickerScreen />;
  }

  return (
    <WikilinkContext.Provider value={wikilinkContext}>
      {isMobile
        ? <MobileWorkspace theme={theme} onQuickOpen={() => setQuickOpen(true)} />
        : <DesktopWorkspace theme={theme} onQuickOpen={() => setQuickOpen(true)} />}
      <QuickOpenDialog open={quickOpen} onOpenChange={setQuickOpen} />
    </WikilinkContext.Provider>
  );
}

function PickerScreen() {
  const app = useApp();
  const agentHandle = useAppState((s) => s.roster[0]?.handle ?? s.installedAgents[0]?.handle);
  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" justify="between" gap="3" px="3" py="2" className="spectrolite-header">
        <Brand />
        <Flex align="center" gap="3">
          <AgentVaultStatus compact />
          <AgentBadges />
        </Flex>
      </Flex>
      <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <VaultPicker
          agentHandle={agentHandle}
          onSelect={(contextPath) => app.vault.selectVault(contextPath)}
        />
      </Box>
      <ChannelDrawer />
      <AgentMessageNotifier />
    </Flex>
  );
}

function Brand() {
  return (
    <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
      <span className="spectrolite-gem spectrolite-gem--small" aria-hidden>◆</span>
      <Heading size="3">Spectrolite</Heading>
    </Flex>
  );
}

function BranchStatusText() {
  const branch = useAppState((s) => s.branches.find((b) => b.current)?.name ?? s.gitBranch);
  return (
    <Text
      size="1"
      color="gray"
      truncate
      title={branch ? `Current branch: ${branch}` : "Current branch unavailable"}
      data-testid="spectrolite-branch-status"
    >
      {branch ?? "branch unavailable"}
    </Text>
  );
}

function DesktopWorkspace({ theme, onQuickOpen }: { theme: "light" | "dark"; onQuickOpen: () => void }) {
  const app = useApp();
  const repoRoot = useAppState((s) => s.repoRoot)!;
  const activePath = useAppState((s) => s.activePath);
  const activeTitle = useActiveTitle();
  const [filesOpen, setFilesOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" justify="between" gap="3" px="3" py="2" className="spectrolite-header">
        <Flex align="center" gap="2" style={{ minWidth: 0, flex: 1 }}>
          <Brand />
          <Button
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => void app.vault.switchVault()}
            title="Switch to a different vault"
            data-testid="spectrolite-toolbar-switch-vault"
          >
            {repoRoot.replace(/^\//, "")}
          </Button>
          <BranchStatusText />
          {activeTitle ? (
            <Text size="1" color="gray" truncate title={activePath ?? activeTitle}>
              / {activeTitle}
            </Text>
          ) : null}
          <SaveStatus />
        </Flex>
        <Flex align="center" gap="3" style={{ flexShrink: 0 }}>
          <AgentVaultStatus compact />
          <MentionDeliveryStatus compact />
          <AgentBadges />
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={onQuickOpen}
            data-testid="spectrolite-quick-open-trigger"
          >
            <MagnifyingGlassIcon /> Search
          </Button>
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={() => setFilesOpen(true)}
            data-testid="spectrolite-files-trigger"
          >
            <ListBulletIcon /> Files
          </Button>
          {activePath ? (
            <Button
              size="1"
              variant="ghost"
              color="gray"
              onClick={() => setBacklinksOpen(true)}
              data-testid="spectrolite-backlinks-trigger"
            >
              <Link2Icon /> Backlinks
            </Button>
          ) : null}
          <IconButton
            size="2"
            variant="ghost"
            color="gray"
            aria-label="Workspace settings"
            onClick={() => setSettingsOpen(true)}
            data-testid="spectrolite-workspace-settings"
          >
            <DotsHorizontalIcon />
          </IconButton>
        </Flex>
      </Flex>

      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <EditorPane theme={theme} onOpenFiles={() => setFilesOpen(true)} />
      </Box>

      <CommitStrip />
      <ChannelDrawer />
      <AgentMessageNotifier />

      <FilesDrawer open={filesOpen} onOpenChange={setFilesOpen} />
      <BacklinksDrawer open={backlinksOpen} onOpenChange={setBacklinksOpen} />
      <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Flex>
  );
}

function MobileWorkspace({ theme, onQuickOpen }: { theme: "light" | "dark"; onQuickOpen: () => void }) {
  const repoRoot = useAppState((s) => s.repoRoot)!;
  const activeTitle = useActiveTitle();
  const activePath = useAppState((s) => s.activePath);
  const activeDirty = useAppState((s) => {
    const buffer = s.activePath ? s.buffers[s.activePath] : undefined;
    return buffer ? hasUnflushedChanges(buffer) : false;
  });
  const activeLastFlushed = useAppState((s) => (s.activePath ? s.lastFlushedAt[s.activePath] : undefined));
  const now = useNowTick();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commitSheetOpen, setCommitSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" gap="2" px="2" py="2" className="spectrolite-header" style={{ minHeight: 48 }}>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Open files"
          onClick={() => setSidebarOpen(true)}
        >
          <HamburgerMenuIcon />
        </IconButton>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2" weight="medium" truncate as="div" title={activePath ?? undefined}>
            {activeTitle ?? "Spectrolite"}
          </Text>
          {activeDirty ? (
            <Text size="1" color="amber">● unflushed</Text>
          ) : activeLastFlushed ? (
            <Text size="1" color="gray">flushed {formatTimeAgo(activeLastFlushed, now)}</Text>
          ) : (
            <Text size="1" color="gray" truncate as="div">{repoRoot.replace(/^\//, "")}</Text>
          )}
        </Box>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Quick open"
          onClick={onQuickOpen}
          data-testid="spectrolite-quick-open-trigger"
        >
          <MagnifyingGlassIcon />
        </IconButton>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Workspace settings"
          onClick={() => setSettingsSheetOpen(true)}
        >
          <DotsHorizontalIcon />
        </IconButton>
      </Flex>

      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <EditorPane theme={theme} mobile onOpenFiles={() => setSidebarOpen(true)} />
      </Box>

      <Flex
        align="center"
        gap="2"
        px="2"
        py="2"
        className="spectrolite-mobile-actions"
        data-testid="spectrolite-mobile-actions"
      >
        <MobileCommitButton onClick={() => setCommitSheetOpen(true)} />
      </Flex>

      <ChannelDrawer />
      <AgentMessageNotifier />

      <MobileSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)}>
        <Flex direction="column" style={{ height: "100%" }}>
          <Flex align="center" justify="between" px="2" py="2" style={{ borderBottom: "1px solid var(--gray-4)" }}>
            <Heading size="2">Files</Heading>
            <Button size="2" variant="ghost" color="gray" onClick={() => setSidebarOpen(false)} aria-label="Close files">
              Done
            </Button>
          </Flex>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <FileTree onOpened={() => setSidebarOpen(false)} />
          </Box>
          <Box style={{ maxHeight: "32vh", borderTop: "1px solid var(--gray-4)", overflow: "hidden" }}>
            <BacklinksPanel onOpened={() => setSidebarOpen(false)} />
          </Box>
        </Flex>
      </MobileSidebar>

      <BottomSheet open={commitSheetOpen} onOpenChange={setCommitSheetOpen} title="Commit">
        <CommitStrip mobile onCommitted={() => setCommitSheetOpen(false)} />
      </BottomSheet>

      <WorkspaceSettingsSheet open={settingsSheetOpen} onOpenChange={setSettingsSheetOpen} />
    </Flex>
  );
}
