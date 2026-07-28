import { describe, expect, it } from "vitest";
import {
  browserCookiePartitionFromStorageKey,
  browserCookiePartitionStorageKey,
  normalizeBrowserCookiePartitionKey,
} from "../cookies.js";

describe("browser cookie partition keys", () => {
  it("normalizes and round-trips the structured key through SQLite identity", () => {
    const key = normalizeBrowserCookiePartitionKey({
      topLevelSite: "https://Top.Example/path",
      hasCrossSiteAncestor: true,
    });
    expect(key).toEqual({
      topLevelSite: "https://top.example",
      hasCrossSiteAncestor: true,
    });
    expect(browserCookiePartitionFromStorageKey(browserCookiePartitionStorageKey(key))).toEqual(
      key
    );
  });

  it("keeps unpartitioned identity distinct", () => {
    expect(browserCookiePartitionStorageKey(undefined)).toBe("");
    expect(browserCookiePartitionFromStorageKey("")).toBeUndefined();
  });
});
