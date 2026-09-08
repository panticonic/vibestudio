import { describe, expect, it, vi } from "vitest";
import { observeWebsiteConnections, type WebsiteConnectionEntry } from "./websiteConnections";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 6; ++i) await Promise.resolve();
};

describe("website chrome connection state", () => {
  it("displays revocation immediately and discards an older connected snapshot", async () => {
    const old = deferred<WebsiteConnectionEntry[]>();
    const latest = deferred<WebsiteConnectionEntry[]>();
    let notify!: (entry: WebsiteConnectionEntry) => void;
    const changed = vi.fn();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const stop = observeWebsiteConnections({
      list,
      listen: (listener) => {
        notify = listener;
        return vi.fn();
      },
      subscribe: async () => {},
      unsubscribe: async () => {},
      changed,
      error: vi.fn(),
    });
    await flush();
    const entry = {
      runtimeId: "panel:browser",
      slotId: "browser-slot",
      documentId: "fresh-document",
      connected: false,
    };
    notify(entry);
    expect(changed.mock.lastCall?.[0].get("browser-slot")).toEqual(entry);
    old.resolve([{ ...entry, connected: true }]);
    await flush();
    expect(changed).toHaveBeenCalledOnce();
    latest.resolve([entry]);
    await flush();
    expect(changed.mock.lastCall?.[0].get("browser-slot").connected).toBe(false);
    stop();
  });

  it("retires a late subscription without reading or publishing into a new workspace", async () => {
    const subscribed = deferred<void>();
    const unsubscribe = vi.fn(async () => {});
    const changed = vi.fn();
    const list = vi.fn();
    const unlisten = vi.fn();
    const stop = observeWebsiteConnections({
      list,
      listen: () => unlisten,
      subscribe: () => subscribed.promise,
      unsubscribe,
      changed,
      error: vi.fn(),
    });
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
    subscribed.resolve();
    await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
