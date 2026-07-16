/**
 * useShellEvent - React hook for subscribing to shell events.
 *
 * Automatically subscribes when mounted and unsubscribes when unmounted.
 * Events are emitted via RPC from the main process.
 *
 * Reference-counted: many components can listen to the same event. The one
 * response-owned watch is replaced only when the complete desired topic set
 * changes, and its cancellation is the unsubscribe operation.
 */

import { useEffect, useRef } from "react";
import { events, type EventName, type EventPayloads } from "./client.js";

// Re-export for consumers
export type { EventPayloads } from "./client.js";

/** Refcount per event name. Shared across all hook instances. */
const subscriptionRefcounts = new Map<EventName, number>();

function addSubscription(event: EventName): void {
  const prev = subscriptionRefcounts.get(event) ?? 0;
  subscriptionRefcounts.set(event, prev + 1);
  if (prev === 0) {
    void events
      .subscribe(event)
      .catch((err: unknown) => console.warn(`[useShellEvent] watch ${event} failed:`, err));
  }
}

function removeSubscription(event: EventName): void {
  const prev = subscriptionRefcounts.get(event) ?? 0;
  if (prev <= 0) return;
  if (prev === 1) {
    subscriptionRefcounts.delete(event);
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
    const cleanup = events.on(event, (payload) => callbackRef.current(payload));
    addSubscription(event);

    return () => {
      cleanup();
      removeSubscription(event);
    };
  }, [event]); // Only depend on event, not callback
}
