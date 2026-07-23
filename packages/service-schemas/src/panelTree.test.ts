import { describe, expect, it } from "vitest";
import { PanelPlacementHintSchema, PanelTreeCreateOptionsSchema } from "./panelTree.js";

describe("PanelPlacementHintSchema", () => {
  it("accepts every disposition plus width fields", () => {
    for (const disposition of ["side", "replace", "split-below"] as const) {
      expect(
        PanelPlacementHintSchema.parse({ disposition, preferredWidth: 560, minWidth: 420 })
      ).toEqual({ disposition, preferredWidth: 560, minWidth: 420 });
    }
  });

  it("rejects unknown dispositions and non-positive widths", () => {
    expect(() => PanelPlacementHintSchema.parse({ disposition: "float" })).toThrow();
    expect(() => PanelPlacementHintSchema.parse({ preferredWidth: 0 })).toThrow();
    expect(() => PanelPlacementHintSchema.parse({ minWidth: -1 })).toThrow();
  });
});

describe("PanelTreeCreateOptionsSchema", () => {
  it("passes placement through the create-options wire schema", () => {
    const parsed = PanelTreeCreateOptionsSchema.parse({
      parentId: "panel-1",
      focus: true,
      placement: { disposition: "split-below", preferredWidth: 500 },
    });
    expect(parsed?.placement).toEqual({ disposition: "split-below", preferredWidth: 500 });
  });

  it("keeps placement optional", () => {
    expect(PanelTreeCreateOptionsSchema.parse({ focus: true })?.placement).toBeUndefined();
    expect(PanelTreeCreateOptionsSchema.parse(undefined)).toBeUndefined();
  });
});
