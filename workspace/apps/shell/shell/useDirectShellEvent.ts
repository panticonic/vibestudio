/**
 * React binding for events addressed to this authenticated shell RPC session.
 *
 * Unlike `useShellEvent`, this hook never opens or changes an `events.watch`
 * response. Use it only for caller-, account-, or connection-addressed events.
 */
import { useEffect, useRef } from "react";
import { directEvents, type EventName, type EventPayloads } from "./client.js";

export function useDirectShellEvent<E extends EventName>(
  event: E,
  callback: (data: EventPayloads[E]) => void
): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(
    () => directEvents.on(event, (payload) => callbackRef.current(payload)),
    [event]
  );
}
