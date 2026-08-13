import { describe, expect, it } from "vitest";
import { productBuiltinDirectAuthority } from "./productBuiltinDirectAuthority.js";

describe("product builtin direct authority", () => {
  it("projects WorkspaceDO methods even when no workspace config service exists", () => {
    expect(
      productBuiltinDirectAuthority({
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        method: "slotCreate",
      })
    ).toMatchObject({
      capability: "workspace-service:workspace.state",
      methodCapability: "workspace.runtime-state.manage",
      methodTier: "gated",
      principals: ["host"],
      declaredBy: "vibestudio/internal",
      presentation: { domain: "computer", verb: "manage" },
    });
  });

  it("does not invent authority for an unknown product method", () => {
    expect(
      productBuiltinDirectAuthority({
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        method: "notAWorkspaceMethod",
      })
    ).toBeNull();
  });
});
