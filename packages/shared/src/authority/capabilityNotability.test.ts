import { describe, expect, it } from "vitest";
import { HOST_SEMANTIC_CAPABILITY_COPY } from "../hostApprovalCopy.js";
import { PRODUCT_BUILTIN_CATALOG } from "../productBuiltinCatalog.generated.js";
import { HOST_AUTHORITY_METHODS } from "./hostAuthorityCatalog.generated.js";
import { capabilityNotability, reviewedCapabilityNotability } from "./capabilityNotability.js";

/**
 * Every capability the platform can present must carry exactly one reviewed
 * notability value (§10). This test is the "registration fails without the
 * field" rule: a new capability that nobody classified fails here rather than
 * quietly rendering as everyday.
 */
function everyReviewedCapability(): string[] {
  const capabilities = new Set<string>();
  for (const method of Object.values(HOST_AUTHORITY_METHODS)) {
    if (method.capability) capabilities.add(method.capability);
  }
  for (const service of PRODUCT_BUILTIN_CATALOG) {
    for (const method of Object.values(
      (service as { methods?: Record<string, { capability?: string | null }> }).methods ?? {}
    )) {
      if (method.capability) capabilities.add(method.capability);
    }
  }
  for (const { prefix } of HOST_SEMANTIC_CAPABILITY_COPY) {
    capabilities.add(prefix.endsWith(".") || prefix.endsWith(":") ? `${prefix}example` : prefix);
  }
  return [...capabilities].sort();
}

describe("capability notability", () => {
  it("classifies every reviewed capability exactly once", () => {
    const unclassified = everyReviewedCapability().filter(
      (capability) =>
        // Receiver-declared capabilities carry their own provider-authored value,
        // which the platform may promote and never demote.
        !capability.startsWith("workspace-service:") &&
        reviewedCapabilityNotability(capability) === null
    );
    expect(unclassified).toEqual([]);
  });

  it("treats critical as headline whatever the list says", () => {
    expect(reviewedCapabilityNotability("workspace.files.read")).toBe("everyday");
    expect(capabilityNotability({ capability: "workspace.files.read", tier: "critical" })).toBe(
      "headline"
    );
  });

  it("keeps an unreviewed capability headline rather than quietly folding it away", () => {
    expect(capabilityNotability({ capability: "nobody.reviewed.this", tier: "gated" })).toBe(
      "headline"
    );
  });

  it("keeps native file-launch effects prominent while folding download controls", () => {
    expect(reviewedCapabilityNotability("service:browserEnvironment.listDownloads")).toBe(
      "everyday"
    );
    expect(reviewedCapabilityNotability("service:browserEnvironment.openDownload")).toBe(
      "headline"
    );
  });

  it("lets a receiver declare its own capability everyday, but never demote a platform headline", () => {
    expect(
      capabilityNotability({
        capability: "workspace-service:news.readFeed",
        tier: "gated",
        declared: "everyday",
      })
    ).toBe("everyday");
    // A receiver that supplies nothing does not get the benefit of the doubt.
    expect(capabilityNotability({ capability: "workspace-service:news.send", tier: "gated" })).toBe(
      "headline"
    );
  });

  it("reads the specific entry rather than a shorter sibling prefix", () => {
    expect(reviewedCapabilityNotability("browser-passwords.read")).toBe("headline");
    expect(reviewedCapabilityNotability("workspace.dependencies.inspect")).toBe("everyday");
    expect(reviewedCapabilityNotability("workspace.dependencies.install")).toBe("headline");
  });

  it("marks the things a person would want to know before adding a part", () => {
    for (const capability of [
      "credential.use",
      "network.response.read",
      "push.send",
      "process.execute",
      "permissions.revoke",
    ]) {
      expect(reviewedCapabilityNotability(capability)).toBe("headline");
    }
  });

  it("keeps the ordinary machinery of being a part everyday", () => {
    for (const capability of [
      "workspace.files.read",
      "workspace.files.write",
      "panel.navigate",
      "internal-model-runtime.use",
      "notifications",
      "workspace-service:channel",
      "workspace-service:development",
      "workspace-service:models",
      "workspace-service:missions",
      "workspace-service:testkit-driver",
      "workspace-service:browser.data",
    ]) {
      expect(reviewedCapabilityNotability(capability)).toBe("everyday");
    }
  });
});
