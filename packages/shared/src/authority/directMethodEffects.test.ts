import { describe, expect, it } from "vitest";
import {
  isHostIntrinsicDirectMethod,
  productDirectMethodCapability,
} from "./directMethodEffects.js";

describe("productDirectMethodCapability", () => {
  it("does not classify host-owned context lifecycle cleanup as graph deletion authority", () => {
    expect(productDirectMethodCapability("GadWorkspaceDO", "vcsDropContext")).toBeNull();
    expect(productDirectMethodCapability("GadWorkspaceDO", "deleteRef")).toBe(
      "workspace.graph.delete"
    );
  });
});

describe("isHostIntrinsicDirectMethod", () => {
  it("recognizes framework methods implemented outside worker source catalogs", () => {
    expect(isHostIntrinsicDirectMethod("durableWorkCapabilities")).toBe(true);
    expect(isHostIntrinsicDirectMethod("getNote")).toBe(false);
  });
});
