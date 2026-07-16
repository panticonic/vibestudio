import type { EventName } from "@vibestudio/shared/events";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { ServerClient } from "./serverClient.js";

export interface ServerEventSubscriptionBridge {
  retain(event: EventName): () => void;
  retainMany(events: Iterable<EventName>): () => void;
  retainAll(events: Iterable<EventName>): Promise<() => void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One response-owned watch from Electron main to the workspace server.
 *
 * Local consumers retain topics. Topic-set changes replace the exact response;
 * transport recovery reopens it. There are no confirmation tables, retry
 * timers, callback subscribers, or inferred liveness.
 */
export function createServerEventSubscriptionBridge(deps: {
  getServerClient(): Pick<ServerClient, "stream"> | null;
  onEvent(event: EventName, payload: unknown): void;
  log?: Pick<Console, "warn">;
}): ServerEventSubscriptionBridge {
  const rpc = {
    stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: Parameters<ServerClient["stream"]>[3]
    ): Promise<Response> {
      if (targetId !== "main") throw new Error(`Unexpected event watch target: ${targetId}`);
      const client = deps.getServerClient();
      if (!client) throw new Error("Workspace server event transport is not connected");
      const dot = method.indexOf(".");
      return client.stream(method.slice(0, dot), method.slice(dot + 1), args, options);
    },
  };
  const events = new EventsClient(rpc);
  const references = new Map<EventName, number>();
  const stopListening = new Map<EventName, () => void>();
  const log = deps.log ?? console;

  const acquireMany = (requestedEvents: Iterable<EventName>) => {
    const acquired = [...new Set(requestedEvents)];
    const first: EventName[] = [];
    for (const event of acquired) {
      const previous = references.get(event) ?? 0;
      references.set(event, previous + 1);
      if (previous !== 0) continue;
      first.push(event);
      stopListening.set(
        event,
        events.on(event, (payload) => deps.onEvent(event, payload))
      );
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const removed: EventName[] = [];
      for (const event of acquired) {
        const remaining = (references.get(event) ?? 1) - 1;
        if (remaining > 0) {
          references.set(event, remaining);
          continue;
        }
        references.delete(event);
        stopListening.get(event)?.();
        stopListening.delete(event);
        removed.push(event);
      }
      void events.unsubscribeMany(removed).catch((error: unknown) => {
        log.warn(
          `[events] server watch replacement failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    };
    return { release, first };
  };

  const retain = (event: EventName): (() => void) => {
    const acquired = acquireMany([event]);
    if (acquired.first.length > 0) {
      void events.subscribeAll(acquired.first).catch((error: unknown) => {
        log.warn(
          `[events] server watch failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    return acquired.release;
  };

  return {
    retain,
    retainMany(requestedEvents) {
      const acquired = acquireMany(requestedEvents);
      if (acquired.first.length > 0) {
        void events.subscribeAll(acquired.first).catch((error: unknown) => {
          log.warn(
            `[events] server watch failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      return acquired.release;
    },
    async retainAll(requestedEvents) {
      const acquired = acquireMany(requestedEvents);
      try {
        await events.subscribeAll(acquired.first);
      } catch (error) {
        acquired.release();
        throw error;
      }
      return acquired.release;
    },
    recover: () => events.recover(),
    async close() {
      references.clear();
      for (const stop of stopListening.values()) stop();
      stopListening.clear();
      await events.unsubscribeAll();
    },
  };
}
