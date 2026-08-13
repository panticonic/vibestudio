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
      "WorkspaceDO",
      "BrowserVaultDO",
      "EvalDO",
      "WebhookStoreDO",
    ]);
  });

  it("derives direct authority from the typed catalog", () => {
    expect(productBuiltinMethodCapability(source, "BrowserVaultDO", "getPasswords")).toBe(
      "browser-data.read"
    );
    expect(productBuiltinMethodCapability(source, "WorkspaceDO", "entityListExecutionRoots")).toBe(
      "workspace.runtime-state.inspect"
    );
    expect(productBuiltinMethodCapability(source, "EvalDO", "listRetainedExecutionRoots")).toBe(
      "runtime.code-execution.manage"
    );
    expect(productBuiltinMethodCapability(source, "WebhookStoreDO", "create")).toBe(
      "webhooks.manage"
    );
    expect(productBuiltinMethodPolicy(source, "BrowserVaultDO", "getPasswords")).toEqual({
      capability: "browser-data.read",
      tier: "gated",
      session: "family",
      sensitivity: "read",
      principals: ["host", "user", "code"],
      presentation: null,
      effect: {
        kind: "host-capability",
        capability: "browser-data.read",
        resource: { kind: "receiver-object" },
      },
    });
  });

  it("does not confer builtin identity on a userland class-name collision", () => {
    expect(productBuiltinByIdentity("workers/untrusted", "EvalDO")).toBeNull();
    expect(productBuiltinMethodCapability("workers/untrusted", "EvalDO", "executeRun")).toBeNull();
    expect(productBuiltinMethodPolicy("workers/untrusted", "EvalDO", "executeRun")).toBeNull();
    expect(productBuiltinMethodRequests("workers/untrusted", "EvalDO", "executeRun")).toEqual([]);
  });

  it("projects outbound authority only for the active builtin method", () => {
    expect(productBuiltinMethodRequests(source, "EvalDO", "executeRun")).toEqual([
      {
        capability: "external.open",
        resource: { kind: "prefix", prefix: "" },
      },
    ]);
    expect(productBuiltinMethodRequests(source, "EvalDO", "listRetainedExecutionRoots")).toEqual(
      []
    );
  });
});
