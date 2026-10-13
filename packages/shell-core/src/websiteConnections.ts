import {
  observeDurableProjection,
  type DurableObservation,
} from "./durableObservation.js";

/** Trusted chrome snapshot. Website-provided titles and messages never update this state. */
export interface WebsiteConnectionEntry {
  runtimeId: string;
  slotId: string | null;
  documentId: string;
  origin?: string;
  connected: boolean;
}

/** Subscribe before reading, and discard snapshots superseded by a live event. */
export function observeWebsiteConnections(input: {
  list(): Promise<WebsiteConnectionEntry[]>;
  listen(changed: (entry: WebsiteConnectionEntry) => void): () => void;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  changed(entries: ReadonlyMap<string, WebsiteConnectionEntry>): void;
  error(error: unknown): void;
}): DurableObservation {
  let state: ReadonlyMap<string, WebsiteConnectionEntry> = new Map();
  const publish = (entries: ReadonlyMap<string, WebsiteConnectionEntry>) => {
    state = entries;
    input.changed(state);
  };
  return observeDurableProjection({
    listen: (invalidate) =>
      input.listen((entry) => {
        // Publish the authenticated transition immediately. The observation
        // generation invalidates any older inventory read before it can land.
        if (entry.slotId) publish(new Map(state).set(entry.slotId, entry));
        invalidate();
      }),
    admit: input.subscribe,
    leave: input.unsubscribe,
    read: input.list,
    apply: (entries) =>
      publish(
        new Map(
          entries.flatMap((entry) =>
            entry.slotId ? [[entry.slotId, entry] as const] : [],
          ),
        ),
      ),
    error: (error) => {
      publish(new Map());
      input.error(error);
    },
  });
}
