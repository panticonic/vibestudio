import { useEffect, useState } from "react";
import type { ParticipantMetadata, PubSubClient } from "@workspace/pubsub";

export interface ChannelSignal {
  id: string;
  ts: number;
  content: string;
  contentType?: string;
}

export interface UseChannelSignalsOptions {
  maxSignals?: number;
  ttlMs?: number;
}

interface StoredChannelSignal extends ChannelSignal {
  expiresAt: number;
}

/**
 * Subscribe to live, non-durable channel signals and keep a small expiring
 * window for transient UI affordances.
 */
export function useChannelSignals<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  options: UseChannelSignalsOptions = {},
): ReadonlyArray<ChannelSignal> {
  const maxSignals = options.maxSignals ?? 5;
  const ttlMs = options.ttlMs ?? 8000;
  const [signals, setSignals] = useState<StoredChannelSignal[]>([]);

  useEffect(() => {
    if (!client) {
      setSignals([]);
      return;
    }

    let cancelled = false;
    let sequence = 0;

    const consume = async () => {
      try {
        for await (const event of client.events({ includeSignals: true })) {
          if (cancelled) break;
          if (event.delivery !== "signal" || event.type !== "signal") continue;
          if (!event.content) continue;

          const ts = event.ts ?? Date.now();
          const nextSignal: StoredChannelSignal = {
            id: `${ts}:${sequence++}`,
            ts,
            content: event.content,
            contentType: event.contentType,
            expiresAt: Date.now() + ttlMs,
          };

          setSignals((prev) => {
            const now = Date.now();
            const next = [...prev.filter((item) => item.expiresAt > now), nextSignal];
            return next.slice(Math.max(0, next.length - maxSignals));
          });
        }
      } catch (err) {
        if (!cancelled) console.error("[useChannelSignals]", err);
      }
    };

    void consume();
    return () => {
      cancelled = true;
    };
  }, [client, maxSignals, ttlMs]);

  useEffect(() => {
    if (signals.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setSignals((prev) => prev.filter((item) => item.expiresAt > now));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [signals.length]);

  return signals.map(({ expiresAt: _expiresAt, ...signal }) => signal);
}
