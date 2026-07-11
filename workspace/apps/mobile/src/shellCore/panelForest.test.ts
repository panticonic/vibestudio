import type { Panel } from "@vibestudio/shared/types";
import {
  buildMobilePanelForestRows,
  orderMobilePanelForest,
  preferredMobileRoot,
} from "./panelForest";

function panel(id: string, children: Panel[] = []): Panel {
  return {
    id,
    title: id,
    children,
    snapshot: { source: `panels/${id}`, contextId: `ctx-${id}`, options: {} },
    artifacts: {},
  };
}

describe("mobile panel forest", () => {
  const forest = [
    { owner: "bob", rootPanels: [panel("bob-root")] },
    { owner: "alice", rootPanels: [panel("alice-root", [panel("alice-child")])] },
  ];

  it("orders and focuses the verified account's roots first", () => {
    expect(orderMobilePanelForest(forest, "alice").map((group) => group.owner)).toEqual([
      "alice",
      "bob",
    ]);
    expect(preferredMobileRoot(forest, "alice")?.id).toBe("alice-root");
  });

  it("keeps explicit owner rows even when there is one populated group", () => {
    const rows = buildMobilePanelForestRows(
      [forest[1]!],
      new Set(),
      "alice",
      new Map([["alice", { userId: "alice", handle: "alice", displayName: "Alice" }]])
    );
    expect(rows.map((row) => (row.kind === "owner" ? row.label : row.panel.id))).toEqual([
      "Your panels",
      "alice-root",
      "alice-child",
    ]);
  });

  it("resolves other owners independently and respects collapsed descendants", () => {
    const rows = buildMobilePanelForestRows(
      forest,
      new Set(["alice-root"]),
      "alice",
      new Map([["bob", { userId: "bob", handle: "bob", displayName: "Bob" }]])
    );
    expect(rows.map((row) => (row.kind === "owner" ? row.label : row.panel.id))).toEqual([
      "Your panels",
      "alice-root",
      "Bob",
      "bob-root",
    ]);
  });
});
