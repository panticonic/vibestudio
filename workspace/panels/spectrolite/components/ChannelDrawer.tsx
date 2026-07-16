/**
 * Channel dock — collapsed bar at the bottom of the workspace that
 * expands into the free-form chat with the resident agents.
 *
 * Messages come from the app store (the session controller is the single
 * event-stream consumer). Unread tracking: `lastReadAt` starts at mount
 * so the replay backlog isn't counted, and bumps whenever the dock opens;
 * newer agent messages show as a badge on the collapsed bar.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Flex, IconButton, ScrollArea, Text, TextArea } from "@radix-ui/themes";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  Cross2Icon,
  PaperPlaneIcon,
  ChatBubbleIcon,
} from "@radix-ui/react-icons";
import { useIsMobile, useViewportHeight } from "@workspace/react";
import { MessageContent } from "@workspace/agentic-chat";
import { useApp, useAppState } from "../app/context";

export function ChannelDrawer() {
  const app = useApp();
  const isMobile = useIsMobile();
  const viewportHeight = useViewportHeight();
  const messages = useAppState((s) => s.messages);
  const clientReady = useAppState((s) => s.client !== null);
  const openSignal = useAppState((s) => s.dockOpenSignal);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Initialise to mount time so replay backlog isn't counted as unread.
  const [lastReadAt, setLastReadAt] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setLastReadAt(Date.now());
  }, [open]);

  // External "please open" signal — toast clicks and "Suggest message".
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages.length]);

  const unreadCount = useMemo(() => {
    if (open) return 0;
    return messages.filter((m) => m.ts > lastReadAt && m.senderType && m.senderType !== "panel")
      .length;
  }, [messages, lastReadAt, open]);

  const mdxActions = useMemo(
    () => ({
      publishMessage: async (content: string) => {
        await app.session.send(content);
      },
    }),
    [app]
  );

  const send = async () => {
    const content = draft.trim();
    if (!content || !clientReady) return;
    setSending(true);
    try {
      await app.session.send(content);
      setDraft("");
    } catch (err) {
      console.warn("[Spectrolite] send failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box className="spectrolite-dock">
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
        className="spectrolite-drawer-toggle"
        style={{
          cursor: "pointer",
          borderBottom: open ? "1px solid var(--gray-4)" : "none",
          minHeight: isMobile ? 44 : undefined,
        }}
      >
        <Flex align="center" gap="2">
          {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          <ChatBubbleIcon width="12" height="12" color="var(--gray-9)" />
          <Text size={isMobile ? "2" : "1"} color="gray" weight="medium">
            Channel
          </Text>
          {!open && unreadCount > 0 ? (
            <Badge color="amber" variant="soft" size={isMobile ? "2" : "1"}>
              {unreadCount} new
            </Badge>
          ) : null}
          {!open && unreadCount === 0 && messages.length > 0 ? (
            <Text size="1" color="gray">
              · {messages.length} messages
            </Text>
          ) : null}
        </Flex>
        {open && isMobile ? (
          <IconButton
            size="2"
            variant="ghost"
            color="gray"
            aria-label="Close channel"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          >
            <Cross2Icon />
          </IconButton>
        ) : null}
      </Flex>
      {open ? (
        // On mobile, give the drawer most of the viewport (clamped);
        // useViewportHeight shrinks it when the virtual keyboard is up so
        // the textarea + send button stay on-screen.
        <Flex
          id="spectrolite-channel-drawer-body"
          direction="column"
          gap="2"
          p="2"
          style={{ maxHeight: isMobile ? Math.min(viewportHeight * 0.6, 480) : "32vh" }}
        >
          <Box ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <ScrollArea>
              <Flex direction="column" gap="2" p="1">
                {messages.length === 0 ? (
                  <Text size="1" color="gray">
                    No messages yet. @-mention an agent in a doc, or say hi below.
                  </Text>
                ) : (
                  messages.map((m) => {
                    const isAgent = m.senderType && m.senderType !== "panel";
                    return (
                      <Box
                        key={m.id}
                        className={`spectrolite-bubble ${isAgent ? "spectrolite-bubble--agent" : "spectrolite-bubble--self"}`}
                      >
                        <Flex align="center" justify="between" gap="2" mb="1">
                          <Text size="1" weight="bold" color={isAgent ? "iris" : "gray"}>
                            @{m.senderHandle ?? m.senderName ?? m.senderId}
                          </Text>
                        </Flex>
                        <Box style={{ fontSize: "var(--font-size-1)" }}>
                          <MessageContent
                            content={m.content}
                            isStreaming={false}
                            mdxActions={mdxActions}
                          />
                        </Box>
                      </Box>
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
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              style={{ flex: 1 }}
              rows={2}
            />
            <IconButton
              size={isMobile ? "3" : "2"}
              variant="solid"
              disabled={!draft.trim() || sending || !clientReady}
              onClick={() => void send()}
              aria-label="Send"
              style={isMobile ? { minHeight: 44, minWidth: 44 } : undefined}
            >
              <PaperPlaneIcon />
            </IconButton>
          </Flex>
        </Flex>
      ) : null}
    </Box>
  );
}
