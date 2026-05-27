import { describe, expect, it } from "vitest";
import { CdpGrantService } from "./cdpGrants.js";

describe("CdpGrantService", () => {
  it("redeems a target-bound grant once", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one");

    expect(grants.redeem(token, "browser:one")).toEqual({ principalId: "panel:one" });
    expect(grants.redeem(token, "browser:one")).toBeNull();
    grants.stop();
  });

  it("rejects grants for another target", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one");

    expect(grants.redeem(token, "browser:two")).toBeNull();
    grants.stop();
  });

  it("rejects expired grants", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one", -1);

    expect(grants.redeem(token, "browser:one")).toBeNull();
    grants.stop();
  });

  it("clears outstanding grants when stopped", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one");

    grants.stop();

    expect(grants.redeem(token, "browser:one")).toBeNull();
  });
});
