import { describe, expect, it } from "vitest";
import {
  checkPanelGatewayPath,
  isPanelReachableGatewayPathname,
  panelAssetCacheKey,
  panelAssetRepresentationPath,
} from "./assetPathPolicy.js";

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

describe("panel asset representation keys", () => {
  const buildKey = "a".repeat(64);

  it("collapses build-pinned entry documents to source and build key", () => {
    expect(
      panelAssetRepresentationPath(
        `/panels/chat/?contextId=panel-one&ref=state%3Aold&buildKey=${buildKey}`
      )
    ).toBe(`/panels/chat/?buildKey=${buildKey}`);
    expect(
      panelAssetRepresentationPath(
        `/panels/chat/index.html?contextId=panel-two&buildKey=${buildKey}`
      )
    ).toBe(`/panels/chat/?buildKey=${buildKey}`);
  });

  it("retains complete targets for unpinned entries and subresources", () => {
    expect(panelAssetRepresentationPath("/panels/chat/?contextId=panel-one")).toBe(
      "/panels/chat/?contextId=panel-one"
    );
    expect(
      panelAssetRepresentationPath(`/panels/chat/bundle.js?buildKey=${buildKey}&variant=debug`)
    ).toBe(`/panels/chat/bundle.js?buildKey=${buildKey}&variant=debug`);
  });

  it("canonicalizes forwarded-header names and order on both platforms", () => {
    const path = `/panels/chat/?contextId=panel-one&buildKey=${buildKey}`;
    const keyed = panelAssetCacheKey(path, {
      Authorization: "Bearer a",
      Accept: "text/html",
    });
    expect(keyed).toBe(
      panelAssetCacheKey(path, { accept: "text/html", authorization: "Bearer a" })
    );
    expect(keyed).toBe(`/panels/chat/?buildKey=${buildKey}`);
    expect(keyed).not.toContain("Bearer a");
    expect(keyed).toBe(
      panelAssetCacheKey(path, { accept: "text/html", authorization: "Bearer rotated" })
    );
    expect(panelAssetCacheKey(path, {})).toBe(`/panels/chat/?buildKey=${buildKey}`);
  });
});
