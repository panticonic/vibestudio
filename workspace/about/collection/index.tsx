/**
 * Collection — a recursive panel subtree with a resident orchestration agent.
 *
 * The panel tree remains the source of truth. The collection UI and its agent
 * both read the same revisioned subtree; chat is part of this panel rather than
 * a synthetic child that pollutes the collection being supervised.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  IconButton,
  Spinner,
  Text,
  TextArea,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  Cross2Icon,
  EnterIcon,
  MagicWandIcon,
  Pencil1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { contextId, panel, panelTree, rpc, type PanelHandle } from "@workspace/runtime";
import { recoveryCoordinator } from "@workspace/runtime/internal/diagnostics";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import { createPanelSandboxConfig, launchAgentIntoChannel } from "@workspace/agentic-core";
import type { AgenticChatHandle } from "@workspace/agentic-chat";
import type { ConnectionConfig } from "@workspace/agentic-chat/types";
import {
  buildCollectionAgentSystemPrompt,
  COLLECTION_AGENT_CLASS,
  COLLECTION_AGENT_HANDLE,
  COLLECTION_AGENT_SOURCE,
  createCollectionSession,
  promptForCollectionStartupTask,
  type CollectionSessionDescriptor,
} from "@workspace/collection-orchestration";
import "@radix-ui/themes/styles.css";
import "@workspace/agentic-chat/styles.css";
import "@workspace/ui/tokens.css";
import { withMemberNote, type CollectionStateArgs } from "./collection";
import "./style.css";

const AgenticChat = lazy(() =>
  import("@workspace/agentic-chat/chat").then((module) => ({ default: module.AgenticChat }))
);

function requireContextId(value: string | undefined): string {
  const resolved = value?.trim();
  if (!resolved) throw new Error("Collection panel runtime has no workspace context");
  return resolved;
}

interface CollectionTreeNode {
  handle: PanelHandle;
  depth: number;
  childCount: number;
}

interface CollectionStoredNode {
  handle: PanelHandle;
  parentSlotId: string;
  childCount: number;
}

interface CollectionPendingPage {
  parentSlotId: string;
  cursor?: string;
}

interface CollectionTreeState {
  revision: number;
  nodes: CollectionStoredNode[];
  pending: CollectionPendingPage[];
}

function nodeLabel(node: CollectionTreeNode): string {
  return node.handle.title || node.handle.source;
}

function flattenCollectionNodes(
  rootPanelId: string,
  nodes: readonly CollectionStoredNode[]
): CollectionTreeNode[] {
  const children = new Map<string, CollectionStoredNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentSlotId) ?? [];
    siblings.push(node);
    children.set(node.parentSlotId, siblings);
  }
  const flattened: CollectionTreeNode[] = [];
  const visited = new Set<string>();
  const visit = (parentSlotId: string, depth: number) => {
    for (const node of children.get(parentSlotId) ?? []) {
      if (visited.has(node.handle.id)) continue;
      visited.add(node.handle.id);
      flattened.push({ handle: node.handle, childCount: node.childCount, depth });
      visit(node.handle.id, depth + 1);
    }
  };
  visit(rootPanelId, 1);
  return flattened;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function MemberNoteEditor(props: { value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(props.value);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(props.value);
  }, [props.value]);

  return (
    <TextField.Root
      mt="2"
      size="1"
      placeholder="Note for the conductor"
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        editing.current = false;
        props.onCommit(draft);
      }}
    />
  );
}

export default function CollectionPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<CollectionStateArgs>();
  const resolvedContextId = requireContextId(contextId);
  const [title, setTitle] = useState(stateArgs.title ?? "Collection");
  const [editingTitle, setEditingTitle] = useState(false);
  const [note, setNote] = useState(stateArgs.note ?? "");
  const [notes, setNotes] = useState<Record<string, string>>(stateArgs.notes ?? {});
  const [tree, setTree] = useState<CollectionTreeState | null>(null);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const [agentLaunchAttempt, setAgentLaunchAttempt] = useState(0);
  const [sending, setSending] = useState<string | null>(null);
  const [session] = useState<CollectionSessionDescriptor>(() => {
    const created = createCollectionSession();
    return {
      channelName: stateArgs.channelName ?? created.channelName,
      agentKey: stateArgs.agentKey ?? created.agentKey,
    };
  });
  const initialPrompt = useRef(
    stateArgs.initialPrompt ??
      (stateArgs.startupTask ? promptForCollectionStartupTask(stateArgs.startupTask) : undefined)
  );
  const chatRef = useRef<AgenticChatHandle | null>(null);
  const editingTitleRef = useRef(false);
  const savingTitleRef = useRef(false);
  const editingNoteRef = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const persist = useCallback(
    (patch: Partial<CollectionStateArgs>) => panel.stateArgs.set(patch),
    []
  );

  useEffect(() => {
    if (stateArgs.channelName === session.channelName && stateArgs.agentKey === session.agentKey) {
      return;
    }
    void persist({ channelName: session.channelName, agentKey: session.agentKey }).catch((cause) =>
      setError(errorMessage(cause))
    );
  }, [persist, session, stateArgs.agentKey, stateArgs.channelName]);

  // The creator passes the label through stateArgs; keep the slot's semantic
  // title explicit so a nested collection remains intelligible in its parent.
  const titledFor = useRef<string | null>(null);
  useEffect(() => {
    const wanted = stateArgs.title?.trim();
    if (!wanted || titledFor.current === wanted) return;
    titledFor.current = wanted;
    setTitle(wanted);
    void panel.setTitle(wanted, { explicit: true }).catch((cause) => setError(errorMessage(cause)));
  }, [stateArgs.title]);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const pending = (async () => {
      try {
        const [page, persisted] = await Promise.all([
          panelTree.page({
            group: { kind: "children", parentSlotId: panel.slotId },
            limit: 50,
          }),
          panelTree.get(panel.slotId).stateArgs.get<CollectionStateArgs>(),
        ]);
        const nodes = page.entries.map((entry) => ({
          handle: entry.handle,
          parentSlotId: panel.slotId,
          childCount: entry.node.childCount,
        }));
        const pending: CollectionPendingPage[] = [
          ...(page.nextCursor ? [{ parentSlotId: panel.slotId, cursor: page.nextCursor }] : []),
          ...page.entries
            .filter((entry) => entry.node.childCount > 0)
            .map((entry) => ({ parentSlotId: entry.node.slotId })),
        ];
        setTree((current) =>
          current?.revision === page.revision
            ? current
            : { revision: page.revision, nodes, pending }
        );
        const persistedNotes = persisted.notes ?? {};
        setNotes((current) =>
          JSON.stringify(current) === JSON.stringify(persistedNotes) ? current : persistedNotes
        );
        if (!editingTitleRef.current && !savingTitleRef.current && persisted.title?.trim()) {
          setTitle(persisted.title.trim());
        }
        if (!editingNoteRef.current) {
          setNote(persisted.note ?? "");
        }
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    })();
    refreshInFlight.current = pending;
    void pending.finally(() => {
      if (refreshInFlight.current === pending) refreshInFlight.current = null;
    });
    return pending;
  }, []);

  const loadMoreMembers = useCallback(async () => {
    const task = tree?.pending[0];
    if (!task || loadingMembers || (tree?.nodes.length ?? 0) >= 500) return;
    setLoadingMembers(true);
    try {
      const page = await panelTree.page({
        group: { kind: "children", parentSlotId: task.parentSlotId },
        ...(task.cursor ? { cursor: task.cursor } : {}),
        limit: 50,
      });
      if (page.revision !== tree.revision) {
        await refresh();
        return;
      }
      setTree((current) => {
        if (!current || current.revision !== page.revision || current.pending[0] !== task) {
          return current;
        }
        const room = Math.max(0, 500 - current.nodes.length);
        const entries = page.entries.slice(0, room);
        return {
          revision: page.revision,
          nodes: [
            ...current.nodes,
            ...entries.map((entry) => ({
              handle: entry.handle,
              parentSlotId: task.parentSlotId,
              childCount: entry.node.childCount,
            })),
          ],
          pending: [
            ...current.pending.slice(1),
            ...(page.nextCursor
              ? [
                  {
                    parentSlotId: task.parentSlotId,
                    cursor: page.nextCursor,
                  },
                ]
              : []),
            ...entries
              .filter((entry) => entry.node.childCount > 0)
              .map((entry) => ({
                parentSlotId: entry.node.slotId,
              })),
          ],
        };
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMembers(false);
    }
  }, [loadingMembers, refresh, tree]);

  useEffect(() => {
    void refresh();
    const unsubscribe = panel.onChildCreated(() => void refresh());
    return unsubscribe;
  }, [refresh]);

  // Mutations may originate in the resident agent or another client. Revision
  // comparison makes this a cheap convergence fallback; the authoritative
  // recursive snapshot, rather than local incremental bookkeeping, wins.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const descendants = useMemo(
    () => flattenCollectionNodes(panel.slotId, tree?.nodes ?? []),
    [tree, panel.slotId]
  );

  const systemPrompt = useMemo(
    () => buildCollectionAgentSystemPrompt({ rootPanelId: panel.slotId, title }),
    [title]
  );

  // A collection owns one resident general-purpose agent. Re-subscribing the
  // stable key is the recovery path as well as first bootstrap.
  useEffect(() => {
    let cancelled = false;
    setAgentReady(false);
    setAgentError(null);
    void launchAgentIntoChannel(rpc, {
      source: COLLECTION_AGENT_SOURCE,
      className: COLLECTION_AGENT_CLASS,
      key: session.agentKey,
      channelId: session.channelName,
      contextId: resolvedContextId,
      replay: true,
      config: {
        handle: COLLECTION_AGENT_HANDLE,
        name: "Collection conductor",
        systemPrompt,
        systemPromptMode: "append",
        ...(stateArgs.agentConfig ?? {}),
      },
    })
      .then(() => {
        if (!cancelled) setAgentReady(true);
      })
      .catch((cause) => {
        if (!cancelled) setAgentError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    resolvedContextId,
    session.agentKey,
    session.channelName,
    stateArgs.agentConfig,
    systemPrompt,
    agentLaunchAttempt,
  ]);

  const commitTitle = () => {
    if (!editingTitleRef.current) return;
    const next = title.trim() || "Collection";
    editingTitleRef.current = false;
    savingTitleRef.current = true;
    setTitle(next);
    setEditingTitle(false);
    void Promise.all([persist({ title: next }), panel.setTitle(next, { explicit: true })])
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => {
        savingTitleRef.current = false;
        void refresh();
      });
  };

  const setMemberNote = async (panelId: string, value: string) => {
    try {
      const root = panelTree.get(panel.slotId);
      const persisted = await root.stateArgs.get<CollectionStateArgs>();
      const next = withMemberNote(persisted.notes, panelId, value);
      setNotes(next);
      await root.stateArgs.set({ notes: next });
    } catch (cause) {
      setError(errorMessage(cause));
      await refresh();
    }
  };

  const sendAgentMessage = useCallback(async (message: string, key: string) => {
    setSending(key);
    setAgentError(null);
    try {
      const chat = chatRef.current;
      if (!chat) throw new Error("Collection conductor chat is not ready");
      await chat.send(message);
    } catch (cause) {
      setAgentError(errorMessage(cause));
    } finally {
      setSending(null);
    }
  }, []);

  const investigate = (node?: CollectionTreeNode) => {
    const message = node
      ? `Focus on panel \`${node.handle.id}\` ("${nodeLabel(node)}") within this collection. Refresh the recursive scope, inspect it in context, and help me understand or improve it.`
      : "Refresh this collection's recursive scope, inspect its current organization and panel state, and suggest or perform the most useful cleanup. Preserve intentional structure and explain any material changes.";
    void sendAgentMessage(message, node?.handle.id ?? "collection");
  };

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      await refresh();
    }
  };

  const config = useMemo<ConnectionConfig>(
    () => ({ clientId: panel.slotId, rpc, recoveryCoordinator }),
    []
  );
  const sandbox = useMemo(() => createPanelSandboxConfig(rpc), []);

  return (
    <Theme appearance={theme} accentColor="iris" radius="medium" style={{ height: "100dvh" }}>
      <Flex direction="column" gap="3" p="4" className="collection-shell">
        <Flex justify="between" align="center" gap="2">
          {editingTitle ? (
            <TextField.Root
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTitle();
                if (event.key === "Escape") {
                  setTitle(stateArgs.title ?? "Collection");
                  setEditingTitle(false);
                  editingTitleRef.current = false;
                }
              }}
              style={{ flex: 1 }}
            />
          ) : (
            <Flex align="center" gap="2" style={{ minWidth: 0 }}>
              <Heading size="5" truncate>
                {title}
              </Heading>
              <IconButton
                size="1"
                variant="ghost"
                aria-label="Rename collection"
                onClick={() => {
                  editingTitleRef.current = true;
                  setEditingTitle(true);
                }}
              >
                <Pencil1Icon />
              </IconButton>
              {tree ? (
                <Badge color="gray" title={`Tree revision ${tree.revision}`}>
                  {tree.nodes.length} loaded
                </Badge>
              ) : null}
            </Flex>
          )}
          <Flex align="center" gap="2">
            <IconButton
              size="1"
              variant="ghost"
              aria-label="Refresh"
              onClick={() => void refresh()}
            >
              <ReloadIcon />
            </IconButton>
            <Button
              size="2"
              variant="soft"
              onClick={() => investigate()}
              disabled={!agentReady || sending !== null}
            >
              {sending === "collection" ? <Spinner size="1" /> : <MagicWandIcon />} Organize
            </Button>
          </Flex>
        </Flex>

        {stateArgs.origin ? (
          <Text size="1" color="gray">
            From {stateArgs.origin}
          </Text>
        ) : null}

        <TextArea
          placeholder="Collection goal, context, or constraints. The resident conductor uses these notes."
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          onFocus={() => {
            editingNoteRef.current = true;
          }}
          onBlur={() => {
            void persist({ note })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => {
                editingNoteRef.current = false;
                void refresh();
              });
          }}
          rows={2}
        />

        {error ? (
          <Text color="red" size="1">
            {error}
          </Text>
        ) : null}

        <Box className="collection-workspace">
          <Flex direction="column" gap="2" className="collection-tree">
            <Flex align="center" gap="2">
              <Heading size="3">Panel tree</Heading>
              {tree ? <Badge color="gray">revision {tree.revision}</Badge> : null}
            </Flex>

            {!tree ? <Spinner size="2" /> : null}
            {tree?.nodes.length === 0 ? (
              <Card>
                <Text size="2" color="gray">
                  Nothing collected yet. Child panels appear here recursively and are immediately
                  available to the resident conductor.
                </Text>
              </Card>
            ) : null}

            {descendants.map((node) => (
              <Card
                key={node.handle.id}
                className="collection-tree-node"
                style={{ marginLeft: Math.min(node.depth - 1, 5) * 14 }}
              >
                <Flex align="center" gap="2">
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Flex align="center" gap="1">
                      <Text as="div" size="2" weight="medium" truncate>
                        {nodeLabel(node)}
                      </Text>
                      {node.childCount > 0 ? (
                        <Badge size="1" color="iris">
                          {node.childCount}
                        </Badge>
                      ) : null}
                    </Flex>
                    <Text as="div" size="1" color="gray" truncate>
                      {node.handle.source}
                    </Text>
                  </Box>
                  <Tooltip content="Focus this panel">
                    <IconButton
                      size="1"
                      variant="soft"
                      aria-label="Focus panel"
                      onClick={() => void act(() => node.handle.focus())}
                    >
                      <EnterIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="Ask the conductor about this panel">
                    <IconButton
                      size="1"
                      variant="soft"
                      aria-label="Investigate panel"
                      disabled={!agentReady || sending !== null}
                      onClick={() => investigate(node)}
                    >
                      {sending === node.handle.id ? <Spinner size="1" /> : <ChatBubbleIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="Close this panel and its descendants">
                    <IconButton
                      size="1"
                      variant="soft"
                      color="red"
                      aria-label="Close panel"
                      onClick={() => void act(() => node.handle.close())}
                    >
                      <Cross2Icon />
                    </IconButton>
                  </Tooltip>
                </Flex>
                <MemberNoteEditor
                  value={notes[node.handle.id] ?? ""}
                  onCommit={(value) => void setMemberNote(node.handle.id, value)}
                />
              </Card>
            ))}
            {tree && tree.pending.length > 0 ? (
              <Button
                size="1"
                variant="ghost"
                disabled={loadingMembers || tree.nodes.length >= 500}
                onClick={() => void loadMoreMembers()}
              >
                {tree.nodes.length >= 500
                  ? "500-panel view limit reached"
                  : loadingMembers
                    ? "Loading…"
                    : "Load more panels"}
              </Button>
            ) : null}
          </Flex>

          <Box className="collection-chat">
            <Flex align="center" justify="between" px="3" py="2" className="collection-chat-header">
              <Flex align="center" gap="2">
                <ChatBubbleIcon />
                <Heading size="3">Conductor</Heading>
                <Badge color={agentReady ? "green" : agentError ? "red" : "gray"}>
                  {agentReady ? "ready" : agentError ? "error" : "starting"}
                </Badge>
                {agentError ? (
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => setAgentLaunchAttempt((attempt) => attempt + 1)}
                  >
                    <ReloadIcon /> Retry
                  </Button>
                ) : null}
              </Flex>
            </Flex>
            {agentError ? (
              <Box px="3" py="2">
                <Text color="red" size="1">
                  {agentError}
                </Text>
              </Box>
            ) : null}
            {agentReady ? (
              <Suspense
                fallback={
                  <Flex align="center" justify="center" style={{ height: "100%" }}>
                    <Spinner />
                  </Flex>
                }
              >
                <AgenticChat
                  ref={chatRef}
                  config={config}
                  channelName={session.channelName}
                  contextId={resolvedContextId}
                  metadata={{
                    name: `${title} conductor`,
                    type: "panel",
                    handle: "collection",
                  }}
                  theme={theme}
                  installedAgents={[
                    { agentId: COLLECTION_AGENT_CLASS, handle: COLLECTION_AGENT_HANDLE },
                  ]}
                  initialPrompt={initialPrompt.current}
                  forceInitialPrompt={Boolean(stateArgs.startupTask)}
                  sandbox={sandbox}
                />
              </Suspense>
            ) : (
              <Flex align="center" justify="center" gap="2" className="collection-chat-loading">
                <Spinner />
                <Text size="2" color="gray">
                  Starting the collection conductor…
                </Text>
              </Flex>
            )}
          </Box>
        </Box>
      </Flex>
    </Theme>
  );
}
