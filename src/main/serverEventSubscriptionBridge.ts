import type { EventName } from "@vibestudio/shared/events";
import type { ServerClient } from "./serverClient.js";

type ServerEventClient = Pick<ServerClient, "call">;

export interface ServerEventSubscriptionBridge {
  add(event: EventName): void;
  delete(event: EventName): void;
  clear(): void;
  replay(opts?: { force?: boolean }): Promise<void>;
}

export function createServerEventSubscriptionBridge(deps: {
  getServerClient(): ServerEventClient | null;
  log?: Pick<Console, "info" | "warn">;
}): ServerEventSubscriptionBridge {
  const desired = new Set<EventName>();
  const confirmed = new Set<EventName>();
  const inFlight = new Map<EventName, Promise<void>>();
  const retryTimers = new Map<EventName, ReturnType<typeof setTimeout>>();
  const log = deps.log ?? console;

  const ensureRemote = (event: EventName): Promise<void> => {
    if (confirmed.has(event)) return Promise.resolve();
    const existing = inFlight.get(event);
    if (existing) return existing;

    const client = deps.getServerClient();
    if (!client) return Promise.resolve();

    const pending = client
      .call("events", "subscribe", [event])
      .then(() => {
        confirmed.add(event);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[events] forward subscribe(${event}) to server failed: ${msg}`);
        if (desired.has(event) && !retryTimers.has(event)) {
          retryTimers.set(
            event,
            setTimeout(() => {
              retryTimers.delete(event);
              void ensureRemote(event);
            }, 2_000)
          );
        }
      })
      .finally(() => {
        inFlight.delete(event);
      });
    inFlight.set(event, pending);
    return pending;
  };

  return {
    add(event) {
      desired.add(event);
      void ensureRemote(event);
    },
    delete(event) {
      desired.delete(event);
      // Remote subscriptions are intentionally monotonic within one server
      // connection. Main is the bridge owner: renderer unmount churn should
      // not be able to race a late unsubscribe against a newer subscribe and
      // strand the shell with only a local subscription.
    },
    clear() {
      desired.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
    },
    async replay(opts = {}) {
      if (opts.force) {
        confirmed.clear();
        inFlight.clear();
      }
      if (desired.size === 0) return;
      const events = [...desired];
      log.info(`[events] replaying ${events.length} shell subscription(s) to server`);
      await Promise.all(events.map((event) => ensureRemote(event)));
    },
  };
}
