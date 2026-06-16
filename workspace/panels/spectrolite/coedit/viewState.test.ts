import { describe, it, expect } from "vitest";
import {
  ViewStateStore,
  liftLegacyViewState,
  type ViewStateBackend,
} from "./viewState.js";

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

  it("seedIfAbsent seeds only when nothing is stored and the state is non-empty", () => {
    const store = new ViewStateStore(mapBackend());
    expect(store.seedIfAbsent("Doc.mdx", {})).toBe(false);
    expect(store.seedIfAbsent("Doc.mdx", { count: 3 })).toBe(true);
    expect(store.get("Doc.mdx", "count", 0)).toBe(3);
    // Already present → never clobber a real edit with a stale migration.
    expect(store.seedIfAbsent("Doc.mdx", { count: 99 })).toBe(false);
    expect(store.get("Doc.mdx", "count", 0)).toBe(3);
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

describe("liftLegacyViewState (migration)", () => {
  it("lifts legacy state: frontmatter into the sidecar and strips it from canonical", () => {
    const doc = `---\ntitle: Demo\nstate:\n  count: 7\n  open: true\n---\n\n# Hello\n\nbody\n`;
    const { viewState, canonical, migrated } = liftLegacyViewState(doc);
    expect(migrated).toBe(true);
    expect(viewState).toEqual({ count: 7, open: true });
    expect(canonical).not.toContain("state:");
    expect(canonical).toContain("title: Demo");
    expect(canonical).toContain("# Hello");
  });

  it("is a no-op for documents without state: frontmatter", () => {
    const doc = `---\ntitle: Plain\n---\n\nbody\n`;
    const { viewState, canonical, migrated } = liftLegacyViewState(doc);
    expect(migrated).toBe(false);
    expect(viewState).toBeNull();
    expect(canonical).toBe(doc);
  });
});
