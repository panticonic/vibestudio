import { addWebViewEntry, sweepIdleWebViews, type WebViewEntry } from "./webViewStack";
import { PANEL_UI_IDLE_UNLOAD_MS } from "@vibez1/shared/constants";

const NONE = {
  isPinned: () => false,
  isKeepLoaded: () => false,
};

function entry(panelId: string, lastActive: number): WebViewEntry {
  return { panelId, url: `http://x/${panelId}`, managed: true, panelInit: null, lastActive };
}

describe("addWebViewEntry", () => {
  it("inserts under cap without evicting", () => {
    const entries = [entry("a", 1), entry("b", 2)];
    const next = addWebViewEntry(entries, entry("c", 3), {
      activePanelId: "c",
      cap: 5,
      ...NONE,
    });
    expect(next.map((e) => e.panelId)).toEqual(["a", "b", "c"]);
  });

  it("evicts the oldest UNPINNED before any pinned panel", () => {
    const entries = [entry("pinned", 1), entry("old", 2), entry("new", 3)];
    const next = addWebViewEntry(entries, entry("incoming", 4), {
      activePanelId: "incoming",
      cap: 3,
      isPinned: (id) => id === "pinned",
      isKeepLoaded: () => false,
    });
    const ids = next.map((e) => e.panelId);
    expect(ids).toContain("pinned");
    expect(ids).not.toContain("old");
    expect(ids).toContain("incoming");
  });

  it("evicts a pinned panel only when all others are pinned/protected", () => {
    const entries = [
      entry("p1", 1),
      entry("p2", 2),
      entry("p3", 3),
      entry("p4", 4),
      entry("active", 5),
    ];
    const next = addWebViewEntry(entries, entry("incoming", 6), {
      activePanelId: "active",
      cap: 5,
      isPinned: (id) => id.startsWith("p"),
      isKeepLoaded: () => false,
    });
    const ids = next.map((e) => e.panelId);
    // active + incoming protected; oldest pinned (p1) is the forced victim.
    expect(ids).not.toContain("p1");
    expect(ids).toContain("active");
    expect(ids).toContain("incoming");
    expect(ids.length).toBe(5);
  });

  it("never evicts the incoming or active panel", () => {
    const entries = [entry("active", 1), entry("other", 2)];
    const next = addWebViewEntry(entries, entry("incoming", 3), {
      activePanelId: "active",
      cap: 2,
      ...NONE,
    });
    const ids = next.map((e) => e.panelId);
    expect(ids).toContain("incoming");
    expect(ids).toContain("active");
    expect(ids).not.toContain("other");
  });
});

describe("sweepIdleWebViews", () => {
  const now = 10_000_000;
  const idle = now - PANEL_UI_IDLE_UNLOAD_MS - 1;
  const fresh = now - 1;

  it("unloads each inactive-unpinned victim AND drops it from the stack", () => {
    const unload = jest.fn();
    const entries = [entry("idleA", idle), entry("idleB", idle), entry("freshC", fresh)];
    const next = sweepIdleWebViews(entries, {
      now,
      activePanelId: null,
      foreground: true,
      unload,
      ...NONE,
    });
    expect(unload).toHaveBeenCalledWith("idleA");
    expect(unload).toHaveBeenCalledWith("idleB");
    expect(unload).toHaveBeenCalledTimes(2);
    expect(next.map((e) => e.panelId)).toEqual(["freshC"]);
  });

  it("retains the active panel even when idle", () => {
    const unload = jest.fn();
    const entries = [entry("active", idle), entry("bg", idle)];
    const next = sweepIdleWebViews(entries, {
      now,
      activePanelId: "active",
      foreground: true,
      unload,
      ...NONE,
    });
    expect(unload).toHaveBeenCalledWith("bg");
    expect(unload).not.toHaveBeenCalledWith("active");
    expect(next.map((e) => e.panelId)).toEqual(["active"]);
  });

  it("retains pinned and keepLoaded panels even when idle", () => {
    const unload = jest.fn();
    const entries = [entry("pinned", idle), entry("automated", idle), entry("plain", idle)];
    const next = sweepIdleWebViews(entries, {
      now,
      activePanelId: null,
      foreground: true,
      unload,
      isPinned: (id) => id === "pinned",
      isKeepLoaded: (id) => id === "automated",
    });
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith("plain");
    expect(new Set(next.map((e) => e.panelId))).toEqual(new Set(["pinned", "automated"]));
  });

  it("is a no-op when foreground is false", () => {
    const unload = jest.fn();
    const entries = [entry("idleA", idle), entry("idleB", idle)];
    const next = sweepIdleWebViews(entries, {
      now,
      activePanelId: null,
      foreground: false,
      unload,
      ...NONE,
    });
    expect(unload).not.toHaveBeenCalled();
    expect(next).toBe(entries);
  });
});
