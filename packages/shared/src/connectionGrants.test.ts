import { describe, expect, it } from "vitest";
import { ConnectionGrantService } from "./connectionGrants.js";
import { EntityCache } from "./runtime/entityCache.js";
import type { EntityRecord } from "./runtime/entitySpec.js";

function makePanelRecord(id: string): EntityRecord {
  return {
    id,
    kind: "panel",
    source: { repoPath: "", effectiveVersion: "" },
    contextId: "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

describe("ConnectionGrantService", () => {
  it("throws when granting an unregistered principal", () => {
    const grants = new ConnectionGrantService({ entityCache: new EntityCache() });
    expect(() => grants.grant("panel:missing", "shell:test")).toThrow(/unregistered/);
    grants.stop();
  });

  it("redeems grants once", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test");

    expect(grants.redeem(token)).toEqual({ principalId: "panel:one", issuedBy: "shell:test" });
    expect(grants.redeem(token)).toBeNull();
    grants.stop();
  });

  it("keeps redeemed grants valid only until the original bounded expiry or principal revocation", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test", 10);

    expect(grants.redeem(token)).toEqual({ principalId: "panel:one", issuedBy: "shell:test" });
    expect(grants.validate(token)).toEqual({
      principalId: "panel:one",
      principalKind: "panel",
      issuedBy: "shell:test",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(grants.validate(token)).toBeNull();
    grants.stop();
  });

  it("revokes redeemed grants for a retired principal", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test");

    expect(grants.redeem(token)).toEqual({ principalId: "panel:one", issuedBy: "shell:test" });
    expect(grants.revokeForPrincipal("panel:one")).toBe(1);
    expect(grants.validate(token)).toBeNull();
    grants.stop();
  });

  it("rejects expired grants", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(grants.redeem(token)).toBeNull();
    grants.stop();
  });

  it("revokes pending grants for a retired principal", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    entityCache._onActivate(makePanelRecord("panel:two"));
    const grants = new ConnectionGrantService({ entityCache });
    const first = grants.grant("panel:one", "shell:test").token;
    const second = grants.grant("panel:one", "shell:test").token;
    const other = grants.grant("panel:two", "shell:test").token;

    expect(grants.revokeForPrincipal("panel:one")).toBe(2);
    expect(grants.redeem(first)).toBeNull();
    expect(grants.redeem(second)).toBeNull();
    expect(grants.redeem(other)).toEqual({ principalId: "panel:two", issuedBy: "shell:test" });
    grants.stop();
  });
});
