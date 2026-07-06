import { useCallback, useEffect, useState } from "react";
import type { ParticipantMetadata, PubSubClient } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import { parseSignalEvent } from "@workspace/agentic-core";

/**
 * A live permission prompt relayed from a linked Claude Code session
 * (docs/claude-code-channels-plan.md §7.3). Surfaced as an inline card in the
 * conversation with Allow/Deny buttons. Keyed by `requestId`.
 */
export interface LinkedPermissionPrompt {
  /** Vessel request id — correlates the verdict back to the pending relay. */
  requestId: string;
  /** Agentic channel carrying the relayed prompt. */
  channelId: string;
  /** Opaque token required by the host to resolve this inline prompt. */
  resolveToken: string;
  /** Tool/operation the agent wants to run (e.g. `Bash`). */
  toolName: string;
  description?: string;
  /** Monospace-rendered tool-input preview. */
  preview?: string;
  /** Wall-clock ms when the prompt arrived. */
  ts: number;
  /** Safety expiry so a card whose settle signal was missed still clears. */
  expiresAt: number;
}

/**
 * The ephemeral AgenticEvent shape the linked-agent vessel publishes for
 * permission lifecycle (`publishPermissionSignal` / `publishPermissionSettledSignal`).
 * Rides the signal channel under {@link AGENTIC_EVENT_PAYLOAD_KIND}.
 */
interface LinkedPermissionAgenticEvent {
  payload?: {
    kind?: string;
    details?: {
      channelId?: string;
      requestId?: string;
      resolveToken?: string;
      toolName?: string;
      description?: string;
      preview?: string;
      behavior?: string;
      settledBy?: string;
    };
  };
}

const PENDING_KIND = "linked-agent.permission_pending";
const SETTLED_KIND = "linked-agent.permission_settled";
/**
 * Slightly beyond the vessel/service 120s auto-deny horizon: a card whose
 * companion `permission_settled` signal never arrived (missed while unmounted)
 * still clears rather than dangling. The normal clear path is the settle signal.
 */
const PERMISSION_CARD_TTL_MS = 130_000;

export interface UseLinkedPermissionSignalsResult {
  prompts: ReadonlyArray<LinkedPermissionPrompt>;
  /** Drop a card locally (optimistic clear on the user's own Allow/Deny click). */
  dismiss: (requestId: string) => void;
}

/**
 * Subscribe to the ephemeral permission signals from linked-agent vessels and
 * keep a live map of pending prompts. A `permission_pending` signal adds a card;
 * the companion `permission_settled` signal (published at every settle site —
 * verdict, terminal-answered, auto-deny, detach) removes it. Signals are
 * non-durable, so a panel reload naturally drops stale pending cards.
 */
export function useLinkedPermissionSignals<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null
): UseLinkedPermissionSignalsResult {
  const [prompts, setPrompts] = useState<Map<string, LinkedPermissionPrompt>>(new Map());

  const dismiss = useCallback((requestId: string) => {
    setPrompts((prev) => {
      if (!prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!client) {
      setPrompts(new Map());
      return;
    }

    let cancelled = false;

    const consume = async () => {
      try {
        for await (const event of client.events({ includeSignals: true })) {
          if (cancelled) break;
          if (event.delivery !== "signal" || event.type !== "signal") continue;
          if (!event.content) continue;
          const agentic = parseSignalEvent<LinkedPermissionAgenticEvent>(
            { content: event.content, contentType: event.contentType },
            AGENTIC_EVENT_PAYLOAD_KIND
          );
          const kind = agentic?.payload?.kind;
          const details = agentic?.payload?.details;
          if (!details) continue;

          if (kind === PENDING_KIND) {
            const requestId = details.requestId;
            const channelId = details.channelId;
            const resolveToken = details.resolveToken;
            const toolName = details.toolName;
            if (!requestId || !channelId || !resolveToken || !toolName) continue;
            const ts = event.ts ?? Date.now();
            const prompt: LinkedPermissionPrompt = {
              requestId,
              channelId,
              resolveToken,
              toolName,
              ...(details.description ? { description: details.description } : {}),
              ...(details.preview ? { preview: details.preview } : {}),
              ts,
              expiresAt: Date.now() + PERMISSION_CARD_TTL_MS,
            };
            setPrompts((prev) => {
              const next = new Map(prev);
              next.set(requestId, prompt);
              return next;
            });
          } else if (kind === SETTLED_KIND) {
            const requestId = details.requestId;
            if (!requestId) continue;
            setPrompts((prev) => {
              if (!prev.has(requestId)) return prev;
              const next = new Map(prev);
              next.delete(requestId);
              return next;
            });
          }
        }
      } catch (err) {
        if (!cancelled) console.error("[useLinkedPermissionSignals]", err);
      }
    };

    void consume();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Safety sweep: clear any card past its TTL (a missed settle signal).
  useEffect(() => {
    if (prompts.size === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setPrompts((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, prompt] of prev) {
          if (prompt.expiresAt <= now) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [prompts.size]);

  const sorted = Array.from(prompts.values()).sort((a, b) => a.ts - b.ts);
  return { prompts: sorted, dismiss };
}
