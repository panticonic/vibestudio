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

  it("preserves WorkspaceDO's inspect-only retention projection", () => {
    expect(productDirectMethodCapability("WorkspaceDO", "entityListExecutionRoots")).toBe(
      "workspace.runtime-state.inspect"
    );
    expect(productDirectMethodCapability("WorkspaceDO", "entityListActive")).toBe(
      "workspace.runtime-state.manage"
    );
  });

  it("preserves EvalDO's host-only retention projection as runtime plumbing", () => {
    expect(productDirectMethodCapability("EvalDO", "listRetainedExecutionRoots")).toBeNull();
    expect(productDirectMethodCapability("EvalDO", "startRun")).toBe(
      "runtime.code-execution.manage"
    );
  });
});

describe("isHostIntrinsicDirectMethod", () => {
  it("recognizes framework methods implemented outside worker source catalogs", () => {
    expect(isHostIntrinsicDirectMethod("durableWorkCapabilities")).toBe(true);
    expect(isHostIntrinsicDirectMethod("getNote")).toBe(false);
  });
});
