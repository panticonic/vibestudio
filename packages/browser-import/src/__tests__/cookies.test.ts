import { describe, expect, it } from "vitest";
import {
  chromiumCookieIsolation,
  firefoxCookieIsolation,
  normalizeCookieExpiry,
} from "../normalize/cookies.js";

describe("cookie normalization", () => {
  it("normalizes Unix seconds, milliseconds, and microseconds to seconds", () => {
    expect(normalizeCookieExpiry(1_800_000_000, false)).toBe(1_800_000_000);
    expect(normalizeCookieExpiry(1_800_000_000_000, false)).toBe(1_800_000_000);
    expect(normalizeCookieExpiry(1_800_000_000_000_000, false)).toBe(1_800_000_000);
  });

  it("keeps session cookies without an expiry", () => {
    expect(normalizeCookieExpiry(1_800_000_000, true)).toBeUndefined();
    expect(normalizeCookieExpiry(0, false)).toBeUndefined();
  });

  it("normalizes Chromium and Firefox partition keys", () => {
    expect(chromiumCookieIsolation("https://top.example", true)).toEqual({
      partitionKey: {
        topLevelSite: "https://top.example",
        hasCrossSiteAncestor: true,
      },
    });
    expect(
      firefoxCookieIsolation(
        "^partitionKey=%28https%2Ctop.example%2C8443%2C1%29",
        ".embedded.example"
      )
    ).toEqual({
      partitionKey: {
        topLevelSite: "https://top.example:8443",
        hasCrossSiteAncestor: true,
      },
    });
  });

  it("does not conflate Firefox containers or private browsing with CHIPS partitions", () => {
    expect(firefoxCookieIsolation("^userContextId=2", ".example.test")).toEqual({
      unsupportedIsolation: "container",
    });
    expect(firefoxCookieIsolation("^privateBrowsingId=1", ".example.test")).toEqual({
      unsupportedIsolation: "private",
    });
  });
});
