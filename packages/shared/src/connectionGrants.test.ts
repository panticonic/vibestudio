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

function makeAppRecord(id: string): EntityRecord {
  return {
    id,
    kind: "app",
    source: { repoPath: "apps/example", effectiveVersion: "1.0.0" },
    contextId: "device-1",
    key: "device-1",
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

  it("keeps redeemed grants valid for the active principal until revocation", async () => {
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
    expect(grants.validate(token)).toEqual({
      principalId: "panel:one",
      principalKind: "panel",
      issuedBy: "shell:test",
    });
    grants.stop();
  });

  it("validates app grants through the principal-kind registry", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makeAppRecord("app:apps/example:device-1"));
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("app:apps/example:device-1", "shell:test");

    expect(grants.validate(token)).toEqual({
      principalId: "app:apps/example:device-1",
      principalKind: "app",
      issuedBy: "shell:test",
    });
    grants.stop();
  });

  it("fails closed when a grant resolves to an unknown principal kind", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate({
      ...makePanelRecord("panel:one"),
      kind: "legacy-panel",
    } as unknown as EntityRecord);
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test");

    expect(grants.validate(token)).toBeNull();
    expect(grants.redeem(token)).toBeNull();
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

  it("bounds redeemed grants per principal (evicts oldest, keeps newest valid)", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const grants = new ConnectionGrantService({ entityCache });

    // Mint + redeem far more grants than the per-principal cap (16); a churny
    // reconnecting principal must not grow the map without bound.
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { token } = grants.grant("panel:one", "shell:test");
      expect(grants.redeem(token)).toEqual({ principalId: "panel:one", issuedBy: "shell:test" });
      tokens.push(token);
    }

    // The oldest redeemed grants were evicted…
    expect(grants.validate(tokens[0]!)).toBeNull();
    expect(grants.validate(tokens[23]!)).toBeNull();
    // …but the newest cap-worth remain valid until revocation.
    expect(grants.validate(tokens[39]!)).toEqual({
      principalId: "panel:one",
      principalKind: "panel",
      issuedBy: "shell:test",
    });
    expect(grants.validate(tokens[24]!)).not.toBeNull();
    // Revocation still clears everything for the principal.
    expect(grants.revokeForPrincipal("panel:one")).toBe(16);
    expect(grants.validate(tokens[39]!)).toBeNull();
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

  it("fails closed when redeeming after the principal is retired", () => {
    const entityCache = new EntityCache();
    const record = makePanelRecord("panel:one");
    entityCache._onActivate(record);
    const grants = new ConnectionGrantService({ entityCache });
    const { token } = grants.grant("panel:one", "shell:test");

    entityCache._onRetire({ ...record, status: "retired", retiredAt: Date.now() });

    expect(grants.redeem(token)).toBeNull();
    expect(grants.validate(token)).toBeNull();
    grants.stop();
  });
});
