import { describe, expect, it } from "vitest";
import { productDirectMethodCapability } from "./directMethodEffects.js";

describe("productDirectMethodCapability", () => {
  it("does not classify host-owned context lifecycle cleanup as graph deletion authority", () => {
    expect(productDirectMethodCapability("GadWorkspaceDO", "vcsDropContext")).toBeNull();
    expect(productDirectMethodCapability("GadWorkspaceDO", "deleteRef")).toBe(
      "workspace.graph.delete"
    );
  });
});
