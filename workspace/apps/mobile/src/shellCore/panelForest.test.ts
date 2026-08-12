import {
  buildMobilePanelForestRows,
  orderMobilePanelForest,
  presentMobilePanelRow,
  type MobilePanelTreeGroup,
  type MobilePanelTreeNode,
} from "./panelForest";

function panel(id: string, children: MobilePanelTreeNode[] = []): MobilePanelTreeNode {
  return {
    id,
    title: id,
    parentId: null,
    owner: null,
    childCount: children.length,
    children,
  };
}

describe("mobile panel forest", () => {
  const forest: MobilePanelTreeGroup[] = [
    { owner: "bob", rootCount: 1, rootPanels: [panel("bob-root")] },
    {
      owner: "alice",
      rootCount: 1,
      rootPanels: [panel("alice-root", [panel("alice-child")])],
    },
  ];

  it("orders the verified account's roots first", () => {
    expect(orderMobilePanelForest(forest, "alice").map((group) => group.owner)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("keeps explicit owner rows even when there is one populated group", () => {
    const rows = buildMobilePanelForestRows(
      [forest[1]!],
      new Set(),
      "alice",
      new Map([["alice", { userId: "alice", handle: "alice", displayName: "Alice" }]])
    );
    expect(
      rows.map((row) =>
        row.kind === "owner" ? row.label : row.kind === "panel" ? row.panel.id : "more"
      )
    ).toEqual(["Your panels", "alice-root", "alice-child"]);
  });

  it("resolves other owners independently and respects collapsed descendants", () => {
    const rows = buildMobilePanelForestRows(
      forest,
      new Set(["alice-root"]),
      "alice",
      new Map([["bob", { userId: "bob", handle: "bob", displayName: "Bob" }]])
    );
    expect(
      rows.map((row) =>
        row.kind === "owner" ? row.label : row.kind === "panel" ? row.panel.id : "more"
      )
    ).toEqual(["Your panels", "alice-root", "Bob", "bob-root"]);
  });

  it("bounds each sibling group and exposes an explicit older-panels row", () => {
    const roots = Array.from({ length: 50 }, (_, index) => panel(`root-${index}`));
    const rows = buildMobilePanelForestRows(
      [{ owner: "alice", rootCount: 55, rootPanels: roots }],
      new Set(),
      "alice",
      new Map()
    );
    expect(rows.filter((row) => row.kind === "panel")).toHaveLength(50);
    expect(rows.at(-1)).toMatchObject({
      kind: "load-more",
      groupKey: "roots:alice",
      remaining: 5,
    });
  });

  it("uses traversal progress rather than the sliding window size for older-history rows", () => {
    const roots = Array.from({ length: 50 }, (_, index) => panel(`older-${index}`));
    const rows = buildMobilePanelForestRows(
      [
        {
          owner: "alice",
          rootCount: 1_000,
          rootLoadedCount: 600,
          rootsHaveMore: true,
          rootPanels: roots,
        },
      ],
      new Set(),
      "alice",
      new Map()
    );
    expect(rows.at(-1)).toMatchObject({ kind: "load-more", remaining: 400 });

    const complete = buildMobilePanelForestRows(
      [
        {
          owner: "alice",
          rootCount: 1_000,
          rootLoadedCount: 1_000,
          rootsHaveMore: false,
          rootPanels: roots,
        },
      ],
      new Set(),
      "alice",
      new Map()
    );
    expect(complete.some((row) => row.kind === "load-more")).toBe(false);
  });

  it("keeps unloaded child branches expandable in the rendered row projection", () => {
    const unloadedParent: MobilePanelTreeNode = {
      ...panel("parent"),
      childCount: 4,
      childrenLoadedCount: 0,
      childrenHaveMore: true,
    };
    const row = buildMobilePanelForestRows(
      [{ owner: "alice", rootCount: 1, rootPanels: [unloadedParent] }],
      new Set(["parent"]),
      "alice",
      new Map()
    ).find(
      (
        candidate
      ): candidate is Extract<
        ReturnType<typeof buildMobilePanelForestRows>[number],
        { kind: "panel" }
      > => candidate.kind === "panel"
    );

    expect(row).toBeDefined();
    expect(presentMobilePanelRow(row!, false)).toMatchObject({
      id: "parent",
      childCount: 4,
      isCollapsed: true,
    });
    expect(presentMobilePanelRow(row!, true)).toMatchObject({
      childCount: 0,
      depth: 0,
      isCollapsed: true,
    });
  });
});
