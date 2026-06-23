import { describe, expect, it } from "vitest";
import { selectCapEvictionVictims, selectIdlePanelVictims } from "./panelGc.js";
import type { LoadedPanelSnapshot } from "./panelGc.js";
import {
  PANEL_UI_IDLE_SWEEP_MS,
  PANEL_UI_IDLE_UNLOAD_MS,
  PANEL_UI_MAX_LOADED_DESKTOP,
  PANEL_UI_MAX_LOADED_MOBILE,
} from "../constants.js";

const NONE = {
  isPinned: () => false,
  isKeepLoaded: () => false,
};

function snap(panelId: string, lastActive: number): LoadedPanelSnapshot {
  return { panelId, lastActive };
}

describe("selectIdlePanelVictims", () => {
  const now = 10_000_000;
  const idleMs = 1_000;

  it("returns only panels whose age >= idleMs", () => {
    const loaded = [
      snap("fresh", now - 500), // not idle
      snap("exactly", now - 1_000), // exactly at threshold -> idle
      snap("old", now - 5_000), // idle
    ];
    const victims = selectIdlePanelVictims(loaded, {
      now,
      idleMs,
      protectedIds: [],
      ...NONE,
    });
    expect(new Set(victims)).toEqual(new Set(["exactly", "old"]));
  });

  it("excludes protected (active/visible) panels regardless of age", () => {
    const loaded = [snap("active", now - 9_999), snap("bg", now - 9_999)];
    const victims = selectIdlePanelVictims(loaded, {
      now,
      idleMs,
      protectedIds: ["active"],
      ...NONE,
    });
    expect(victims).toEqual(["bg"]);
  });

  it("excludes pinned panels (hard exclusion) regardless of age", () => {
    const loaded = [snap("pinned", now - 9_999), snap("plain", now - 9_999)];
    const victims = selectIdlePanelVictims(loaded, {
      now,
      idleMs,
      protectedIds: [],
      isPinned: (id) => id === "pinned",
      isKeepLoaded: () => false,
    });
    expect(victims).toEqual(["plain"]);
  });

  it("excludes keepLoaded (automation) panels regardless of age", () => {
    const loaded = [snap("automated", now - 9_999), snap("plain", now - 9_999)];
    const victims = selectIdlePanelVictims(loaded, {
      now,
      idleMs,
      protectedIds: [],
      isPinned: () => false,
      isKeepLoaded: (id) => id === "automated",
    });
    expect(victims).toEqual(["plain"]);
  });

  it("returns exactly the right ids in a mixed set", () => {
    const loaded = [
      snap("active", now - 50_000),
      snap("pinned", now - 50_000),
      snap("automated", now - 50_000),
      snap("idle-a", now - 2_000),
      snap("idle-b", now - 3_000),
      snap("fresh", now - 10),
    ];
    const victims = selectIdlePanelVictims(loaded, {
      now,
      idleMs,
      protectedIds: ["active"],
      isPinned: (id) => id === "pinned",
      isKeepLoaded: (id) => id === "automated",
    });
    expect(new Set(victims)).toEqual(new Set(["idle-a", "idle-b"]));
  });

  it("returns [] when nothing is idle", () => {
    const loaded = [snap("a", now - 10), snap("b", now - 20)];
    expect(selectIdlePanelVictims(loaded, { now, idleMs, protectedIds: [], ...NONE })).toEqual([]);
  });
});

describe("selectCapEvictionVictims", () => {
  it("returns [] when at or under cap", () => {
    const loaded = [snap("a", 1), snap("b", 2), snap("c", 3)];
    expect(selectCapEvictionVictims(loaded, { cap: 3, protectedIds: [], ...NONE })).toEqual([]);
    expect(selectCapEvictionVictims(loaded, { cap: 5, protectedIds: [], ...NONE })).toEqual([]);
  });

  it("evicts the oldest panel(s) to reach the cap", () => {
    const loaded = [snap("newest", 100), snap("middle", 50), snap("oldest", 10)];
    const victims = selectCapEvictionVictims(loaded, { cap: 2, protectedIds: [], ...NONE });
    expect(victims).toEqual(["oldest"]);
  });

  it("evicts the oldest UNPINNED panel before any pinned one", () => {
    // P1 is pinned and the oldest; the oldest unpinned should still go first.
    const loaded = [snap("P1", 10), snap("u-old", 20), snap("u-new", 30)];
    const victims = selectCapEvictionVictims(loaded, {
      cap: 2,
      protectedIds: [],
      isPinned: (id) => id === "P1",
      isKeepLoaded: () => false,
    });
    expect(victims).toEqual(["u-old"]);
  });

  it("falls back to pinned (oldest first) only when all others are pinned/protected", () => {
    // Worked example from §4.2: cap=5, all 5 loaded are pinned, opening a 6th.
    const loaded = [
      snap("p1", 10),
      snap("p2", 20),
      snap("p3", 30),
      snap("p4", 40),
      snap("p5", 50),
      snap("incoming", 60), // the just-focused 6th, protected
    ];
    const victims = selectCapEvictionVictims(loaded, {
      cap: 5,
      protectedIds: ["incoming"],
      isPinned: (id) => id.startsWith("p"),
      isKeepLoaded: () => false,
    });
    // Must evict exactly one — the oldest pinned, since the 6th must render.
    expect(victims).toEqual(["p1"]);
  });

  it("never returns a protected id", () => {
    const loaded = [snap("keep", 1), snap("other", 2), snap("third", 3)];
    const victims = selectCapEvictionVictims(loaded, {
      cap: 1,
      protectedIds: ["keep"],
      ...NONE,
    });
    expect(victims).not.toContain("keep");
    expect(victims).toEqual(["other", "third"]);
  });

  it("never returns a keepLoaded id", () => {
    const loaded = [snap("automated", 1), snap("plain-old", 2), snap("plain-new", 3)];
    const victims = selectCapEvictionVictims(loaded, {
      cap: 2,
      protectedIds: [],
      isPinned: () => false,
      isKeepLoaded: (id) => id === "automated",
    });
    expect(victims).toEqual(["plain-old"]);
  });

  it("worked example §4.2: cap=5 with one pinned, opening a 6th protected panel", () => {
    const loaded = [
      snap("P1", 10), // pinned
      snap("a", 20),
      snap("b", 30),
      snap("c", 40),
      snap("d", 50),
      snap("incoming", 60), // protected (just focused)
    ];
    const victims = selectCapEvictionVictims(loaded, {
      cap: 5,
      protectedIds: ["incoming"],
      isPinned: (id) => id === "P1",
      isKeepLoaded: () => false,
    });
    // The oldest UNPINNED (a) goes; P1 survives.
    expect(victims).toEqual(["a"]);
  });
});

describe("GC constants", () => {
  it("have the expected values", () => {
    expect(PANEL_UI_IDLE_UNLOAD_MS).toBe(60 * 60 * 1000);
    expect(PANEL_UI_IDLE_SWEEP_MS).toBe(5 * 60 * 1000);
    expect(PANEL_UI_MAX_LOADED_DESKTOP).toBe(16);
    expect(PANEL_UI_MAX_LOADED_MOBILE).toBe(5);
  });
});
