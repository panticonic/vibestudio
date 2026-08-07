// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { FlattenedPanel } from "../shell/hooks/index.js";
import { buildGuides } from "./panelTreeGuides.js";

function row(id: string, parentId: string | null, depth: number): FlattenedPanel {
  return {
    id,
    parentId,
    depth,
    index: 0,
    collapsed: false,
    panel: { id, title: id, childCount: 0, position: 0 },
  };
}

describe("buildGuides", () => {
  it("preserves continuing ancestor stems and terminates last-child branches", () => {
    const guides = buildGuides([
      row("root-a", null, 0),
      row("a-1", "root-a", 1),
      row("a-1-i", "a-1", 2),
      row("a-2", "root-a", 1),
      row("root-b", null, 0),
      row("b-1", "root-b", 1),
    ]);

    expect(Object.fromEntries(guides)).toEqual({
      "root-a": "",
      "a-1": "T",
      "a-1-i": "vL",
      "a-2": "L",
      "root-b": "",
      "b-1": "L",
    });
  });

  it("handles a wide sibling group without scanning ahead per row", () => {
    const rows = [row("root", null, 0)];
    for (let index = 0; index < 2_000; index++) {
      rows.push(row(`child-${index}`, "root", 1));
    }

    const guides = buildGuides(rows);
    expect(guides.get("child-0")).toBe("T");
    expect(guides.get("child-1998")).toBe("T");
    expect(guides.get("child-1999")).toBe("L");
  });
});
