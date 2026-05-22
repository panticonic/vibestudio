/**
 * Surface agent `say` messages as shell notifications.
 *
 * The default companion agent is `SilentAgentWorker`, which only sends
 * to the channel via its explicit `say` tool — i.e. it never chats
 * unprompted. When it DOES speak, we don't want the user to miss it
 * just because the channel drawer is collapsed.
 *
 * Strategy: subscribe to channel events; for every completed
 * agentic-trajectory message from a non-panel participant, fire a
 * `notifications.show()` toast with an "Open chat" action that focuses
 * the panel + expands the drawer.
 *
 * Toasts are deduplicated by messageId and suppressed when the panel
 * is currently focused — the user will see the message in the drawer
 * directly in that case.
 */

import { useEffect, useRef } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import { notifications, id as panelId, focusPanel } from "@workspace/runtime";
import { usePanelFocus } from "@workspace/react";

const NOTIFICATION_TTL_MS = 8_000;

export interface AgentMessageNotifierProps {
  client: PubSubClient | null;
  /** Open the drawer programmatically when the user clicks the notification. */
  onOpenDrawer?: () => void;
}

export function AgentMessageNotifier({ client, onOpenDrawer }: AgentMessageNotifierProps) {
  const focused = usePanelFocus();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const event of client.events({ includeReplay: false, includeSignals: false })) {
          if (cancelled) return;
          const wire = event as unknown as {
            type?: string;
            messageId?: string;
            senderId?: string;
            senderMetadata?: { handle?: string; name?: string; type?: string };
            payload?: { kind?: string; payload?: { content?: string; role?: string } };
          };
          if (wire.type !== "agentic.trajectory.v1/event") continue;
          const evt = wire.payload;
          if (!evt || evt.kind !== "message.completed") continue;
          const content = evt.payload?.content;
          if (typeof content !== "string" || !content) continue;
          // Only notify on non-panel senders (i.e. agents).
          if (wire.senderMetadata?.type === "panel") continue;
          const id = wire.messageId ?? `${wire.senderId ?? "?"}`;
          if (seenRef.current.has(id)) continue;
          seenRef.current.add(id);
          // Suppress when the panel is focused — the user will see the
          // message in the drawer directly. Notifications are for the
          // case where the user is looking elsewhere.
          if (focusedRef.current) continue;
          const senderHandle = wire.senderMetadata?.handle ?? wire.senderMetadata?.name ?? "agent";
          const preview = content.length > 140 ? `${content.slice(0, 140)}…` : content;
          try {
            await notifications.show({
              type: "info",
              title: `@${senderHandle}`,
              message: preview,
              ttl: NOTIFICATION_TTL_MS,
              actions: [{
                label: "Open chat",
                variant: "soft",
                onClick: () => {
                  void focusPanel(panelId);
                  onOpenDrawer?.();
                },
              }],
            });
          } catch (err) {
            console.debug("[Spectrolite] notification failed:", err);
          }
        }
      } catch (err) {
        if (!cancelled) console.warn("[Spectrolite] notifier stream ended:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [client, onOpenDrawer]);

  return null;
}
