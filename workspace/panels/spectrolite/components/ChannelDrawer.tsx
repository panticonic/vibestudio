/**
 * Minimal chat drawer for talking to resident agents OUTSIDE the document.
 *
 * Subscribes to the PubSubClient's event stream and filters for completed
 * agentic-trajectory messages (`kind: "message.completed"`). Most of the
 * back-and-forth happens via `kb.user_edit` messages and agent file edits —
 * this drawer is the escape hatch for free-form chat and for receiving
 * agent replies to prompts like "suggest a commit message".
 *
 * Unread tracking: the drawer remembers `lastReadAt` (initialised to mount
 * time so the replay backlog isn't counted) and bumps it whenever the
 * drawer opens. Agent messages newer than `lastReadAt` are surfaced as a
 * coloured unread badge on the toggle when the drawer is closed —
 * persistent, low-cost, and not space-consuming. The shell-level toast
 * notifier handles the "user is in another window" case separately.
 *
 * When an agent message is displayed, a "Use as commit msg" action is
 * surfaced if the parent provided `onUseAsCommitMessage` — closing the
 * commit-suggestion loop without copy-paste.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import { Badge, Box, Button, Card, Flex, IconButton, ScrollArea, Text, TextArea } from "@radix-ui/themes";
import { ChevronUpIcon, ChevronDownIcon, Cross2Icon, PaperPlaneIcon, CommitIcon } from "@radix-ui/react-icons";
import { useIsMobile, useViewportHeight } from "@workspace/react";
import { MessageContent } from "@workspace/agentic-chat";

interface DrawerMessage {
  id: string;
  senderId: string;
  senderHandle?: string;
  senderName?: string;
  senderType?: string;
  content: string;
  ts: number;
}

const MAX_DRAWER_MESSAGES = 50;

export interface ChannelDrawerProps {
  client: PubSubClient | null;
  onSend?: (content: string) => void;
  /** When provided, agent messages get a "Use as commit msg" button. */
  onUseAsCommitMessage?: (content: string) => void;
  /** Bump to programmatically open the drawer (e.g. from a notification click). */
  openSignal?: number;
}

export function ChannelDrawer({ client, onSend, onUseAsCommitMessage, openSignal }: ChannelDrawerProps) {
  const isMobile = useIsMobile();
  const viewportHeight = useViewportHeight();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<DrawerMessage[]>([]);
  // Initialise to mount time so replay backlog isn't counted as unread.
  const [lastReadAt, setLastReadAt] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Opening the drawer marks everything currently visible as read.
  useEffect(() => {
    if (open) setLastReadAt(Date.now());
  }, [open]);

  useEffect(() => {
    // Reset on client swap so messages from a previous channel don't
    // persist across reconnects / context switches.
    setMessages([]);
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const event of client.events({ includeReplay: true, includeSignals: false })) {
          if (cancelled) return;
          const wire = event as unknown as {
            type?: string;
            messageId?: string;
            senderId?: string;
            senderMetadata?: { handle?: string; name?: string; type?: string };
            ts?: number;
            payload?: { kind?: string; payload?: { content?: string; role?: string } };
          };
          if (wire.type !== "agentic.trajectory.v1/event") continue;
          const evt = wire.payload;
          if (!evt) continue;
          // We render only completed messages so partial streaming chunks
          // don't flicker into the drawer.
          if (evt.kind !== "message.completed") continue;
          const content = evt.payload?.content;
          if (typeof content !== "string" || !content) continue;
          const id = wire.messageId ?? `${wire.senderId ?? "?"}-${wire.ts ?? Date.now()}`;
          setMessages((prev) => {
            if (prev.some((m) => m.id === id)) return prev;
            const next: DrawerMessage[] = [
              ...prev,
              {
                id,
                senderId: wire.senderId ?? "?",
                senderHandle: wire.senderMetadata?.handle,
                senderName: wire.senderMetadata?.name,
                senderType: wire.senderMetadata?.type,
                content,
                ts: wire.ts ?? Date.now(),
              },
            ];
            return next.slice(-MAX_DRAWER_MESSAGES);
          });
        }
      } catch (err) {
        if (!cancelled) console.warn("[Spectrolite] channel event stream ended:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const mdxActions = useMemo(() => ({
    publishMessage: async (content: string) => {
      if (!client) return;
      await client.send(content);
      onSend?.(content);
    },
  }), [client, onSend]);

  const recent = useMemo(() => messages.slice(-MAX_DRAWER_MESSAGES), [messages]);
  const newestAgentMessage = useMemo(() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const m = recent[i]!;
      if (m.senderType && m.senderType !== "panel") return m;
    }
    return null;
  }, [recent]);

  // Unread = agent (non-panel) messages newer than lastReadAt.
  const unreadCount = useMemo(() => {
    if (open) return 0;
    return recent.filter((m) => m.ts > lastReadAt && m.senderType && m.senderType !== "panel").length;
  }, [recent, lastReadAt, open]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, recent.length]);

  // External "please open" signal — wired to AgentMessageNotifier so
  // clicking the toast opens the drawer where the user can read more.
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    setOpen(true);
  }, [openSignal]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !client) return;
    setSending(true);
    try {
      await client.send(content);
      setDraft("");
      onSend?.(content);
    } catch (err) {
      console.warn("[Spectrolite] send failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box
      style={{
        borderTop: "1px solid var(--gray-5)",
        background: "var(--color-panel-translucent)",
        flexShrink: 0,
      }}
    >
      <Flex
        align="center"
        justify="between"
        gap="2"
        px="3"
        py={isMobile ? "2" : "1"}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls="spectrolite-channel-drawer-body"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        style={{
          cursor: "pointer",
          borderBottom: open ? "1px solid var(--gray-5)" : "none",
          outline: "none",
          minHeight: isMobile ? 44 : undefined,
        }}
        className="spectrolite-drawer-toggle"
      >
        <Flex align="center" gap="2">
          {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          <Text size={isMobile ? "2" : "1"} color="gray" weight="medium">Channel</Text>
          {!open && unreadCount > 0 ? (
            <Badge color="amber" variant="soft" size={isMobile ? "2" : "1"}>
              {unreadCount} new
            </Badge>
          ) : null}
          {!open && unreadCount === 0 && recent.length > 0 ? (
            <Text size="1" color="gray">· {recent.length} messages</Text>
          ) : null}
        </Flex>
        {open && isMobile ? (
          <IconButton size="2" variant="ghost" color="gray" aria-label="Close channel" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
            <Cross2Icon />
          </IconButton>
        ) : null}
      </Flex>
      {open ? (
        // On mobile, give the drawer most of the available viewport
        // height (clamped so it doesn't cover the editor entirely);
        // useViewportHeight makes this shrink when the virtual keyboard
        // is up so the textarea + send button stay on-screen.
        <Flex
          id="spectrolite-channel-drawer-body"
          direction="column"
          gap="2"
          p="2"
          style={{
            maxHeight: isMobile ? Math.min(viewportHeight * 0.6, 480) : "30vh",
          }}
        >
          <Box ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <ScrollArea>
              <Flex direction="column" gap="1">
                {recent.length === 0 ? (
                  <Text size="1" color="gray">No messages yet.</Text>
                ) : (
                  recent.map((m) => {
                    const isAgent = m.senderType && m.senderType !== "panel";
                    const isNewestAgentMsg = isAgent && newestAgentMessage?.id === m.id;
                    return (
                      <Card key={m.id} size="1">
                        <Flex direction="column" gap="1">
                          <Flex align="center" justify="between" gap="2">
                            <Text size="1" color="gray" weight="medium">
                              @{m.senderHandle ?? m.senderName ?? m.senderId}
                            </Text>
                            {isNewestAgentMsg && onUseAsCommitMessage ? (
                              <Button
                                size="1"
                                variant="ghost"
                                onClick={() => onUseAsCommitMessage(m.content)}
                                title="Copy this reply into the commit message field"
                              >
                                <CommitIcon /> Use as commit msg
                              </Button>
                            ) : null}
                          </Flex>
                          <Box style={{ fontSize: "var(--font-size-1)" }}>
                            <MessageContent content={m.content} isStreaming={false} mdxActions={mdxActions} />
                          </Box>
                        </Flex>
                      </Card>
                    );
                  })
                )}
              </Flex>
            </ScrollArea>
          </Box>
          <Flex gap="2" align="end" style={{ flexShrink: 0 }}>
            <TextArea
              size={isMobile ? "2" : "1"}
              placeholder="Talk to the agents…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              style={{ flex: 1 }}
              rows={isMobile ? 2 : 2}
            />
            <Button
              size={isMobile ? "3" : "1"}
              variant="soft"
              disabled={!draft.trim() || sending || !client}
              onClick={() => void send()}
              aria-label="Send"
              style={isMobile ? { minHeight: 44, minWidth: 44 } : undefined}
            >
              <PaperPlaneIcon />
            </Button>
          </Flex>
        </Flex>
      ) : null}
    </Box>
  );
}
