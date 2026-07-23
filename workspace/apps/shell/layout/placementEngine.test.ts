import { describe, expect, it } from "vitest";
import {
  applyLayoutAction,
  computeViewport,
  findPane,
  normalizeLayout,
  paneForPanel,
  validateRestoredLayout,
  type LayoutAction,
  type LayoutEnv,
} from "./placementEngine";
import {
  MIN_COLUMN_WIDTH,
  MIN_PANE_HEIGHT,
  SINGLE_COLUMN_BREAKPOINT,
  mintColumnId,
  mintPaneId,
  nativeSlotIdForPane,
  type PanelLayout,
} from "./types";

// ---------------------------------------------------------------------------
// Test fixtures: a tiny owner-grouped panel forest.
//
// owner1:  root
//           ├── A
//           │    ├── B
//           │    │    └── C
//           │    └── B2      (sibling of B)
//           └── D
// owner2:  other-root
//           └── other-child

const PARENTS: Record<string, string | null> = {
  root: null,
  A: "root",
  B: "A",
  C: "B",
  B2: "A",
  D: "root",
  "other-root": null,
  "other-child": "other-root",
};

const OWNERS: Record<string, string> = {
  root: "o1",
  A: "o1",
  B: "o1",
  C: "o1",
  B2: "o1",
  D: "o1",
  "other-root": "o2",
  "other-child": "o2",
};

function ancestors(id: string): string[] {
  const out: string[] = [];
  let cur = PARENTS[id] ?? null;
  while (cur !== null) {
    out.push(cur);
    cur = PARENTS[cur] ?? null;
  }
  return out;
}

function treeRelation(a: string, b: string): "self" | "ancestor" | "descendant" | "sibling" | "none" {
  if (!(a in PARENTS) || !(b in PARENTS)) return "none";
  if (OWNERS[a] !== OWNERS[b]) return "none"; // rule 8: owner boundaries
  if (a === b) return "self";
  if (ancestors(b).includes(a)) return "ancestor"; // a is an ancestor of b
  if (ancestors(a).includes(b)) return "descendant"; // a is a descendant of b
  if (PARENTS[a] === PARENTS[b]) return "sibling";
  return "none";
}

interface EnvOverrides {
  viewportWidth?: number;
  viewportHeight?: number;
  paneChromeHeight?: number;
  firstRootPanelId?: string | null;
  minWidths?: Record<string, number>;
}

function makeEnv(overrides: EnvOverrides = {}): LayoutEnv {
  return {
    viewportWidth: overrides.viewportWidth ?? 2000,
    viewportHeight: overrides.viewportHeight ?? 1000,
    paneChromeHeight: overrides.paneChromeHeight ?? 28,
    firstRootPanelId: () =>
      overrides.firstRootPanelId === undefined ? "root" : overrides.firstRootPanelId,
    minWidthOf: (panelId) => overrides.minWidths?.[panelId] ?? MIN_COLUMN_WIDTH,
    treeRelation,
    nearestVisibleRelative: (panelId, layout) => {
      // self < descendant < ancestor < sibling, nearest first (rule 1b).
      const visible: Array<{ paneId: string; panelId: string }> = [];
      for (const column of layout.columns) {
        for (const pane of column.panes) visible.push({ paneId: pane.id, panelId: pane.panelId });
      }
      const rank = { self: 0, descendant: 1, ancestor: 2, sibling: 3, none: 4 } as const;
      const distance = (a: string, b: string): number => {
        const upA = [a, ...ancestors(a)];
        const upB = [b, ...ancestors(b)];
        for (let i = 0; i < upA.length; i++) {
          const j = upB.indexOf(upA[i] ?? "");
          if (j !== -1) return i + j;
        }
        return Number.POSITIVE_INFINITY;
      };
      let best: { paneId: string; score: number; dist: number } | null = null;
      for (const entry of visible) {
        const rel = treeRelation(entry.panelId, panelId);
        const score = rank[rel];
        if (score >= rank.none) continue;
        const dist = distance(entry.panelId, panelId); // nearest first
        if (best === null || score < best.score || (score === best.score && dist < best.dist)) {
          best = { paneId: entry.paneId, score, dist };
        }
      }
      return best?.paneId ?? null;
    },
  };
}

function colAt(layout: PanelLayout, columnIndex: number) {
  const column = layout.columns[columnIndex];
  if (!column) throw new Error(`no column at index ${columnIndex}`);
  return column;
}

function paneAt(layout: PanelLayout, columnIndex: number, paneIndex: number) {
  const pane = colAt(layout, columnIndex).panes[paneIndex];
  if (!pane) throw new Error(`no pane at ${columnIndex},${paneIndex}`);
  return pane;
}

function layoutOf(...columns: string[][]): PanelLayout {
  const layout: PanelLayout = {
    columns: columns.map((panelIds, ci) => ({
      id: `col-${ci}`,
      widthFr: 1,
      panes: panelIds.map((panelId, pi) => ({ id: `pane-${ci}-${pi}`, heightFr: 1, panelId })),
    })),
    focusedPaneId: columns.length > 0 ? "pane-0-0" : null,
  };
  return layout;
}

function visiblePanelIds(layout: PanelLayout): string[] {
  return layout.columns.flatMap((c) => c.panes.map((p) => p.panelId));
}

function assertInvariants(layout: PanelLayout): void {
  // No duplicate panelIds (D3).
  const ids = visiblePanelIds(layout);
  expect(new Set(ids).size).toBe(ids.length);
  // No empty columns.
  for (const column of layout.columns) {
    expect(column.panes.length).toBeGreaterThanOrEqual(1);
    for (const pane of column.panes) {
      expect(Number.isFinite(pane.heightFr)).toBe(true);
      expect(pane.heightFr).toBeGreaterThan(0);
    }
    expect(Number.isFinite(column.widthFr)).toBe(true);
    expect(column.widthFr).toBeGreaterThan(0);
  }
  // focusedPaneId valid, or null iff columns empty.
  if (layout.columns.length === 0) {
    expect(layout.focusedPaneId).toBeNull();
  } else {
    expect(layout.focusedPaneId).not.toBeNull();
    expect(findPane(layout, layout.focusedPaneId as string)).not.toBeNull();
  }
}

// ---------------------------------------------------------------------------

describe("types helpers", () => {
  it("mints prefixed unique ids and derives native slot ids", () => {
    const paneId = mintPaneId();
    const colId = mintColumnId();
    expect(paneId).toMatch(/^pane-[0-9a-f-]{8}$/);
    expect(colId).toMatch(/^col-[0-9a-f-]{8}$/);
    expect(mintPaneId()).not.toBe(paneId);
    expect(nativeSlotIdForPane("pane-x")).toBe("panel-stack:pane-x");
  });
});

describe("atomic pane moves", () => {
  it("moves a stacked pane into an adjacent column without losing its panel", () => {
    const layout = layoutOf(["A", "B"], ["C"]);
    const paneId = paneAt(layout, 0, 1).id;
    const next = applyLayoutAction(
      layout,
      { type: "move-pane-to-new-column", paneId },
      makeEnv()
    );

    expect(next.columns.map((column) => column.panes.map((pane) => pane.panelId))).toEqual([
      ["A"],
      ["B"],
      ["C"],
    ]);
    expect(next.focusedPaneId).toBe(paneId);
    expect(paneForPanel(next, "B")?.pane.id).toBe(paneId);
    assertInvariants(next);
  });
});

describe("helpers", () => {
  it("findPane and paneForPanel locate panes", () => {
    const layout = layoutOf(["A"], ["B", "C"]);
    expect(findPane(layout, "pane-1-1")?.pane.panelId).toBe("C");
    expect(findPane(layout, "nope")).toBeNull();
    expect(paneForPanel(layout, "B")?.pane.id).toBe("pane-1-0");
    expect(paneForPanel(layout, "Z")).toBeNull();
  });

  it("normalizeLayout prunes empty columns, renormalizes fr, fixes dangling focus", () => {
    const layout: PanelLayout = {
      columns: [
        { id: "c1", widthFr: NaN, panes: [{ id: "p1", heightFr: -5, panelId: "A" }] },
        { id: "c2", widthFr: 3, panes: [] },
      ],
      focusedPaneId: "gone",
    };
    const next = normalizeLayout(layout);
    assertInvariants(next);
    expect(next.columns).toHaveLength(1);
    expect(colAt(next, 0).widthFr).toBeCloseTo(1);
    expect(paneAt(next, 0, 0).heightFr).toBeCloseTo(1);
    expect(next.focusedPaneId).toBe("p1");
  });

  it("normalizeLayout keeps proportions when renormalizing", () => {
    const layout = layoutOf(["A"], ["B"]);
    colAt(layout, 0).widthFr = 2;
    colAt(layout, 1).widthFr = 6;
    const next = normalizeLayout(layout);
    expect(colAt(next, 0).widthFr / colAt(next, 1).widthFr).toBeCloseTo(2 / 6);
    expect(colAt(next, 0).widthFr + colAt(next, 1).widthFr).toBeCloseTo(2);
  });
});

describe("show-panel (rule 1)", () => {
  it("focuses the existing pane when the panel is already visible, never duplicates (rule 9)", () => {
    const layout = layoutOf(["A"], ["B"]);
    const env = makeEnv();
    const action: LayoutAction = { type: "show-panel", panelId: "B", origin: "tree-click" };
    const next = applyLayoutAction(layout, action, env);
    expect(next.focusedPaneId).toBe("pane-1-0");
    expect(visiblePanelIds(next)).toEqual(["A", "B"]);
    // Double delivery is idempotent.
    const again = applyLayoutAction(next, action, env);
    expect(again).toEqual(next);
    assertInvariants(again);
  });

  it("replaces in the nearest tree relative's pane and focuses it", () => {
    // B visible; showing C (child of B) should replace in B's pane, not A's.
    const layout = layoutOf(["A"], ["B"]);
    layout.focusedPaneId = "pane-0-0";
    const next = applyLayoutAction(
      layout,
      { type: "show-panel", panelId: "C", origin: "tree-click" },
      makeEnv()
    );
    expect(paneAt(next, 1, 0).panelId).toBe("C");
    expect(paneAt(next, 0, 0).panelId).toBe("A");
    expect(next.focusedPaneId).toBe("pane-1-0");
    assertInvariants(next);
  });

  it("falls back to the focused pane when no relative is visible (owner boundary, rule 8)", () => {
    const layout = layoutOf(["A"], ["B"]);
    layout.focusedPaneId = "pane-1-0";
    const next = applyLayoutAction(
      layout,
      { type: "show-panel", panelId: "other-child", origin: "navigate-event" },
      makeEnv()
    );
    // other-child is in another owner's tree — "none" to everything visible.
    expect(paneAt(next, 1, 0).panelId).toBe("other-child");
    expect(paneAt(next, 0, 0).panelId).toBe("A");
    assertInvariants(next);
  });

  it("seeds a single column into an empty layout", () => {
    const layout: PanelLayout = { columns: [], focusedPaneId: null };
    const next = applyLayoutAction(
      layout,
      { type: "show-panel", panelId: "A", origin: "navigate-event" },
      makeEnv()
    );
    expect(visiblePanelIds(next)).toEqual(["A"]);
    assertInvariants(next);
  });

  it("keeps pane (position) ids stable across replace-in-place", () => {
    const layout = layoutOf(["B"]);
    const next = applyLayoutAction(
      layout,
      { type: "show-panel", panelId: "B2", origin: "tree-click" },
      makeEnv()
    );
    expect(paneAt(next, 0, 0).id).toBe("pane-0-0");
    expect(paneAt(next, 0, 0).panelId).toBe("B2");
  });
});

describe("open-child (rule 2)", () => {
  it("side (default): opens a new column right of the parent when it fits", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A" },
      makeEnv({ viewportWidth: 2000 })
    );
    expect(next.columns).toHaveLength(2);
    expect(paneAt(next, 0, 0).panelId).toBe("A");
    expect(paneAt(next, 1, 0).panelId).toBe("B");
    expect(findPane(next, next.focusedPaneId as string)?.pane.panelId).toBe("B");
    assertInvariants(next);
  });

  it("side: replaces in the parent's pane when the fit test fails (D4)", () => {
    // Two columns at min width already consume 840; adding 420 more exceeds 1000.
    const layout = layoutOf(["A"], ["D"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A" },
      makeEnv({ viewportWidth: 1000 })
    );
    expect(next.columns).toHaveLength(2);
    expect(paneAt(next, 0, 0).panelId).toBe("B");
    expect(paneAt(next, 1, 0).panelId).toBe("D");
    assertInvariants(next);
  });

  it("side: fit test respects per-panel min widths from hints", () => {
    const layout = layoutOf(["A"]);
    const env = makeEnv({ viewportWidth: 1000, minWidths: { B: 700 } });
    // 420 + 700 > 1000 → replace.
    const next = applyLayoutAction(layout, { type: "open-child", panelId: "B", parentId: "A" }, env);
    expect(next.columns).toHaveLength(1);
    expect(paneAt(next, 0, 0).panelId).toBe("B");
  });

  it("narrow viewport (< SINGLE_COLUMN_BREAKPOINT) always replaces (rule 7)", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A" },
      makeEnv({ viewportWidth: SINGLE_COLUMN_BREAKPOINT - 1 })
    );
    expect(next.columns).toHaveLength(1);
    expect(paneAt(next, 0, 0).panelId).toBe("B");
  });

  it("replace disposition replaces in the parent's pane", () => {
    const layout = layoutOf(["A"], ["D"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A", hint: { disposition: "replace" } },
      makeEnv()
    );
    expect(paneAt(next, 0, 0).panelId).toBe("B");
    expect(paneAt(next, 1, 0).panelId).toBe("D");
    assertInvariants(next);
  });

  it("falls back to show-panel rules when the parent is not visible", () => {
    const layout = layoutOf(["D"]);
    layout.focusedPaneId = "pane-0-0";
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "C", parentId: "B", hint: { disposition: "replace" } },
      makeEnv()
    );
    expect(next.columns).toHaveLength(1);
    expect(paneAt(next, 0, 0).panelId).toBe("C");
  });

  it("split-below stacks under the parent when the column has vertical room (rule 2c)", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A", hint: { disposition: "split-below" } },
      makeEnv({ viewportHeight: 1000, paneChromeHeight: 28 })
    );
    expect(next.columns).toHaveLength(1);
    expect(colAt(next, 0).panes.map((p) => p.panelId)).toEqual(["A", "B"]);
    expect(findPane(next, next.focusedPaneId as string)?.pane.panelId).toBe("B");
    assertInvariants(next);
  });

  it("split-below falls through to side when the column is vertically full", () => {
    // (1+1) * (160+28) = 376 > 300 → refuse split, open beside instead.
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A", hint: { disposition: "split-below" } },
      makeEnv({ viewportHeight: 300, viewportWidth: 2000 })
    );
    expect(next.columns).toHaveLength(2);
    expect(paneAt(next, 1, 0).panelId).toBe("B");
  });

  it("split-below falls all the way to replace when neither direction fits", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-child", panelId: "B", parentId: "A", hint: { disposition: "split-below" } },
      makeEnv({ viewportHeight: 300, viewportWidth: 500 })
    );
    expect(next.columns).toHaveLength(1);
    expect(colAt(next, 0).panes.map((p) => p.panelId)).toEqual(["B"]);
  });

  it("is idempotent: re-delivered open-child focuses, never duplicates (rule 9)", () => {
    const layout = layoutOf(["A"]);
    const env = makeEnv();
    const action: LayoutAction = { type: "open-child", panelId: "B", parentId: "A" };
    const once = applyLayoutAction(layout, action, env);
    const twice = applyLayoutAction(once, action, env);
    expect(visiblePanelIds(twice)).toEqual(visiblePanelIds(once));
    expect(twice.columns).toHaveLength(2);
    expect(findPane(twice, twice.focusedPaneId as string)?.pane.panelId).toBe("B");
    assertInvariants(twice);
  });
});

describe("open-beside / split-below explicit (rule 3)", () => {
  it("open-beside is always honored even past the fit limit", () => {
    const layout = layoutOf(["A"], ["B"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-beside", panelId: "C", anchorPaneId: "pane-1-0" },
      makeEnv({ viewportWidth: 600 }) // far too narrow for three columns
    );
    expect(next.columns).toHaveLength(3);
    expect(paneAt(next, 2, 0).panelId).toBe("C");
    assertInvariants(next);
  });

  it("open-beside on an already-visible panel focuses it (D3)", () => {
    const layout = layoutOf(["A"], ["B"]);
    const next = applyLayoutAction(
      layout,
      { type: "open-beside", panelId: "A", anchorPaneId: "pane-1-0" },
      makeEnv()
    );
    expect(next.columns).toHaveLength(2);
    expect(next.focusedPaneId).toBe("pane-0-0");
  });

  it("explicit split-below is honored when the column fits vertically", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "split-below", panelId: "B", anchorPaneId: "pane-0-0" },
      makeEnv()
    );
    expect(colAt(next, 0).panes.map((p) => p.panelId)).toEqual(["A", "B"]);
    assertInvariants(next);
  });

  it("explicit split-below on a full column falls back to open-beside", () => {
    // viewportHeight 570 fits 3 panes (3*188=564) but not 4 (752).
    const layout = layoutOf(["A", "B", "D"]);
    const next = applyLayoutAction(
      layout,
      { type: "split-below", panelId: "C", anchorPaneId: "pane-0-1" },
      makeEnv({ viewportHeight: 570 })
    );
    expect(next.columns).toHaveLength(2);
    expect(paneAt(next, 1, 0).panelId).toBe("C");
    assertInvariants(next);
  });

  it("split-below with an unfittable column and explicit anchor never squeezes below MIN_PANE_HEIGHT", () => {
    const layout = layoutOf(["A"]);
    const env = makeEnv({ viewportHeight: MIN_PANE_HEIGHT + 28 }); // fits exactly one pane
    const next = applyLayoutAction(
      layout,
      { type: "split-below", panelId: "B", anchorPaneId: "pane-0-0" },
      env
    );
    expect(colAt(next, 0).panes).toHaveLength(1);
    expect(next.columns).toHaveLength(2);
  });
});

describe("close-pane (rule 4)", () => {
  it("removes the pane and redistributes heightFr proportionally", () => {
    const layout = layoutOf(["A", "B", "C"]);
    paneAt(layout, 0, 0).heightFr = 1;
    paneAt(layout, 0, 1).heightFr = 2;
    paneAt(layout, 0, 2).heightFr = 1;
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "pane-0-1" }, makeEnv());
    expect(colAt(next, 0).panes.map((p) => p.panelId)).toEqual(["A", "C"]);
    const a = paneAt(next, 0, 0);
    const c = paneAt(next, 0, 1);
    expect(a.heightFr / c.heightFr).toBeCloseTo(1);
    expect(a.heightFr + c.heightFr).toBeCloseTo(2);
    assertInvariants(next);
  });

  it("removes an emptied column and redistributes widthFr", () => {
    const layout = layoutOf(["A"], ["B"], ["C"]);
    layout.columns.forEach((c, i) => (c.widthFr = i + 1));
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "pane-1-0" }, makeEnv());
    expect(next.columns.map((c) => c.panes[0]?.panelId)).toEqual(["A", "C"]);
    expect(colAt(next, 0).widthFr / colAt(next, 1).widthFr).toBeCloseTo(1 / 3);
    assertInvariants(next);
  });

  it("moves focus to the nearest surviving pane in the same column first", () => {
    const layout = layoutOf(["A", "B"], ["C"]);
    layout.focusedPaneId = "pane-0-1";
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "pane-0-1" }, makeEnv());
    expect(next.focusedPaneId).toBe("pane-0-0");
  });

  it("moves focus to the left neighbor column when the column emptied", () => {
    const layout = layoutOf(["A"], ["B"]);
    layout.focusedPaneId = "pane-1-0";
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "pane-1-0" }, makeEnv());
    expect(next.focusedPaneId).toBe("pane-0-0");
    assertInvariants(next);
  });

  it("keeps focus untouched when a non-focused pane closes", () => {
    const layout = layoutOf(["A"], ["B"]);
    layout.focusedPaneId = "pane-0-0";
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "pane-1-0" }, makeEnv());
    expect(next.focusedPaneId).toBe("pane-0-0");
  });

  it("reseeds from firstRootPanelId after closing the last pane", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "close-pane", paneId: "pane-0-0" },
      makeEnv({ firstRootPanelId: "root" })
    );
    expect(visiblePanelIds(next)).toEqual(["root"]);
    assertInvariants(next);
  });

  it("empty workspace: closing the last pane yields columns: [] / focusedPaneId: null", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "close-pane", paneId: "pane-0-0" },
      makeEnv({ firstRootPanelId: null })
    );
    expect(next).toEqual({ columns: [], focusedPaneId: null });
    assertInvariants(next);
  });

  it("ignores an unknown paneId", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(layout, { type: "close-pane", paneId: "nope" }, makeEnv());
    expect(visiblePanelIds(next)).toEqual(["A"]);
  });
});

describe("tree-reconcile (rules 5 and 8)", () => {
  it("swaps in the first surviving fallback candidate", () => {
    const layout = layoutOf(["A"], ["B"]);
    const next = applyLayoutAction(
      layout,
      { type: "tree-reconcile", removed: [{ panelId: "B", fallbackCandidates: ["B2", "A"] }] },
      makeEnv()
    );
    expect(paneAt(next, 1, 0).panelId).toBe("B2");
    expect(paneAt(next, 1, 0).id).toBe("pane-1-0"); // position survives
    assertInvariants(next);
  });

  it("skips candidates that are already visible (D3) and candidates removed in the same batch", () => {
    const layout = layoutOf(["A"], ["B"], ["C"]);
    const next = applyLayoutAction(
      layout,
      {
        type: "tree-reconcile",
        removed: [
          { panelId: "B", fallbackCandidates: ["C", "B2"] }, // C is visible → skip
          { panelId: "C", fallbackCandidates: ["B"] }, // B removed in this batch → close
        ],
      },
      makeEnv()
    );
    expect(visiblePanelIds(next)).toEqual(["A", "B2"]);
    assertInvariants(next);
  });

  it("closes the pane when no candidate survives (owner-boundary 'none' relations yield empty candidates)", () => {
    const layout = layoutOf(["A"], ["other-child"]);
    // caller computed candidates within the owner's tree only; other-child's
    // owner tree vanished entirely → no candidates.
    const next = applyLayoutAction(
      layout,
      { type: "tree-reconcile", removed: [{ panelId: "other-child", fallbackCandidates: [] }] },
      makeEnv()
    );
    expect(visiblePanelIds(next)).toEqual(["A"]);
    assertInvariants(next);
  });

  it("handles an atomic whole-subtree deletion emptying the layout, reseeding once", () => {
    const layout = layoutOf(["A"], ["B", "C"]);
    const next = applyLayoutAction(
      layout,
      {
        type: "tree-reconcile",
        removed: [
          { panelId: "A", fallbackCandidates: [] },
          { panelId: "B", fallbackCandidates: ["A"] },
          { panelId: "C", fallbackCandidates: ["B", "A"] },
        ],
      },
      makeEnv({ firstRootPanelId: "root" })
    );
    expect(visiblePanelIds(next)).toEqual(["root"]);
    assertInvariants(next);
  });

  it("empties to columns: [] when the workspace has no roots left", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "tree-reconcile", removed: [{ panelId: "A", fallbackCandidates: [] }] },
      makeEnv({ firstRootPanelId: null })
    );
    expect(next).toEqual({ columns: [], focusedPaneId: null });
  });

  it("ignores removed panels that are not visible", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "tree-reconcile", removed: [{ panelId: "D", fallbackCandidates: ["root"] }] },
      makeEnv()
    );
    expect(visiblePanelIds(next)).toEqual(["A"]);
  });
});

describe("focus-pane and resize (rule 6)", () => {
  it("focus-pane focuses an existing pane and ignores unknown ids", () => {
    const layout = layoutOf(["A"], ["B"]);
    const env = makeEnv();
    const next = applyLayoutAction(layout, { type: "focus-pane", paneId: "pane-1-0" }, env);
    expect(next.focusedPaneId).toBe("pane-1-0");
    const noop = applyLayoutAction(next, { type: "focus-pane", paneId: "nope" }, env);
    expect(noop.focusedPaneId).toBe("pane-1-0");
  });

  it("resize-columns writes normalized fractions, preserving proportions", () => {
    const layout = layoutOf(["A"], ["B"]);
    const next = applyLayoutAction(layout, { type: "resize-columns", columnFrs: [3, 1] }, makeEnv());
    expect(colAt(next, 0).widthFr / colAt(next, 1).widthFr).toBeCloseTo(3);
    expect(colAt(next, 0).widthFr + colAt(next, 1).widthFr).toBeCloseTo(2);
  });

  it("resize-columns rejects mismatched lengths and sanitizes bad fractions", () => {
    const layout = layoutOf(["A"], ["B"]);
    const rejected = applyLayoutAction(layout, { type: "resize-columns", columnFrs: [1] }, makeEnv());
    expect(rejected.columns.map((c) => c.widthFr)).toEqual([1, 1]);
    const sanitized = applyLayoutAction(
      layout,
      { type: "resize-columns", columnFrs: [NaN, 2] },
      makeEnv()
    );
    assertInvariants(sanitized);
  });

  it("resize-panes writes normalized fractions within one column", () => {
    const layout = layoutOf(["A", "B"], ["C"]);
    const next = applyLayoutAction(
      layout,
      { type: "resize-panes", columnId: "col-0", paneFrs: [1, 3] },
      makeEnv()
    );
    const a = paneAt(next, 0, 0);
    const b = paneAt(next, 0, 1);
    expect(b.heightFr / a.heightFr).toBeCloseTo(3);
    expect(paneAt(next, 1, 0).heightFr).toBeCloseTo(1);
    const rejected = applyLayoutAction(
      layout,
      { type: "resize-panes", columnId: "col-9", paneFrs: [1, 3] },
      makeEnv()
    );
    expect(colAt(rejected, 0).panes.map((p) => p.heightFr)).toEqual([1, 1]);
  });
});

describe("replacement drift (rule 10)", () => {
  it("replacing B with sibling B2 leaves descendant C's pane untouched", () => {
    const layout = layoutOf(["B"], ["C"]);
    layout.focusedPaneId = "pane-0-0";
    const next = applyLayoutAction(
      layout,
      { type: "show-panel", panelId: "B2", origin: "tree-click" },
      makeEnv()
    );
    expect(next.columns.map((c) => c.panes[0]?.panelId)).toEqual(["B2", "C"]);
    expect(next.columns).toHaveLength(2);
    assertInvariants(next);
  });
});

describe("computeViewport (§3.1 / D10)", () => {
  it("returns everything resident when all columns fit", () => {
    const layout = layoutOf(["A"], ["B"]);
    const vp = computeViewport(layout, makeEnv({ viewportWidth: 2000 }));
    expect(vp).toEqual({ residentColumnIds: ["col-0", "col-1"], parkedLeft: [], parkedRight: [] });
  });

  it("parks the far columns and keeps the focused column resident", () => {
    const layout = layoutOf(["A"], ["B"], ["C"], ["D"]);
    layout.focusedPaneId = "pane-3-0";
    // 2 columns fit (840 <= 1000 < 1260).
    const vp = computeViewport(layout, makeEnv({ viewportWidth: 1000 }));
    expect(vp.residentColumnIds).toEqual(["col-2", "col-3"]);
    expect(vp.parkedLeft).toEqual(["col-0", "col-1"]);
    expect(vp.parkedRight).toEqual([]);
  });

  it("anchors on a middle focused column, extending right first", () => {
    const layout = layoutOf(["A"], ["B"], ["C"], ["D"]);
    layout.focusedPaneId = "pane-1-0";
    const vp = computeViewport(layout, makeEnv({ viewportWidth: 1000 }));
    expect(vp.residentColumnIds).toContain("col-1");
    expect(vp.residentColumnIds).toHaveLength(2);
    expect([...vp.parkedLeft, ...vp.residentColumnIds, ...vp.parkedRight]).toEqual([
      "col-0",
      "col-1",
      "col-2",
      "col-3",
    ]);
  });

  it("respects per-panel min widths when computing residency", () => {
    const layout = layoutOf(["A"], ["B"]);
    const vp = computeViewport(layout, makeEnv({ viewportWidth: 1000, minWidths: { B: 900 } }));
    expect(vp.residentColumnIds).toEqual(["col-0"]);
    expect(vp.parkedRight).toEqual(["col-1"]);
  });

  it("below SINGLE_COLUMN_BREAKPOINT only the focused column is resident", () => {
    const layout = layoutOf(["A"], ["B"], ["C"]);
    layout.focusedPaneId = "pane-1-0";
    const vp = computeViewport(layout, makeEnv({ viewportWidth: SINGLE_COLUMN_BREAKPOINT - 1 }));
    expect(vp).toEqual({
      residentColumnIds: ["col-1"],
      parkedLeft: ["col-0"],
      parkedRight: ["col-2"],
    });
  });

  it("handles an empty layout", () => {
    const vp = computeViewport({ columns: [], focusedPaneId: null }, makeEnv());
    expect(vp).toEqual({ residentColumnIds: [], parkedLeft: [], parkedRight: [] });
  });
});

describe("validateRestoredLayout (§7)", () => {
  const goodLayout = (): PanelLayout => layoutOf(["A"], ["B"]);
  const persisted = (layout: unknown, version: unknown = 1): unknown => ({
    version,
    workspaceId: "ws-1",
    layout,
    updatedAt: "2026-07-23T00:00:00Z",
  });
  const allPanels = new Set(Object.keys(PARENTS));

  it("accepts a valid blob and returns a normalized layout", () => {
    const restored = validateRestoredLayout(persisted(goodLayout()), allPanels);
    expect(restored).not.toBeNull();
    expect(visiblePanelIds(restored as PanelLayout)).toEqual(["A", "B"]);
    assertInvariants(restored as PanelLayout);
  });

  it("rejects wrong versions, non-objects, and malformed shapes", () => {
    expect(validateRestoredLayout(null, allPanels)).toBeNull();
    expect(validateRestoredLayout("junk", allPanels)).toBeNull();
    expect(validateRestoredLayout(persisted(goodLayout(), 2), allPanels)).toBeNull();
    expect(
      validateRestoredLayout(
        { workspaceId: "ws-1", layout: goodLayout(), updatedAt: "now" }, // no version
        allPanels
      )
    ).toBeNull();
    expect(validateRestoredLayout(persisted(null), allPanels)).toBeNull();
    expect(validateRestoredLayout(persisted({ columns: "nope", focusedPaneId: null }), allPanels)).toBeNull();
    expect(validateRestoredLayout(persisted({ columns: [], focusedPaneId: 42 }), allPanels)).toBeNull();
  });

  it("rejects NaN / non-positive / missing fractions", () => {
    for (const badFr of [NaN, 0, -1, Infinity, undefined, "1"]) {
      const layout = goodLayout();
      (layout.columns[0] as { widthFr: unknown }).widthFr = badFr;
      expect(validateRestoredLayout(persisted(layout), allPanels)).toBeNull();
      const layout2 = goodLayout();
      (paneAt(layout2, 1, 0) as { heightFr: unknown }).heightFr = badFr;
      expect(validateRestoredLayout(persisted(layout2), allPanels)).toBeNull();
    }
  });

  it("rejects missing/duplicate ids and missing panelIds", () => {
    const dupPane = goodLayout();
    paneAt(dupPane, 1, 0).id = paneAt(dupPane, 0, 0).id;
    expect(validateRestoredLayout(persisted(dupPane), allPanels)).toBeNull();
    const dupCol = goodLayout();
    colAt(dupCol, 1).id = colAt(dupCol, 0).id;
    expect(validateRestoredLayout(persisted(dupCol), allPanels)).toBeNull();
    const noPanel = goodLayout();
    (paneAt(noPanel, 0, 0) as { panelId: unknown }).panelId = undefined;
    expect(validateRestoredLayout(persisted(noPanel), allPanels)).toBeNull();
  });

  it("prunes panes whose panels no longer exist and repairs focus", () => {
    const layout = layoutOf(["A"], ["ghost"]);
    layout.focusedPaneId = "pane-1-0";
    const restored = validateRestoredLayout(persisted(layout), new Set(["A"]));
    expect(restored).not.toBeNull();
    expect(visiblePanelIds(restored as PanelLayout)).toEqual(["A"]);
    expect((restored as PanelLayout).focusedPaneId).toBe("pane-0-0");
    assertInvariants(restored as PanelLayout);
  });

  it("prunes duplicate panelIds (D3) keeping the first", () => {
    const layout = layoutOf(["A"], ["A"]);
    const restored = validateRestoredLayout(persisted(layout), allPanels);
    expect(visiblePanelIds(restored as PanelLayout)).toEqual(["A"]);
  });

  it("returns null when nothing is restorable", () => {
    const layout = layoutOf(["ghost1"], ["ghost2"]);
    expect(validateRestoredLayout(persisted(layout), new Set(["A"]))).toBeNull();
    expect(
      validateRestoredLayout(persisted({ columns: [], focusedPaneId: null }), allPanels)
    ).toBeNull();
  });
});

describe("property: random action sequences preserve invariants", () => {
  // Deterministic PRNG so failures are reproducible.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PANELS = Object.keys(PARENTS);

  function randomAction(rand: () => number, layout: PanelLayout): LayoutAction {
    const panes = layout.columns.flatMap((c) => c.panes);
    const pick = <T>(items: T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error("pick from empty array");
      return item;
    };
    const panelId = pick(PANELS);
    const anyPaneId = panes.length > 0 ? pick(panes).id : "missing-pane";
    const kind = Math.floor(rand() * 8);
    switch (kind) {
      case 0:
        return { type: "show-panel", panelId, origin: rand() < 0.5 ? "tree-click" : "navigate-event" };
      case 1:
        return {
          type: "open-child",
          panelId,
          parentId: PARENTS[panelId] ?? pick(PANELS),
          hint:
            rand() < 0.5
              ? undefined
              : { disposition: pick(["side", "replace", "split-below"] as const) },
        };
      case 2:
        return { type: "open-beside", panelId, anchorPaneId: anyPaneId };
      case 3:
        return { type: "split-below", panelId, anchorPaneId: anyPaneId };
      case 4:
        return { type: "close-pane", paneId: anyPaneId };
      case 5: {
        const removedCount = 1 + Math.floor(rand() * 3);
        return {
          type: "tree-reconcile",
          removed: Array.from({ length: removedCount }, () => ({
            panelId: pick(PANELS),
            fallbackCandidates: Array.from({ length: Math.floor(rand() * 3) }, () => pick(PANELS)),
          })),
        };
      }
      case 6:
        return { type: "focus-pane", paneId: anyPaneId };
      default:
        return rand() < 0.5
          ? { type: "resize-columns", columnFrs: layout.columns.map(() => rand() * 4) }
          : {
              type: "resize-panes",
              columnId: layout.columns.length > 0 ? pick(layout.columns).id : "missing",
              paneFrs:
                layout.columns.length > 0
                  ? pick(layout.columns).panes.map(() => rand() * 4)
                  : [],
            };
    }
  }

  it("never yields duplicate panelIds, empty columns, or dangling focus", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = mulberry32(seed);
      const env = makeEnv({
        viewportWidth: 600 + Math.floor(rand() * 2000),
        viewportHeight: 300 + Math.floor(rand() * 1200),
        firstRootPanelId: rand() < 0.2 ? null : "root",
      });
      let layout: PanelLayout = { columns: [], focusedPaneId: null };
      for (let step = 0; step < 60; step++) {
        const action = randomAction(rand, layout);
        layout = applyLayoutAction(layout, action, env);
        try {
          assertInvariants(layout);
          // computeViewport must partition the columns.
          const vp = computeViewport(layout, env);
          expect([...vp.parkedLeft, ...vp.residentColumnIds, ...vp.parkedRight]).toEqual(
            layout.columns.map((c) => c.id)
          );
        } catch (error) {
          throw new Error(
            `Invariant violated at seed=${seed} step=${step} action=${JSON.stringify(action)}: ${String(error)}`
          );
        }
      }
    }
  });
});

describe("place-in-pane (explicit drop, D8)", () => {
  it("replaces exactly the target pane and focuses it", () => {
    const layout = layoutOf(["A"], ["D"]);
    const next = applyLayoutAction(
      layout,
      { type: "place-in-pane", panelId: "B", paneId: "pane-1-0" },
      makeEnv()
    );
    expect(next.columns[1]?.panes[0]?.panelId).toBe("B");
    expect(next.columns[0]?.panes[0]?.panelId).toBe("A");
    expect(next.focusedPaneId).toBe("pane-1-0");
    assertInvariants(next);
  });

  it("focuses the existing pane instead of duplicating an already-visible panel", () => {
    const layout = layoutOf(["A"], ["D"]);
    const next = applyLayoutAction(
      layout,
      { type: "place-in-pane", panelId: "A", paneId: "pane-1-0" },
      makeEnv()
    );
    expect(next.columns[1]?.panes[0]?.panelId).toBe("D");
    expect(next.focusedPaneId).toBe("pane-0-0");
    assertInvariants(next);
  });

  it("is a no-op for an unknown pane", () => {
    const layout = layoutOf(["A"]);
    const next = applyLayoutAction(
      layout,
      { type: "place-in-pane", panelId: "B", paneId: "pane-9-9" },
      makeEnv()
    );
    expect(visiblePanelIds(next)).toEqual(["A"]);
  });
});
