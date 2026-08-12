import { describe, expect, it } from "vitest";

import { parseLayoutDropId, viewportDropId } from "./dropTargets";

describe("viewport drop target ids", () => {
  it.each(["left", "full", "right"] as const)("round-trips the %s position", (position) => {
    expect(parseLayoutDropId(viewportDropId(position))).toEqual({
      kind: "viewport",
      position,
    });
  });

  it("rejects tree and malformed drop ids", () => {
    expect(parseLayoutDropId("panel-a")).toBeNull();
    expect(parseLayoutDropId("layout-drop:viewport:below")).toBeNull();
  });
});
