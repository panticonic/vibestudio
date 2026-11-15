import { describe, expect, it } from "vitest";
import {
  INTERNAL_DO_CLASSES,
  productBuiltinByIdentity,
  productBuiltinMethodCapability,
  productBuiltinMethodPolicy,
  productBuiltinMethodRequests,
} from "./productBuiltinCatalog.generated.js";

describe("generated product builtin catalog", () => {
  const source = "vibestudio/internal";
  it("catalogs every product-owned internal Durable Object", () => {
    expect(INTERNAL_DO_CLASSES).toEqual([
      "WorkspaceStateDO",
      "WorkspaceDO",
      "BrowserVaultDO",
      "WebhookStoreDO",
    ]);
  });

  it("derives direct authority from the typed catalog", () => {
    expect(productBuiltinMethodCapability(source, "BrowserVaultDO", "listPasswordSummaries")).toBe(
      "browser-data.read"
    );
    expect(
      productBuiltinMethodCapability(source, "WorkspaceStateDO", "entityListExecutionRoots")
    ).toBe("workspace.runtime-state.inspect");
    expect(productBuiltinMethodCapability(source, "WebhookStoreDO", "create")).toBe(
      "webhooks.manage"
    );
    expect(productBuiltinMethodPolicy(source, "BrowserVaultDO", "listPasswordSummaries")).toEqual({
      website: {
        kind: "closed",
        reason:
          "Browser profile data requires the browser privacy UI and cannot be exported to websites.",
      },
      capability: "browser-data.read",
      tier: "gated",
      session: "family",
      sensitivity: "read",
      principals: ["host"],
      presentation: null,
      effect: {
        kind: "host-capability",
        capability: "browser-data.read",
        resource: { kind: "receiver-object" },
      },
    });
  });

  it("does not confer builtin identity on a userland class-name collision", () => {
    expect(productBuiltinByIdentity("workers/untrusted", "WorkspaceStateDO")).toBeNull();
    expect(
      productBuiltinMethodCapability("workers/untrusted", "WorkspaceStateDO", "entityResolve")
    ).toBeNull();
    expect(
      productBuiltinMethodPolicy("workers/untrusted", "WorkspaceStateDO", "entityResolve")
    ).toBeNull();
    expect(
      productBuiltinMethodRequests("workers/untrusted", "WorkspaceStateDO", "entityResolve")
    ).toEqual([]);
  });

  it("projects no outbound authority for a product method: eval is hosted code, not a product class", () => {
    expect(productBuiltinMethodRequests(source, "EvalDO", "executeRun")).toEqual([]);
    expect(productBuiltinByIdentity(source, "EvalDO")).toBeNull();
    expect(productBuiltinMethodRequests(source, "WorkspaceStateDO", "entityResolve")).toEqual([]);
  });
});
