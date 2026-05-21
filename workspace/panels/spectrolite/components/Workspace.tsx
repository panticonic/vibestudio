/**
 * Top-level layout for Spectrolite.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Header: title + flush status + agent roster                    │
 *   ├──────────┬─────────────────────────────────────────────────────┤
 *   │ FileTree │ DocumentEditor (Edit ↔ Preview)                     │
 *   │ Backlnks │                                                     │
 *   ├──────────┴─────────────────────────────────────────────────────┤
 *   │ CommitStrip                                                    │
 *   ├────────────────────────────────────────────────────────────────┤
 *   │ ChannelDrawer (collapsed by default)                           │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Owns:
 *   - active-file state + file-buffer map
 *   - PubSubClient lifecycle
 *   - flush controller
 *   - publishing kb.user_edit messages (+ enriched parallel send on mention)
 *   - commit-message state shared between drawer and CommitStrip
 *   - wikilink resolution + create-on-click
 *   - frontmatter title extraction for the breadcrumb
 *   - empty-state onboarding (creates a starter doc)
 */

import { promises as fs } from "fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, Heading, Text, Theme } from "@radix-ui/themes";
import { CheckCircledIcon, FilePlusIcon, LightningBoltIcon } from "@radix-ui/react-icons";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { rpc, recoveryCoordinator, useStateArgs, setStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import type { AvailableAgent } from "../bootstrap";
import { listAvailableAgents } from "../bootstrap";
import { FileTree } from "./FileTree";
import { DocumentEditor, writeBufferToDisk } from "./DocumentEditor";
import { ChannelDrawer } from "./ChannelDrawer";
import { CommitStrip } from "./CommitStrip";
import { AgentRoster, type RosterAgent } from "./AgentRoster";
import { BacklinksPanel } from "./BacklinksPanel";
import type { MentionCandidate } from "./MentionAutocomplete";
import { createFlushController } from "../flush/flush-controller";
import { buildFlushPayload } from "../flush/diff";
import { createBufferEntry, hasUnflushedChanges, type FileBufferEntry } from "../state/fileBuffer";
import { KB_USER_EDIT_TYPE, registerSpectroliteMessageTypes } from "../messages/register";
import { WikilinkContext } from "../mdx/components";
import { resolveWikilinkTarget, wikilinksFromJsx } from "../mdx/wikilink";

export interface WorkspaceProps {
  channelName: string;
  channelContextId: string;
  repoRoot: string;
  primaryAgentHandle?: string;
  onAddAgent: (agentId: string) => Promise<void>;
  onRemoveAgent: (handle: string) => Promise<void>;
}

const PANEL_METADATA = {
  name: "Spectrolite",
  type: "panel" as const,
  handle: "spectrolite",
};

interface SpectroliteStateArgs {
  openPath?: string;
  channelName?: string;
  contextId?: string;
  pendingAgents?: Array<{ handle: string }>;
}

const SAMPLE_DOC_NAME = "Welcome.mdx";

const SAMPLE_DOC = `---
title: Welcome to Spectrolite
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

Delete this file or replace its contents when you're ready.
`;

const FRONTMATTER_TITLE_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const TITLE_LINE_RE = /^title:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m;

function readFrontmatterTitle(markdown: string): string | null {
  const m = FRONTMATTER_TITLE_RE.exec(markdown);
  if (!m) return null;
  const titleMatch = TITLE_LINE_RE.exec(m[1] ?? "");
  if (!titleMatch) return null;
  return (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? "").trim() || null;
}

function pathToTitle(relPath: string): string {
  const name = relPath.split("/").pop() ?? relPath;
  return name.replace(/\.mdx$/, "");
}

function formatTimeAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "just now";
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function Workspace({
  channelName,
  channelContextId,
  repoRoot,
  primaryAgentHandle,
  onAddAgent,
  onRemoveAgent,
}: WorkspaceProps) {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<SpectroliteStateArgs>();
  const [client, setClient] = useState<PubSubClient | null>(null);
  const [activePath, setActivePath] = useState<string | null>(stateArgs.openPath ?? null);
  const [buffers, setBuffers] = useState<Record<string, FileBufferEntry>>({});
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [lastFlushedAt, setLastFlushedAt] = useState<Record<string, number>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const pathsRef = useRef(workspacePaths);
  pathsRef.current = workspacePaths;

  // Tick every 5s so "flushed Ns ago" stays fresh
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // Connect to the channel
  useEffect(() => {
    let cancelled = false;
    const c = connectViaRpc({
      rpc,
      channel: channelName,
      contextId: channelContextId,
      metadata: PANEL_METADATA,
      recoveryCoordinator,
    });
    void c.ready().then(() => registerSpectroliteMessageTypes(c)).catch((err) => {
      console.warn("[Spectrolite] message type registration failed:", err);
    });
    if (!cancelled) setClient(c);
    return () => {
      cancelled = true;
      c.close();
    };
  }, [channelName, channelContextId]);

  useEffect(() => {
    if (!client) return;
    const unsubscribe = client.onRoster(() => {
      const next: RosterAgent[] = [];
      for (const p of Object.values(client.roster)) {
        const meta = p.metadata as { handle?: string; type?: string };
        if (meta.type === "panel") continue;
        if (!meta.handle) continue;
        next.push({ handle: meta.handle, participantId: p.id, status: "live" });
      }
      setRoster(next);
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => { void listAvailableAgents().then(setAvailableAgents).catch(() => {}); }, []);

  useEffect(() => {
    if (activePath && activePath !== stateArgs.openPath) {
      void setStateArgs({ openPath: activePath });
    }
  }, [activePath, stateArgs.openPath]);

  // Flush: write buffer to disk, compute diff vs lastFlushedMdx, publish
  // kb.user_edit, then if @-mentions resolved send a parallel chat message
  // with the diff inlined so the agent has full context for its response.
  const flush = useCallback(async (relPath: string) => {
    const c = client;
    const entry = buffersRef.current[relPath];
    if (!entry || !c) return;
    if (!hasUnflushedChanges(entry)) return;

    const before = entry.lastFlushedMdx;
    const after = entry.currentMdx;
    try {
      await writeBufferToDisk(repoRoot, relPath, after);
    } catch (err) {
      console.warn(`[Spectrolite] write failed for ${relPath}:`, err);
      return;
    }

    const knownHandles = Object.values(c.roster)
      .map((p) => (p.metadata as { handle?: string }).handle)
      .filter((h): h is string => Boolean(h) && h !== PANEL_METADATA.handle);
    const beforeOnDisk = wikilinksFromJsx(before);
    const afterOnDisk = wikilinksFromJsx(after);
    const payload = buildFlushPayload({ path: relPath, before: beforeOnDisk, after: afterOnDisk, knownHandles });
    if (!payload) return;

    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) return prev;
      return { ...prev, [relPath]: { ...cur, savedMdx: after, lastFlushedMdx: after } };
    });
    setLastFlushedAt((prev) => ({ ...prev, [relPath]: payload.at }));

    try {
      await c.publishCustomMessage({
        typeId: KB_USER_EDIT_TYPE,
        initialState: {
          path: relPath,
          unifiedDiff: payload.unifiedDiff,
          addedLines: payload.addedLines,
          removedLines: payload.removedLines,
          mentions: payload.mentions,
          at: payload.at,
          editorContextId: channelContextId,
        },
        displayMode: "row",
      });
    } catch (err) {
      console.warn("[Spectrolite] kb.user_edit publish failed:", err);
    }

    // Mentioned-agent fast path: send a normal chat message with the diff
    // inlined so the agent's mention-respond policy fires AND it has full
    // context without having to re-read the file.
    if (payload.mentions.length > 0) {
      try {
        const handles = payload.mentions.map((h) => `@${h}`).join(" ");
        const message = [
          `${handles} I just edited \`${relPath}\`. Diff:`,
          "```diff",
          payload.unifiedDiff,
          "```",
        ].join("\n");
        await c.send(message, { mentions: payload.mentions });
      } catch (err) {
        console.warn("[Spectrolite] mention send failed:", err);
      }
    }
  }, [client, repoRoot, channelContextId]);

  const flushController = useMemo(() => createFlushController({ onFlush: flush }), [flush]);
  useEffect(() => () => flushController.dispose(), [flushController]);

  const handleEditorChange = useCallback((relPath: string, next: string) => {
    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) return prev;
      if (cur.currentMdx === next) return prev;
      return { ...prev, [relPath]: { ...cur, currentMdx: next } };
    });
    flushController.noteChange(relPath);
  }, [flushController]);

  const handleEditorReload = useCallback((relPath: string, content: string) => {
    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) {
        return { ...prev, [relPath]: createBufferEntry(relPath, content) };
      }
      return {
        ...prev,
        [relPath]: { ...cur, savedMdx: content, currentMdx: content, lastFlushedMdx: content },
      };
    });
  }, []);

  const handleFlushClick = useCallback((relPath: string) => {
    flushController.flushNow(relPath);
  }, [flushController]);

  // Create-on-click for unresolved wikilinks: create a stub MDX file at the
  // repo root, refresh the path index, and open the new file.
  const createFileAt = useCallback(async (relPath: string, initialContent: string): Promise<string | null> => {
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const full = `${repoRoot}/${finalPath}`;
    const lastSlash = full.lastIndexOf("/");
    if (lastSlash > 0) {
      try { await fs.mkdir(full.slice(0, lastSlash), { recursive: true }); } catch { /* ignore */ }
    }
    try {
      await fs.writeFile(full, initialContent);
      setRefreshNonce((n) => n + 1);
      return finalPath;
    } catch (err) {
      console.warn(`[Spectrolite] create failed for ${finalPath}:`, err);
      return null;
    }
  }, [repoRoot]);

  const activeBuffer = activePath ? buffers[activePath] : undefined;
  const activeDirty = activeBuffer ? hasUnflushedChanges(activeBuffer) : false;
  const activeTitle = activeBuffer ? (readFrontmatterTitle(activeBuffer.currentMdx) ?? (activePath ? pathToTitle(activePath) : null)) : null;
  const activeLastFlushed = activePath ? lastFlushedAt[activePath] : undefined;

  const mentionCandidates: MentionCandidate[] = useMemo(() => roster.map((a) => ({ handle: a.handle })), [roster]);

  // Wikilink context — resolves [[Page]] to a path, opens it, OR creates
  // a stub when no match exists (Obsidian-style click-to-create).
  const wikilinkContext = useMemo(() => ({
    resolve: (target: string) => resolveWikilinkTarget(target, pathsRef.current),
    open: (path: string) => setActivePath(path),
    openOrCreate: async (target: string) => {
      const resolved = resolveWikilinkTarget(target, pathsRef.current);
      if (resolved) {
        setActivePath(resolved);
        return;
      }
      const created = await createFileAt(target, `# ${target}\n\n`);
      if (created) setActivePath(created);
    },
  }), [createFileAt]);

  const handleCreateWelcomeDoc = useCallback(async () => {
    const created = await createFileAt(SAMPLE_DOC_NAME, SAMPLE_DOC);
    if (created) setActivePath(created);
  }, [createFileAt]);

  return (
    <Theme appearance={theme} radius="medium" style={{ height: "100dvh" }}>
      <WikilinkContext.Provider value={wikilinkContext}>
        <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
          <Flex
            align="center"
            justify="between"
            gap="3"
            px="3"
            py="2"
            style={{ borderBottom: "1px solid var(--gray-5)", flexShrink: 0 }}
          >
            <Flex align="center" gap="2">
              <Heading size="3">Spectrolite</Heading>
              {activeTitle ? <Text size="1" color="gray">/ {activeTitle}</Text> : null}
              {activeDirty ? (
                <Flex align="center" gap="1" title="Unflushed edits">
                  <LightningBoltIcon color="orange" />
                  <Text size="1" color="amber">unflushed</Text>
                </Flex>
              ) : activeLastFlushed ? (
                <Flex align="center" gap="1" title={`Last flushed at ${new Date(activeLastFlushed).toLocaleString()}`}>
                  <CheckCircledIcon color="green" />
                  <Text size="1" color="gray">flushed {formatTimeAgo(activeLastFlushed, nowTick)}</Text>
                </Flex>
              ) : null}
            </Flex>
            <AgentRoster
              agents={roster}
              availableAgents={availableAgents}
              onAdd={async (id) => { await onAddAgent(id); }}
              onRemove={async (handle) => { await onRemoveAgent(handle); }}
            />
          </Flex>
          <Flex style={{ flex: 1, minHeight: 0 }}>
            <Flex direction="column" style={{ width: 260, borderRight: "1px solid var(--gray-5)", flexShrink: 0 }}>
              <Box style={{ flex: 1, minHeight: 0 }}>
                <FileTree
                  root={repoRoot}
                  activePath={activePath}
                  onOpen={setActivePath}
                  refreshNonce={refreshNonce}
                  onPathsRefreshed={setWorkspacePaths}
                />
              </Box>
              <BacklinksPanel
                root={repoRoot}
                activePath={activePath}
                paths={workspacePaths}
                refreshKey={refreshNonce}
                onOpen={setActivePath}
              />
            </Flex>
            <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              {activePath ? (
                <DocumentEditor
                  repoRoot={repoRoot}
                  relPath={activePath}
                  theme={theme}
                  onChange={handleEditorChange}
                  onReload={handleEditorReload}
                  onFlushClick={handleFlushClick}
                  hasUnflushedChanges={activeDirty}
                  mentionCandidates={mentionCandidates}
                />
              ) : workspacePaths.length === 0 ? (
                <EmptyState onCreateWelcomeDoc={handleCreateWelcomeDoc} agentHandle={roster[0]?.handle ?? primaryAgentHandle} />
              ) : (
                <Flex align="center" justify="center" style={{ height: "100%" }}>
                  <Text size="2" color="gray">
                    Select a file from the sidebar to start editing.
                  </Text>
                </Flex>
              )}
            </Box>
          </Flex>
          <CommitStrip
            repoRoot={repoRoot}
            client={client}
            primaryAgentHandle={primaryAgentHandle ?? roster[0]?.handle}
            onCommitted={() => setRefreshNonce((n) => n + 1)}
            message={commitMessage}
            onMessageChange={setCommitMessage}
          />
          <ChannelDrawer
            client={client}
            onUseAsCommitMessage={setCommitMessage}
          />
        </Flex>
      </WikilinkContext.Provider>
    </Theme>
  );
}

function EmptyState({ onCreateWelcomeDoc, agentHandle }: { onCreateWelcomeDoc: () => void; agentHandle?: string }) {
  return (
    <Flex align="center" justify="center" style={{ height: "100%" }} p="6">
      <Flex direction="column" align="center" gap="3" style={{ maxWidth: 520, textAlign: "center" }}>
        <Heading size="4">Welcome to Spectrolite</Heading>
        <Text size="2" color="gray">
          A live MDX knowledge base with a resident editing agent
          {agentHandle ? <> — <Text weight="medium">@{agentHandle}</Text> is already in the room.</> : ""}
        </Text>
        <Text size="2" color="gray">
          Edit prose inline, @-mention the agent in the document, click <strong>Flush</strong>
          (or pause for 1.5 s) to share the diff. The agent edits the file
          directly — you see the changes appear in the editor.
        </Text>
        <Button onClick={onCreateWelcomeDoc} variant="solid">
          <FilePlusIcon /> Create starter note
        </Button>
        <Text size="1" color="gray">
          Or use the <strong>+ New</strong> field in the sidebar to make your own.
        </Text>
      </Flex>
    </Flex>
  );
}
