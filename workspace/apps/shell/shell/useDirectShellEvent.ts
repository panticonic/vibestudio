/**
 * React binding for events addressed to this authenticated shell RPC session.
 *
 * Unlike `useShellEvent`, this hook never opens or changes an `events.watch`
 * response. Use it only for caller-, account-, or connection-addressed events.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { directEvents, type EventName, type EventPayloads } from "./client.js";

export function useDirectShellEvent<E extends EventName>(
  event: E,
  callback: (data: EventPayloads[E]) => void
): void {
  const callbackRef = useRef(callback);

  // Keep an already-installed listener aligned with this commit. A passive
  // effect leaves a window where it can dispatch to the previous render.
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => directEvents.on(event, (payload) => callbackRef.current(payload)), [event]);
}
