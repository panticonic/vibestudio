import { describe, it, expect } from "vitest";
import { ViewStateStore, type ViewStateBackend } from "./viewState.js";

function mapBackend(): ViewStateBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (k) => store.get(k) ?? null,
    write: (k, v) => void store.set(k, v),
    remove: (k) => void store.delete(k),
  };
}

describe("ViewStateStore", () => {
  it("returns the initial value until a key is set, then the stored value", () => {
    const store = new ViewStateStore(mapBackend());
    expect(store.get("Doc.mdx", "count", 0)).toBe(0);
    store.set("Doc.mdx", "count", 5);
    expect(store.get("Doc.mdx", "count", 0)).toBe(5);
  });

  it("persists to the backend and survives a fresh store over the same backend", () => {
    const backend = mapBackend();
    new ViewStateStore(backend).set("Doc.mdx", "open", true);
    const reopened = new ViewStateStore(backend);
    expect(reopened.get("Doc.mdx", "open", false)).toBe(true);
  });

  it("notifies subscribers on change", () => {
    const store = new ViewStateStore(mapBackend());
    let hits = 0;
    const off = store.subscribe("Doc.mdx", () => hits++);
    store.set("Doc.mdx", "x", 1);
    store.set("Doc.mdx", "x", 2);
    expect(hits).toBe(2);
    off();
    store.set("Doc.mdx", "x", 3);
    expect(hits).toBe(2);
  });

  it("rename moves view-state to follow the doc; clear removes it", () => {
    const store = new ViewStateStore(mapBackend());
    store.set("Old.mdx", "k", "v");
    store.rename("Old.mdx", "New.mdx");
    expect(store.get("New.mdx", "k", null)).toBe("v");
    expect(store.get("Old.mdx", "k", null)).toBeNull();
    store.clear("New.mdx");
    expect(store.get("New.mdx", "k", null)).toBeNull();
  });
});
