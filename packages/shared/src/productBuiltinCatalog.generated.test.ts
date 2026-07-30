import { describe, expect, it } from "vitest";
import {
  INTERNAL_DO_CLASSES,
  productBuiltinByIdentity,
  productBuiltinCapabilityCategory,
  productBuiltinCapabilityPresentation,
  productBuiltinMethodCapability,
  productBuiltinMethodPolicy,
  productBuiltinMethodRequests,
} from "./productBuiltinCatalog.generated.js";
import { authorityRow } from "./authority/authorityRows.js";

describe("generated product builtin catalog", () => {
  const source = "vibestudio/internal";
  it("catalogs every product-owned internal Durable Object", () => {
    expect(INTERNAL_DO_CLASSES).toEqual([
      "DevelopmentDO",
      "WorkspaceDO",
      "BrowserDataDO",
      "EvalDO",
      "WebhookStoreDO",
      "MissionsDO",
      "PhoneProvisioningDO",
    ]);
  });

  it("derives direct authority from the typed catalog", () => {
    expect(productBuiltinMethodCapability(source, "BrowserDataDO", "getPasswords")).toBe(
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
    expect(productBuiltinMethodPolicy(source, "BrowserDataDO", "listDownloadRecords")).toEqual({
      capability: "browser-data.read",
      tier: "open",
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

  it("projects builtin approval presentation into declared authority rows", () => {
    expect(productBuiltinCapabilityCategory("development.runs.force-retire")).toEqual({
      domain: "computer",
      verb: "manage",
    });
    expect(productBuiltinCapabilityPresentation("development.runs.force-retire")).toMatchObject({
      title: "Abandon development-build recovery",
      action: "permanently abandon recovery of a development build",
    });
    expect(
      authorityRow({
        capability: "development.runs.force-retire",
        resource: { kind: "prefix", prefix: "" },
        tier: "critical",
        statement: "declared",
        provenance: { source: "manifest" },
      })
    ).toMatchObject({
      domain: "computer",
      verb: "manage",
      action: "permanently abandon recovery of a development build",
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

  it("projects schema-declared execution identity constraints", () => {
    expect(
      productBuiltinMethodPolicy(source, "DevelopmentDO", "faultFailBuildAfterSnapshotRetained")
        ?.execution
    ).toEqual({ harness: "attested-system-test" });
  });
});
