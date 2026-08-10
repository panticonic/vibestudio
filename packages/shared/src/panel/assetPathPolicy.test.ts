import { describe, expect, it } from "vitest";
import { checkPanelGatewayPath, isPanelReachableGatewayPathname } from "./assetPathPolicy.js";

const DIGEST = "a".repeat(64);

describe("panel gateway asset path policy", () => {
  it("admits only the exact content-addressed shared-style shape", () => {
    const pathname = `/__vibestudio/shared-style/${DIGEST}.css`;
    expect(isPanelReachableGatewayPathname(pathname)).toBe(true);
    expect(checkPanelGatewayPath(`${pathname}?cache=1`)).toEqual({
      allowed: true,
      target: `${pathname}?cache=1`,
    });

    for (const denied of [
      "/__vibestudio/shared-style/not-a-digest.css",
      `/__vibestudio/shared-style/${DIGEST}.js`,
      `/__vibestudio/shared-style/${DIGEST}.css/extra`,
      "/__vibestudio/management",
    ]) {
      expect(checkPanelGatewayPath(denied), denied).toMatchObject({
        allowed: false,
        denied: "policy",
      });
    }
  });

  it("admits immutable panel build assets only under an exact build digest", () => {
    const pathname = `/__vibestudio/panel-build/${DIGEST}/bundle-ABC123.js`;
    expect(checkPanelGatewayPath(`${pathname}?cache=1`)).toEqual({
      allowed: true,
      target: `${pathname}?cache=1`,
    });

    for (const denied of [
      "/__vibestudio/panel-build/not-a-digest/bundle.js",
      `/__vibestudio/panel-build/${DIGEST}`,
      `/__vibestudio/panel-build/${DIGEST}/`,
    ]) {
      expect(checkPanelGatewayPath(denied), denied).toMatchObject({
        allowed: false,
        denied: "policy",
      });
    }
  });

  it("admits the read-only unit icon route without opening its namespace", () => {
    expect(
      checkPanelGatewayPath("/__vibestudio/unit-icon?source=panels%2Fchat&path=assets%2Ficon.svg")
    ).toEqual({
      allowed: true,
      target: "/__vibestudio/unit-icon?source=panels%2Fchat&path=assets%2Ficon.svg",
    });
    expect(checkPanelGatewayPath("/__vibestudio/unit-icon/other")).toMatchObject({
      allowed: false,
      denied: "policy",
    });
  });

  it("continues to deny management and origin-escape paths", () => {
    for (const denied of ["/_r/s/auth/issue-device", "/rpc", "/_w/do/x", "//evil.test/x"]) {
      expect(checkPanelGatewayPath(denied), denied).toMatchObject({ allowed: false });
    }
  });
});
