import { describe, expect, it } from "vitest";
import {
  checkPanelGatewayPath,
  isPanelReachableGatewayPathname,
  panelAssetCacheKey,
  unitIconTarget,
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

  it("keys a build subresource independently of forwarded headers", () => {
    // The webview sends a different `accept` per fetch destination, so keying
    // build artifacts by header digest stored the same immutable chunk once per
    // destination AND made the key unknowable before the request — which is what
    // made prefetching them impossible.
    const path = `/__vibestudio/panel-build/${"a".repeat(64)}/chunk-ABC123.js`;
    const asScript = panelAssetCacheKey(path, { accept: "*/*", "user-agent": "RN" });
    const asStyle = panelAssetCacheKey(path, { accept: "text/css,*/*;q=0.1" });
    const bare = panelAssetCacheKey(path, {});
    expect(asScript).toBe(path);
    expect(asStyle).toBe(path);
    expect(bare).toBe(path);
  });

  it("keys versioned runtime helpers independently of forwarded headers", () => {
    const path = `/panels/chat/__loader.js?v=${"b".repeat(64)}`;
    expect(panelAssetCacheKey(path, { accept: "*/*", "user-agent": "desktop-a" })).toBe(path);
    expect(panelAssetCacheKey(path, { accept: "text/javascript", "user-agent": "desktop-b" })).toBe(
      path
    );
    const mutable = "/panels/chat/__loader.js";
    expect(panelAssetCacheKey(mutable, { accept: "*/*" })).not.toBe(
      panelAssetCacheKey(mutable, { accept: "text/javascript" })
    );
  });

  it("still separates non-build paths by forwarded headers", () => {
    // The relaxation is justified only by the build path being content-addressed
    // with bytes that no forwarded header can select; everything else keeps the
    // vary digest.
    const path = "/about/new/thing.js";
    const a = panelAssetCacheKey(path, { accept: "text/css" });
    const b = panelAssetCacheKey(path, { accept: "*/*" });
    expect(a).not.toBe(b);
    expect(a.startsWith(`${path}#h=`)).toBe(true);
  });
});

describe("unit icon targets", () => {
  const SOURCE = "about/help";

  it("names the icon's content when a version is known", () => {
    expect(unitIconTarget(SOURCE, "./assets/icon.svg", "0123456789abcdef")).toBe(
      "__vibestudio/unit-icon?source=about%2Fhelp&path=assets%2Ficon.svg&v=0123456789abcdef"
    );
  });

  it("carries an exact source state separately from the content identity", () => {
    const version = "a".repeat(64);
    const state = "b".repeat(64);
    expect(unitIconTarget(SOURCE, "./assets/icon.svg", version, state)).toBe(
      `__vibestudio/unit-icon?source=about%2Fhelp&path=assets%2Ficon.svg&v=${version}&s=${state}`
    );
  });

  it("omits the version when there is none, rather than sending an empty one", () => {
    // An empty `v` would look versioned to the route and make a mutable icon
    // immutable — the one way this can go wrong.
    expect(unitIconTarget(SOURCE, "./assets/icon.svg")).toBe(
      "__vibestudio/unit-icon?source=about%2Fhelp&path=assets%2Ficon.svg"
    );
    expect(unitIconTarget(SOURCE, "./assets/icon.svg", "")).not.toContain("v=");
  });

  it("has no target for an icon that is not unit-relative", () => {
    expect(unitIconTarget(SOURCE, "data:image/svg+xml;base64,AAA")).toBeNull();
    expect(unitIconTarget(SOURCE, "https://example.test/icon.svg")).toBeNull();
  });

  it("returns no leading slash, so each origin prefixes its own base", () => {
    // Panels reach it as `../../…`, mobile as `<loopback>/…`.
    expect(unitIconTarget(SOURCE, "./icon.svg", "aaaaaaaa")?.startsWith("/")).toBe(false);
  });

  it("keys a versioned icon independently of forwarded headers", () => {
    // The whole point is that it can be stored. Keying by header digest would
    // split one glyph across every `accept` a client happens to send, which is
    // what already went wrong for build subresources.
    const target = `/${unitIconTarget(SOURCE, "./assets/icon.svg", "0123456789abcdef")}`;
    expect(panelAssetCacheKey(target, { accept: "image/svg+xml" })).toBe(
      panelAssetCacheKey(target, { accept: "image/webp,*/*" })
    );
    expect(panelAssetCacheKey(target, {})).toBe(target);
  });

  it("still separates an unversioned icon by header, since it is not immutable", () => {
    const target = `/${unitIconTarget(SOURCE, "./assets/icon.svg")}`;
    expect(panelAssetCacheKey(target, { accept: "image/svg+xml" })).not.toBe(
      panelAssetCacheKey(target, { accept: "image/webp" })
    );
  });
});
