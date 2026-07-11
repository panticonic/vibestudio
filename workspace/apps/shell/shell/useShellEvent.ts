/**
 * useShellEvent - React hook for subscribing to shell events.
 *
 * Automatically subscribes when mounted and unsubscribes when unmounted.
 * Events are emitted via RPC from the main process.
 *
 * Reference-counted: many components can listen to the same event. The
 * underlying RPC `events.subscribe` is issued once per event (on 0→1) and
 * `events.unsubscribe` once per event (on 1→0). Without this, a component
 * that unmounts would yank the subscription out from under every other
 * live listener for that event.
 */

import { useEffect, useRef } from "react";
import { events, onRpcEvent, type EventName, type EventPayloads } from "./client.js";

// Re-export for consumers
export type { EventPayloads } from "./client.js";

/** Refcount per event name. Shared across all hook instances. */
const subscriptionRefcounts = new Map<EventName, number>();
const retryAttempts = new Map<EventName, number>();
const retryTimers = new Map<EventName, number>();

function ensureSubscribed(event: EventName): void {
  void events
    .subscribe(event)
    .then(() => {
      retryAttempts.delete(event);
      window.dispatchEvent(new CustomEvent("shell-event-subscription-restored", { detail: event }));
    })
    .catch((err: unknown) => {
      console.warn(`[useShellEvent] subscribe ${event} failed:`, err);
      if ((subscriptionRefcounts.get(event) ?? 0) <= 0 || retryTimers.has(event)) return;
      const attempt = (retryAttempts.get(event) ?? 0) + 1;
      retryAttempts.set(event, attempt);
      window.dispatchEvent(
        new CustomEvent("shell-event-subscription-degraded", { detail: { event, attempt } })
      );
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt - 1, 5));
      retryTimers.set(
        event,
        window.setTimeout(() => {
          retryTimers.delete(event);
          if ((subscriptionRefcounts.get(event) ?? 0) > 0) ensureSubscribed(event);
        }, delay)
      );
    });
}

function addSubscription(event: EventName): void {
  const prev = subscriptionRefcounts.get(event) ?? 0;
  subscriptionRefcounts.set(event, prev + 1);
  if (prev === 0) {
    ensureSubscribed(event);
  }
}

function removeSubscription(event: EventName): void {
  const prev = subscriptionRefcounts.get(event) ?? 0;
  if (prev <= 0) return;
  if (prev === 1) {
    subscriptionRefcounts.delete(event);
    const timer = retryTimers.get(event);
    if (timer !== undefined) window.clearTimeout(timer);
    retryTimers.delete(event);
    retryAttempts.delete(event);
    void events
      .unsubscribe(event)
      .catch((err: unknown) => console.warn(`[useShellEvent] unsubscribe ${event} failed:`, err));
  } else {
    subscriptionRefcounts.set(event, prev - 1);
  }
}

/**
 * Subscribe to a shell event from the main process.
 *
 * @param event - The event name to subscribe to
 * @param callback - Function to call when the event is received
 *
 * @example
 * ```tsx
 * useShellEvent("system-theme-changed", (theme) => {
 *   console.log("Theme changed to:", theme);
 * });
 * ```
 */
export function useShellEvent<E extends EventName>(
  event: E,
  callback: (data: EventPayloads[E]) => void
): void {
  // Use ref to store the latest callback without triggering effect re-runs
  const callbackRef = useRef(callback);

  // Update ref on every render (no effect trigger)
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    const channel = `event:${event}`;
    const cleanup = onRpcEvent(channel, (ev) => {
      callbackRef.current(ev.payload as EventPayloads[E]);
    });
    addSubscription(event);

    return () => {
      cleanup();
      removeSubscription(event);
    };
  }, [event]); // Only depend on event, not callback
}
