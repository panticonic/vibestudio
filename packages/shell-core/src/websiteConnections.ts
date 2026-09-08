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
}): () => void {
  let disposed = false;
  let revision = 0;
  let state: ReadonlyMap<string, WebsiteConnectionEntry> = new Map();
  const publish = (entries: ReadonlyMap<string, WebsiteConnectionEntry>) => {
    state = entries;
    input.changed(state);
  };
  const refresh = async () => {
    const requested = ++revision;
    try {
      const entries = await input.list();
      if (!disposed && requested === revision)
        publish(
          new Map(
            entries.flatMap((entry) => (entry.slotId ? [[entry.slotId, entry] as const] : []))
          )
        );
    } catch (error) {
      if (!disposed && requested === revision) {
        publish(new Map());
        input.error(error);
      }
    }
  };
  const unlisten = input.listen((entry) => {
    if (disposed) return;
    // Invalidate pending reads before displaying this authenticated transition.
    ++revision;
    if (entry.slotId) publish(new Map(state).set(entry.slotId, entry));
    void refresh();
  });
  const subscribed = input
    .subscribe()
    .then(async () => {
      if (!disposed) await refresh();
    })
    .catch((error) => {
      if (!disposed) input.error(error);
    });
  return () => {
    disposed = true;
    unlisten();
    // A late subscribe must not recreate a watch after its UI owner has left.
    void subscribed.then(() => input.unsubscribe()).catch(input.error);
  };
}
