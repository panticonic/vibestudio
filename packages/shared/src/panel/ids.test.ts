import { describe, expect, it } from "vitest";
import { PanelEntityIdSchema, PanelSlotIdSchema, asPanelEntityId, asPanelSlotId } from "./ids.js";

describe("panel id wire schemas", () => {
  it("accepts and brands ids from their own namespaces", () => {
    expect(PanelSlotIdSchema.parse("panel:tree/root")).toBe(asPanelSlotId("panel:tree/root"));
    expect(PanelEntityIdSchema.parse("panel:nav-runtime")).toBe(
      asPanelEntityId("panel:nav-runtime")
    );
  });

  it("rejects cross-namespace ids", () => {
    expect(() => PanelSlotIdSchema.parse("panel:nav-runtime")).toThrow(/panel slot id/);
    expect(() => PanelEntityIdSchema.parse("panel:tree/root")).toThrow(/panel entity id/);
  });
});
